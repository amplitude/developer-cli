import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { debuglog } from 'node:util';

import { lock } from 'proper-lockfile';
import { z } from 'zod';

import { amplitudeDataFiles, amplitudeDataPath } from './amplitude-data-path';
import { transportError, usageError } from './cli-error';

/**
 * On-disk credential store for the `amp` CLI: a versioned file holding named
 * profiles (one credential + the backend it targets) plus a pointer to the
 * active one. Replaces the earlier flat single-PAT file.
 *
 * Forward-compat is load-bearing here (we want to evolve the shape later
 * without breaking older CLIs that read a newer file): every object keeps
 * unknown keys (`.catchall`) and a credential `type` this version doesn't model
 * round-trips untouched rather than failing the read.
 */

export const CURRENT_VERSION = 1;

const debugLock = debuglog('amp');

export function debugCredentialPersistenceError(
  operation: string,
  error: unknown,
): void {
  debugLock(
    '%s: %s',
    operation,
    error instanceof Error ? error.message : String(error),
  );
}

// Validates a user-supplied profile name at the *creation* boundary (login /
// pat). Deliberately NOT enforced on the store's `profiles` key — load stays
// lenient so a name written by a newer CLI (or before this rule existed)
// round-trips instead of dropping the profile. Strict identifier charset keeps
// names safe to interpolate into `auth list` / `status` output (no newlines or
// control chars to spoof a row) and predictable across tools. `default` is a
// valid name: it is the profile the CLI targets when --profile is omitted.
export const profileNameSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(64, 'must be at most 64 characters')
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'use letters, digits, dot, underscore, or hyphen',
  );

/** Throws a friendly error if `name` is not a valid profile name. */
export function assertValidProfileName(name: string): void {
  const result = profileNameSchema.safeParse(name);
  if (!result.success) {
    throw usageError(
      `Invalid profile name "${name}": ${result.error.issues[0]?.message ?? 'invalid'}.`,
    );
  }
}

export const oauthCredentialSchema = z
  .object({
    type: z.literal('oauth'),
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    expires_at: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
  })
  .catchall(z.unknown());

export const patCredentialSchema = z
  .object({
    type: z.literal('pat'),
    pat: z.string().min(1),
  })
  .catchall(z.unknown());

// A credential type this CLI version does not model (e.g. a future
// service_account). Matched last so known types win; preserved on rewrite.
const unknownCredentialSchema = z
  .object({ type: z.string().min(1) })
  .catchall(z.unknown());

const credentialSchema = z.union([
  oauthCredentialSchema,
  patCredentialSchema,
  unknownCredentialSchema,
]);

const profileSchema = z
  .object({
    base_url: z.string().min(1),
    credential: credentialSchema,
    saved_at: z.string().min(1),
    // Storage backend for this profile's secret. "file" today; recorded rather
    // than assumed so an OS-keychain backend can be added (and later defaulted)
    // without breaking existing files.
    store: z.string().optional(),
  })
  .catchall(z.unknown());

const storeSchema = z
  .object({
    version: z.number().int(),
    default: z.string().optional(),
    profiles: z.record(z.string(), profileSchema),
  })
  .catchall(z.unknown());

export type OAuthCredential = z.infer<typeof oauthCredentialSchema>;
export type PatCredential = z.infer<typeof patCredentialSchema>;
export type Credential = z.infer<typeof credentialSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type CredentialStore = z.infer<typeof storeSchema>;

export function credentialsPath(override?: string): string {
  return amplitudeDataPath(amplitudeDataFiles.credentials, override);
}

export function emptyStore(): CredentialStore {
  return { version: CURRENT_VERSION, profiles: {} };
}

/**
 * Reads the store. A missing or legacy-flat file is treated as "no store yet"
 * (empty) — the next save overwrites it. There is no migration from the old
 * flat PAT file by design.
 *
 * A file that exists but cannot be read or parsed (corrupt JSON, bad
 * permissions) is also treated as empty so the CLI stays usable, but we warn on
 * stderr first: the next save silently overwrites it, and silent credential
 * loss is worse than a noisy one.
 */
export function loadStore(path: string = credentialsPath()): CredentialStore {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyStore();
    }
    process.stderr.write(
      `amp: could not read credentials at ${path} (${
        error instanceof Error ? error.message : String(error)
      }); treating as empty. The next login will overwrite it.\n`,
    );
    return emptyStore();
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(
      `amp: credentials at ${path} are not valid JSON (${
        error instanceof Error ? error.message : String(error)
      }); treating as empty. The next login will overwrite it.\n`,
    );
    return emptyStore();
  }

  const parsed = storeSchema.safeParse(json);
  if (parsed.success) {
    return parsed.data;
  }

  // Schema mismatch falls into two cases. A legacy flat PAT file (or any
  // pre-versioned/foreign shape) is the expected "no store yet" — silent, since
  // warning on every read of an old file is noise. But a file that already
  // *looks like* our versioned store yet fails validation (e.g. one malformed
  // profile fails the whole `z.record`) would otherwise silently hide every
  // profile until the next save overwrites it — so warn loudly there, the same
  // as corrupt JSON.
  if (looksLikeStore(json)) {
    const issue = parsed.error.issues[0];
    const where = issue
      ? `${issue.path.join('.') || 'root'}: ${issue.message}`
      : 'schema mismatch';
    process.stderr.write(
      `amp: credentials at ${path} did not validate (${where}); treating as empty. The next login will overwrite it.\n`,
    );
  }
  return emptyStore();
}

// Whether the parsed JSON is an attempt at *our* versioned store (vs a legacy
// flat PAT file or unrelated shape). Used to decide whether a schema-validation
// failure is worth warning about.
function looksLikeStore(json: unknown): boolean {
  return (
    typeof json === 'object' &&
    json !== null &&
    ('version' in json || 'profiles' in json)
  );
}

export function saveStore(
  store: CredentialStore,
  path: string = credentialsPath(),
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tempPath = join(
    dir,
    `.credentials.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );

  try {
    writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * How long a lockfile may go un-refreshed before a peer treats it as abandoned
 * and steals it. Must stay at least 2x REFRESH_TIMEOUT_MS (token-refresh.ts):
 * a steal mid-exchange means two processes redeem the same refresh token, which
 * trips Hydra's rotation reuse-detection and revokes the whole family. Enforced
 * by a test. proper-lockfile re-stamps the mtime every `update` ms, so only a
 * stall longer than this — a suspended laptop, an event loop starved by a fleet
 * of parallel `amp` processes — can trigger it.
 */
export const CREDENTIAL_LOCK_STALE_MS = 20_000;

// Keep re-stamping at the pre-existing cadence rather than letting it drift to
// the `stale / 2` default, so the threshold above buys tolerance for a stall
// instead of just spacing out the writes that prevent one.
const CREDENTIAL_LOCK_UPDATE_MS = 5_000;

interface CredentialLockRetryOptions {
  retries: number;
  factor: number;
  minTimeout: number;
  maxTimeout: number;
}

// ~22.5s of total waiting, which has to outlast CREDENTIAL_LOCK_STALE_MS: a
// holder killed mid-write leaves its lockfile behind, and peers can only
// reclaim it once it goes stale. Give up sooner and a hard crash turns every
// queued command into a failure instead of a pause.
const CREDENTIAL_LOCK_RETRIES: CredentialLockRetryOptions = {
  retries: 28,
  factor: 1.5,
  minTimeout: 50,
  maxTimeout: 1000,
};

// A completed rotation holds the only usable refresh token in memory. Give its
// reconciliation a longer, still-bounded window without making routine lock
// contention slower. 51 retries with the same backoff total ~45.46 seconds.
const CREDENTIAL_LOCK_RECOVERY_RETRIES: CredentialLockRetryOptions = {
  ...CREDENTIAL_LOCK_RETRIES,
  retries: 51,
};

function retryBudgetMs(options: CredentialLockRetryOptions): number {
  return Array.from({ length: options.retries }, (_, attempt) =>
    Math.min(
      options.minTimeout * options.factor ** attempt,
      options.maxTimeout,
    ),
  ).reduce((total, timeout) => total + timeout, 0);
}

export const CREDENTIAL_LOCK_RETRY_BUDGET_MS = retryBudgetMs(
  CREDENTIAL_LOCK_RETRIES,
);
export const CREDENTIAL_LOCK_RECOVERY_RETRY_BUDGET_MS = retryBudgetMs(
  CREDENTIAL_LOCK_RECOVERY_RETRIES,
);

export interface CredentialLockState {
  isCompromised(): boolean;
}

export interface CredentialLockOptions {
  lock?: typeof lock;
  retryMode?: 'normal' | 'rotation_recovery';
  acquireError?: () => Error;
}

export interface UpdateStoreOptions extends CredentialLockOptions {
  save?: typeof saveStore;
  persistError?: () => Error;
}

/**
 * Runs `fn` while holding a cross-process advisory lock on the store file, so
 * concurrent writers (transparent refresh, login, logout) serialize instead of
 * clobbering each other. A failed acquire surfaces as the caller-selected
 * recovery error, or a retryable transport error by default. `options.lock` is
 * a test seam.
 *
 * Only the parent directory is created up front — that is what the lockfile
 * `mkdir` needs, and it destroys nothing if a peer is mid-write. The store file
 * itself is deliberately left absent: seeding it here would be an *unlocked*
 * write that could clobber a profile a peer just committed, and `loadStore`
 * already reads a missing file as empty once we are inside the lock.
 */
export async function withCredentialLock<T>(
  path: string,
  fn: (state: CredentialLockState) => T | Promise<T>,
  options: CredentialLockOptions = {},
): Promise<T> {
  const acquire = options.lock ?? lock;
  const retries =
    options.retryMode === 'rotation_recovery'
      ? CREDENTIAL_LOCK_RECOVERY_RETRIES
      : CREDENTIAL_LOCK_RETRIES;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let compromiseError: Error | undefined;
  let release: () => Promise<void>;
  try {
    release = await acquire(path, {
      retries,
      stale: CREDENTIAL_LOCK_STALE_MS,
      update: CREDENTIAL_LOCK_UPDATE_MS,
      realpath: false,
      onCompromised: (error) => {
        // proper-lockfile's default rethrows, but it calls this from its
        // mtime-updater's fs callback — off our promise chain, so the throw is
        // uncatchable and kills the CLI mid-refresh. Record the loss so a
        // refresh can reconcile a completed rotation under a replacement
        // lock instead of discarding the only usable token.
        compromiseError ??= error;
        debugLock('credentials lock ownership was lost: %s', error.message);
      },
    });
  } catch (error) {
    debugLock(
      'could not acquire credentials lock: %s',
      error instanceof Error ? error.message : String(error),
    );
    throw (
      options.acquireError?.() ??
      transportError('Could not access saved credentials; try again.')
    );
  }

  const state: CredentialLockState = {
    isCompromised() {
      return compromiseError !== undefined;
    },
  };

  try {
    return await fn(state);
  } finally {
    // A compromised lock makes release() reject. That must not replace the
    // operation result or expose internal recovery mechanics to the user.
    try {
      await release();
    } catch (error) {
      debugLock(
        'could not release credentials lock: %s',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * The one safe way to change the store: under the lock, reload the latest
 * store, apply `mutate`, and persist the result — so a concurrent writer can't
 * be clobbered by a stale snapshot. Do any slow work (network, prompts) BEFORE
 * calling this so the locked section stays short. Returns the persisted store.
 */
export async function updateStore(
  path: string | undefined,
  mutate: (store: CredentialStore) => CredentialStore,
  options: UpdateStoreOptions = {},
): Promise<CredentialStore> {
  const resolved = path ?? credentialsPath();
  return withCredentialLock(
    resolved,
    () => {
      const next = mutate(loadStore(resolved));
      try {
        (options.save ?? saveStore)(next, resolved);
      } catch (error) {
        debugCredentialPersistenceError('could not save credentials', error);
        throw options.persistError?.() ?? error;
      }
      return next;
    },
    options,
  );
}

export function getProfile(
  store: CredentialStore,
  name: string,
): Profile | undefined {
  return store.profiles[name];
}

/** Adds or replaces a profile. Does not change the active (`default`) profile. */
export function setProfile(
  store: CredentialStore,
  name: string,
  profile: Profile,
): CredentialStore {
  return { ...store, profiles: { ...store.profiles, [name]: profile } };
}

/** Points `default` at an existing profile. Throws if the profile is unknown. */
export function setDefault(
  store: CredentialStore,
  name: string,
): CredentialStore {
  if (!store.profiles[name]) {
    throw new Error(`No such profile: ${name}`); // plain-error-ok: internal invariant guarded by callers, which always create or verify the profile first — unreachable in practice.
  }
  return { ...store, default: name };
}

/**
 * Removes a profile. Clears `default` if it pointed at the removed profile —
 * never auto-promotes a survivor (the active identity only changes on an
 * explicit command). Unknown profile name is a no-op.
 */
export function removeProfile(
  store: CredentialStore,
  name: string,
): CredentialStore {
  if (!store.profiles[name]) {
    return store;
  }
  const profiles = { ...store.profiles };
  delete profiles[name];
  const next: CredentialStore = { ...store, profiles };
  if (store.default === name) {
    delete next.default;
  }
  return next;
}
