import { type FlagValue, stringFlag } from './args';
import { authError } from './cli-error';
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
import { refreshProfileTokenLocked } from './token-refresh';

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
  path?: string;
  now?: number;
}

export interface ResolvedAuth {
  token: string;
  baseUrl: string;
  // The profile's persisted backend, kept separate from `baseUrl` because an
  // explicit request override may intentionally target another host. Reactive
  // refresh uses this to detect a concurrent same-name login to another
  // environment before retrying with its credential.
  profileBaseUrl?: string;
  source: string;
  // Whether the resolved credential is an OAuth profile with a refresh token —
  // i.e. a 401 can be recovered by a forced refresh + retry. False on the
  // --token / AMP_TOKEN paths and for a profile with no refresh token.
  refreshable: boolean;
  // Whether resolveAuthWithRefresh proactively rotated this token. If so, a
  // subsequent 401 can't be helped by refreshing again (the token is freshly
  // minted), so the reactive path skips it to avoid a double rotation. Stays
  // false when the proactive path only adopted a peer's already-refreshed
  // token — that one is not ours, so the reactive net still applies.
  refreshed?: boolean;
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
      throw authError(
        `Stored token for profile "${name}" has expired. Run \`amp auth login\`.`,
        'invalid_token',
      );
    }
    return oauth.data.access_token;
  }

  const pat = patCredentialSchema.safeParse(profile.credential);
  if (pat.success) {
    return pat.data.pat;
  }

  throw authError(
    `Profile "${name}" uses an unsupported credential type "${profile.credential.type}". Update the CLI.`,
    'invalid_token',
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

  const store = input.store ?? loadStore(input.path);
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
      refreshable: false,
    };
  }

  const ampToken = trimmed(env.AMP_TOKEN);
  if (ampToken) {
    return {
      token: ampToken,
      baseUrl: rawTokenBaseUrl(input, env),
      source: 'AMP_TOKEN env var',
      refreshable: false,
    };
  }

  const store = input.store ?? loadStore(input.path);
  const selected = selectProfile({ ...input, store, env });
  if (selected) {
    const oauth = oauthCredentialSchema.safeParse(selected.profile.credential);
    return {
      token: tokenFromProfile(selected.profile, selected.name, now),
      baseUrl: stripTrailingSlash(
        trimmed(input.baseUrlFlag) ?? selected.profile.base_url,
      ),
      profileBaseUrl: selected.profile.base_url,
      source: selected.source,
      profile: selected.name,
      refreshable: oauth.success && Boolean(oauth.data.refresh_token),
    };
  }

  // selectProfile returned nothing: either a name was requested but no such
  // profile exists, or no profile is active at all. The guidance differs.
  const name =
    trimmed(input.profileFlag) ?? trimmed(env.AMP_PROFILE) ?? store.default;
  if (name) {
    throw authError(`No such profile: ${name}. Run \`amp auth list\`.`);
  }
  // "no profiles at all" vs "profiles exist but none is active" (e.g. just
  // after logging out the default) — the suggested fix differs.
  if (Object.keys(store.profiles).length > 0) {
    throw authError(
      'No active profile. Run `amp auth use <name>` to pick one (`amp auth list`), or `amp auth login`.',
    );
  }
  throw authError('No credentials. Run `amp auth login`.');
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
  overrides: Pick<ResolveInput, 'store' | 'path' | 'now' | 'env'> = {},
): ResolvedAuth {
  return resolveAuth({
    tokenFlag: stringFlag(flags, ['token']),
    profileFlag: stringFlag(flags, ['profile']),
    baseUrlFlag: baseUrlOverrideFromFlags(flags),
    ...overrides,
  });
}

/**
 * Async sibling of {@link resolveAuthFromFlags}: proactively refreshes a
 * selected, expired OAuth profile that still has a refresh token — persisting
 * the rotation — before delegating to the synchronous resolver. A profile
 * with no refresh token is left alone, so {@link tokenFromProfile}'s expiry
 * throw remains the re-auth backstop.
 */
export async function resolveAuthWithRefresh(
  flags: Record<string, FlagValue>,
  overrides: Pick<ResolveInput, 'path' | 'now' | 'env'> = {},
): Promise<ResolvedAuth> {
  const now = overrides.now ?? Date.now();
  const selected = selectProfileFromFlags(flags, overrides);
  let rotation:
    | {
        profile: string;
        accessToken: string;
      }
    | undefined;
  if (selected) {
    const oauth = oauthCredentialSchema.safeParse(selected.profile.credential);
    if (
      oauth.success &&
      oauth.data.refresh_token &&
      isExpired(oauth.data.expires_at, now)
    ) {
      const fresh = await refreshProfileTokenLocked({
        name: selected.name,
        now,
        path: overrides.path,
      });
      // Only a real rotation makes the token freshly minted; adopting a peer's
      // token leaves the reactive 401 path as the useful backstop.
      if (fresh.rotated) {
        rotation = {
          profile: selected.name,
          accessToken: fresh.credential.access_token,
        };
      }
    }
  }
  const resolved = resolveAuthFromFlags(flags, { ...overrides, now });
  return {
    ...resolved,
    refreshed:
      rotation !== undefined &&
      resolved.profile === rotation.profile &&
      resolved.token === rotation.accessToken,
  };
}

/**
 * Flags adapter for {@link selectProfile}, mirroring {@link resolveAuthFromFlags}.
 * Used by `auth status` to render the selected profile's metadata even when its
 * token has expired.
 */
export function selectProfileFromFlags(
  flags: Record<string, FlagValue>,
  overrides: Pick<ResolveInput, 'store' | 'path' | 'env'> = {},
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
