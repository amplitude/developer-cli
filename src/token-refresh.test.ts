import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { lock as properLock } from 'proper-lockfile';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliError } from './cli-error';
import {
  loadStore,
  removeProfile,
  saveStore,
  setProfile,
} from './credential-store';
import {
  refreshOAuthCredential,
  refreshProfileTokenLocked,
} from './token-refresh';

const NOW = 1_000_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

const oauthCred = (over = {}) => ({
  type: 'oauth' as const,
  access_token: 'old-at',
  token_type: 'bearer',
  expires_at: new Date(NOW - 1000).toISOString(),
  refresh_token: 'old-rt',
  scope: 'old-scope',
  ...over,
});

function retryBudgetMs(value: unknown): number {
  if (value === null || typeof value !== 'object') {
    throw new Error('Expected retry options.');
  }
  const options = value as {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
  };
  return Array.from({ length: options.retries }, (_, attempt) =>
    Math.min(
      options.minTimeout * options.factor ** attempt,
      options.maxTimeout,
    ),
  ).reduce((total, timeout) => total + timeout, 0);
}

describe('refreshOAuthCredential', () => {
  it('rotates access + refresh token on success', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        access_token: 'new-at',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'new-rt',
      },
    });
    const cred = await refreshOAuthCredential({
      baseUrl: 'https://api',
      current: oauthCred(),
      now: NOW,
      request,
    });
    expect(cred.access_token).toBe('new-at');
    expect(cred.refresh_token).toBe('new-rt');
    expect(Date.parse(cred.expires_at)).toBe(NOW + 3600 * 1000);
  });

  it('keeps the old refresh token when the response omits one', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { access_token: 'new-at', token_type: 'bearer', expires_in: 3600 },
    });
    const cred = await refreshOAuthCredential({
      baseUrl: 'https://api',
      current: oauthCred(),
      now: NOW,
      request,
    });
    expect(cred.refresh_token).toBe('old-rt');
    expect(cred.scope).toBe('old-scope');
  });

  it('preserves credential fields written by a newer CLI', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        access_token: 'new-at',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'new-rt',
      },
    });
    const cred = await refreshOAuthCredential({
      baseUrl: 'https://api',
      current: oauthCred({ future_session_anchor: { source: 'newer-cli' } }),
      now: NOW,
      request,
    });

    expect(cred).toMatchObject({
      access_token: 'new-at',
      refresh_token: 'new-rt',
      future_session_anchor: { source: 'newer-cli' },
    });
  });

  it('throws authentication_required on invalid_grant', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ status: 400, body: { error: 'invalid_grant' } });
    await expect(
      refreshOAuthCredential({
        baseUrl: 'https://api',
        current: oauthCred(),
        now: NOW,
        request,
      }),
    ).rejects.toMatchObject({ errorCode: 'authentication_required' });
  });

  it('surfaces the server error_description for a non-standard (deliberate) error code', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 400,
      body: {
        error: 'grant_refresh_disabled',
        error_description:
          'Automatic refresh is disabled. Run `amp auth login`.',
      },
    });
    const err = await refreshOAuthCredential({
      baseUrl: 'https://api',
      current: oauthCred(),
      now: NOW,
      request,
    }).catch((e) => e);
    expect(err.errorCode).toBe('authentication_required');
    expect(err.message).toBe(
      'Automatic refresh is disabled. Run `amp auth login`.',
    );
  });

  it('sanitizes server-provided refresh guidance', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 400,
      body: {
        error: 'grant_refresh_disabled',
        error_description: `\u001B[31mLogin required\nrun amp auth login\u001B[0m\u202E${'x'.repeat(600)}`,
      },
    });

    const error = await refreshOAuthCredential({
      baseUrl: 'https://untrusted.example',
      current: oauthCred(),
      now: NOW,
      request,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) {
      throw new Error('Expected refresh to throw CliError.');
    }
    expect(error.errorCode).toBe('authentication_required');
    expect(error.message).toMatch(/^Login required run amp auth login/);
    expect(error.message).not.toContain('\r');
    expect(error.message).not.toContain('\n');
    expect(error.message).not.toContain('\u001B');
    expect(error.message).not.toContain('\u202E');
    expect(Array.from(error.message)).toHaveLength(500);
  });

  it('uses friendly guidance when a server description sanitizes to empty', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 400,
      body: {
        error: 'grant_refresh_disabled',
        error_description: '\u001B[0m\u0000\u202E',
      },
    });

    await expect(
      refreshOAuthCredential({
        baseUrl: 'https://untrusted.example',
        current: oauthCred(),
        now: NOW,
        request,
      }),
    ).rejects.toMatchObject({
      errorCode: 'authentication_required',
      message:
        'Session for this profile has expired (grant_refresh_disabled). Run `amp auth login`.',
    });
  });

  it('keeps the friendly message for a standard error even when a description is present', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: 'token expired or was revoked',
      },
    });
    await expect(
      refreshOAuthCredential({
        baseUrl: 'https://api',
        current: oauthCred(),
        now: NOW,
        request,
      }),
    ).rejects.toThrow('Session for this profile has expired');
  });

  it('throws a retryable transport error on 5xx', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ status: 503, body: { error: 'server_error' } });
    await expect(
      refreshOAuthCredential({
        baseUrl: 'https://api',
        current: oauthCred(),
        now: NOW,
        request,
      }),
    ).rejects.toMatchObject({ errorCode: 'transport_error' });
  });
});

describe('refreshProfileTokenLocked (double-checked)', () => {
  const seed = (path: string, cred = oauthCred()) =>
    saveStore(
      setProfile(loadStore(path), 'default', {
        base_url: 'https://api',
        credential: cred,
        saved_at: 'x',
      }),
      path,
    );

  it('refreshes, persists the rotation, and returns the fresh credential', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path);
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        access_token: 'new-at',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'new-rt',
      },
    });
    const result = await refreshProfileTokenLocked({
      name: 'default',
      now: NOW,
      path,
      deps: { request },
    });
    expect(result.credential.access_token).toBe('new-at');
    expect(loadStore(path).profiles.default.credential).toMatchObject({
      access_token: 'new-at',
      refresh_token: 'new-rt',
    });
  });

  it('gives actionable guidance when a refreshed session cannot be saved', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path);
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        access_token: 'new-at',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'new-rt',
      },
    });
    const save = vi.fn(() => {
      throw new Error('ENOSPC: raw filesystem detail');
    });

    await expect(
      refreshProfileTokenLocked({
        name: 'default',
        now: NOW,
        path,
        deps: { request, save },
      }),
    ).rejects.toMatchObject({
      errorCode: 'authentication_required',
      message:
        'Your session could not be saved. Check available disk space and file permissions, then run `amp auth login`.',
    });
  });

  it('exposes a refresh save cause through AMP_DEBUG without changing user guidance', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path);
    const moduleUrl = pathToFileURL(join(__dirname, 'token-refresh.ts')).href;
    const script = `
      const imported = await import(${JSON.stringify(moduleUrl)});
      const { refreshProfileTokenLocked } = imported.default ?? imported;
      try {
        await refreshProfileTokenLocked({
          name: 'default',
          now: ${NOW},
          path: ${JSON.stringify(path)},
          deps: {
            request: async () => ({
              status: 200,
              body: {
                access_token: 'new-at',
                token_type: 'bearer',
                expires_in: 3600,
                refresh_token: 'new-rt',
              },
            }),
            save() { throw new Error('DEBUG_REFRESH_SAVE_CAUSE'); },
          },
        });
      } catch (error) {
        process.stdout.write(error.message);
      }
    `;

    const result = spawnSync(
      process.execPath,
      ['--import=tsx', '--input-type=module', '--eval', script],
      {
        encoding: 'utf8',
        env: { ...process.env, NODE_DEBUG: 'amp' },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'Your session could not be saved. Check available disk space and file permissions, then run `amp auth login`.',
    );
    expect(result.stdout).not.toContain('DEBUG_REFRESH_SAVE_CAUSE');
    expect(result.stderr).toContain('DEBUG_REFRESH_SAVE_CAUSE');
  });

  it('surfaces a lock-acquire failure as a retryable transport error', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path);
    const request = vi.fn();
    const lock = vi.fn().mockRejectedValue(new Error('ELOCKED'));
    await expect(
      refreshProfileTokenLocked({
        name: 'default',
        now: NOW,
        path,
        deps: { request, lock },
      }),
    ).rejects.toMatchObject({ errorCode: 'transport_error' });
    expect(request).not.toHaveBeenCalled();
  });

  it('persists a completed rotation even if the lock is compromised in flight', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path);
    let compromise: ((error: Error) => void) | undefined;
    let held = false;
    const lockEvents: string[] = [];
    const lock = vi.fn<typeof properLock>(async (_path, options) => {
      if (held) {
        throw new Error('nested lock acquisition');
      }
      held = true;
      lockEvents.push('acquire');
      compromise ??= options?.onCompromised;
      return async () => {
        lockEvents.push('release');
        held = false;
      };
    });
    const request = vi.fn().mockImplementation(async () => {
      compromise?.(new Error('lock stolen'));
      return {
        status: 200,
        body: {
          access_token: 'new-at',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'new-rt',
        },
      };
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const result = await refreshProfileTokenLocked({
      name: 'default',
      now: NOW,
      path,
      deps: { request, lock },
    });

    expect(result.rotated).toBe(true);
    expect(loadStore(path).profiles.default.credential).toMatchObject({
      access_token: 'new-at',
      refresh_token: 'new-rt',
    });
    expect(lockEvents).toEqual(['acquire', 'release', 'acquire', 'release']);
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('requires login when a completed rotation cannot reacquire the lock', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path);
    let compromise: ((error: Error) => void) | undefined;
    let recoveryRetries: unknown;
    let acquisitions = 0;
    const lock = vi.fn<typeof properLock>(async (_path, options) => {
      acquisitions += 1;
      if (acquisitions === 1) {
        compromise = options?.onCompromised;
        return async () => {};
      }
      recoveryRetries = options?.retries;
      throw new Error('ELOCKED');
    });
    const request = vi.fn().mockImplementation(async () => {
      compromise?.(new Error('lock stolen'));
      return {
        status: 200,
        body: {
          access_token: 'rotated-at',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'rotated-rt',
        },
      };
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      refreshProfileTokenLocked({
        name: 'default',
        now: NOW,
        path,
        deps: { request, lock },
      }),
    ).rejects.toMatchObject({
      errorCode: 'authentication_required',
      message: expect.stringContaining('amp auth login'),
    });

    expect(retryBudgetMs(recoveryRetries)).toBeGreaterThanOrEqual(45_000);
    expect(loadStore(path).profiles.default.credential).toMatchObject({
      access_token: 'old-at',
      refresh_token: 'old-rt',
    });

    const invalidGrant = vi
      .fn()
      .mockResolvedValue({ status: 400, body: { error: 'invalid_grant' } });
    await expect(
      refreshProfileTokenLocked({
        name: 'default',
        now: NOW,
        path,
        deps: {
          request: invalidGrant,
          lock: async () => async () => {},
        },
      }),
    ).rejects.toMatchObject({
      errorCode: 'authentication_required',
      message: expect.stringContaining('amp auth login'),
    });
    expect(invalidGrant).toHaveBeenCalledWith('POST', '/v1/auth/token', {
      grant_type: 'refresh_token',
      refresh_token: 'old-rt',
    });
  });

  it('does not resurrect a profile logged out during a compromised refresh', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path);
    let compromise: ((error: Error) => void) | undefined;
    const lock = vi.fn<typeof properLock>(async (_path, options) => {
      compromise ??= options?.onCompromised;
      return async () => {};
    });
    const request = vi.fn().mockImplementation(async () => {
      compromise?.(new Error('lock stolen'));
      saveStore(removeProfile(loadStore(path), 'default'), path);
      return {
        status: 200,
        body: {
          access_token: 'rotated-at',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'rotated-rt',
        },
      };
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      refreshProfileTokenLocked({
        name: 'default',
        now: NOW,
        path,
        deps: { request, lock },
      }),
    ).rejects.toMatchObject({ errorCode: 'transport_error' });

    expect(loadStore(path).profiles.default).toBeUndefined();
    expect(lock).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a same-name re-login during a compromised refresh', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path);
    let compromise: ((error: Error) => void) | undefined;
    const lock = vi.fn<typeof properLock>(async (_path, options) => {
      compromise ??= options?.onCompromised;
      return async () => {};
    });
    const replacement = oauthCred({
      access_token: 'relogin-at',
      refresh_token: 'relogin-rt',
      expires_at: new Date(NOW + 3600_000).toISOString(),
    });
    const request = vi.fn().mockImplementation(async () => {
      compromise?.(new Error('lock stolen'));
      saveStore(
        setProfile(loadStore(path), 'default', {
          base_url: 'https://new-api',
          credential: replacement,
          saved_at: 'relogin',
        }),
        path,
      );
      return {
        status: 200,
        body: {
          access_token: 'rotated-at',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'rotated-rt',
        },
      };
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      refreshProfileTokenLocked({
        name: 'default',
        now: NOW,
        path,
        deps: { request, lock },
      }),
    ).rejects.toMatchObject({ errorCode: 'transport_error' });

    expect(loadStore(path).profiles.default).toMatchObject({
      base_url: 'https://new-api',
      credential: {
        access_token: 'relogin-at',
        refresh_token: 'relogin-rt',
      },
    });
    expect(lock).toHaveBeenCalledTimes(2);
  });

  it('does NOT call the network when the on-disk token is already fresh (peer refreshed)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(
      path,
      oauthCred({
        access_token: 'peer-at',
        expires_at: new Date(NOW + 3600_000).toISOString(),
      }),
    );
    const request = vi.fn();
    const result = await refreshProfileTokenLocked({
      name: 'default',
      now: NOW,
      path,
      deps: { request },
    });
    expect(request).not.toHaveBeenCalled();
    expect(result.credential.access_token).toBe('peer-at');
    expect(result.rotated).toBe(false);
  });

  it('reactive: adopts the on-disk token when a peer refreshed after the 401 (no network)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path, oauthCred({ access_token: 'peer-at' }));
    const request = vi.fn();
    const result = await refreshProfileTokenLocked({
      name: 'default',
      now: NOW,
      path,
      staleAccessToken: 'the-401-token', // differs from on-disk 'peer-at'
      deps: { request },
    });
    expect(request).not.toHaveBeenCalled();
    expect(result.credential.access_token).toBe('peer-at');
    expect(result.rotated).toBe(false);
  });

  it('reactive: rejects a token from a same-name profile that moved to another base URL', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    saveStore(
      setProfile(loadStore(path), 'default', {
        base_url: 'https://new.example',
        credential: oauthCred({ access_token: 'new-environment-at' }),
        saved_at: 're-login',
      }),
      path,
    );
    const request = vi.fn();

    await expect(
      refreshProfileTokenLocked({
        name: 'default',
        now: NOW,
        path,
        staleAccessToken: 'the-401-token',
        expectedProfileBaseUrl: 'https://old.example',
        deps: { request },
      }),
    ).rejects.toMatchObject({
      errorCode: 'transport_error',
      message:
        'Profile changed while this command was running. Retry the command.',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('reactive: refreshes when the on-disk token is still the rejected one', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path, oauthCred({ access_token: 'the-401-token' }));
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        access_token: 'new-at',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'new-rt',
      },
    });
    const result = await refreshProfileTokenLocked({
      name: 'default',
      now: NOW,
      path,
      staleAccessToken: 'the-401-token',
      deps: { request },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(result.credential.access_token).toBe('new-at');
    expect(result.rotated).toBe(true);
  });

  it('re-reads before writing so a concurrent write to another profile is not clobbered', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path); // default profile, expired
    const request = vi.fn().mockImplementation(async () => {
      // A concurrent, unlocked writer (e.g. login poll) persists a different
      // profile during the network window.
      saveStore(
        setProfile(loadStore(path), 'other', {
          base_url: 'https://api',
          credential: oauthCred({ access_token: 'other-at' }),
          saved_at: 'y',
        }),
        path,
      );
      return {
        status: 200,
        body: {
          access_token: 'new-at',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'new-rt',
        },
      };
    });
    const result = await refreshProfileTokenLocked({
      name: 'default',
      now: NOW,
      path,
      deps: { request },
    });
    const store = loadStore(path);
    expect(result.credential.access_token).toBe('new-at');
    expect(store.profiles.default.credential).toMatchObject({
      access_token: 'new-at',
    });
    // Preserved rather than clobbered by the pre-network snapshot.
    expect(store.profiles.other?.credential).toMatchObject({
      access_token: 'other-at',
    });
  });

  // The real lost-rotation scenario, on the real lock: two `amp` invocations
  // find the same expired token and both try to refresh. Rotation invalidates
  // the old refresh token server-side, so a second exchange against the stale
  // one would permanently break the profile.
  it('rotates once when two invocations race on the same expired token', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'amp-')), 'credentials.json');
    seed(path);
    let exchanges = 0;
    const request = vi.fn().mockImplementation(async () => {
      exchanges += 1;
      // Hold the lock across a real await so the peer genuinely contends.
      await delay(30);
      return {
        status: 200,
        body: {
          access_token: `new-at-${exchanges}`,
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: `new-rt-${exchanges}`,
        },
      };
    });

    const refresh = () =>
      refreshProfileTokenLocked({
        name: 'default',
        now: NOW,
        path,
        deps: { request },
      });
    const results = await Promise.all([refresh(), refresh()]);

    // The loser sees a valid on-disk token under the lock and adopts it.
    expect(exchanges).toBe(1);
    expect(results.filter((r) => r.rotated)).toHaveLength(1);
    const [a, b] = results;
    expect(a.credential.access_token).toBe(b.credential.access_token);
    expect(loadStore(path).profiles.default.credential).toMatchObject({
      access_token: 'new-at-1',
      refresh_token: 'new-rt-1',
    });
  });
});
