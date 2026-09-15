import { spawnSync } from 'node:child_process';
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
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CREDENTIAL_LOCK_RECOVERY_RETRY_BUDGET_MS,
  CREDENTIAL_LOCK_RETRY_BUDGET_MS,
  CREDENTIAL_LOCK_STALE_MS,
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
  updateStore,
  withCredentialLock,
} from './credential-store';
import { REFRESH_TIMEOUT_MS } from './token-refresh';

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
    vi.restoreAllMocks();
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

    it('accepts the name "default" (used as the implicit profile)', () => {
      expect(() => assertValidProfileName('default')).not.toThrow();
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

  describe('updateStore', () => {
    it('applies the mutation and persists it', async () => {
      const path = tempPath();
      saveStore(setProfile(emptyStore(), 'a', oauthProfile('https://a')), path);

      const next = await updateStore(path, (store) =>
        setProfile(store, 'b', oauthProfile('https://b')),
      );

      expect(Object.keys(next.profiles).sort()).toEqual(['a', 'b']);
      expect(Object.keys(loadStore(path).profiles).sort()).toEqual(['a', 'b']);
    });

    it('reloads the latest store before mutating', async () => {
      const path = tempPath();
      saveStore(emptyStore(), path);
      // A write that landed after the caller's own view but before updateStore.
      saveStore(
        setProfile(emptyStore(), 'landed', oauthProfile('https://x')),
        path,
      );

      const next = await updateStore(path, (store) => {
        // The mutate receives the latest on-disk store, so it can't clobber it.
        expect(getProfile(store, 'landed')).toBeDefined();
        return setProfile(store, 'mine', oauthProfile('https://y'));
      });

      expect(Object.keys(next.profiles).sort()).toEqual(['landed', 'mine']);
    });

    it('creates the store file when missing', async () => {
      const path = tempPath();
      expect(existsSync(path)).toBe(false);

      await updateStore(path, (store) =>
        setProfile(store, 'a', oauthProfile('https://a')),
      );

      expect(existsSync(path)).toBe(true);
      expect(getProfile(loadStore(path), 'a')).toBeDefined();
    });

    it('surfaces a lock-acquire failure as a retryable transport error', async () => {
      const path = tempPath();
      saveStore(emptyStore(), path);
      const failingLock = vi.fn().mockRejectedValue(new Error('ELOCKED'));

      await expect(
        updateStore(path, (store) => store, { lock: failingLock }),
      ).rejects.toMatchObject({
        errorCode: 'transport_error',
        message: 'Could not access saved credentials; try again.',
      });
    });

    it('keeps a mapped save error user-safe while exposing its cause through AMP_DEBUG', () => {
      const path = tempPath();
      const moduleUrl = pathToFileURL(
        join(__dirname, 'credential-store.ts'),
      ).href;
      const script = `
        const imported = await import(${JSON.stringify(moduleUrl)});
        const { updateStore } = imported.default ?? imported;
        try {
          await updateStore(
            ${JSON.stringify(path)},
            (store) => store,
            {
              save() { throw new Error('DEBUG_PERSISTENCE_CAUSE'); },
              persistError() { return new Error('SAFE_USER_ERROR'); },
            },
          );
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
      expect(result.stdout).toBe('SAFE_USER_ERROR');
      expect(result.stdout).not.toContain('DEBUG_PERSISTENCE_CAUSE');
      expect(result.stderr).toContain('DEBUG_PERSISTENCE_CAUSE');
    });
  });

  // These use the real proper-lockfile, not the `lock` test seam: the lockfile
  // is an atomic mkdir, so two holders in one process contend on disk exactly
  // as two `amp` processes do. Each critical section awaits, so an
  // unserialized implementation really would interleave and lose a write.
  describe('lock timing constants', () => {
    it('leaves a stall margin over the longest work done under the lock', () => {
      // A steal mid-exchange redeems the same refresh token twice, which trips
      // Hydra reuse-detection and revokes the family. Keep the margin if either
      // constant moves.
      expect(CREDENTIAL_LOCK_STALE_MS).toBeGreaterThanOrEqual(
        2 * REFRESH_TIMEOUT_MS,
      );
    });

    it('keeps normal and recovery retry budgets above their invariants', () => {
      expect(CREDENTIAL_LOCK_RETRY_BUDGET_MS).toBeGreaterThan(
        CREDENTIAL_LOCK_STALE_MS,
      );
      expect(CREDENTIAL_LOCK_RECOVERY_RETRY_BUDGET_MS).toBeGreaterThanOrEqual(
        45_000,
      );
      expect(CREDENTIAL_LOCK_RECOVERY_RETRY_BUDGET_MS).toBeLessThan(60_000);
      expect(CREDENTIAL_LOCK_RECOVERY_RETRY_BUDGET_MS).toBeGreaterThan(
        CREDENTIAL_LOCK_RETRY_BUDGET_MS,
      );
    });
  });

  describe('withCredentialLock contention', () => {
    it('serializes two concurrent holders on the same path', async () => {
      const path = tempPath();
      const events: string[] = [];
      const hold = (tag: string) =>
        withCredentialLock(path, async () => {
          events.push(`${tag}:enter`);
          await delay(50);
          events.push(`${tag}:exit`);
        });

      await Promise.all([hold('a'), hold('b')]);

      // Whoever won, its exit precedes the other's enter.
      expect([
        'a:enter,a:exit,b:enter,b:exit',
        'b:enter,b:exit,a:enter,a:exit',
      ]).toContain(events.join(','));
    });

    it('keeps both writes when two async read-modify-writes race', async () => {
      const path = tempPath();
      saveStore(emptyStore(), path);
      const add = (name: string) =>
        withCredentialLock(path, async () => {
          const store = loadStore(path);
          // Without the lock both holders would read this same snapshot and
          // the second save would drop the first profile.
          await delay(20);
          saveStore(
            setProfile(store, name, oauthProfile(`https://${name}`)),
            path,
          );
        });

      await Promise.all([add('a'), add('b')]);

      expect(Object.keys(loadStore(path).profiles).sort()).toEqual(['a', 'b']);
    });

    it('waits out a slow holder through the real retry backoff', async () => {
      const path = tempPath();
      // Held well past the first few backoff steps, so the contender only
      // succeeds by actually retrying — this covers CREDENTIAL_LOCK_RETRIES.
      let markAcquired: () => void;
      const acquired = new Promise<void>((resolve) => {
        markAcquired = resolve;
      });
      const holder = withCredentialLock(path, () => {
        markAcquired();
        return delay(300);
      });

      try {
        await Promise.race([acquired, holder]);
        await expect(withCredentialLock(path, () => 'acquired')).resolves.toBe(
          'acquired',
        );
      } finally {
        await holder;
      }
    });

    it('releases the lock when the critical section throws', async () => {
      const path = tempPath();
      await expect(
        withCredentialLock(path, () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      // A leaked lock would make this acquire fail instead of resolving.
      await expect(withCredentialLock(path, () => 'acquired')).resolves.toBe(
        'acquired',
      );
    });

    it('locks a store file that does not exist yet', async () => {
      const path = tempPath();
      expect(existsSync(path)).toBe(false);

      await expect(withCredentialLock(path, () => 'acquired')).resolves.toBe(
        'acquired',
      );
      // The lock must not seed the file — that write would be unlocked.
      expect(existsSync(path)).toBe(false);
    });

    it('does not expose a recovered lock compromise to the user', async () => {
      const path = tempPath();
      let onCompromised: ((error: Error) => void) | undefined;
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      await withCredentialLock(path, () => 'acquired', {
        lock: async (_path, options) => {
          onCompromised = options?.onCompromised;
          return async () => {};
        },
      });

      // proper-lockfile calls this from its mtime-updater's fs callback, so a
      // throw here would be an uncaught exception, not a rejected promise.
      expect(() => onCompromised?.(new Error('lock stolen'))).not.toThrow();
      expect(stderr).not.toHaveBeenCalled();
      stderr.mockRestore();
    });

    it('does not let a failed release mask the error from the locked section', async () => {
      const path = tempPath();
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      await expect(
        withCredentialLock(
          path,
          () => {
            throw new Error('the real failure');
          },
          {
            lock: async () => async () => {
              throw new Error('ERELEASED');
            },
          },
        ),
      ).rejects.toThrow('the real failure');
      expect(stderr).not.toHaveBeenCalled();
    });

    it('returns success without exposing release mechanics to the user', async () => {
      const path = tempPath();
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      await expect(
        withCredentialLock(path, () => 'persisted', {
          lock: async () => async () => {
            throw new Error('ERELEASED');
          },
        }),
      ).resolves.toBe('persisted');
      expect(stderr).not.toHaveBeenCalled();
    });

    it('gives actionable guidance without exposing lock internals when acquire fails', async () => {
      const path = tempPath();

      await expect(
        withCredentialLock(path, () => 'unreachable', {
          lock: async () => {
            throw new Error('EACCES: permission denied');
          },
        }),
      ).rejects.toThrow('Could not access saved credentials; try again.');
    });
  });
});
