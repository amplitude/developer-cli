/* eslint-disable no-console */
import { text } from 'node:stream/consumers';

import { type FlagValue, isFlagEnabled, stringFlag } from './args';
import {
  personalAccessTokenSetupUrl,
  resolveAppOrigin,
  resolveOrgUrl,
} from './auth-guidance';
import {
  type AnonymousRequest,
  type DeviceFlowOptions,
  createAnonymousRequest,
  pollDeviceTokenBounded,
  requestDeviceToken,
} from './authToken';
import { authError, CliError, usageError } from './cli-error';
import {
  assertRegionAndEnvNotBothSet,
  DEFAULT_POLL_TIMEOUT_SECONDS,
  ENV_BASE_URLS,
  resolveNamedBaseUrl,
} from './config';
import {
  resolveAuthFromFlags,
  resolveAuthWithRefresh,
  selectProfileFromFlags,
} from './credential-resolver';
import {
  type Credential,
  type CredentialStore,
  type OAuthCredential,
  type PatCredential,
  type Profile,
  type UpdateStoreOptions,
  assertValidProfileName,
  emptyStore,
  getProfile,
  loadStore,
  oauthCredentialSchema,
  removeProfile,
  setDefault,
  setProfile,
  updateStore,
} from './credential-store';
import { toOAuthError } from './oauthError';
import {
  deviceAuthorizationResponseSchema,
  type TokenResponse,
} from './oauthResponseSchemas';
import { formatJsonOutput, shouldUseJsonOutput } from './output';
import {
  emptyPending,
  gcExpiredPending,
  getPending,
  isPendingExpired,
  loadPending,
  type PendingEntry,
  type PendingStore,
  pendingPath as defaultPendingPath,
  removePending,
  savePending,
  setPending,
} from './pending-store';
import { askSecret, confirm } from './prompt';
import { DEFAULT_SCOPES } from './scopes';
import { terminal, terminalForStdout } from './terminal';

export type LogoutAllGateDecision = 'block' | 'confirm' | 'proceed';

/**
 * Decides whether `amp logout --all` may wipe every stored profile. Mirrors the
 * DELETE gate: interactive confirm at a TTY, `--yes` in scripts, block otherwise.
 */
export function logoutAllGateDecision(options: {
  isTTY: boolean;
  yes: boolean;
}): LogoutAllGateDecision {
  if (options.yes) {
    return 'proceed';
  }
  return options.isTTY ? 'confirm' : 'block';
}

/** Builds an OAuth credential record from a freshly minted device-flow token. */
export function oauthCredentialFromToken(
  token: TokenResponse,
  now: number,
): OAuthCredential {
  return {
    type: 'oauth',
    access_token: token.access_token,
    token_type: token.token_type,
    expires_at: new Date(now + token.expires_in * 1000).toISOString(),
    refresh_token: token.refresh_token ?? undefined,
    scope: token.scope ?? undefined,
  };
}

/**
 * The base URL a login targets. Force-explicit: creating a profile needs an
 * explicit `--base-url` or `--env`; re-authing an existing profile reuses the
 * env recorded on it (so a bare re-login keeps working).
 */
export function loginBaseUrl(args: {
  baseUrlFlag?: string;
  envFlag?: string;
  regionFlag?: string;
  existing?: Profile;
}): string {
  assertRegionAndEnvNotBothSet(args);
  if (args.baseUrlFlag) {
    return args.baseUrlFlag.replace(/\/$/, '');
  }
  const named = resolveNamedBaseUrl({
    envFlag: args.envFlag,
    regionFlag: args.regionFlag,
  });
  if (named) {
    return named;
  }
  if (args.existing) {
    return args.existing.base_url;
  }
  throw usageError('Creating a profile requires --region <us|eu>.');
}

/**
 * The profile name a create-or-reauth verb targets: an explicit `--profile`,
 * else the active pointer (`store.default`), else the implicit `default`
 * (materialized on first login). Throws when relying on a *set* pointer whose
 * profile is gone (an orphaned hand-edited default) so the caller matches the
 * resolver's "No such profile" wording rather than falling into loginBaseUrl's
 * create-time "requires --region". A cold store (unset pointer) falls through to
 * `default` and create-mode.
 */
export function targetProfileName(
  store: CredentialStore,
  requestedName: string | undefined,
): string {
  if (requestedName !== undefined) {
    assertValidProfileName(requestedName);
    return requestedName;
  }
  if (store.default) {
    if (!getProfile(store, store.default)) {
      throw usageError(
        `No such profile: ${store.default}. Run \`amp auth list\`.`,
      );
    }
    return store.default;
  }
  return 'default';
}

/**
 * Wraps a phase response in the `{ status, message, data | error }` envelope
 * every agent-driven auth verb emits. `status` is always a string enum;
 * secrets (`device_code`) must never be passed in `data`.
 */
export function authFlowJson(
  payload: {
    status:
      | 'verification_required'
      | 'pending'
      | 'authorized'
      | 'expired'
      | 'error';
    message: string;
    data?: Record<string, unknown>;
    error?: Record<string, unknown>;
  },
  isTTY: boolean,
): string {
  return isTTY ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

export interface AuthStartDeps {
  path?: string;
  pendingPath?: string;
  now?: () => number;
  stdout?: (line: string) => void;
  request?: AnonymousRequest;
  isTTY?: boolean;
}

/**
 * `amp auth login start` — device-flow phase 1. Requests a device
 * authorization, stashes the secret `device_code` in the
 * pending-logins store (never emitted), and prints the JSON envelope an agent
 * relays to the human: the `user_code` to confirm and the poll command to run
 * next.
 */
export async function runAuthLoginStart(
  flags: Record<string, FlagValue>,
  deps: AuthStartDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const emit = deps.stdout ?? ((line) => console.log(line));
  const pPath = deps.pendingPath ?? defaultPendingPath();
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const toJson = (payload: Parameters<typeof authFlowJson>[0]): string =>
    authFlowJson(payload, isTTY);

  // Machine verb: any validation/parse failure must still be a JSON envelope,
  // never a thrown prose error to stderr.
  try {
    const store = loadStore(deps.path);
    const profileName = targetProfileName(
      store,
      stringFlag(flags, ['profile']),
    );
    const existing = getProfile(store, profileName);
    const baseUrl = loginBaseUrl({
      baseUrlFlag: stringFlag(flags, ['base-url']),
      envFlag: stringFlag(flags, ['env']),
      regionFlag: stringFlag(flags, ['region']),
      existing,
    });

    if (
      existing &&
      existing.base_url !== baseUrl &&
      !isFlagEnabled(flags.force)
    ) {
      // A retarget refusal is a usage error, like a missing --region — throw so
      // the catch emits usage_error/exit 2, matching `auth pat` instead of a
      // bespoke profile_target_conflict/exit 1.
      throw usageError(
        `Profile "${profileName}" targets ${existing.base_url}; refusing to silently retarget it to ${baseUrl}. Use a different --profile, or pass --force to overwrite.`,
      );
    }

    const request = deps.request ?? createAnonymousRequest(baseUrl);
    const response = await request('POST', '/v1/auth/device-authorization', {
      scope: DEFAULT_SCOPES,
    });
    if (response.status < 200 || response.status >= 300) {
      const oauthError = toOAuthError(response.body);
      const detail = oauthError.error_description ?? oauthError.error_hint;
      emit(
        toJson({
          status: 'error',
          message: `Could not start device authorization: ${detail ?? oauthError.error}.`,
          error: {
            error_code: oauthError.error,
            detail: detail ?? undefined,
            status: response.status,
          },
        }),
      );
      process.exitCode = 1;
      return;
    }
    const parsed = deviceAuthorizationResponseSchema.safeParse(response.body);
    if (!parsed.success) {
      emit(
        toJson({
          status: 'error',
          message:
            'The authorization server returned an unexpected device-authorization response.',
          error: { error_code: 'unexpected_response' },
        }),
      );
      process.exitCode = 1;
      return;
    }
    const device = parsed.data;
    const expiresAt = new Date(now() + device.expires_in * 1000).toISOString();
    const entry: PendingEntry = {
      device_code: device.device_code,
      base_url: baseUrl,
      expires_at: expiresAt,
      interval: device.interval ?? 5,
      started_at: new Date(now()).toISOString(),
    };
    // Every start mints a fresh code; we never resume (a stale or errored code
    // must never trap the user). Opportunistically GC expired entries on the way
    // in, so abandoned logins don't accumulate. After GC, any remaining entry for
    // this profile is a still-live code being overwritten — flag it so the agent
    // steers the human to the new code, not one they may already have open.
    const pending = gcExpiredPending(loadPending(pPath), now());
    const supersededPriorLogin = pending.pending[profileName] !== undefined;
    savePending(setPending(pending, profileName, entry), pPath);

    const verificationUrl =
      device.verification_uri_complete ?? device.verification_uri;
    const pollCmd = `amp auth login poll --profile ${profileName} --json`;
    const supersedeNote = supersededPriorLogin
      ? ' This replaces an earlier in-progress code for this profile — have the user use this one.'
      : '';
    emit(
      toJson({
        status: 'verification_required',
        message: `Ask the user to open ${verificationUrl} and confirm code ${device.user_code}, then run \`${pollCmd}\` until it reports authorized. Each poll blocks up to ~${DEFAULT_POLL_TIMEOUT_SECONDS}s by default (pass \`--timeout <seconds>\`, or \`--timeout 0\` for a single check).${supersedeNote}`,
        data: {
          user_code: device.user_code,
          verification_uri: device.verification_uri,
          verification_uri_complete: verificationUrl,
          expires_at: expiresAt,
          expires_in_seconds: device.expires_in,
          region: regionLabelForBaseUrl(baseUrl)?.toLowerCase(),
          profile: profileName,
          scopes: DEFAULT_SCOPES.split(' '),
        },
      }),
    );
  } catch (error) {
    // A thrown CliError (e.g. loginBaseUrl's "requires --region", a usage
    // error) already classifies itself — carry its code and exit code into
    // the envelope instead of flattening every failure to start_failed/1, so
    // the same mistake exits 2 here as it does on `auth pat`.
    if (error instanceof CliError) {
      emit(
        toJson({
          status: 'error',
          message: error.message,
          error: { error_code: error.errorCode, detail: error.detail },
        }),
      );
      process.exitCode = error.exitCode;
      return;
    }
    emit(
      toJson({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        error: {
          error_code: 'start_failed',
          detail: error instanceof Error ? error.message : undefined,
        },
      }),
    );
    process.exitCode = 1;
  }
}

/**
 * Resolves which profile `amp auth login poll` targets: an explicit
 * `--profile`, else the sole in-flight pending login, else the store's active
 * default (when it has a pending entry). Returns an error when there's nothing
 * to poll, or when more than one pending login exists and none of the above
 * disambiguates it (we never guess a profile out of several live logins).
 */
export function resolvePollProfile(
  pending: PendingStore,
  explicit: string | undefined,
  storeDefault: string | undefined,
  now: number,
):
  | { name: string }
  | {
      error: string;
      code: 'no_pending_login' | 'ambiguous_pending_login';
    } {
  if (explicit) {
    return { name: explicit };
  }
  // Only non-expired entries are in-flight. Expired ones are removed lazily
  // (when poll targets them), so a leftover stale entry must not shadow the live
  // login or manufacture false ambiguity when --profile is omitted.
  const live = Object.keys(pending.pending).filter(
    (name) => !isPendingExpired(pending.pending[name], now),
  );
  if (live.length === 1) {
    return { name: live[0] };
  }
  if (storeDefault && live.includes(storeDefault)) {
    return { name: storeDefault };
  }
  if (live.length === 0) {
    return {
      error: `No login in progress. Start one with \`${loginStartRestartHint()}\`.`,
      code: 'no_pending_login',
    };
  }
  return {
    error: `Ambiguous: pending logins for ${live.join(', ')}. Pass --profile <name>.`,
    code: 'ambiguous_pending_login',
  };
}

/**
 * The `amp auth login start` command to suggest in a restart hint. Derives
 * `--region <us|eu>` from a pending entry's `base_url` when known (via
 * `regionLabelForBaseUrl`); falls back to the generic `<us|eu>` placeholder
 * when there's no entry to derive from, or its base_url isn't a recognized
 * region (e.g. an internal/dev host).
 */
function loginStartRestartHint(baseUrl?: string): string {
  const region = baseUrl && regionLabelForBaseUrl(baseUrl)?.toLowerCase();
  return `amp auth login start --region ${region ?? '<us|eu>'} --json`;
}

export interface AuthPollDeps extends AuthStartDeps {
  sleep?: (seconds: number) => Promise<void>;
  lock?: UpdateStoreOptions['lock'];
  save?: UpdateStoreOptions['save'];
}

/**
 * Parses `--timeout` into whole seconds: omitted falls back to the default,
 * an explicit value must be a finite non-negative integer (0 means single-shot).
 * Returns `undefined` on invalid input rather than throwing, so the caller can
 * emit an error envelope instead of crashing the process.
 */
function parseTimeoutSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return DEFAULT_POLL_TIMEOUT_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

/**
 * `amp auth login poll` — device-flow phase 2. Resolves the in-flight
 * profile (see `resolvePollProfile`), then makes one bounded poll attempt
 * against `/v1/auth/token`: `authorized` saves + activates the profile and
 * clears the pending entry; `pending` reports back (exit 75) for the agent to
 * retry; `expired`/`error` clear the pending entry and exit non-zero. Never
 * emits the pending entry's secret `device_code`.
 */
export async function runAuthLoginPoll(
  flags: Record<string, FlagValue>,
  deps: AuthPollDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const emit = deps.stdout ?? ((line) => console.log(line));
  const sleep =
    deps.sleep ??
    ((seconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000)));
  const pPath = deps.pendingPath ?? defaultPendingPath();
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const toJson = (payload: Parameters<typeof authFlowJson>[0]): string =>
    authFlowJson(payload, isTTY);

  // Machine verb: any unexpected failure must still be a JSON envelope.
  try {
    const store = loadStore(deps.path);
    const pending = loadPending(pPath);
    const resolved = resolvePollProfile(
      pending,
      stringFlag(flags, ['profile']),
      store.default,
      now(),
    );
    if ('error' in resolved) {
      emit(
        toJson({
          status: 'error',
          message: resolved.error,
          error: { error_code: resolved.code },
        }),
      );
      process.exitCode = 1;
      return;
    }

    const name = resolved.name;
    const entry = getPending(pending, name);
    if (!entry) {
      emit(
        toJson({
          status: 'error',
          message: `No pending login for "${name}". Start one with \`${loginStartRestartHint()}\`.`,
          error: { error_code: 'no_pending_login' },
        }),
      );
      process.exitCode = 1;
      return;
    }

    const clearPending = (): void => {
      const current = loadPending(pPath);
      // A concurrent `start` may have superseded our entry with a fresh
      // device_code; only clear the row we were actually polling, never a
      // newer in-progress login.
      if (getPending(current, name)?.device_code !== entry.device_code) {
        return;
      }
      savePending(removePending(current, name), pPath);
    };

    if (isPendingExpired(entry, now())) {
      clearPending();
      emit(
        toJson({
          status: 'expired',
          message: `The device code expired before confirmation. Start over with \`${loginStartRestartHint(entry.base_url)}\`.`,
        }),
      );
      process.exitCode = 1;
      return;
    }

    const timeoutRaw = stringFlag(flags, ['timeout']);
    const timeoutSeconds = parseTimeoutSeconds(timeoutRaw);
    if (timeoutSeconds === undefined) {
      emit(
        toJson({
          status: 'error',
          message: `Invalid --timeout "${timeoutRaw}". Must be a non-negative integer number of seconds.`,
          error: { error_code: 'invalid_timeout' },
        }),
      );
      // A bad flag value is a usage error — exit 2, matching every other
      // invalid invocation, not the generic 1.
      process.exitCode = 2;
      return;
    }
    const request = deps.request ?? createAnonymousRequest(entry.base_url);

    const result = await pollDeviceTokenBounded({
      request,
      deviceCode: entry.device_code,
      intervalSeconds: entry.interval,
      codeExpiresAtMs: Date.parse(entry.expires_at),
      timeoutSeconds,
      now,
      sleep,
    });

    if (result.status === 'authorized') {
      const profile: Profile = {
        base_url: entry.base_url,
        credential: oauthCredentialFromToken(result.token, now()),
        saved_at: new Date(now()).toISOString(),
        store: 'file',
      };
      // updateStore locks, reloads, and writes atomically, so a concurrent
      // auth saved during the poll's long wait isn't clobbered.
      await updateStore(
        deps.path,
        (fresh) => setDefault(setProfile(fresh, name, profile), name),
        {
          lock: deps.lock,
          save: deps.save,
          retryMode: 'rotation_recovery',
          acquireError: completedSignInSaveError,
          persistError: completedSignInWriteError,
        },
      );
      // Profile is now authenticated, so any pending code for it is moot —
      // clear unconditionally (unlike the error/expired paths, which guard on
      // device_code to avoid nuking a fresh start). Otherwise a code a
      // concurrent `start` minted mid-poll would linger and make later polls
      // misreport `pending` for an already-authenticated profile.
      savePending(removePending(loadPending(pPath), name), pPath);
      emit(
        toJson({
          status: 'authorized',
          message: `Logged in; profile "${name}" activated. Confirm with \`amp context --json\`.`,
          data: {
            profile: name,
            base_url: entry.base_url,
            region: regionLabelForBaseUrl(entry.base_url)?.toLowerCase(),
            token_expires_at:
              profile.credential.type === 'oauth'
                ? profile.credential.expires_at
                : undefined,
            scopes: result.token.scope
              ? result.token.scope.split(' ')
              : undefined,
          },
        }),
      );
      return;
    }

    if (result.status === 'pending') {
      // Persist a slow_down-raised interval so the next poll subprocess honors it
      // (RFC 8628 §3.5 — the raised interval applies to all subsequent requests).
      // Only onto the row we actually polled: a concurrent `start` may have
      // superseded it, and this slow_down was raised against the old code, so it
      // must not inflate the fresh code's interval (nor clobber its device_code).
      const fresh = loadPending(pPath);
      const current = getPending(fresh, name);
      if (
        current &&
        current.device_code === entry.device_code &&
        current.interval !== result.interval
      ) {
        savePending(
          setPending(fresh, name, { ...current, interval: result.interval }),
          pPath,
        );
      }
      emit(
        toJson({
          status: 'pending',
          message: `Not confirmed yet. Re-run \`amp auth login poll --profile ${name} --json\` immediately — it blocks up to ~${timeoutSeconds}s internally; no sleep needed.`,
          data: {
            expires_at: entry.expires_at,
            poll_waits_seconds: timeoutSeconds,
          },
        }),
      );
      process.exitCode = 75;
      return;
    }

    clearPending();
    if (result.status === 'expired') {
      emit(
        toJson({
          status: 'expired',
          message: `The device code expired before confirmation. Start over with \`${loginStartRestartHint(entry.base_url)}\`.`,
        }),
      );
    } else {
      const detail = result.error.description ?? result.error.hint;
      emit(
        toJson({
          status: 'error',
          message: `Authorization failed: ${detail ?? result.error.code}. Start over with \`${loginStartRestartHint(entry.base_url)}\`.`,
          error: {
            error_code: result.error.code,
            detail: detail ?? undefined,
          },
        }),
      );
    }
    process.exitCode = 1;
  } catch (error) {
    // A thrown CliError (e.g. a bare `--profile` with no value) is already a
    // classified usage error — surface its code and exit code rather than
    // wrapping it as a retryable poll_failed/1.
    if (error instanceof CliError) {
      emit(
        toJson({
          status: 'error',
          message: error.message,
          error: { error_code: error.errorCode, detail: error.detail },
        }),
      );
      process.exitCode = error.exitCode;
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    emit(
      toJson({
        status: 'error',
        message: `${detail} The pending login is preserved — re-run the poll command to retry.`,
        error: {
          error_code: 'poll_failed',
          detail: error instanceof Error ? error.message : undefined,
        },
      }),
    );
    process.exitCode = 1;
  }
}

/**
 * Drops any in-flight `login start` entry for `name`. Completing auth
 * out-of-band (interactive `login`, `pat`) strands the device-flow code the
 * agent started; without this a later `login poll` would keep hammering the
 * abandoned code and reporting `pending` until it expired. No write when
 * there's nothing pending for the profile.
 */
function clearPendingLogin(pendingPath: string, name: string): void {
  const pending = loadPending(pendingPath);
  if (!getPending(pending, name)) {
    return;
  }
  savePending(removePending(pending, name), pendingPath);
}

function completedSignInSaveError(): CliError {
  return authError(
    'Sign-in succeeded, but the session could not be saved. Run `amp auth login` again.',
  );
}

function completedSignInWriteError(): CliError {
  return authError(
    'Sign-in succeeded, but the session could not be saved. Check available disk space and file permissions, then run `amp auth login` again.',
  );
}

export interface AuthLoginDeps {
  requestToken?: (options: DeviceFlowOptions) => Promise<TokenResponse>;
  now?: () => number;
  path?: string;
  pendingPath?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  confirm?: (message: string) => Promise<boolean>;
  lock?: UpdateStoreOptions['lock'];
  save?: UpdateStoreOptions['save'];
}

/**
 * `amp auth login` — runs the device flow, saves the token as an OAuth profile,
 * and activates it (announcing the switch). `--profile` is optional: omitting
 * it targets the active pointer, else the implicit `default` profile (see
 * `targetProfileName`). Creating a profile also requires `--env`/`--base-url`.
 */
export async function runAuthLogin(
  flags: Record<string, FlagValue>,
  deps: AuthLoginDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const emitStderr = deps.stderr ?? ((line) => console.error(line));
  const confirmOverwrite = deps.confirm ?? confirm;
  const requestToken = deps.requestToken ?? requestDeviceToken;

  const store = loadStore(deps.path);

  const profileName = targetProfileName(store, stringFlag(flags, ['profile']));
  const existing = getProfile(store, profileName);

  const regionFlag = stringFlag(flags, ['region']);
  const baseUrlFlag = stringFlag(flags, ['base-url']);
  const baseUrl = loginBaseUrl({
    baseUrlFlag,
    envFlag: stringFlag(flags, ['env']),
    regionFlag,
    existing,
  });
  if (regionFlag && !baseUrlFlag) {
    emitStdout(
      `Authenticating to ${resolveAppOrigin({ apiBaseUrl: baseUrl })}/`,
    );
  }

  // Reusing a name for a different target is almost always a mistake — confirm
  // before clobbering, unless --force opts in (mirrors auth pat / login start).
  // Same target is a silent refresh.
  if (
    existing &&
    existing.base_url !== baseUrl &&
    !isFlagEnabled(flags.force)
  ) {
    const approved = await confirmOverwrite(
      `Profile "${profileName}" currently targets ${existing.base_url}. Overwrite to ${baseUrl}?`,
    );
    if (!approved) {
      throw new Error('Aborted.'); // plain-error-ok: TTY-only user cancellation; unreachable non-interactively.
    }
  }

  const token = await requestToken({
    flow: stringFlag(flags, ['flow']) ?? 'device',
    scope: stringFlag(flags, ['scope']) ?? DEFAULT_SCOPES,
    request: createAnonymousRequest(baseUrl),
    stderr: emitStderr,
  });

  const profile: Profile = {
    base_url: baseUrl,
    credential: oauthCredentialFromToken(token, now()),
    saved_at: new Date(now()).toISOString(),
    store: 'file',
  };

  // updateStore locks, reloads, and writes atomically, so a transparent
  // refresh (or other auth command) that landed during the long device flow
  // isn't clobbered.
  const previousDefault = store.default;
  await updateStore(
    deps.path,
    (fresh) => setDefault(setProfile(fresh, profileName, profile), profileName),
    {
      lock: deps.lock,
      save: deps.save,
      retryMode: 'rotation_recovery',
      acquireError: completedSignInSaveError,
      persistError: completedSignInWriteError,
    },
  );
  clearPendingLogin(deps.pendingPath ?? defaultPendingPath(), profileName);

  const verb = existing ? 'updated' : 'created';
  const wasNote =
    previousDefault && previousDefault !== profileName
      ? ` (was "${previousDefault}")`
      : '';
  emitStdout(
    terminal.success(
      `Profile "${profileName}" ${verb} and set as default${wasNote}.`,
    ),
  );
}

/** Strips Bearer / PAT= prefixes from a pasted token, leaving the bare PAT. */
export function normalizePat(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('Bearer ')) {
    value = value.slice('Bearer '.length).trim();
  }
  if (value.startsWith('PAT=')) {
    value = value.slice('PAT='.length).trim();
  }
  return value;
}

/**
 * Reads a PAT for `--with-token`: from stdin when piped (the agent / CI path),
 * or a masked prompt at a TTY (the human path). Honors the "two readers"
 * tenet — one flag, both input modes.
 */
async function readWithToken(
  baseUrl: string,
  emitStdout: (line: string) => void,
): Promise<string> {
  if (process.stdin.isTTY) {
    emitStdout(
      `Create a PAT with the scopes you need at:\n  ${personalAccessTokenSetupUrl(
        { apiBaseUrl: baseUrl, orgUrl: resolveOrgUrl() },
      )}`,
    );
    return askSecret('Paste your Personal Access Token: ');
  }
  return text(process.stdin);
}

export interface AuthPatDeps {
  path?: string;
  pendingPath?: string;
  now?: () => number;
  stdout?: (line: string) => void;
  // Test seam: supplies the raw token in place of stdin / the masked prompt.
  readToken?: () => Promise<string>;
}

/**
 * `amp auth pat --with-token` — save a supplied Personal Access Token as a
 * profile and activate it. The token is read from stdin when piped, or a masked
 * prompt at a TTY. `--profile` is optional: omitting it targets the active
 * pointer, else the implicit `default` profile (see `targetProfileName`).
 * Creating a profile still requires `--env`/`--base-url`; re-auth of an
 * existing profile reuses its recorded env.
 *
 * `--with-token` is mandatory: it makes the supply-an-existing-PAT path
 * explicit and keeps the bare `amp auth pat` verb reserved.
 */
export async function runAuthPat(
  flags: Record<string, FlagValue>,
  deps: AuthPatDeps = {},
): Promise<void> {
  if (!isFlagEnabled(flags['with-token'])) {
    throw usageError(
      '`amp auth pat` requires --with-token to supply an existing PAT (piped on stdin, or pasted at a prompt).',
    );
  }

  const now = deps.now ?? (() => Date.now());
  const emitStdout = deps.stdout ?? ((line) => console.log(line));

  const store = loadStore(deps.path);
  const profileName = targetProfileName(store, stringFlag(flags, ['profile']));
  const existing = getProfile(store, profileName);
  const regionFlag = stringFlag(flags, ['region']);
  const baseUrlFlag = stringFlag(flags, ['base-url']);
  const baseUrl = loginBaseUrl({
    baseUrlFlag,
    envFlag: stringFlag(flags, ['env']),
    regionFlag,
    existing,
  });
  if (regionFlag && !baseUrlFlag) {
    emitStdout(
      `Authenticating to ${resolveAppOrigin({ apiBaseUrl: baseUrl })}/`,
    );
  }

  // Reusing a name for a different target is almost always a mistake — block
  // unless the caller explicitly opts in with --force (mirrors
  // `auth login --start`'s gate; no interactive confirm here since this path
  // must also work non-interactively/piped).
  if (
    existing &&
    existing.base_url !== baseUrl &&
    !isFlagEnabled(flags.force)
  ) {
    throw usageError(
      `Profile "${profileName}" targets ${existing.base_url}; refusing to silently retarget it to ${baseUrl}. Use a different --profile, or pass --force to overwrite.`,
    );
  }

  const readToken =
    deps.readToken ?? (() => readWithToken(baseUrl, emitStdout));
  const pat = normalizePat(await readToken());
  if (!pat) {
    throw usageError('PAT cannot be empty.');
  }

  const credential: PatCredential = { type: 'pat', pat };
  const profile: Profile = {
    base_url: baseUrl,
    credential,
    saved_at: new Date(now()).toISOString(),
    store: 'file',
  };

  // updateStore locks, reloads, and writes atomically, so a transparent
  // refresh (or other auth command) that landed during interactive PAT entry
  // isn't clobbered.
  const previousDefault = store.default;
  await updateStore(deps.path, (fresh) =>
    setDefault(setProfile(fresh, profileName, profile), profileName),
  );
  clearPendingLogin(deps.pendingPath ?? defaultPendingPath(), profileName);

  const verb = existing ? 'updated' : 'created';
  const wasNote =
    previousDefault && previousDefault !== profileName
      ? ` (was "${previousDefault}")`
      : '';
  emitStdout(
    terminal.success(
      `Profile "${profileName}" ${verb} and set as default${wasNote}.`,
    ),
  );
}

interface ProfileCommandDeps {
  path?: string;
  pendingPath?: string;
  now?: () => number;
  stdout?: (line: string) => void;
  confirm?: (message: string) => Promise<boolean>;
  isTTY?: boolean;
}

/** Reverses a base_url back to its friendly `--env` name when one is known. */
export function envLabel(baseUrl: string): string {
  for (const [name, url] of Object.entries(ENV_BASE_URLS)) {
    if (url === baseUrl) {
      return name;
    }
  }
  return baseUrl;
}

/** US/EU label for `auth status`, shown only for prod/prod-eu profiles. */
export function regionLabelForBaseUrl(baseUrl: string): string | undefined {
  if (baseUrl === ENV_BASE_URLS.prod) {
    return 'US';
  }
  if (baseUrl === ENV_BASE_URLS['prod-eu']) {
    return 'EU';
  }
  return undefined;
}

function humanizeDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Time-to-expiry label for `auth list` — only OAuth tokens expire. */
export function expiryLabel(credential: Credential, now: number): string {
  const oauth = oauthCredentialSchema.safeParse(credential);
  if (!oauth.success) {
    return '—';
  }
  const at = Date.parse(oauth.data.expires_at);
  if (Number.isNaN(at)) {
    return '—';
  }
  return at <= now ? 'expired' : `in ${humanizeDuration(at - now)}`;
}

export function formatProfileList(store: CredentialStore, now: number): string {
  const names = Object.keys(store.profiles);
  if (names.length === 0) {
    return 'No profiles. Run `amp auth login`.';
  }

  const rows = names.map((name) => {
    const profile = store.profiles[name];
    return {
      marker: store.default === name ? '*' : ' ',
      profile: name,
      type: profile.credential.type,
      env: envLabel(profile.base_url),
      expires: expiryLabel(profile.credential, now),
    };
  });

  // Pad each column to the widest cell (header included) so the table aligns
  // regardless of profile-name / env length. Trailing column isn't padded.
  const header = {
    profile: 'PROFILE',
    type: 'TYPE',
    env: 'ENV',
    expires: 'EXPIRES',
  };
  const width = (key: 'profile' | 'type' | 'env') =>
    Math.max(header[key].length, ...rows.map((row) => row[key].length));
  const wProfile = width('profile');
  const wType = width('type');
  const wEnv = width('env');

  const line = (
    marker: string,
    cells: { profile: string; type: string; env: string; expires: string },
  ) =>
    `${marker} ${cells.profile.padEnd(wProfile)}  ${cells.type.padEnd(wType)}  ${cells.env.padEnd(wEnv)}  ${cells.expires}`.trimEnd();

  return [line(' ', header), ...rows.map((row) => line(row.marker, row))].join(
    '\n',
  );
}

/**
 * `amp auth list` — show profiles, marking the default with `*`. Piped or
 * `--json` emits `{ profiles: [...], default }` on stdout instead of the
 * table; an empty store is still exit 0 (listing succeeded, there's just
 * nothing to show).
 */
export function runAuthList(
  flags: Record<string, FlagValue>,
  deps: ProfileCommandDeps = {},
): void {
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const now = deps.now?.() ?? Date.now();
  const store = loadStore(deps.path);

  if (shouldUseJsonOutput({ jsonFlag: isFlagEnabled(flags.json), isTTY })) {
    const profiles = Object.keys(store.profiles).map((name) => {
      const profile = store.profiles[name];
      const oauth = oauthCredentialSchema.safeParse(profile.credential);
      return {
        name,
        type: profile.credential.type,
        base_url: profile.base_url,
        region: regionLabelForBaseUrl(profile.base_url)?.toLowerCase(),
        expires_at: oauth.success ? oauth.data.expires_at : undefined,
        is_default: store.default === name,
      };
    });
    emitStdout(
      formatJsonOutput({ profiles, default: store.default ?? null }, isTTY),
    );
    return;
  }

  emitStdout(formatProfileList(store, now));
}

/** `amp auth use <name>` — repoint the default with no re-auth. */
export async function runAuthUse(
  name: string | undefined,
  deps: ProfileCommandDeps = {},
): Promise<void> {
  if (!name) {
    throw usageError(
      '`amp auth use` requires a profile name: amp auth use <name>.',
    );
  }
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const previousDefault = loadStore(deps.path).default;
  // updateStore locks, reloads, and writes atomically, so repointing the
  // default can't clobber a rotation a transparent refresh persisted since.
  // The profile check belongs inside too — it may have been logged out.
  await updateStore(deps.path, (fresh) => {
    if (!getProfile(fresh, name)) {
      const known = Object.keys(fresh.profiles);
      throw usageError(
        `No such profile: ${name}.${known.length ? ` Known: ${known.join(', ')}.` : ' Run `amp auth login`.'}`,
      );
    }
    return setDefault(fresh, name);
  });
  const wasNote =
    previousDefault && previousDefault !== name
      ? ` (was "${previousDefault}")`
      : '';
  emitStdout(terminal.success(`Default profile is now "${name}"${wasNote}.`));
}

/**
 * `amp logout [--profile <name> | --all]` — remove a profile, or wipe the whole
 * store with `--all`. Target resolution is `--profile` > default > a solitary
 * in-progress login > error. Clears
 * `default` if it pointed at the removed profile and never auto-promotes a
 * survivor (the active identity only changes on an explicit command), so
 * logging out the default leaves no default set.
 */
export async function runLogout(
  flags: Record<string, FlagValue>,
  deps: ProfileCommandDeps = {},
): Promise<void> {
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const confirmLogout = deps.confirm ?? confirm;
  const now = deps.now ?? (() => Date.now());
  const pPath = deps.pendingPath ?? defaultPendingPath();
  const store = loadStore(deps.path);

  if (isFlagEnabled(flags.all)) {
    if (stringFlag(flags, ['profile'])) {
      throw usageError('Pass either --profile <name> or --all, not both.');
    }
    const count = Object.keys(store.profiles).length;
    const pendingCount = Object.keys(loadPending(pPath).pending).length;
    if (count === 0 && pendingCount === 0) {
      emitStdout('No profiles to remove.');
      return;
    }

    // Gate protects stored credentials; only apply it when there are profiles
    // to remove. An in-flight pending login is transient, so clearing it alone
    // needs no confirmation.
    if (count > 0) {
      const decision = logoutAllGateDecision({
        isTTY:
          deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
        yes: isFlagEnabled(flags.yes),
      });
      if (decision === 'block') {
        throw usageError(
          'Pass --yes to remove every stored profile with `amp logout --all`.',
        );
      }
      if (decision === 'confirm') {
        const approved = await confirmLogout(
          `Remove all ${count} profile${count === 1 ? '' : 's'}? Stored credentials cannot be recovered.`,
        );
        if (!approved) {
          throw new Error('Aborted.'); // plain-error-ok: TTY-only user cancellation; unreachable non-interactively.
        }
      }
    }

    await updateStore(deps.path, () => emptyStore());
    savePending(emptyPending(), pPath);
    emitStdout(
      terminal.success(
        count > 0
          ? `Removed all ${count} profile${count === 1 ? '' : 's'}. No credentials remain — run \`amp auth login\`.`
          : `Cleared ${pendingCount} in-progress login${pendingCount === 1 ? '' : 's'}.`,
      ),
    );
    return;
  }

  const pending = loadPending(pPath);
  // A cold `login start` leaves a pending entry but no store default yet, so
  // fall back to a solitary in-progress login — otherwise bare `logout` can't
  // cancel it, though `logout --profile <name>` can. Only live entries count
  // (expired ones are GC'd lazily), matching how `login poll` disambiguates.
  const livePending = Object.keys(pending.pending).filter(
    (name) => !isPendingExpired(pending.pending[name], now()),
  );
  const target =
    stringFlag(flags, ['profile']) ??
    store.default ??
    (livePending.length === 1 ? livePending[0] : undefined);

  if (!target) {
    throw usageError(
      'No profile to log out of. Pass --profile <name> or set a default with `amp auth use`.',
    );
  }
  const hasProfile = getProfile(store, target) !== undefined;
  const hasPending = getPending(pending, target) !== undefined;
  // A `start`ed-but-never-completed login has a pending entry with no stored
  // profile yet (e.g. first-time `default`). `logout --profile <name>` must be
  // able to cancel it, so only error when there's neither a profile nor a
  // pending login to remove.
  if (!hasProfile && !hasPending) {
    const known = Object.keys(store.profiles);
    throw usageError(
      `No such profile: ${target}.${known.length ? ` Known: ${known.join(', ')}.` : ''}`,
    );
  }

  // Drop any in-flight login for this profile — a logout shouldn't leave its
  // device-flow secrets behind. Re-read immediately before the write so a
  // `login start` for another profile that landed since the snapshot above
  // isn't clobbered (same reload-before-mutate rule the poll paths follow).
  if (hasPending) {
    savePending(removePending(loadPending(pPath), target), pPath);
  }
  if (!hasProfile) {
    emitStdout(
      terminal.success(`Canceled the in-progress login for "${target}".`),
    );
    return;
  }

  // updateStore locks, reloads, and writes atomically, so removing `target`
  // can't clobber a concurrent auth to a different profile.
  const next = await updateStore(deps.path, (fresh) =>
    removeProfile(fresh, target),
  );

  // Confirm against the persisted store rather than the snapshot: an `auth use`
  // that landed since keeps its own default, so there's nothing to warn about.
  const lostDefault = store.default === target && next.default === undefined;
  if (lostDefault) {
    const remaining = Object.keys(next.profiles);
    const pick = remaining.length
      ? `select another (${remaining.join(', ')}) with \`amp auth use <profile>\``
      : 'create one with `amp auth login`';
    emitStdout(
      terminal.success(
        `Logged out of "${target}". No default set — commands won't authenticate until you ${pick}.`,
      ),
    );
    return;
  }
  emitStdout(terminal.success(`Logged out of "${target}".`));
}

/** Masks a secret for display: first and last few chars, middle elided. */
export function maskToken(token: string): string {
  if (token.length <= 8) {
    return '••••';
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

interface AuthStatusDeps {
  store?: CredentialStore;
  path?: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  isTTY?: boolean;
}

type AuthTokenDeps = Omit<AuthStatusDeps, 'store' | 'isTTY'>;

/**
 * `amp auth status` — local inspection of the active credential. Resolves via
 * the shared precedence ladder (so it agrees with every API command), then
 * prints source, profile/type/expiry, base URL, and a masked token. Exits 0
 * when a usable credential resolves, non-zero otherwise — scriptable. When
 * `AMP_TOKEN` is in effect it is announced (the gh "exported token silently
 * shadows my login" mitigation). No network call.
 *
 * Piped or `--json`: emits a single JSON object on stdout and exits 0 when
 * authenticated. When resolution fails, stdout stays empty — the resolver's
 * `CliError` (`authentication_required`/`invalid_token`) is left to propagate
 * to `main()`'s standard error envelope on stderr, rather than being caught
 * and rendered as the TTY diagnostic below.
 */
export function runAuthStatus(
  flags: Record<string, FlagValue>,
  deps: AuthStatusDeps = {},
): void {
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const now = deps.now?.() ?? Date.now();
  const store = deps.store ?? loadStore(deps.path);

  if (shouldUseJsonOutput({ jsonFlag: isFlagEnabled(flags.json), isTTY })) {
    const auth = resolveAuthFromFlags(flags, { store, now, env: deps.env });
    const profile = auth.profile ? getProfile(store, auth.profile) : undefined;
    const oauth =
      profile && oauthCredentialSchema.safeParse(profile.credential);
    emitStdout(
      formatJsonOutput(
        {
          authenticated: true,
          source: auth.source,
          profile: auth.profile,
          type: profile?.credential.type ?? 'token',
          base_url: auth.baseUrl,
          expires_at:
            oauth && oauth.success ? oauth.data.expires_at : undefined,
          token: maskToken(auth.token),
        },
        isTTY,
      ),
    );
    return;
  }

  const styled = terminalForStdout(isTTY);
  emitStdout(`${styled.heading('Auth status')}\n`);

  const emitProfileRows = (name: string, profile: Profile): void => {
    const marker = store.default === name ? ' (default)' : '';
    emitStdout(`Profile:  ${name}${marker}`);
    emitStdout(`Type:     ${profile.credential.type}`);
    emitStdout(`Expires:  ${expiryLabel(profile.credential, now)}`);
  };

  let auth;
  try {
    auth = resolveAuthFromFlags(flags, { store, now, env: deps.env });
  } catch (error) {
    // Resolution failed — most often an expired (or otherwise unusable) stored
    // credential. Still surface the selected profile's metadata, including
    // `Expires: expired`, so status stays a useful diagnostic; then exit non-zero.
    const selected = selectProfileFromFlags(flags, { store, env: deps.env });
    if (selected) {
      emitProfileRows(selected.name, selected.profile);
    }
    emitStdout(
      styled.warning(error instanceof Error ? error.message : String(error)),
    );
    // Same failure must exit the same regardless of output mode: carry the
    // resolver's CliError exit code (invalid_token/authentication_required →
    // 3) instead of flattening the TTY path to 1, matching the JSON path.
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
    return;
  }

  if (auth.source.startsWith('AMP_TOKEN')) {
    emitStdout(
      styled.warning('AMP_TOKEN is set and overrides any stored profile.'),
    );
  }

  emitStdout(`Source:   ${styled.dim(auth.source)}`);

  const profile = auth.profile ? getProfile(store, auth.profile) : undefined;
  if (auth.profile && profile) {
    emitProfileRows(auth.profile, profile);
  }

  const region = regionLabelForBaseUrl(auth.baseUrl);
  if (region) {
    emitStdout(
      `Region:   ${region} (${resolveAppOrigin({ apiBaseUrl: auth.baseUrl })}/)`,
    );
  }
  emitStdout(`Base URL: ${styled.dim(auth.baseUrl)}`);
  emitStdout(`Token:    ${maskToken(auth.token)}`);
}

/**
 * `amp auth token` — print the resolved access token to stdout, nothing else,
 * so it pipes cleanly (`TOKEN=$(amp auth token)`). Reads the store via the
 * shared resolver instead of running a flow, transparently refreshing an
 * expired-but-refreshable profile first; when no credential resolves (or the
 * selected one has expired with no refresh token) the resolver throws and the
 * CLI exits non-zero with no stdout.
 */
export async function runAuthToken(
  flags: Record<string, FlagValue>,
  deps: AuthTokenDeps = {},
): Promise<void> {
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const auth = await resolveAuthWithRefresh(flags, {
    path: deps.path,
    now: deps.now?.(),
    env: deps.env,
  });
  emitStdout(auth.token);
}
