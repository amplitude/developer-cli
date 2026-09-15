import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliError } from './cli-error';
import {
  authorizationHeaderForToken,
  resolveAuth,
  resolveAuthFromFlags,
  resolveAuthWithRefresh,
} from './credential-resolver';
import {
  type CredentialStore,
  type OAuthCredential,
  CURRENT_VERSION,
  emptyStore,
  loadStore,
  saveStore,
  setDefault,
  setProfile,
} from './credential-store';
import * as tokenRefresh from './token-refresh';

const NOW = Date.parse('2026-06-23T12:00:00.000Z');
const FUTURE = '2026-06-24T12:00:00.000Z';
const PAST = '2026-06-22T12:00:00.000Z';

function oauthStore(
  name: string,
  baseUrl: string,
  expiresAt: string,
): CredentialStore {
  let store = setProfile(emptyStore(), name, {
    base_url: baseUrl,
    credential: {
      type: 'oauth',
      access_token: 'eyJ.jwt',
      token_type: 'Bearer',
      expires_at: expiresAt,
    },
    saved_at: '2026-06-23T00:00:00.000Z',
    store: 'file',
  });
  return setDefault(store, name);
}

describe('resolveAuth', () => {
  it('--token flag wins over everything', () => {
    const r = resolveAuth({
      tokenFlag: 'raw-flag',
      env: { AMP_TOKEN: 'env-token' },
      store: oauthStore('p', 'https://prod', FUTURE),
      now: NOW,
    });
    expect(r.token).toBe('raw-flag');
    expect(r.source).toBe('--token flag');
  });

  it('AMP_TOKEN is king over profile selection', () => {
    const r = resolveAuth({
      profileFlag: 'p',
      env: { AMP_TOKEN: 'env-token' },
      store: oauthStore('p', 'https://prod', FUTURE),
      now: NOW,
    });
    expect(r.token).toBe('env-token');
    expect(r.source).toBe('AMP_TOKEN env var');
  });

  it('--profile selects the named profile and its base_url', () => {
    const r = resolveAuth({
      profileFlag: 'p',
      env: {},
      store: oauthStore('p', 'https://staging', FUTURE),
      now: NOW,
    });
    expect(r.token).toBe('eyJ.jwt');
    expect(r.baseUrl).toBe('https://staging');
    expect(r.source).toBe('--profile p');
  });

  it('AMP_PROFILE selects when no --profile is given', () => {
    const r = resolveAuth({
      env: { AMP_PROFILE: 'p' },
      store: oauthStore('p', 'https://prod', FUTURE),
      now: NOW,
    });
    expect(r.source).toBe('AMP_PROFILE env (p)');
  });

  it('falls back to the default profile', () => {
    const r = resolveAuth({
      env: {},
      store: oauthStore('p', 'https://prod', FUTURE),
      now: NOW,
    });
    expect(r.source).toBe('default profile p');
  });

  it('--base-url overrides the profile base_url', () => {
    const r = resolveAuth({
      profileFlag: 'p',
      baseUrlFlag: 'http://localhost:3036',
      env: {},
      store: oauthStore('p', 'https://prod', FUTURE),
      now: NOW,
    });
    expect(r.baseUrl).toBe('http://localhost:3036');
    expect(r.profileBaseUrl).toBe('https://prod');
  });

  it('throws on an unknown profile', () => {
    expect(() =>
      resolveAuth({
        profileFlag: 'nope',
        env: {},
        store: emptyStore(),
        now: NOW,
      }),
    ).toThrow(/nope/);
  });

  it('throws a structured CliError with an auth hint on an unknown profile', () => {
    try {
      resolveAuth({
        profileFlag: 'nope',
        env: {},
        store: emptyStore(),
        now: NOW,
      });
      expect.unreachable('resolveAuth should have thrown');
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      expect(error.errorCode).toBe('authentication_required');
      expect(error.exitCode).toBe(3);
      expect(error.hint).toBeTruthy();
    }
  });

  it('throws when the selected oauth token has expired', () => {
    expect(() =>
      resolveAuth({
        env: {},
        store: oauthStore('p', 'https://prod', PAST),
        now: NOW,
      }),
    ).toThrow(/expired/i);
  });

  it('throws a structured CliError with an invalid_token code when the stored token has expired', () => {
    try {
      resolveAuth({
        env: {},
        store: oauthStore('p', 'https://prod', PAST),
        now: NOW,
      });
      expect.unreachable('resolveAuth should have thrown');
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      expect(error.errorCode).toBe('invalid_token');
      expect(error.exitCode).toBe(3);
      expect(error.hint).toBeTruthy();
    }
  });

  it('returns a PAT credential as its raw token', () => {
    let store = setProfile(emptyStore(), 'ci', {
      base_url: 'https://prod',
      credential: { type: 'pat', pat: 'amp_ci' },
      saved_at: '2026-06-23T00:00:00.000Z',
    });
    store = setDefault(store, 'ci');
    expect(resolveAuth({ env: {}, store, now: NOW }).token).toBe('amp_ci');
  });

  it('throws on an unsupported credential type', () => {
    let store = setProfile(emptyStore(), 'sa', {
      base_url: 'https://prod',
      credential: { type: 'service_account', client_id: 'c' },
      saved_at: '2026-06-23T00:00:00.000Z',
    });
    store = setDefault(store, 'sa');
    expect(() => resolveAuth({ env: {}, store, now: NOW })).toThrow(
      /unsupported credential type/i,
    );
  });

  it('throws a structured CliError with an invalid_token code for an unsupported credential type', () => {
    let store = setProfile(emptyStore(), 'sa', {
      base_url: 'https://prod',
      credential: { type: 'service_account', client_id: 'c' },
      saved_at: '2026-06-23T00:00:00.000Z',
    });
    store = setDefault(store, 'sa');
    try {
      resolveAuth({ env: {}, store, now: NOW });
      expect.unreachable('resolveAuth should have thrown');
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      expect(error.errorCode).toBe('invalid_token');
      expect(error.exitCode).toBe(3);
      expect(error.hint).toBeTruthy();
    }
  });

  it('errors with login guidance when the store is empty', () => {
    expect(() =>
      resolveAuth({ env: {}, store: emptyStore(), now: NOW }),
    ).toThrow(/No credentials\. Run `amp auth login`/);
  });

  it('throws a structured CliError with an authentication_required code when the store is empty', () => {
    try {
      resolveAuth({ env: {}, store: emptyStore(), now: NOW });
      expect.unreachable('resolveAuth should have thrown');
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      expect(error.errorCode).toBe('authentication_required');
      expect(error.exitCode).toBe(3);
      expect(error.hint).toBeTruthy();
    }
  });

  it('points to `auth use` when profiles exist but none is active', () => {
    // A profile exists, but no default (e.g. just after logging out the default).
    const store = setProfile(emptyStore(), 'p', {
      base_url: 'https://prod',
      credential: { type: 'pat', pat: 'amp_x' },
      saved_at: '2026-06-23T00:00:00.000Z',
    });
    expect(() => resolveAuth({ env: {}, store, now: NOW })).toThrow(
      /No active profile.*amp auth use/s,
    );
  });

  it('throws a structured CliError with an authentication_required code when no profile is active', () => {
    const store = setProfile(emptyStore(), 'p', {
      base_url: 'https://prod',
      credential: { type: 'pat', pat: 'amp_x' },
      saved_at: '2026-06-23T00:00:00.000Z',
    });
    try {
      resolveAuth({ env: {}, store, now: NOW });
      expect.unreachable('resolveAuth should have thrown');
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      expect(error.errorCode).toBe('authentication_required');
      expect(error.exitCode).toBe(3);
      expect(error.hint).toBeTruthy();
    }
  });

  it('raw-token path defaults base_url and honors AMP_API_BASE_URL', () => {
    expect(
      resolveAuth({ tokenFlag: 't', env: {}, store: emptyStore(), now: NOW })
        .baseUrl,
    ).toBe('https://developer-api.amplitude.com');
    expect(
      resolveAuth({
        tokenFlag: 't',
        env: { AMP_API_BASE_URL: 'https://dev.example.com/' },
        store: emptyStore(),
        now: NOW,
      }).baseUrl,
    ).toBe('https://dev.example.com');
  });
});

describe('resolveAuthFromFlags', () => {
  it('resolves --region into the base URL', () => {
    const r = resolveAuthFromFlags(
      { region: 'eu' },
      { store: oauthStore('p', 'https://prod', FUTURE), now: NOW },
    );
    expect(r.baseUrl).toBe('https://developer-api.eu.amplitude.com');
  });

  it('throws when both --region and --env are given', () => {
    expect(() =>
      resolveAuthFromFlags(
        { region: 'eu', env: 'staging' },
        { store: oauthStore('p', 'https://prod', FUTURE), now: NOW },
      ),
    ).toThrow('Pass either --region or --env, not both.');
  });

  it('throws when both --region and --env are given even though --base-url would win', () => {
    expect(() =>
      resolveAuthFromFlags(
        { region: 'us', env: 'staging', 'base-url': 'http://localhost:3036' },
        { store: oauthStore('p', 'https://prod', FUTURE), now: NOW },
      ),
    ).toThrow('Pass either --region or --env, not both.');
  });
});

describe('resolveAuthWithRefresh', () => {
  const dirs: string[] = [];
  const store = (
    cred: CredentialStore['profiles']['default']['credential'],
  ) => ({
    version: 1,
    default: 'default',
    profiles: {
      default: { base_url: 'https://api', credential: cred, saved_at: 'x' },
    },
  });
  const expiredOAuth = {
    type: 'oauth' as const,
    access_token: 'old',
    token_type: 'bearer',
    expires_at: new Date(NOW - 1000).toISOString(),
    refresh_token: 'rt',
  };

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function seed(cred: CredentialStore['profiles']['default']['credential']) {
    const dir = mkdtempSync(join(tmpdir(), 'amp-resolver-'));
    dirs.push(dir);
    const path = join(dir, 'credentials.json');
    saveStore(store(cred), path);
    return path;
  }

  function persistRefresh(
    path: string,
    credential: OAuthCredential,
    rotated: boolean,
  ) {
    return vi
      .spyOn(tokenRefresh, 'refreshProfileTokenLocked')
      .mockImplementation(async (params) => {
        if (params.path !== path) {
          throw new Error('refresh did not receive the temporary path');
        }
        const latest = loadStore(path);
        saveStore(
          setProfile(latest, 'default', {
            ...latest.profiles.default,
            credential,
            saved_at: new Date(NOW).toISOString(),
          }),
          path,
        );
        return { credential, rotated };
      });
  }

  it('refreshes an expired OAuth profile and returns the fresh token', async () => {
    const path = seed(expiredOAuth);
    const credential = {
      type: 'oauth' as const,
      access_token: 'fresh',
      token_type: 'bearer',
      expires_at: new Date(NOW + 3600_000).toISOString(),
      refresh_token: 'rt2',
    };
    persistRefresh(path, credential, true);

    const auth = await resolveAuthWithRefresh({}, { path, now: NOW });

    expect(auth.token).toBe('fresh');
    expect(auth.refreshed).toBe(true);
    expect(loadStore(path).profiles.default.credential).toEqual(credential);
  });

  it('reports refreshed=false when it only adopted a peer refresh', async () => {
    const path = seed(expiredOAuth);
    persistRefresh(
      path,
      {
        type: 'oauth',
        access_token: 'peer',
        token_type: 'bearer',
        expires_at: new Date(NOW + 3600_000).toISOString(),
        refresh_token: 'rt',
      },
      false,
    );

    const auth = await resolveAuthWithRefresh({}, { path, now: NOW });

    // No rotation of ours, so runOperation's reactive 401 net must still fire.
    expect(auth.token).toBe('peer');
    expect(auth.refreshed).toBe(false);
  });

  it('keeps a newly selected default profile eligible for reactive refresh', async () => {
    const path = seed(expiredOAuth);
    const otherCredential = {
      type: 'oauth' as const,
      access_token: 'other',
      token_type: 'bearer',
      expires_at: new Date(NOW + 3600_000).toISOString(),
      refresh_token: 'other-rt',
    };
    const latest = loadStore(path);
    saveStore(
      setProfile(latest, 'other', {
        base_url: 'https://other-api',
        credential: otherCredential,
        saved_at: new Date(NOW).toISOString(),
      }),
      path,
    );

    vi.spyOn(tokenRefresh, 'refreshProfileTokenLocked').mockImplementation(
      async () => {
        saveStore(setDefault(loadStore(path), 'other'), path);
        return {
          credential: {
            type: 'oauth',
            access_token: 'fresh-default',
            token_type: 'bearer',
            expires_at: new Date(NOW + 3600_000).toISOString(),
            refresh_token: 'fresh-default-rt',
          },
          rotated: true,
        };
      },
    );

    const auth = await resolveAuthWithRefresh({}, { path, now: NOW });

    expect(auth.profile).toBe('other');
    expect(auth.token).toBe('other');
    expect(auth.refreshable).toBe(true);
    expect(auth.refreshed).toBe(false);
  });

  it('does not refresh when the token is still valid', async () => {
    const spy = vi.spyOn(tokenRefresh, 'refreshProfileTokenLocked');
    const valid = {
      ...expiredOAuth,
      access_token: 'ok',
      expires_at: new Date(NOW + 3600_000).toISOString(),
    };
    const path = seed(valid);
    const auth = await resolveAuthWithRefresh({}, { path, now: NOW });
    expect(spy).not.toHaveBeenCalled();
    expect(auth.token).toBe('ok');
  });

  it('falls through to the expiry error when there is no refresh token', async () => {
    const noRt = { ...expiredOAuth, refresh_token: undefined };
    const path = seed(noRt);
    await expect(
      resolveAuthWithRefresh({}, { path, now: NOW }),
    ).rejects.toMatchObject({ errorCode: 'invalid_token' });
  });
});

describe('authorizationHeaderForToken', () => {
  it('formats by token shape', () => {
    expect(authorizationHeaderForToken('amp_x')).toBe('Bearer PAT=amp_x');
    expect(authorizationHeaderForToken('PAT=amp_x')).toBe('Bearer PAT=amp_x');
    expect(authorizationHeaderForToken('Bearer abc')).toBe('Bearer abc');
    expect(authorizationHeaderForToken('eyJ.jwt')).toBe('Bearer eyJ.jwt');
  });
});

it('exposes CURRENT_VERSION for callers', () => {
  expect(CURRENT_VERSION).toBe(1);
});
