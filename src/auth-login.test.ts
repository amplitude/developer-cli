import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { lock as properLock } from 'proper-lockfile';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loginBaseUrl,
  oauthCredentialFromToken,
  runAuthLogin,
} from './auth-commands';
import {
  CURRENT_VERSION,
  getProfile,
  loadStore,
  saveStore,
  setProfile,
} from './credential-store';
import type { TokenResponse } from './oauthResponseSchemas';
import {
  getPending,
  loadPending,
  savePending,
  setPending,
} from './pending-store';

const NOW = Date.parse('2026-06-23T12:00:00.000Z');

const TOKEN: TokenResponse = {
  access_token: 'eyJ.jwt',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'refresh_x',
  scope: 'read:projects',
};

describe('oauthCredentialFromToken', () => {
  it('computes expires_at from expires_in and carries optional fields', () => {
    expect(oauthCredentialFromToken(TOKEN, NOW)).toEqual({
      type: 'oauth',
      access_token: 'eyJ.jwt',
      token_type: 'Bearer',
      expires_at: '2026-06-23T13:00:00.000Z',
      refresh_token: 'refresh_x',
      scope: 'read:projects',
    });
  });
});

describe('loginBaseUrl', () => {
  it('prefers --base-url (trailing slash trimmed)', () => {
    expect(loginBaseUrl({ baseUrlFlag: 'http://localhost:3036/' })).toBe(
      'http://localhost:3036',
    );
  });

  it('maps --env', () => {
    expect(loginBaseUrl({ envFlag: 'staging' })).toBe(
      'https://developer-api.stag2.amplitude.com',
    );
  });

  it('maps --region', () => {
    expect(loginBaseUrl({ regionFlag: 'us' })).toBe(
      'https://developer-api.amplitude.com',
    );
  });

  it('throws when both --region and --env are given', () => {
    expect(() =>
      loginBaseUrl({ regionFlag: 'us', envFlag: 'staging' }),
    ).toThrow('Pass either --region or --env, not both.');
  });

  it('throws when both --region and --env are given even though --base-url would win', () => {
    expect(() =>
      loginBaseUrl({
        regionFlag: 'us',
        envFlag: 'staging',
        baseUrlFlag: 'http://localhost:3036',
      }),
    ).toThrow('Pass either --region or --env, not both.');
  });

  it('reuses an existing profile base_url on re-auth', () => {
    expect(
      loginBaseUrl({
        existing: {
          base_url: 'https://prod',
          credential: { type: 'pat', pat: 'amp_x' },
          saved_at: 'x',
        },
      }),
    ).toBe('https://prod');
  });

  it('errors creating a profile without --region (hidden --env/--base-url stay out of the message)', () => {
    expect(() => loginBaseUrl({})).toThrow(/requires --region <us\|eu>/);
    try {
      loginBaseUrl({});
    } catch (error) {
      const message = String(error);
      expect(message).not.toContain('--env');
      expect(message).not.toContain('--base-url');
    }
  });

  it('errors on an unknown --env', () => {
    expect(() => loginBaseUrl({ envFlag: 'nope' })).toThrow(/Unknown --env/);
  });
});

describe('runAuthLogin', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    dirs.length = 0;
  });

  function tempPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'amp-login-'));
    dirs.push(dir);
    return join(dir, 'credentials.json');
  }

  function pendingPathFor(path: string): string {
    return join(dirname(path), 'pending.json');
  }

  function deps(path: string, out: string[]) {
    return {
      path,
      pendingPath: pendingPathFor(path),
      now: () => NOW,
      stdout: (line: string) => out.push(line),
      stderr: () => {},
      requestToken: () => Promise.resolve(TOKEN),
      confirm: () => Promise.resolve(true),
    };
  }

  it('creates a profile, activates it, and saves the oauth credential', async () => {
    const path = tempPath();
    const out: string[] = [];
    await runAuthLogin({ profile: 'amplitude', env: 'prod' }, deps(path, out));

    const store = loadStore(path);
    expect(store.default).toBe('amplitude');
    expect(getProfile(store, 'amplitude')?.base_url).toBe(
      'https://developer-api.amplitude.com',
    );
    expect(getProfile(store, 'amplitude')?.credential.type).toBe('oauth');
    expect(out.join('\n')).toMatch(/created and set as default/);
  });

  it('gives actionable guidance when a completed sign-in cannot be saved', async () => {
    const path = tempPath();
    let retries: unknown;
    const lock = vi.fn<typeof properLock>(async (_path, options) => {
      retries = options?.retries;
      throw new Error('ELOCKED');
    });

    await expect(
      runAuthLogin(
        { profile: 'amplitude', env: 'prod' },
        { ...deps(path, []), lock },
      ),
    ).rejects.toMatchObject({
      errorCode: 'authentication_required',
      message:
        'Sign-in succeeded, but the session could not be saved. Run `amp auth login` again.',
    });
    expect(retries).toMatchObject({ retries: 51 });
  });

  it('uses the same guidance when writing a completed sign-in fails', async () => {
    const path = tempPath();
    const save = vi.fn(() => {
      throw new Error('ENOSPC: raw filesystem detail');
    });

    await expect(
      runAuthLogin(
        { profile: 'amplitude', env: 'prod' },
        { ...deps(path, []), save },
      ),
    ).rejects.toMatchObject({
      errorCode: 'authentication_required',
      message:
        'Sign-in succeeded, but the session could not be saved. Check available disk space and file permissions, then run `amp auth login` again.',
    });
  });

  it('re-reads before saving so a concurrent write during the device flow survives', async () => {
    const path = tempPath();
    const out: string[] = [];
    const withConcurrentWrite = {
      ...deps(path, out),
      // Simulate a transparent refresh persisting a different profile while the
      // device flow is awaiting the user.
      requestToken: () => {
        saveStore(
          setProfile(loadStore(path), 'other', {
            base_url: 'https://api',
            credential: {
              type: 'oauth',
              token_type: 'Bearer',
              access_token: 'refreshed',
              expires_at: '2099-01-01T00:00:00.000Z',
            },
            saved_at: 'y',
          }),
          path,
        );
        return Promise.resolve(TOKEN);
      },
    };
    await runAuthLogin(
      { profile: 'amplitude', env: 'prod' },
      withConcurrentWrite,
    );

    const store = loadStore(path);
    expect(getProfile(store, 'amplitude')?.credential.type).toBe('oauth');
    // The concurrent refresh survives rather than being clobbered.
    expect(getProfile(store, 'other')?.credential).toMatchObject({
      access_token: 'refreshed',
    });
  });

  it('repoints the default and announces the previous one', async () => {
    const path = tempPath();
    const out: string[] = [];
    await runAuthLogin({ profile: 'amplitude', env: 'prod' }, deps(path, out));
    out.length = 0;
    await runAuthLogin({ profile: 'staging', env: 'staging' }, deps(path, out));

    expect(loadStore(path).default).toBe('staging');
    expect(out.join('\n')).toMatch(/set as default \(was "amplitude"\)/);
  });

  it('re-auths the default in place when --profile is omitted', async () => {
    const path = tempPath();
    const out: string[] = [];
    await runAuthLogin({ profile: 'amplitude', env: 'prod' }, deps(path, out));
    out.length = 0;

    // Bare login: no --profile, no --env — refreshes the active profile.
    await runAuthLogin({}, deps(path, out));

    const store = loadStore(path);
    expect(store.default).toBe('amplitude');
    expect(getProfile(store, 'amplitude')?.base_url).toBe(
      'https://developer-api.amplitude.com',
    );
    expect(out.join('\n')).toMatch(/updated and set as default\./);
  });

  it('creates the implicit "default" profile when --profile is omitted', async () => {
    const path = tempPath();
    const out: string[] = [];
    await runAuthLogin({ env: 'prod' }, deps(path, out));

    const store = loadStore(path);
    expect(store.default).toBe('default');
    expect(getProfile(store, 'default')?.base_url).toBe(
      'https://developer-api.amplitude.com',
    );
    expect(out.join('\n')).toMatch(/created and set as default/);
  });

  it('errors asking for --region on a cold bare login', async () => {
    await expect(runAuthLogin({}, deps(tempPath(), []))).rejects.toThrow(
      /requires --region/,
    );
  });

  it('errors with "No such profile" when the stored default is orphaned', async () => {
    // A hand-edited file whose `default` names a profile that isn't present.
    const path = tempPath();
    saveStore(
      { version: CURRENT_VERSION, default: 'ghost', profiles: {} },
      path,
    );

    // Bare login (no --profile) should match the resolver's wording, not fall
    // into loginBaseUrl's "creating a profile requires --env".
    await expect(runAuthLogin({}, deps(path, []))).rejects.toThrow(
      /No such profile: ghost/,
    );
  });

  it('accepts an explicit --profile default', async () => {
    const path = tempPath();
    const out: string[] = [];
    await runAuthLogin({ profile: 'default', env: 'prod' }, deps(path, out));
    expect(loadStore(path).default).toBe('default');
    expect(out.join('\n')).toMatch(/created and set as default/);
  });

  it('rejects an invalid profile name', async () => {
    await expect(
      runAuthLogin({ profile: 'bad name', env: 'prod' }, deps(tempPath(), [])),
    ).rejects.toThrow(/Invalid profile name/);
  });

  it('announces the region when --region is used', async () => {
    const path = tempPath();
    const out: string[] = [];
    await runAuthLogin({ profile: 'amplitude', region: 'us' }, deps(path, out));
    expect(out.join('\n')).toContain(
      'Authenticating to https://app.amplitude.com/',
    );
  });

  it('does not announce a region when --env is used', async () => {
    const path = tempPath();
    const out: string[] = [];
    await runAuthLogin({ profile: 'amplitude', env: 'prod' }, deps(path, out));
    expect(out.join('\n')).not.toContain('Authenticating to');
  });

  it('does not announce a region when --base-url wins over --region', async () => {
    const path = tempPath();
    const out: string[] = [];
    await runAuthLogin(
      {
        profile: 'amplitude',
        region: 'us',
        'base-url': 'http://localhost:3036',
      },
      deps(path, out),
    );
    expect(out.join('\n')).not.toContain('Authenticating to');
    expect(getProfile(loadStore(path), 'amplitude')?.base_url).toBe(
      'http://localhost:3036',
    );
  });

  it('aborts a re-login to a different target when not confirmed', async () => {
    const path = tempPath();
    await runAuthLogin({ profile: 'p', env: 'prod' }, deps(path, []));

    await expect(
      runAuthLogin(
        { profile: 'p', env: 'staging' },
        { ...deps(path, []), confirm: () => Promise.resolve(false) },
      ),
    ).rejects.toThrow(/Aborted/);
    // unchanged
    expect(loadStore(path).profiles.p?.base_url).toBe(
      'https://developer-api.amplitude.com',
    );
  });

  it('skips the overwrite confirm and retargets when --force is passed', async () => {
    const path = tempPath();
    await runAuthLogin({ profile: 'p', env: 'prod' }, deps(path, []));

    await runAuthLogin(
      { profile: 'p', env: 'staging', force: true },
      {
        ...deps(path, []),
        confirm: () => {
          throw new Error('confirm must not be called when --force is passed');
        },
      },
    );

    expect(loadStore(path).profiles.p?.base_url).toBe(
      'https://developer-api.stag2.amplitude.com',
    );
  });

  it('requests the full default scope set when --scope is absent', async () => {
    const path = tempPath();
    const scopes: Array<string | undefined> = [];
    const capturing = {
      ...deps(path, []),
      requestToken: (options: { scope?: string }) => {
        scopes.push(options.scope);
        return Promise.resolve(TOKEN);
      },
    };

    await runAuthLogin({ profile: 'amplitude', env: 'prod' }, capturing);
    expect(scopes[0]).toBe(
      'analytics:read destinations:read destinations:write flags:read flags:write mcp:read mcp:write offline_access openid projects:read taxonomy:read taxonomy:write',
    );
  });

  it('forwards an explicit --scope verbatim', async () => {
    const path = tempPath();
    const scopes: Array<string | undefined> = [];
    const capturing = {
      ...deps(path, []),
      requestToken: (options: { scope?: string }) => {
        scopes.push(options.scope);
        return Promise.resolve(TOKEN);
      },
    };

    await runAuthLogin(
      { profile: 'amplitude', env: 'prod', scope: 'read:projects' },
      capturing,
    );
    expect(scopes[0]).toBe('read:projects');
  });

  it('clears a stranded login-start entry for the profile it authenticates', async () => {
    const path = tempPath();
    const pendingPath = pendingPathFor(path);
    savePending(
      setPending(loadPending(pendingPath), 'amplitude', {
        device_code: 'abandoned',
        base_url: 'https://developer-api.amplitude.com',
        expires_at: new Date(NOW + 600_000).toISOString(),
        interval: 5,
        started_at: new Date(NOW).toISOString(),
      }),
      pendingPath,
    );

    await runAuthLogin({ profile: 'amplitude', env: 'prod' }, deps(path, []));

    expect(getPending(loadPending(pendingPath), 'amplitude')).toBeUndefined();
  });

  it('leaves another profile’s pending login untouched', async () => {
    const path = tempPath();
    const pendingPath = pendingPathFor(path);
    savePending(
      setPending(loadPending(pendingPath), 'other', {
        device_code: 'other-code',
        base_url: 'https://developer-api.amplitude.com',
        expires_at: new Date(NOW + 600_000).toISOString(),
        interval: 5,
        started_at: new Date(NOW).toISOString(),
      }),
      pendingPath,
    );

    await runAuthLogin({ profile: 'amplitude', env: 'prod' }, deps(path, []));

    expect(getPending(loadPending(pendingPath), 'other')?.device_code).toBe(
      'other-code',
    );
  });
});
