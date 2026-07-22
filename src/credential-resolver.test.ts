import { describe, expect, it } from 'vitest';

import {
  authorizationHeaderForToken,
  resolveAuth,
  resolveAuthFromFlags,
} from './credential-resolver';
import {
  type CredentialStore,
  CURRENT_VERSION,
  emptyStore,
  setDefault,
  setProfile,
} from './credential-store';

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

  it('throws when the selected oauth token has expired', () => {
    expect(() =>
      resolveAuth({
        env: {},
        store: oauthStore('p', 'https://prod', PAST),
        now: NOW,
      }),
    ).toThrow(/expired/i);
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

  it('errors with login guidance when the store is empty', () => {
    expect(() =>
      resolveAuth({ env: {}, store: emptyStore(), now: NOW }),
    ).toThrow(/No credentials\. Run `amp auth login`/);
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
