import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  envLabel,
  expiryLabel,
  formatProfileList,
  logoutAllGateDecision,
  maskToken,
  regionLabelForBaseUrl,
  runAuthStatus,
  runAuthToken,
  runAuthUse,
  runLogout,
} from './auth-commands';
import {
  type CredentialStore,
  CURRENT_VERSION,
  emptyStore,
  loadStore,
  saveStore,
  setDefault,
  setProfile,
} from './credential-store';
import {
  emptyPending,
  getPending,
  loadPending,
  savePending,
  setPending,
} from './pending-store';

const NOW = Date.parse('2026-06-23T12:00:00.000Z');

const pendingEntry = (baseUrl: string) => ({
  device_code: 'DC',
  code_verifier: 'CV',
  base_url: baseUrl,
  expires_at: '2999-01-01T00:00:00Z',
  interval: 5,
  started_at: '2026-07-15T00:00:00.000Z',
});

function oauthProfile(baseUrl: string, expiresAt: string) {
  return {
    base_url: baseUrl,
    credential: {
      type: 'oauth' as const,
      access_token: 'eyJ.jwt',
      token_type: 'Bearer',
      expires_at: expiresAt,
    },
    saved_at: '2026-06-23T00:00:00.000Z',
    store: 'file',
  };
}

describe('envLabel', () => {
  it('reverses a known base_url to its env name', () => {
    expect(envLabel('https://developer-api.amplitude.com')).toBe('prod');
    expect(envLabel('http://localhost:3036')).toBe('local');
  });

  it('falls back to the raw base_url when unknown', () => {
    expect(envLabel('https://custom.example.com')).toBe(
      'https://custom.example.com',
    );
  });
});

describe('regionLabelForBaseUrl', () => {
  it('labels prod as US and prod-eu as EU', () => {
    expect(regionLabelForBaseUrl('https://developer-api.amplitude.com')).toBe(
      'US',
    );
    expect(
      regionLabelForBaseUrl('https://developer-api.eu.amplitude.com'),
    ).toBe('EU');
  });

  it('returns undefined for internal envs', () => {
    expect(regionLabelForBaseUrl('http://localhost:3036')).toBeUndefined();
    expect(
      regionLabelForBaseUrl('https://developer-api.stag2.amplitude.com'),
    ).toBeUndefined();
  });
});

describe('expiryLabel', () => {
  it('reports a relative time for a valid oauth token', () => {
    expect(
      expiryLabel(
        oauthProfile('x', '2026-06-23T14:05:00.000Z').credential,
        NOW,
      ),
    ).toBe('in 2h 5m');
  });

  it('reports expired for a past oauth token', () => {
    expect(
      expiryLabel(
        oauthProfile('x', '2026-06-23T11:00:00.000Z').credential,
        NOW,
      ),
    ).toBe('expired');
  });

  it('returns — for a non-oauth credential', () => {
    expect(expiryLabel({ type: 'pat', pat: 'amp_x' }, NOW)).toBe('—');
  });
});

describe('formatProfileList', () => {
  it('marks the default with * and masks secrets', () => {
    let store = setProfile(
      emptyStore(),
      'amplitude',
      oauthProfile(
        'https://developer-api.amplitude.com',
        '2026-06-23T21:14:00.000Z',
      ),
    );
    store = setProfile(
      store,
      'staging',
      oauthProfile(
        'https://developer-api.stag2.amplitude.com',
        '2026-06-23T22:02:00.000Z',
      ),
    );
    store = setDefault(store, 'staging');

    const out = formatProfileList(store, NOW);
    const lines = out.split('\n');

    // Header row, then a * on the default and a space on the rest.
    expect(lines[0]).toMatch(/PROFILE\s+TYPE\s+ENV\s+EXPIRES/);
    expect(out).toMatch(/\* staging\s+oauth\s+staging/);
    expect(out).toMatch(/ {2}amplitude\s+oauth\s+prod/);
    expect(out).not.toContain('eyJ.jwt');

    // Columns align: the `oauth` type cell starts at the same index on every
    // data row (proves padding, not just single-space joins).
    const typeAt = lines.map((l) => l.indexOf('oauth')).filter((i) => i >= 0);
    expect(new Set(typeAt).size).toBe(1);
  });

  it('guides login when empty', () => {
    expect(formatProfileList(emptyStore(), NOW)).toMatch(/amp auth login/);
  });
});

describe('runAuthUse', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    dirs.length = 0;
  });

  function seeded(): { path: string; store: CredentialStore } {
    const dir = mkdtempSync(join(tmpdir(), 'amp-use-'));
    dirs.push(dir);
    const path = join(dir, 'credentials.json');
    let store: CredentialStore = setProfile(
      emptyStore(),
      'amplitude',
      oauthProfile(
        'https://developer-api.amplitude.com',
        '2026-06-24T00:00:00.000Z',
      ),
    );
    store = setProfile(
      store,
      'staging',
      oauthProfile(
        'https://developer-api.stag2.amplitude.com',
        '2026-06-24T00:00:00.000Z',
      ),
    );
    store = setDefault(store, 'amplitude');
    saveStore(store, path);
    return { path, store };
  }

  it('repoints the default and announces the previous one', () => {
    const { path } = seeded();
    const out: string[] = [];
    runAuthUse('staging', { path, stdout: (l) => out.push(l) });

    expect(loadStore(path).default).toBe('staging');
    expect(out.join('\n')).toMatch(/now "staging" \(was "amplitude"\)/);
  });

  it('throws listing known profiles on an unknown name', () => {
    const { path } = seeded();
    expect(() => runAuthUse('nope', { path })).toThrow(
      /Known: amplitude, staging/,
    );
  });

  it('requires a name', () => {
    expect(() => runAuthUse(undefined, { path: seeded().path })).toThrow(
      /requires a profile name/,
    );
  });
});

describe('logoutAllGateDecision', () => {
  it('proceeds when --yes is set', () => {
    expect(logoutAllGateDecision({ isTTY: false, yes: true })).toBe('proceed');
  });

  it('confirms interactively when no bypass is given in a TTY', () => {
    expect(logoutAllGateDecision({ isTTY: true, yes: false })).toBe('confirm');
  });

  it('blocks in a non-interactive shell without --yes', () => {
    expect(logoutAllGateDecision({ isTTY: false, yes: false })).toBe('block');
  });
});

describe('runLogout', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    dirs.length = 0;
  });

  function seeded(): string {
    const dir = mkdtempSync(join(tmpdir(), 'amp-logout-'));
    dirs.push(dir);
    const path = join(dir, 'credentials.json');
    let store: CredentialStore = setProfile(
      emptyStore(),
      'amplitude',
      oauthProfile(
        'https://developer-api.amplitude.com',
        '2026-06-24T00:00:00.000Z',
      ),
    );
    store = setProfile(
      store,
      'staging',
      oauthProfile(
        'https://developer-api.stag2.amplitude.com',
        '2026-06-24T00:00:00.000Z',
      ),
    );
    store = setDefault(store, 'amplitude');
    saveStore(store, path);
    return path;
  }

  it('removes a non-default profile and leaves the default untouched', async () => {
    const path = seeded();
    const out: string[] = [];
    await runLogout(
      { profile: 'staging' },
      { path, stdout: (l) => out.push(l) },
    );

    const after = loadStore(path);
    expect(after.profiles.staging).toBeUndefined();
    expect(after.default).toBe('amplitude');
    expect(out.join('\n')).toMatch(/Logged out of "staging"\./);
  });

  it('clears the default (never auto-promotes) when logging out the default', async () => {
    const path = seeded();
    const out: string[] = [];
    await runLogout({}, { path, stdout: (l) => out.push(l) });

    const after = loadStore(path);
    expect(after.profiles.amplitude).toBeUndefined();
    expect(after.default).toBeUndefined();
    expect(after.profiles.staging).toBeDefined();
    expect(out.join('\n')).toMatch(/No default set/);
  });

  it('errors with known names on an unknown target', async () => {
    const path = seeded();
    await expect(runLogout({ profile: 'nope' }, { path })).rejects.toThrow(
      /Known: amplitude, staging/,
    );
  });

  it('errors when there is nothing to log out of', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amp-logout-empty-'));
    dirs.push(dir);
    const path = join(dir, 'credentials.json');
    saveStore(emptyStore(), path);
    await expect(runLogout({}, { path })).rejects.toThrow(
      /No profile to log out of/,
    );
  });

  it('--all --yes wipes every profile and clears the default', async () => {
    const path = seeded();
    const out: string[] = [];
    await runLogout(
      { all: true, yes: true },
      { path, stdout: (l) => out.push(l), isTTY: false },
    );

    const after = loadStore(path);
    expect(Object.keys(after.profiles)).toEqual([]);
    expect(after.default).toBeUndefined();
    expect(out.join('\n')).toMatch(/Removed all 2 profiles/);
  });

  it('--all on an empty store is a no-op message, not an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amp-logout-all-empty-'));
    dirs.push(dir);
    const path = join(dir, 'credentials.json');
    saveStore(emptyStore(), path);
    const out: string[] = [];
    await runLogout({ all: true }, { path, stdout: (l) => out.push(l) });
    expect(out.join('\n')).toMatch(/No profiles to remove/);
  });

  it('blocks --all without --yes in a non-interactive shell', async () => {
    const path = seeded();
    await expect(
      runLogout({ all: true }, { path, isTTY: false }),
    ).rejects.toThrow(/Pass --yes to remove every stored profile/);
    expect(Object.keys(loadStore(path).profiles)).toEqual([
      'amplitude',
      'staging',
    ]);
  });

  it('aborts --all when confirmation is declined', async () => {
    const path = seeded();
    await expect(
      runLogout(
        { all: true },
        {
          path,
          isTTY: true,
          confirm: () => Promise.resolve(false),
        },
      ),
    ).rejects.toThrow(/Aborted/);
    expect(Object.keys(loadStore(path).profiles)).toEqual([
      'amplitude',
      'staging',
    ]);
  });

  it('wipes every profile when confirmation is approved', async () => {
    const path = seeded();
    const out: string[] = [];
    await runLogout(
      { all: true },
      {
        path,
        isTTY: true,
        confirm: () => Promise.resolve(true),
        stdout: (l) => out.push(l),
      },
    );

    const after = loadStore(path);
    expect(Object.keys(after.profiles)).toEqual([]);
    expect(out.join('\n')).toMatch(/Removed all 2 profiles/);
  });

  it('rejects --all combined with --profile', async () => {
    await expect(
      runLogout({ all: true, profile: 'staging' }, { path: seeded() }),
    ).rejects.toThrow(/not both/);
  });

  it('clears the pending login for the profile being logged out', async () => {
    const path = seeded();
    const pendingPath = join(dirname(path), 'pending.json');
    savePending(
      setPending(
        setPending(
          emptyPending(),
          'staging',
          pendingEntry('https://developer-api.stag2.amplitude.com'),
        ),
        'amplitude',
        pendingEntry('https://developer-api.amplitude.com'),
      ),
      pendingPath,
    );
    await runLogout(
      { profile: 'staging' },
      { path, pendingPath, stdout: () => {} },
    );
    const after = loadPending(pendingPath);
    expect(after.pending.staging).toBeUndefined();
    expect(after.pending.amplitude).toBeDefined();
  });

  it('--all clears every pending login alongside the profiles', async () => {
    const path = seeded();
    const pendingPath = join(dirname(path), 'pending.json');
    savePending(
      setPending(
        emptyPending(),
        'amplitude',
        pendingEntry('https://developer-api.amplitude.com'),
      ),
      pendingPath,
    );
    await runLogout(
      { all: true, yes: true },
      { path, pendingPath, isTTY: false, stdout: () => {} },
    );
    expect(Object.keys(loadPending(pendingPath).pending)).toEqual([]);
  });

  it('cancels a pending login for a profile with no stored credential yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amp-logout-pending-cancel-'));
    dirs.push(dir);
    const path = join(dir, 'credentials.json');
    const pendingPath = join(dir, 'pending.json');
    saveStore(emptyStore(), path);
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('https://developer-api.amplitude.com'),
      ),
      pendingPath,
    );
    const out: string[] = [];
    await runLogout(
      { profile: 'default' },
      { path, pendingPath, stdout: (l) => out.push(l) },
    );
    expect(getPending(loadPending(pendingPath), 'default')).toBeUndefined();
    expect(out.join('\n')).toMatch(/Canceled the in-progress login/);
  });

  it('bare logout cancels a solitary in-progress login with no default set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amp-logout-bare-pending-'));
    dirs.push(dir);
    const path = join(dir, 'credentials.json');
    const pendingPath = join(dir, 'pending.json');
    // Cold `login start`: a pending entry exists but store.default is unset.
    saveStore(emptyStore(), path);
    savePending(
      setPending(
        emptyPending(),
        'default',
        pendingEntry('https://developer-api.amplitude.com'),
      ),
      pendingPath,
    );
    const out: string[] = [];
    await runLogout({}, { path, pendingPath, stdout: (l) => out.push(l) });
    expect(getPending(loadPending(pendingPath), 'default')).toBeUndefined();
    expect(out.join('\n')).toMatch(/Canceled the in-progress login/);
  });

  it('bare logout selects the sole live login, ignoring an expired sibling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amp-logout-live-plus-expired-'));
    dirs.push(dir);
    const path = join(dir, 'credentials.json');
    const pendingPath = join(dir, 'pending.json');
    saveStore(emptyStore(), path);
    let store = emptyPending();
    store = setPending(
      store,
      'live',
      pendingEntry('https://developer-api.amplitude.com'),
    );
    store = setPending(store, 'stale', {
      ...pendingEntry('https://developer-api.amplitude.com'),
      device_code: 'STALE',
      expires_at: '2000-01-01T00:00:00Z',
    });
    savePending(store, pendingPath);
    const out: string[] = [];
    await runLogout(
      {},
      {
        path,
        pendingPath,
        now: () => Date.parse('2026-07-16T00:00:00Z'),
        stdout: (l) => out.push(l),
      },
    );
    const after = loadPending(pendingPath);
    expect(getPending(after, 'live')).toBeUndefined();
    expect(getPending(after, 'stale')?.device_code).toBe('STALE');
    expect(out.join('\n')).toMatch(/Canceled the in-progress login/);
  });

  it('--all clears pending even when there are no profiles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amp-logout-pending-only-'));
    dirs.push(dir);
    const path = join(dir, 'credentials.json');
    const pendingPath = join(dir, 'pending.json');
    saveStore(emptyStore(), path);
    savePending(
      setPending(
        emptyPending(),
        'work',
        pendingEntry('https://developer-api.amplitude.com'),
      ),
      pendingPath,
    );
    const out: string[] = [];
    await runLogout(
      { all: true },
      { path, pendingPath, stdout: (l) => out.push(l) },
    );
    expect(Object.keys(loadPending(pendingPath).pending)).toEqual([]);
    expect(out.join('\n')).toMatch(/Cleared 1 in-progress login/);
  });
});

describe('maskToken', () => {
  it('shows the ends and elides the middle', () => {
    expect(maskToken('eyJabcdefghAB12')).toBe('eyJa…AB12');
  });

  it('fully masks short tokens', () => {
    expect(maskToken('amp_x')).toBe('••••');
  });
});

describe('runAuthStatus', () => {
  const original = process.exitCode;
  afterEach(() => {
    process.exitCode = original;
  });

  function statusStore(): CredentialStore {
    const store = setProfile(
      emptyStore(),
      'amplitude',
      oauthProfile(
        'https://developer-api.amplitude.com',
        '2026-06-23T14:00:00.000Z',
      ),
    );
    return setDefault(store, 'amplitude');
  }

  it('reports the default profile with type, expiry, and a masked token', () => {
    const out: string[] = [];
    runAuthStatus(
      {},
      {
        store: statusStore(),
        now: () => NOW,
        env: {},
        stdout: (l) => out.push(l),
      },
    );
    const text = out.join('\n');

    expect(text).toMatch(/Source: {3}default profile amplitude/);
    expect(text).toMatch(/Profile: {2}amplitude \(default\)/);
    expect(text).toMatch(/Type: {5}oauth/);
    expect(text).toMatch(/Expires: {2}in 2h 0m/);
    expect(text).not.toContain('eyJ.jwt');
    expect(process.exitCode).not.toBe(1);
  });

  it('shows the Region line for a prod profile', () => {
    const out: string[] = [];
    runAuthStatus(
      {},
      {
        store: statusStore(),
        now: () => NOW,
        env: {},
        stdout: (l) => out.push(l),
      },
    );
    expect(out.join('\n')).toContain(
      'Region:   US (https://app.amplitude.com/)',
    );
  });

  it('omits the Region line for an internal-env profile', () => {
    const store = setDefault(
      setProfile(
        emptyStore(),
        'staging',
        oauthProfile(
          'https://developer-api.stag2.amplitude.com',
          '2026-06-23T14:00:00.000Z',
        ),
      ),
      'staging',
    );
    const out: string[] = [];
    runAuthStatus(
      {},
      { store, now: () => NOW, env: {}, stdout: (l) => out.push(l) },
    );
    expect(out.join('\n')).not.toContain('Region:');
  });

  it('emits plain text without ANSI when stdout is not a TTY', () => {
    const out: string[] = [];
    runAuthStatus(
      {},
      {
        store: statusStore(),
        now: () => NOW,
        env: {},
        isTTY: false,
        stdout: (l) => out.push(l),
      },
    );
    const text = out.join('\n');

    expect(text).toMatch(/Auth status/);
    expect(text).toMatch(/Source: {3}default profile amplitude/);
    expect(text).not.toContain(`${String.fromCharCode(0x1b)}[`);
  });

  it('exits non-zero with guidance when nothing resolves', () => {
    const out: string[] = [];
    runAuthStatus(
      {},
      {
        store: emptyStore(),
        now: () => NOW,
        env: {},
        stdout: (l) => out.push(l),
      },
    );

    expect(out.join('\n')).toMatch(/amp auth login/);
    expect(process.exitCode).toBe(1);
  });

  it('announces AMP_TOKEN when it is in effect', () => {
    const out: string[] = [];
    runAuthStatus(
      {},
      {
        store: statusStore(),
        now: () => NOW,
        env: { AMP_TOKEN: 'env-token' },
        stdout: (l) => out.push(l),
      },
    );
    const text = out.join('\n');

    expect(text).toMatch(/AMP_TOKEN is set/);
    expect(text).toMatch(/Source: {3}AMP_TOKEN env var/);
    expect(process.exitCode).not.toBe(1);
  });

  it('still shows the profile row (Expires: expired) and exits non-zero for an expired credential', () => {
    const store = setDefault(
      setProfile(
        emptyStore(),
        'amplitude',
        oauthProfile(
          'https://developer-api.amplitude.com',
          '2026-06-23T10:00:00.000Z',
        ),
      ),
      'amplitude',
    );
    const out: string[] = [];
    runAuthStatus(
      {},
      { store, now: () => NOW, env: {}, stdout: (l) => out.push(l) },
    );
    const text = out.join('\n');

    expect(text).toMatch(/Profile: {2}amplitude \(default\)/);
    expect(text).toMatch(/Type: {5}oauth/);
    expect(text).toMatch(/Expires: {2}expired/);
    expect(text).toMatch(/expired/i);
    expect(text).not.toContain('eyJ.jwt');
    expect(process.exitCode).toBe(1);
  });
});

describe('runAuthToken', () => {
  function tokenStore(expiresAt: string): CredentialStore {
    const store = setProfile(
      emptyStore(),
      'amplitude',
      oauthProfile('https://developer-api.amplitude.com', expiresAt),
    );
    return setDefault(store, 'amplitude');
  }

  it('prints only the resolved access token (pipeable)', () => {
    const out: string[] = [];
    runAuthToken(
      {},
      {
        store: tokenStore('2026-06-23T14:00:00.000Z'),
        now: () => NOW,
        env: {},
        stdout: (l) => out.push(l),
      },
    );
    expect(out).toEqual(['eyJ.jwt']);
  });

  it('throws (no stdout) when no credential resolves', () => {
    expect(() =>
      runAuthToken({}, { store: emptyStore(), now: () => NOW, env: {} }),
    ).toThrow(/amp auth login/);
  });

  it('throws when the selected token has expired', () => {
    expect(() =>
      runAuthToken(
        {},
        {
          store: tokenStore('2026-06-23T11:00:00.000Z'),
          now: () => NOW,
          env: {},
        },
      ),
    ).toThrow(/expired/i);
  });
});

it('store version constant is stable', () => {
  expect(CURRENT_VERSION).toBe(1);
});
