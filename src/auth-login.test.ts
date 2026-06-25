import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
} from './credential-store';
import type { TokenResponse } from './oauthResponseSchemas';

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

  it('errors creating a profile without --env/--base-url (force-explicit)', () => {
    expect(() => loginBaseUrl({})).toThrow(/requires --env|--base-url/);
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

  function deps(path: string, out: string[]) {
    return {
      path,
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

  it('errors when neither --profile nor a default profile exists', async () => {
    await expect(
      runAuthLogin({ env: 'prod' }, deps(tempPath(), [])),
    ).rejects.toThrow(/No default profile/);
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

  it('rejects the reserved name "default"', async () => {
    await expect(
      runAuthLogin({ profile: 'default', env: 'prod' }, deps(tempPath(), [])),
    ).rejects.toThrow(/reserved/);
  });

  it('rejects an invalid profile name', async () => {
    await expect(
      runAuthLogin({ profile: 'bad name', env: 'prod' }, deps(tempPath(), [])),
    ).rejects.toThrow(/Invalid profile name/);
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
      'mcp:read mcp:write read:flags read:projects read:taxonomy write:flags write:taxonomy',
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
});
