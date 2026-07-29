import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolvePollProfile,
  runAuthLoginPoll,
  runAuthLoginStart,
  targetProfileName,
} from './auth-commands';
import {
  CURRENT_VERSION,
  type CredentialStore,
  getProfile,
  loadStore,
  saveStore,
  setProfile,
} from './credential-store';
import {
  emptyPending,
  getPending,
  loadPending,
  savePending,
  setPending,
} from './pending-store';

const profile = {
  base_url: 'https://developer-api.amplitude.com',
  credential: { type: 'pat' as const, pat: 'amp_x' },
  saved_at: '2026-06-23T12:00:00.000Z',
};

function storeWith(over: Partial<CredentialStore> = {}): CredentialStore {
  return { version: CURRENT_VERSION, profiles: {}, ...over };
}

describe('targetProfileName', () => {
  it('returns an explicit --profile after validating it', () => {
    expect(targetProfileName(storeWith(), 'prod')).toBe('prod');
  });

  it('rejects an invalid explicit --profile', () => {
    expect(() => targetProfileName(storeWith(), 'bad/name')).toThrow(
      /Invalid profile name/,
    );
  });

  it('falls back to the active pointer when --profile is omitted', () => {
    const store = storeWith({ default: 'prod', profiles: { prod: profile } });
    expect(targetProfileName(store, undefined)).toBe('prod');
  });

  it('falls back to "default" on a cold store (unset pointer)', () => {
    expect(targetProfileName(storeWith(), undefined)).toBe('default');
  });

  it('throws for an orphaned pointer (set but missing profile)', () => {
    const store = storeWith({ default: 'ghost' });
    expect(() => targetProfileName(store, undefined)).toThrow(
      /No such profile: ghost/,
    );
  });
});

function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'amp-start-'));
  return {
    path: join(dir, 'credentials.json'),
    pendingPath: join(dir, 'pending.json'),
  };
}

describe('runAuthLoginStart', () => {
  it('persists a pending entry and emits verification_required without secrets', async () => {
    const { path, pendingPath } = paths();
    const lines: string[] = [];
    await runAuthLoginStart(
      { region: 'us' },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: (l) => lines.push(l),
        request: async (method, p) => {
          expect(method).toBe('POST');
          expect(p).toBe('/v1/auth/device-authorization');
          return {
            status: 200,
            body: {
              device_code: 'DC',
              user_code: 'HZNK-QLIB',
              verification_uri: 'https://app.amplitude.com/device',
              verification_uri_complete:
                'https://app.amplitude.com/device?user_code=HZNK-QLIB',
              expires_in: 600,
              interval: 5,
            },
          };
        },
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('verification_required');
    expect(out.data.user_code).toBe('HZNK-QLIB');
    expect(out.data.profile).toBe('default');
    expect(out.data.region).toBe('us');
    // Proactively tells the agent the poll blocks (default) and is tunable.
    expect(out.message).toMatch(/blocks up to ~25s by default/);
    expect(out.message).toMatch(/--timeout/);
    expect(lines.join('\n')).not.toContain('DC'); // device_code withheld
    expect(getPending(loadPending(pendingPath), 'default')?.device_code).toBe(
      'DC',
    );
  });

  it('surfaces the server OAuth error on a non-2xx device-authorization response', async () => {
    const { path, pendingPath } = paths();
    const lines: string[] = [];
    await runAuthLoginStart(
      { region: 'us' },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: (l) => lines.push(l),
        request: async () => ({
          status: 400,
          body: {
            error: 'invalid_request',
            error_description: 'Unknown scope requested.',
          },
        }),
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('error');
    expect(out.error.error_code).toBe('invalid_request');
    expect(out.error.detail).toBe('Unknown scope requested.');
    expect(out.message).toContain('Unknown scope requested.');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('garbage-collects expired pending entries on start', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(emptyPending(), 'old', pendingEntry('2000-01-01T00:00:00Z')),
      pendingPath,
    );
    await runAuthLoginStart(
      { region: 'us' },
      {
        path,
        pendingPath,
        now: () => Date.parse('2026-07-15T00:00:00.000Z'),
        stdout: () => {},
        request: async () => ({
          status: 200,
          body: {
            device_code: 'DC',
            user_code: 'UC',
            verification_uri: 'https://app.amplitude.com/device',
            verification_uri_complete:
              'https://app.amplitude.com/device?user_code=UC',
            expires_in: 600,
            interval: 5,
          },
        }),
      },
    );
    expect(Object.keys(loadPending(pendingPath).pending)).toEqual(['default']);
  });

  it('mints a fresh code and notes it supersedes a still-live prior one', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    const lines: string[] = [];
    await runAuthLoginStart(
      { region: 'us' },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: (l) => lines.push(l),
        request: async () => ({
          status: 200,
          body: {
            device_code: 'DC2',
            user_code: 'NEW-CODE',
            verification_uri: 'https://app.amplitude.com/device',
            verification_uri_complete:
              'https://app.amplitude.com/device?user_code=NEW-CODE',
            expires_in: 600,
            interval: 5,
          },
        }),
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('verification_required');
    expect(out.message).toMatch(/replaces an earlier in-progress code/);
    expect(getPending(loadPending(pendingPath), 'default')?.device_code).toBe(
      'DC2',
    );
  });

  it('refuses to silently retarget an existing profile to a different region', async () => {
    const { path, pendingPath } = paths();
    const store: CredentialStore = storeWith({
      default: 'default',
      profiles: {
        default: {
          base_url: 'https://developer-api.eu.amplitude.com',
          credential: { type: 'pat', pat: 'amp_x' },
          saved_at: '2026-06-23T12:00:00.000Z',
        },
      },
    });
    saveStore(store, path);
    const lines: string[] = [];
    await runAuthLoginStart(
      { region: 'us' },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: (l) => lines.push(l),
        request: async () => {
          throw new Error('request should not be called');
        },
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('error');
    // Same usage-error contract as `auth pat`'s retarget refusal and start's
    // other invocation errors: usage_error / exit 2.
    expect(out.error.error_code).toBe('usage_error');
    expect(out.message).toContain('https://developer-api.eu.amplitude.com');
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    expect(Object.keys(loadPending(pendingPath).pending)).toEqual([]);
  });

  it('proceeds with a cross-region retarget when --force is set', async () => {
    const { path, pendingPath } = paths();
    const store: CredentialStore = storeWith({
      default: 'default',
      profiles: {
        default: {
          base_url: 'https://developer-api.eu.amplitude.com',
          credential: { type: 'pat', pat: 'amp_x' },
          saved_at: '2026-06-23T12:00:00.000Z',
        },
      },
    });
    saveStore(store, path);
    const lines: string[] = [];
    await runAuthLoginStart(
      { region: 'us', force: true },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: (l) => lines.push(l),
        request: async () => ({
          status: 200,
          body: {
            device_code: 'DC',
            user_code: 'UC',
            verification_uri: 'https://app.amplitude.com/device',
            verification_uri_complete:
              'https://app.amplitude.com/device?user_code=UC',
            expires_in: 600,
            interval: 5,
          },
        }),
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('verification_required');
  });

  it('pretty-prints the JSON envelope at a TTY', async () => {
    const { path, pendingPath } = paths();
    const lines: string[] = [];
    await runAuthLoginStart(
      { region: 'us' },
      {
        path,
        pendingPath,
        now: () => 0,
        isTTY: true,
        stdout: (l) => lines.push(l),
        request: async () => ({
          status: 200,
          body: {
            device_code: 'DC',
            user_code: 'UC',
            verification_uri: 'https://app.amplitude.com/device',
            verification_uri_complete:
              'https://app.amplitude.com/device?user_code=UC',
            expires_in: 600,
            interval: 5,
          },
        }),
      },
    );
    const out = lines.join('\n');
    expect(out).toContain('\n  "status"');
  });

  it('emits a clean unexpected_response envelope on a malformed 2xx device-authorization body', async () => {
    const { path, pendingPath } = paths();
    const lines: string[] = [];
    await runAuthLoginStart(
      { region: 'us' },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: (l) => lines.push(l),
        request: async () => ({
          status: 200,
          body: {}, // missing device_code/user_code/verification_uri/expires_in
        }),
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('error');
    expect(out.error.error_code).toBe('unexpected_response');
    expect(out.message).toBe(
      'The authorization server returned an unexpected device-authorization response.',
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(getPending(loadPending(pendingPath), 'default')).toBeUndefined();
  });

  it('emits a JSON error envelope (not a throw) on invalid input', async () => {
    const { path, pendingPath } = paths();
    const lines: string[] = [];
    // No --region on a cold store → loginBaseUrl throws a usage error; it must
    // surface as a JSON envelope that keeps the usage_error/exit-2
    // classification, not get flattened to start_failed/exit-1.
    await runAuthLoginStart(
      {},
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: (l) => lines.push(l),
        request: async () => ({ status: 200, body: {} }),
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('error');
    expect(out.error.error_code).toBe('usage_error');
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });
});

const pendingEntry = (expiresAt: string) => ({
  device_code: 'DC',
  code_verifier: 'CV',
  base_url: 'https://developer-api.amplitude.com',
  expires_at: expiresAt,
  interval: 5,
  started_at: '2026-07-15T00:00:00.000Z',
});

describe('resolvePollProfile', () => {
  it('auto-selects the sole pending login when --profile is omitted', () => {
    const pending = setPending(
      emptyPending(),
      'work',
      pendingEntry('2999-01-01T00:00:00Z'),
    );
    expect(
      resolvePollProfile(pending, undefined, undefined, Date.now()),
    ).toEqual({
      name: 'work',
    });
  });

  it('falls back to the store default when multiple logins are pending', () => {
    const pending = setPending(
      setPending(emptyPending(), 'work', pendingEntry('2999-01-01T00:00:00Z')),
      'personal',
      pendingEntry('2999-01-01T00:00:00Z'),
    );
    expect(
      resolvePollProfile(pending, undefined, 'personal', Date.now()),
    ).toEqual({
      name: 'personal',
    });
  });

  it('errors listing profiles when multiple logins are pending and none disambiguates', () => {
    const pending = setPending(
      setPending(emptyPending(), 'work', pendingEntry('2999-01-01T00:00:00Z')),
      'personal',
      pendingEntry('2999-01-01T00:00:00Z'),
    );
    const result = resolvePollProfile(
      pending,
      undefined,
      undefined,
      Date.now(),
    );
    expect('error' in result && result.error).toMatch(/work/);
    expect('error' in result && result.error).toMatch(/personal/);
    expect('error' in result && result.code).toBe('ambiguous_pending_login');
  });

  it('does not guess "default" over another live login when the active pointer is elsewhere', () => {
    const pending = setPending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      'work',
      pendingEntry('2999-01-01T00:00:00Z'),
    );
    const result = resolvePollProfile(pending, undefined, 'prod', Date.now());
    expect('error' in result && result.code).toBe('ambiguous_pending_login');
  });

  it('ignores expired entries so a stale sibling does not shadow the live login', () => {
    const pending = setPending(
      setPending(emptyPending(), 'stale', pendingEntry('2000-01-01T00:00:00Z')),
      'live',
      pendingEntry('2999-01-01T00:00:00Z'),
    );
    expect(
      resolvePollProfile(pending, undefined, undefined, Date.now()),
    ).toEqual({
      name: 'live',
    });
  });

  it('reports no login in progress when every pending entry is expired', () => {
    const pending = setPending(
      setPending(emptyPending(), 'a', pendingEntry('2000-01-01T00:00:00Z')),
      'b',
      pendingEntry('2000-01-01T00:00:00Z'),
    );
    const result = resolvePollProfile(
      pending,
      undefined,
      undefined,
      Date.now(),
    );
    expect('error' in result && result.error).toMatch(/No login in progress/);
    expect('error' in result && result.code).toBe('no_pending_login');
  });
});

describe('runAuthLoginPoll', () => {
  it('authorizes: writes+activates the profile and clears pending', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    const lines: string[] = [];
    await runAuthLoginPoll(
      { profile: 'default' },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: (l) => lines.push(l),
        request: async () => ({
          status: 200,
          body: { access_token: 'AT', token_type: 'bearer', expires_in: 3600 },
        }),
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('authorized');
    expect(out.data.profile).toBe('default');
    expect(out.data.region).toBe('us');
    const store = loadStore(path);
    expect(store.default).toBe('default');
    expect(getProfile(store, 'default')?.credential.type).toBe('oauth');
    expect(getPending(loadPending(pendingPath), 'default')).toBeUndefined();
  });

  it('authorizes with region derived from an EU pending base_url', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(emptyPending(), 'default', {
        ...pendingEntry('2999-01-01T00:00:00Z'),
        base_url: 'https://developer-api.eu.amplitude.com',
      }),
      pendingPath,
    );
    const lines: string[] = [];
    await runAuthLoginPoll(
      { profile: 'default' },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: (l) => lines.push(l),
        request: async () => ({
          status: 200,
          body: { access_token: 'AT', token_type: 'bearer', expires_in: 3600 },
        }),
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('authorized');
    expect(out.data.region).toBe('eu');
  });

  it('reports pending (exit 75) when not yet confirmed', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    const lines: string[] = [];
    process.exitCode = 0;
    await runAuthLoginPoll(
      { profile: 'default', timeout: '0' },
      {
        path,
        pendingPath,
        now: () => 0,
        sleep: async () => {},
        stdout: (l) => lines.push(l),
        request: async () => ({
          status: 400,
          body: { error: 'authorization_pending' },
        }),
      },
    );
    expect(JSON.parse(lines.join('\n')).status).toBe('pending');
    expect(process.exitCode).toBe(75);
    process.exitCode = 0;
  });

  it('errors when there is no pending login', async () => {
    const { path, pendingPath } = paths();
    const lines: string[] = [];
    await runAuthLoginPoll(
      { profile: 'default' },
      { path, pendingPath, now: () => 0, stdout: (l) => lines.push(l) },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('error');
    expect(out.error.error_code).toBe('no_pending_login');
    process.exitCode = 0;
  });

  it('surfaces ambiguous_pending_login when multiple logins are pending and none disambiguates', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        setPending(
          emptyPending(),
          'work',
          pendingEntry('2999-01-01T00:00:00Z'),
        ),
        'personal',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    const lines: string[] = [];
    await runAuthLoginPoll(
      {},
      { path, pendingPath, now: () => 0, stdout: (l) => lines.push(l) },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('error');
    expect(out.error.error_code).toBe('ambiguous_pending_login');
    process.exitCode = 0;
  });

  it('names --region eu in the restart hint for an EU pending entry', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(emptyPending(), 'default', {
        ...pendingEntry('2000-01-01T00:00:00Z'), // already expired
        base_url: 'https://developer-api.eu.amplitude.com',
      }),
      pendingPath,
    );
    const lines: string[] = [];
    await runAuthLoginPoll(
      { profile: 'default' },
      {
        path,
        pendingPath,
        now: () => Date.now(),
        stdout: (l) => lines.push(l),
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('expired');
    expect(out.message).toContain('--region eu');
    expect(out.message).not.toContain('--region us');
    process.exitCode = 0;
  });

  it('surfaces the server error_code on an OAuth-error outcome (access_denied)', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    const lines: string[] = [];
    await runAuthLoginPoll(
      { profile: 'default' },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: (l) => lines.push(l),
        request: async () => ({
          status: 400,
          body: {
            error: 'access_denied',
            error_description: 'The user denied the authorization request.',
          },
        }),
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('error');
    expect(out.error.error_code).toBe('access_denied');
    expect(out.error.detail).toBe('The user denied the authorization request.');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects a non-numeric --timeout with an invalid_timeout envelope', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    const lines: string[] = [];
    await runAuthLoginPoll(
      { profile: 'default', timeout: 'abc' },
      { path, pendingPath, now: () => 0, stdout: (l) => lines.push(l) },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('error');
    expect(out.error.error_code).toBe('invalid_timeout');
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it('preserves a thrown usage error (bare --profile) as usage_error/exit 2, not poll_failed', async () => {
    const { path, pendingPath } = paths();
    const lines: string[] = [];
    await runAuthLoginPoll(
      { profile: true },
      { path, pendingPath, now: () => 0, stdout: (l) => lines.push(l) },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('error');
    expect(out.error.error_code).toBe('usage_error');
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it('keeps the pending entry on a transient server_error (retryable)', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    let t = 0;
    const lines: string[] = [];
    process.exitCode = 0;
    await runAuthLoginPoll(
      { profile: 'default', timeout: '2' },
      {
        path,
        pendingPath,
        now: () => (t += 1000),
        sleep: async () => {},
        stdout: (l) => lines.push(l),
        request: async () => ({ status: 500, body: { error: 'server_error' } }),
      },
    );
    expect(JSON.parse(lines.join('\n')).status).toBe('pending');
    expect(getPending(loadPending(pendingPath), 'default')).toBeDefined();
    expect(process.exitCode).toBe(75);
    process.exitCode = 0;
  });

  it('notes the pending login is preserved and hints a retry on poll_failed', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    const lines: string[] = [];
    await runAuthLoginPoll(
      { profile: 'default' },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: (l) => lines.push(l),
        request: async () => {
          throw new Error('Could not reach the API');
        },
      },
    );
    const out = JSON.parse(lines.join('\n'));
    expect(out.status).toBe('error');
    expect(out.error.error_code).toBe('poll_failed');
    expect(out.message).toMatch(/re-run the poll command to retry/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(getPending(loadPending(pendingPath), 'default')).toBeDefined();
  });

  it('does not apply a slow_down interval to a concurrently-started fresh code', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    let t = 0;
    process.exitCode = 0;
    await runAuthLoginPoll(
      { profile: 'default', timeout: '5' },
      {
        path,
        pendingPath,
        now: () => (t += 1000),
        sleep: async () => {},
        stdout: () => {},
        request: async () => {
          // A concurrent `start` overwrites the entry with a fresh device_code
          // (interval 5) while this poll's request is in flight; the slow_down
          // below was raised against the old code and must not touch the fresh row.
          savePending(
            setPending(loadPending(pendingPath), 'default', {
              ...pendingEntry('2999-01-01T00:00:00Z'),
              device_code: 'FRESH',
            }),
            pendingPath,
          );
          return { status: 400, body: { error: 'slow_down' } };
        },
      },
    );
    const after = getPending(loadPending(pendingPath), 'default');
    expect(after?.device_code).toBe('FRESH');
    expect(after?.interval).toBe(5);
    process.exitCode = 0;
  });

  it('does not clear a pending entry a concurrent start superseded when erroring', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    process.exitCode = 0;
    await runAuthLoginPoll(
      { profile: 'default', timeout: '0' },
      {
        path,
        pendingPath,
        now: () => 0,
        sleep: async () => {},
        stdout: () => {},
        request: async () => {
          // A concurrent `start` mints a fresh code mid-flight; this slower
          // poll then errors and must not wipe the newer in-progress login.
          savePending(
            setPending(loadPending(pendingPath), 'default', {
              ...pendingEntry('2999-01-01T00:00:00Z'),
              device_code: 'FRESH',
            }),
            pendingPath,
          );
          return { status: 400, body: { error: 'access_denied' } };
        },
      },
    );
    expect(getPending(loadPending(pendingPath), 'default')?.device_code).toBe(
      'FRESH',
    );
    process.exitCode = 0;
  });

  it('clears the pending entry on authorize even if a concurrent start superseded it', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    await runAuthLoginPoll(
      { profile: 'default' },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: () => {},
        request: async () => {
          // A concurrent `start` mints a fresh code mid-flight; this poll then
          // authorizes. The profile is now authenticated, so the leftover code
          // must be cleared, not left to make later polls report `pending`.
          savePending(
            setPending(loadPending(pendingPath), 'default', {
              ...pendingEntry('2999-01-01T00:00:00Z'),
              device_code: 'FRESH',
            }),
            pendingPath,
          );
          return {
            status: 200,
            body: {
              access_token: 'AT',
              token_type: 'bearer',
              expires_in: 3600,
            },
          };
        },
      },
    );
    expect(getPending(loadPending(pendingPath), 'default')).toBeUndefined();
  });

  it('does not clobber a profile a concurrent auth wrote to the store mid-poll', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    await runAuthLoginPoll(
      { profile: 'default' },
      {
        path,
        pendingPath,
        now: () => 0,
        stdout: () => {},
        request: async () => {
          // A concurrent auth (e.g. another profile's poll, or an interactive
          // login) writes to the SAME store file while this poll is in
          // flight. The authorized save below must layer onto this, not a
          // stale pre-poll snapshot.
          saveStore(
            setProfile(loadStore(path), 'other', {
              base_url: 'https://concurrent.example.com',
              credential: { type: 'pat', pat: 'amp_other' },
              saved_at: '2026-06-23T12:00:00.000Z',
              store: 'file',
            }),
            path,
          );
          return {
            status: 200,
            body: {
              access_token: 'AT',
              token_type: 'bearer',
              expires_in: 3600,
            },
          };
        },
      },
    );
    expect(getProfile(loadStore(path), 'default')).toBeDefined();
    const other = getProfile(loadStore(path), 'other');
    expect(other).toBeDefined();
    expect(other?.base_url).toBe('https://concurrent.example.com');
  });

  it('persists a slow_down-raised interval for the next poll', async () => {
    const { path, pendingPath } = paths();
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('2999-01-01T00:00:00Z'),
      ),
      pendingPath,
    );
    let t = 0;
    process.exitCode = 0;
    await runAuthLoginPoll(
      { profile: 'default', timeout: '2' },
      {
        path,
        pendingPath,
        now: () => (t += 1000),
        sleep: async () => {},
        stdout: () => {},
        request: async () => ({ status: 400, body: { error: 'slow_down' } }),
      },
    );
    expect(
      getPending(loadPending(pendingPath), 'default')?.interval,
    ).toBeGreaterThan(5);
    process.exitCode = 0;
  });
});
