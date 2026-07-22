import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

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
    throw new Error(
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
  return override ?? join(homedir(), '.amplitude', 'amp', 'credentials.json');
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
    throw new Error(`No such profile: ${name}`);
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
