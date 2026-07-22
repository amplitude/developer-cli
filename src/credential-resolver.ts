import { type FlagValue, stringFlag } from './args';
import {
  assertRegionAndEnvNotBothSet,
  DEFAULT_API_BASE_URL,
  resolveNamedBaseUrl,
} from './config';
import {
  type CredentialStore,
  type Profile,
  getProfile,
  loadStore,
  oauthCredentialSchema,
  patCredentialSchema,
} from './credential-store';

/**
 * Resolves which credential a command should use and how to reach the API.
 *
 * Precedence (highest first): `--token` flag, then `AMP_TOKEN` (env-token-is-
 * king — a CI-injected token outranks any stored profile so it can't be
 * silently shadowed), then `--profile`, then `AMP_PROFILE`, then the store's
 * `default` profile. The active identity is never changed here — selection is
 * read-only.
 */
export interface ResolveInput {
  tokenFlag?: string;
  profileFlag?: string;
  baseUrlFlag?: string;
  env?: NodeJS.ProcessEnv;
  store?: CredentialStore;
  now?: number;
}

export interface ResolvedAuth {
  token: string;
  baseUrl: string;
  source: string;
  // Set only when a stored profile was selected (not on the --token / AMP_TOKEN
  // paths), so callers like `auth status` can show the profile's type/expiry
  // without re-deriving the precedence ladder.
  profile?: string;
}

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

// Base URL for the raw-token path (`--token` / `AMP_TOKEN`): explicit flag >
// env > prod default. The prod default here is intentional and is NOT the
// "implicit prod" that force-explicit forbids — that rule guards a *persisted*
// profile's base_url (a durable default users come to depend on, a trap-door).
// This path persists nothing: it's an ephemeral, per-invocation token, so the
// prod default is a power-user/CI escape hatch (mirrors gh's GH_TOKEN, which
// likewise defaults its host). A wrong-env token here fails closed (the server
// rejects it), it doesn't silently write a bad default.
function rawTokenBaseUrl(input: ResolveInput, env: NodeJS.ProcessEnv): string {
  return stripTrailingSlash(
    trimmed(input.baseUrlFlag) ??
      trimmed(env.AMP_API_BASE_URL) ??
      DEFAULT_API_BASE_URL,
  );
}

function isExpired(expiresAt: string, now: number): boolean {
  const at = Date.parse(expiresAt);
  // An unparseable expiry is left to the server to reject rather than locking
  // the user out locally on a format quirk.
  return Number.isNaN(at) ? false : at <= now;
}

/**
 * The usable bearer token for a profile's credential. OAuth tokens are checked
 * for expiry (no refresh yet — the seam is here for when the server enables the
 * grant); PATs pass through; a credential type this version doesn't model is a
 * hard error rather than a silent skip.
 */
export function tokenFromProfile(
  profile: Profile,
  name: string,
  now: number,
): string {
  const oauth = oauthCredentialSchema.safeParse(profile.credential);
  if (oauth.success) {
    if (isExpired(oauth.data.expires_at, now)) {
      throw new Error(
        `Stored token for profile "${name}" has expired. Run \`amp auth login\`.`,
      );
    }
    return oauth.data.access_token;
  }

  const pat = patCredentialSchema.safeParse(profile.credential);
  if (pat.success) {
    return pat.data.pat;
  }

  throw new Error(
    `Profile "${name}" uses an unsupported credential type "${profile.credential.type}". Update the CLI.`,
  );
}

export interface SelectedProfile {
  name: string;
  profile: Profile;
  source: string;
}

/**
 * The store-backed profile a command would select, ignoring whether its token
 * is still usable. Returns undefined when a raw token (`--token` / `AMP_TOKEN`)
 * shadows the store, or when no stored profile is active. Lets `auth status`
 * render a profile's type/expiry even when {@link tokenFromProfile} throws on
 * expiry — selection and token-extraction are separate concerns.
 */
export function selectProfile(
  input: ResolveInput = {},
): SelectedProfile | undefined {
  const env = input.env ?? process.env;
  if (trimmed(input.tokenFlag) || trimmed(env.AMP_TOKEN)) {
    return undefined;
  }

  const store = input.store ?? loadStore();
  const profileFlag = trimmed(input.profileFlag);
  const ampProfile = trimmed(env.AMP_PROFILE);
  const name = profileFlag ?? ampProfile ?? store.default;
  if (!name) {
    return undefined;
  }

  const profile = getProfile(store, name);
  if (!profile) {
    return undefined;
  }

  const source = profileFlag
    ? `--profile ${name}`
    : ampProfile
      ? `AMP_PROFILE env (${name})`
      : `default profile ${name}`;
  return { name, profile, source };
}

export function resolveAuth(input: ResolveInput = {}): ResolvedAuth {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();

  const tokenFlag = trimmed(input.tokenFlag);
  if (tokenFlag) {
    return {
      token: tokenFlag,
      baseUrl: rawTokenBaseUrl(input, env),
      source: '--token flag',
    };
  }

  const ampToken = trimmed(env.AMP_TOKEN);
  if (ampToken) {
    return {
      token: ampToken,
      baseUrl: rawTokenBaseUrl(input, env),
      source: 'AMP_TOKEN env var',
    };
  }

  const store = input.store ?? loadStore();
  const selected = selectProfile({ ...input, store, env });
  if (selected) {
    return {
      token: tokenFromProfile(selected.profile, selected.name, now),
      baseUrl: stripTrailingSlash(
        trimmed(input.baseUrlFlag) ?? selected.profile.base_url,
      ),
      source: selected.source,
      profile: selected.name,
    };
  }

  // selectProfile returned nothing: either a name was requested but no such
  // profile exists, or no profile is active at all. The guidance differs.
  const name =
    trimmed(input.profileFlag) ?? trimmed(env.AMP_PROFILE) ?? store.default;
  if (name) {
    throw new Error(`No such profile: ${name}. Run \`amp auth list\`.`);
  }
  // "no profiles at all" vs "profiles exist but none is active" (e.g. just
  // after logging out the default) — the suggested fix differs.
  if (Object.keys(store.profiles).length > 0) {
    throw new Error(
      'No active profile. Run `amp auth use <name>` to pick one (`amp auth list`), or `amp auth login`.',
    );
  }
  throw new Error('No credentials. Run `amp auth login`.');
}

/**
 * The base-url override carried by the request flags: explicit `--base-url`
 * wins, else `--region`/`--env` is mapped through resolveNamedBaseUrl. Mirrors
 * `loginBaseUrl`'s precedence so a command and a login agree on what a region
 * or env name means.
 */
function baseUrlOverrideFromFlags(
  flags: Record<string, FlagValue>,
): string | undefined {
  const envFlag = stringFlag(flags, ['env']);
  const regionFlag = stringFlag(flags, ['region']);
  assertRegionAndEnvNotBothSet({ envFlag, regionFlag });
  const baseUrl = stringFlag(flags, ['base-url']);
  if (baseUrl) {
    return baseUrl;
  }
  return resolveNamedBaseUrl({
    envFlag,
    regionFlag,
  });
}

/**
 * Adapts parsed CLI flags into a {@link resolveAuth} call — the single entry
 * point the request pipeline and `auth status` share. `overrides` lets tests
 * inject a store / clock / env without touching disk or globals.
 */
export function resolveAuthFromFlags(
  flags: Record<string, FlagValue>,
  overrides: Pick<ResolveInput, 'store' | 'now' | 'env'> = {},
): ResolvedAuth {
  return resolveAuth({
    tokenFlag: stringFlag(flags, ['token']),
    profileFlag: stringFlag(flags, ['profile']),
    baseUrlFlag: baseUrlOverrideFromFlags(flags),
    ...overrides,
  });
}

/**
 * Flags adapter for {@link selectProfile}, mirroring {@link resolveAuthFromFlags}.
 * Used by `auth status` to render the selected profile's metadata even when its
 * token has expired.
 */
export function selectProfileFromFlags(
  flags: Record<string, FlagValue>,
  overrides: Pick<ResolveInput, 'store' | 'env'> = {},
): SelectedProfile | undefined {
  return selectProfile({
    tokenFlag: stringFlag(flags, ['token']),
    profileFlag: stringFlag(flags, ['profile']),
    ...overrides,
  });
}

/**
 * Formats a resolved token into an Authorization header by its shape: an
 * `amp_` value is a PAT, an already-prefixed value passes through, anything
 * else is a bearer. (Carried over from the prior auth header logic.)
 */
export function authorizationHeaderForToken(token: string): string {
  if (token.startsWith('Bearer ')) {
    return token;
  }
  if (token.startsWith('PAT=')) {
    return `Bearer ${token}`;
  }
  if (token.startsWith('amp_')) {
    return `Bearer PAT=${token}`;
  }
  return `Bearer ${token}`;
}
