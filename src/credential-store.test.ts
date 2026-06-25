import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CURRENT_VERSION,
  type CredentialStore,
  type OAuthCredential,
  assertValidProfileName,
  emptyStore,
  getProfile,
  loadStore,
  removeProfile,
  saveStore,
  setDefault,
  setProfile,
} from './credential-store';

const OAUTH: OAuthCredential = {
  type: 'oauth',
  access_token: 'eyJ.test.token',
  token_type: 'Bearer',
  expires_at: '2026-06-24T12:00:00.000Z',
  refresh_token: 'refresh_test',
  scope: 'read:projects',
};

function oauthProfile(baseUrl: string): CredentialStore['profiles'][string] {
  return {
    base_url: baseUrl,
    credential: OAUTH,
    saved_at: '2026-06-23T14:56:23.000Z',
    store: 'file',
  };
}

describe('credential-store', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    dirs.length = 0;
  });

  function tempPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'amp-store-'));
    dirs.push(dir);
    return join(dir, 'credentials.json');
  }

  describe('loadStore', () => {
    it('returns an empty store when the file is missing', () => {
      expect(loadStore(tempPath())).toEqual(emptyStore());
    });

    it('returns an empty store on corrupt JSON', () => {
      const path = tempPath();
      writeFileSync(path, '{ not valid json');
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      expect(loadStore(path)).toEqual(emptyStore());
      stderr.mockRestore();
    });

    it('warns on stderr before treating corrupt JSON as empty', () => {
      const path = tempPath();
      writeFileSync(path, '{ not valid json');
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      loadStore(path);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('not valid JSON'),
      );
      stderr.mockRestore();
    });

    it('does not warn when the file is simply missing', () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      loadStore(tempPath());
      expect(stderr).not.toHaveBeenCalled();
      stderr.mockRestore();
    });

    it('ignores a legacy flat PAT file (no version/profiles) without warning', () => {
      const path = tempPath();
      writeFileSync(
        path,
        JSON.stringify({ pat: 'amp_old', org_url: 'amplitude', saved_at: 'x' }),
      );
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      expect(loadStore(path)).toEqual(emptyStore());
      expect(stderr).not.toHaveBeenCalled();
      stderr.mockRestore();
    });

    it('warns when a versioned store fails schema validation', () => {
      // Looks like our store (has version/profiles) but one profile is malformed
      // — without a warning every profile would silently vanish.
      const path = tempPath();
      writeFileSync(
        path,
        JSON.stringify({
          version: CURRENT_VERSION,
          default: 'a',
          profiles: { a: { credential: { type: 'oauth' } } },
        }),
      );
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      expect(loadStore(path)).toEqual(emptyStore());
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('did not validate'),
      );
      stderr.mockRestore();
    });

    it('emptyStore carries the current version and no default', () => {
      expect(emptyStore()).toEqual({ version: CURRENT_VERSION, profiles: {} });
    });
  });

  describe('round-trip', () => {
    it('saves and loads a profile store', () => {
      const path = tempPath();
      let store = emptyStore();
      store = setProfile(store, 'amplitude', oauthProfile('https://prod'));
      store = setDefault(store, 'amplitude');
      saveStore(store, path);

      expect(loadStore(path)).toEqual(store);
    });

    it('writes atomically with no temp files left behind', () => {
      const path = tempPath();
      saveStore(setProfile(emptyStore(), 'p', oauthProfile('https://x')), path);

      expect(existsSync(path)).toBe(true);
      expect(readdirSync(dirname(path))).toEqual(['credentials.json']);
    });

    it('writes the file 0600', () => {
      if (process.platform === 'win32') {
        return;
      }
      const path = tempPath();
      saveStore(setProfile(emptyStore(), 'p', oauthProfile('https://x')), path);

      // eslint-disable-next-line no-bitwise -- masking permission bits off st_mode
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it('creates the parent directory 0700', () => {
      if (process.platform === 'win32') {
        return;
      }
      const base = mkdtempSync(join(tmpdir(), 'amp-store-'));
      dirs.push(base);
      const dir = join(base, 'nested');
      saveStore(
        setProfile(emptyStore(), 'p', oauthProfile('https://x')),
        join(dir, 'credentials.json'),
      );

      // eslint-disable-next-line no-bitwise -- masking permission bits off st_mode
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });
  });

  describe('profile CRUD', () => {
    it('setProfile adds without changing the default', () => {
      const store = setProfile(emptyStore(), 'a', oauthProfile('https://a'));
      expect(getProfile(store, 'a')?.base_url).toBe('https://a');
      expect(store.default).toBeUndefined();
    });

    it('setDefault throws on an unknown profile', () => {
      expect(() => setDefault(emptyStore(), 'nope')).toThrow();
    });

    it('removeProfile clears the default when removing the active profile', () => {
      let store = setProfile(emptyStore(), 'a', oauthProfile('https://a'));
      store = setDefault(store, 'a');
      store = removeProfile(store, 'a');

      expect(getProfile(store, 'a')).toBeUndefined();
      expect(store.default).toBeUndefined();
    });

    it('removeProfile leaves the default when removing a non-default profile', () => {
      let store = setProfile(emptyStore(), 'a', oauthProfile('https://a'));
      store = setProfile(store, 'b', oauthProfile('https://b'));
      store = setDefault(store, 'a');
      store = removeProfile(store, 'b');

      expect(store.default).toBe('a');
      expect(getProfile(store, 'b')).toBeUndefined();
    });

    it('removeProfile on an unknown profile is a no-op', () => {
      const store = setProfile(emptyStore(), 'a', oauthProfile('https://a'));
      expect(removeProfile(store, 'nope')).toEqual(store);
    });
  });

  describe('forward-compat', () => {
    it('round-trips a credential type this version does not model', () => {
      const path = tempPath();
      const store: CredentialStore = {
        version: CURRENT_VERSION,
        default: 'sa',
        profiles: {
          sa: {
            base_url: 'https://prod',
            credential: {
              type: 'service_account',
              client_id: 'cid',
              secret_ref: 'ref',
            },
            saved_at: '2026-06-23T00:00:00.000Z',
          },
        },
      };
      saveStore(store, path);

      expect(loadStore(path)).toEqual(store);
    });

    it('loads a file written by a newer CLI version without downgrading it', () => {
      const path = tempPath();
      const future = CURRENT_VERSION + 1;
      writeFileSync(
        path,
        JSON.stringify({
          version: future,
          default: 'a',
          profiles: { a: oauthProfile('https://a') },
        }),
      );

      const loaded = loadStore(path);
      expect(loaded.version).toBe(future);

      // A mutation from this older CLI must not stamp the file back to
      // CURRENT_VERSION — the newer version is preserved across rewrites.
      saveStore(setProfile(loaded, 'b', oauthProfile('https://b')), path);
      expect(loadStore(path).version).toBe(future);
    });

    it('preserves unknown top-level and profile keys (passthrough)', () => {
      const path = tempPath();
      const store: CredentialStore = {
        version: CURRENT_VERSION,
        profiles: {
          a: { ...oauthProfile('https://a'), future_field: 'keep' },
        },
        future_top: { nested: true },
      };
      saveStore(store, path);

      expect(loadStore(path)).toEqual(store);
    });
  });

  describe('assertValidProfileName', () => {
    it('accepts identifier-style names', () => {
      for (const name of ['dev', 'prod-eu', 'my_org.1', 'A1', 'x'.repeat(64)]) {
        expect(() => assertValidProfileName(name)).not.toThrow();
      }
    });

    it('rejects the reserved name "default"', () => {
      expect(() => assertValidProfileName('default')).toThrow(/reserved/);
    });

    it('rejects whitespace, control chars, slashes, empty, and over-length', () => {
      for (const name of [
        '',
        ' ',
        'my profile',
        'a\nb',
        'a/b',
        'emoji😀',
        'x'.repeat(65),
      ]) {
        expect(() => assertValidProfileName(name)).toThrow(
          /Invalid profile name/,
        );
      }
    });
  });
});
