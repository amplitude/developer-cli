import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';

import { lock } from 'proper-lockfile';

import { oauthCredentialFromToken } from './auth-commands';
import { type AnonymousRequest, createAnonymousRequest } from './authToken';
import { authError, transportError } from './cli-error';
import {
  credentialsPath,
  debugCredentialPersistenceError,
  getProfile,
  loadStore,
  type OAuthCredential,
  type Profile,
  oauthCredentialSchema,
  saveStore,
  setProfile,
  withCredentialLock,
} from './credential-store';
import {
  type TokenResponse,
  tokenResponseSchema,
} from './oauthResponseSchemas';

// The refresh exchange runs while holding the credential lock, so it has to be
// bounded: an unbounded socket would pin the lock and starve every concurrent
// `amp` invocation. CREDENTIAL_LOCK_RETRIES in credential-store.ts is sized to
// outlast this, and CREDENTIAL_LOCK_STALE_MS to leave room for a stalled
// process to finish the exchange before a peer may steal the lock.
export const REFRESH_TIMEOUT_MS = 10_000;

interface RefreshExchangeParams {
  baseUrl: string;
  current: OAuthCredential;
  now: number;
  request?: AnonymousRequest;
}

const MAX_SERVER_GUIDANCE_CODE_POINTS = 500;

function sanitizeServerGuidance(value: string): string {
  const singleLine = stripVTControlCharacters(value)
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(singleLine)
    .slice(0, MAX_SERVER_GUIDANCE_CODE_POINTS)
    .join('');
}

function oauthErrorCode(body: unknown): string | undefined {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const value = body.error;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function oauthErrorDescription(body: unknown): string | undefined {
  if (
    body !== null &&
    typeof body === 'object' &&
    'error_description' in body
  ) {
    const value = body.error_description;
    if (typeof value === 'string' && value.length > 0) {
      return sanitizeServerGuidance(value) || undefined;
    }
  }
  return undefined;
}

// Standard OAuth token-endpoint error codes. For these we show our own friendly
// re-auth sentence. A non-standard code means the server is deliberately
// signalling something (e.g. a future "refresh disabled" control) — we surface
// its error_description verbatim, so that message can be controlled server-side
// without shipping a new CLI.
const STANDARD_OAUTH_ERROR_CODES = new Set([
  'invalid_grant',
  'invalid_token',
  'invalid_request',
  'invalid_client',
  'invalid_scope',
  'unauthorized_client',
  'unsupported_grant_type',
]);

// A malformed success body from the token endpoint is a server bug, not user
// error — same rationale as authToken.ts's parseResponse, kept local since
// that one isn't exported.
function parseTokenResponse(body: unknown): TokenResponse {
  const result = tokenResponseSchema.safeParse(body);
  if (result.success) {
    return result.data;
  }
  throw transportError(
    'The authorization server returned an unexpected token response.',
  );
}

export async function refreshOAuthCredential(
  params: RefreshExchangeParams,
): Promise<OAuthCredential> {
  const { baseUrl, current, now } = params;
  if (!current.refresh_token) {
    throw authError(
      'No refresh token for this credential. Run `amp auth login`.',
      'authentication_required',
    );
  }

  const request =
    params.request ??
    createAnonymousRequest(baseUrl, {
      timeoutMs: REFRESH_TIMEOUT_MS,
    });

  let response: { status: number; body: unknown };
  try {
    response = await request('POST', '/v1/auth/token', {
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
    });
  } catch {
    throw transportError(
      `Could not reach the API at ${baseUrl} to refresh the session.`,
    );
  }

  if (response.status >= 200 && response.status < 300) {
    const token = parseTokenResponse(response.body);
    const base = oauthCredentialFromToken(token, now);
    return {
      ...current,
      ...base,
      // Rotation-preserve: a non-rotating refresh response omits
      // refresh_token/scope, so keep the current credential's values rather
      // than dropping a still-valid refresh token.
      refresh_token: token.refresh_token ?? current.refresh_token,
      scope: token.scope ?? current.scope,
    };
  }

  const code = oauthErrorCode(response.body);
  if (response.status === 400 || response.status === 401) {
    const description = oauthErrorDescription(response.body);
    if (
      code !== undefined &&
      !STANDARD_OAUTH_ERROR_CODES.has(code) &&
      description !== undefined
    ) {
      // Deliberate server message (non-standard code) — surface it verbatim.
      throw authError(description, 'authentication_required');
    }
    throw authError(
      `Session for this profile has expired (${code ?? 'invalid_grant'}). Run \`amp auth login\`.`,
      'authentication_required',
    );
  }
  throw transportError(
    'The authorization server could not refresh the session. Try again.',
  );
}

interface LockedRefreshParams {
  name: string;
  now: number;
  // Reactive (post-401) path: the access token that was just rejected. Refresh
  // only if the on-disk token is still this one — if a peer already refreshed
  // while we waited for the lock, its token is adopted instead of forcing
  // another rotation. Omit for the proactive path (which gates on expiry).
  staleAccessToken?: string;
  expectedProfileBaseUrl?: string;
  path?: string;
  deps?: {
    request?: AnonymousRequest;
    lock?: typeof lock;
    save?: typeof saveStore;
  };
}

function isExpired(expiresAt: string, now: number): boolean {
  const at = Date.parse(expiresAt);
  // An unparseable expiry is left to the server to reject rather than locking
  // the user out locally on a format quirk (mirrors credential-resolver.ts).
  return Number.isNaN(at) ? false : at <= now;
}

export interface LockedRefreshResult {
  credential: OAuthCredential;
  // False when the credential came from a peer that refreshed while we waited
  // for the lock — no rotation happened here, so callers that gate a retry on
  // "we just minted this" must not treat it as fresh.
  rotated: boolean;
}

type RefreshLockStep =
  | { kind: 'complete'; result: LockedRefreshResult }
  | { kind: 'persist_after_release'; persist: () => LockedRefreshResult };

function isSameCredentialGeneration(
  latestProfile: Profile | undefined,
  sourceProfile: Profile,
  sourceCredential: OAuthCredential,
): latestProfile is Profile {
  if (!latestProfile || latestProfile.base_url !== sourceProfile.base_url) {
    return false;
  }

  const latestCredential = oauthCredentialSchema.safeParse(
    latestProfile.credential,
  );
  return (
    latestCredential.success &&
    isDeepStrictEqual(latestCredential.data, sourceCredential)
  );
}

export async function refreshProfileTokenLocked(
  params: LockedRefreshParams,
): Promise<LockedRefreshResult> {
  const path = params.path ?? credentialsPath();
  const step = await withCredentialLock<RefreshLockStep>(
    path,
    async (state) => {
      const store = loadStore(path);
      const profile = getProfile(store, params.name);
      if (!profile) {
        throw authError(
          `No such profile: ${params.name}. Run \`amp auth login\`.`,
        );
      }
      if (
        params.staleAccessToken !== undefined &&
        params.expectedProfileBaseUrl !== undefined &&
        profile.base_url !== params.expectedProfileBaseUrl
      ) {
        throw transportError(
          'Profile changed while this command was running. Retry the command.',
        );
      }
      const oauth = oauthCredentialSchema.safeParse(profile.credential);
      if (!oauth.success) {
        throw authError(
          `Profile "${params.name}" is not an OAuth credential.`,
          'invalid_token',
        );
      }
      // Double-check under the lock: a peer may have already refreshed this
      // profile while we waited for the lock, so avoid a redundant rotation.
      if (params.staleAccessToken !== undefined) {
        // Reactive: only refresh if the rejected token is still the current
        // one; otherwise a peer already refreshed — adopt their token.
        if (oauth.data.access_token !== params.staleAccessToken) {
          return {
            kind: 'complete',
            result: { credential: oauth.data, rotated: false },
          };
        }
      } else if (!isExpired(oauth.data.expires_at, params.now)) {
        // Proactive: still valid on disk, so a peer refreshed it.
        return {
          kind: 'complete',
          result: { credential: oauth.data, rotated: false },
        };
      }
      // Once the exchange succeeds below, the new refresh token must be
      // persisted even if compromise is reported in flight; discarding a
      // completed rotation would strand the profile on the consumed token.
      const fresh = await refreshOAuthCredential({
        baseUrl: profile.base_url,
        current: oauth.data,
        now: params.now,
        request: params.deps?.request,
      });

      const persistFresh = (): LockedRefreshResult => {
        // Re-read right before writing and require the same credential
        // generation we actually refreshed. If a peer logged out or
        // re-authenticated this profile after taking the compromised lock,
        // their explicit change wins; resurrecting or overwriting it could
        // pair a token with the wrong backend and strand the user.
        const latest = loadStore(path);
        const latestProfile = getProfile(latest, params.name);
        if (!isSameCredentialGeneration(latestProfile, profile, oauth.data)) {
          throw transportError(
            `Profile "${params.name}" changed while its session was refreshing; try again.`,
          );
        }

        try {
          (params.deps?.save ?? saveStore)(
            setProfile(latest, params.name, {
              ...latestProfile,
              credential: fresh,
              saved_at: new Date(params.now).toISOString(),
            }),
            path,
          );
        } catch (error) {
          debugCredentialPersistenceError(
            'could not save refreshed credentials',
            error,
          );
          throw authError(
            'Your session could not be saved. Check available disk space and file permissions, then run `amp auth login`.',
          );
        }
        return { credential: fresh, rotated: true };
      };

      if (state.isCompromised()) {
        // proper-lockfile is not reentrant. Return first so the outer finally
        // releases the old lock, then reacquire below before reconciling.
        return { kind: 'persist_after_release', persist: persistFresh };
      }

      return { kind: 'complete', result: persistFresh() };
    },
    { lock: params.deps?.lock },
  );

  if (step.kind === 'complete') {
    return step.result;
  }

  return withCredentialLock(path, () => step.persist(), {
    lock: params.deps?.lock,
    retryMode: 'rotation_recovery',
    acquireError: () =>
      authError(
        'Your saved session could not be updated safely. Run `amp auth login` before retrying.',
      ),
  });
}
