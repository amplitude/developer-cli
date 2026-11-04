import { setTimeout as delay } from 'node:timers/promises';

import { type FlagValue, isFlagEnabled, stringFlag } from './args';
import { oauthCredentialFromToken, targetProfileName } from './auth-commands';
import {
  type AnonymousRequest,
  completeDeviceAuthorization,
  createAnonymousRequest,
  type DeviceAuthorizationOptions,
} from './authToken';
import {
  CliError,
  exitCodeForErrorCode,
  transportError,
  usageError,
} from './cli-error';
import { resolveExplicitBaseUrl } from './config';
import {
  getProfile,
  loadStore,
  type Profile,
  setDefault,
  setProfile,
  updateStore,
} from './credential-store';
import { type TokenResponse } from './oauthResponseSchemas';
import {
  gcExpiredPending,
  getPending,
  loadPending,
  type PendingEntry,
  pendingPath as defaultPendingPath,
  removePending,
  savePending,
  setPending,
} from './pending-store';
import {
  SIGNUP_DOCUMENT_URLS,
  type SignupOutput,
  signupErrorFromResponse,
  signupLoginCommand,
  signupMissingInformationError,
  signupPollContinuation,
  signupRequestSchema,
  signupResponseSchema,
  signupSupportedFlags,
} from './signup-response';

export interface AuthSignupDeps extends Pick<
  DeviceAuthorizationOptions,
  'stdin' | 'stderr' | 'openUrl' | 'sleep'
> {
  path?: string;
  pendingPath?: string;
  now?: () => number;
  request?: AnonymousRequest;
  updateStore?: typeof updateStore;
  savePending?: typeof savePending;
  isInteractive?: boolean;
}
export type AuthSignupResult =
  | { ok: true; exitCode: 0 | 2; output: SignupOutput }
  | { ok: false; error: CliError };

const suppliedInputsSchema = signupRequestSchema
  .omit({ terms_acceptance: true })
  .partial();

function needsInformation(schema: Record<string, unknown>): AuthSignupResult {
  const error = signupMissingInformationError(schema);
  if (error) return { ok: false, error };
  return {
    ok: true,
    exitCode: 2,
    output: {
      status: 'needs_information',
      message:
        'Signup requires additional information. Supply the required information and run signup again.',
      data: { schema, supported_flags: signupSupportedFlags(schema) },
    },
  };
}

function persistenceError(code: string, message: string): AuthSignupResult {
  return {
    ok: false,
    error: new CliError({
      errorCode: code,
      message,
      exitCode: exitCodeForErrorCode(code),
    }),
  };
}

/** Sign up once, persist the resulting authentication state, and return a safe outcome. */
export async function runAuthSignup(
  flags: Record<string, FlagValue>,
  deps: AuthSignupDeps = {},
): Promise<AuthSignupResult> {
  const isInteractive =
    !isFlagEnabled(flags['non-interactive']) &&
    (deps.isInteractive ??
      Boolean(process.stdin.isTTY && process.stdout.isTTY));

  let profileName: string;
  let baseUrl: string;
  try {
    const target = resolveExplicitBaseUrl({
      baseUrlFlag: stringFlag(flags, ['base-url']),
      envFlag: stringFlag(flags, ['env']),
      regionFlag: stringFlag(flags, ['region']),
    });
    if (!target) {
      return {
        ok: false,
        error: usageError('Signup requires --region <us|eu>.'),
      };
    }
    baseUrl = target;
    const store = loadStore(deps.path);
    profileName = targetProfileName(store, stringFlag(flags, ['profile']));
    const existing = getProfile(store, profileName);
    if (
      existing &&
      existing.base_url !== baseUrl &&
      !isFlagEnabled(flags.force)
    ) {
      return {
        ok: false,
        error: usageError(
          `Profile "${profileName}" targets ${existing.base_url}; refusing to silently retarget it to ${baseUrl}. Use a different --profile, or pass --force to overwrite.`,
        ),
      };
    }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof CliError
          ? error
          : new CliError({
              message: 'Could not read signup profile configuration.',
              errorCode: 'profile_read_failed',
              exitCode: 1,
            }),
    };
  }

  const inputs = suppliedInputsSchema.safeParse({
    email: flags.email,
    full_name: flags['full-name'],
  });
  if (!inputs.success) {
    const fields = [
      ...new Set(inputs.error.issues.map((issue) => issue.path.join('.'))),
    ];
    return {
      ok: false,
      error: usageError(
        `Invalid signup input: ${fields.join(', ')}. Run \`amp auth signup --help\`.`,
      ),
    };
  }
  const accepted = isFlagEnabled(flags['accept-tos']);
  if (!inputs.data.email) {
    return { ok: false, error: usageError('Signup requires --email <email>.') };
  }

  const body = signupRequestSchema.safeParse({
    email: inputs.data.email,
    ...(inputs.data.full_name === undefined
      ? {}
      : { full_name: inputs.data.full_name }),
    ...(accepted
      ? {
          terms_acceptance: {
            terms_of_service: {
              url: SIGNUP_DOCUMENT_URLS.terms_of_service,
              accepted: true,
            },
            privacy_policy: {
              url: SIGNUP_DOCUMENT_URLS.privacy_policy,
              accepted: true,
            },
          },
        }
      : {}),
  });
  if (!body.success)
    return {
      ok: false,
      error: usageError(
        'Invalid signup request. Run `amp auth signup --help`.',
      ),
    };

  const request = deps.request ?? createAnonymousRequest(baseUrl);
  let result: Awaited<ReturnType<AnonymousRequest>>;
  try {
    result = await request('POST', '/v1/auth/signup', body.data);
  } catch {
    return {
      ok: false,
      error: transportError(
        `Could not complete the signup request at ${baseUrl}.`,
      ),
    };
  }
  if (result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      error: signupErrorFromResponse(result.status, '', result.body),
    };
  }
  const parsed = signupResponseSchema.safeParse(result.body);
  if (!parsed.success)
    return {
      ok: false,
      error: new CliError({
        message: 'The signup service returned an unexpected response.',
        errorCode: 'unexpected_response',
        exitCode: 1,
      }),
    };

  const response = parsed.data;
  const now = deps.now ?? Date.now;
  const pPath = deps.pendingPath ?? defaultPendingPath();
  const persistPending = deps.savePending ?? savePending;
  const loginCommand = signupLoginCommand(
    profileName,
    baseUrl,
    isFlagEnabled(flags.force),
  );
  const saveCredentials = async (
    token: TokenResponse,
  ): Promise<AuthSignupResult> => {
    const savedAt = now();
    const profile: Profile = {
      base_url: baseUrl,
      credential: oauthCredentialFromToken(token, savedAt),
      saved_at: new Date(savedAt).toISOString(),
      store: 'file',
    };
    try {
      await (deps.updateStore ?? updateStore)(
        deps.path,
        (latest) =>
          setDefault(setProfile(latest, profileName, profile), profileName),
        { retryMode: 'rotation_recovery' },
      );
    } catch {
      return persistenceError(
        'credential_save_failed',
        `Authentication completed, but credentials could not be saved. Run \`${loginCommand}\` to sign in again.`,
      );
    }
    try {
      const pending = loadPending(pPath);
      if (getPending(pending, profileName))
        persistPending(removePending(pending, profileName), pPath);
    } catch {
      return persistenceError(
        'pending_cleanup_failed',
        'Signup credentials were saved and the profile is active, but obsolete pending authorization could not be cleared. Check local file permissions before starting another login.',
      );
    }
    return {
      ok: true,
      exitCode: 0,
      output: {
        status: 'authorized',
        message:
          'Authentication complete. You can now run authenticated CLI commands',
        data: {
          profile: profileName,
          base_url: baseUrl,
          ...(body.data.terms_acceptance
            ? {
                terms_acceptance: {
                  terms_of_service:
                    body.data.terms_acceptance.terms_of_service.url,
                  privacy_policy: body.data.terms_acceptance.privacy_policy.url,
                },
              }
            : {}),
        },
      },
    };
  };

  switch (response.type) {
    case 'needs_information':
      return needsInformation(response.needs_information.schema);
    case 'credentials':
      return saveCredentials(response.credentials);

    case 'requires_auth': {
      const device = response.requires_auth.device_authorization;
      const startedAt = now();
      const pending = gcExpiredPending(loadPending(pPath), startedAt);
      const replacedPending = getPending(pending, profileName) !== undefined;
      const entry: PendingEntry = {
        device_code: device.device_code,
        base_url: baseUrl,
        expires_at: new Date(
          startedAt + device.expires_in * 1000,
        ).toISOString(),
        interval: device.interval ?? 5,
        started_at: new Date(startedAt).toISOString(),
      };
      try {
        persistPending(setPending(pending, profileName, entry), pPath);
      } catch {
        return persistenceError(
          'pending_save_failed',
          'Could not save the signup authorization challenge. Check local file permissions and start signup or login again.',
        );
      }
      const continuation = signupPollContinuation(profileName);
      if (isInteractive) {
        const authorization = await completeDeviceAuthorization(device, {
          request,
          now,
          stdin: deps.stdin,
          stderr: deps.stderr,
          openUrl: deps.openUrl,
          sleep: deps.sleep,
          transientRetries: 2,
        });
        if (!authorization.ok) {
          if (
            authorization.error.code === 'access_denied' ||
            authorization.error.code === 'expired_token'
          ) {
            try {
              const current = loadPending(pPath);
              // A concurrent login may have replaced the challenge we polled.
              if (
                getPending(current, profileName)?.device_code ===
                device.device_code
              ) {
                persistPending(removePending(current, profileName), pPath);
              }
            } catch {
              return persistenceError(
                'pending_cleanup_failed',
                `${authorization.error.message} Could not clear the saved authorization. Check local file permissions before running \`${loginCommand}\`.`,
              );
            }
          }
          if (authorization.error.canResume) {
            for (let attempt = 0; ; attempt += 1) {
              try {
                const current = loadPending(pPath);
                const saved = getPending(current, profileName);
                // Only update the challenge we polled; a concurrent login may
                // have replaced it while we were waiting for authorization.
                if (
                  saved?.device_code === device.device_code &&
                  saved.interval !== authorization.error.interval
                ) {
                  persistPending(
                    setPending(current, profileName, {
                      ...saved,
                      interval: authorization.error.interval,
                    }),
                    pPath,
                  );
                }
                break;
              } catch {
                if (attempt < 2) {
                  const seconds = 0.1 * (attempt + 1);
                  await (deps.sleep ?? ((wait) => delay(wait * 1000)))(seconds);
                  continue;
                }
                return persistenceError(
                  'pending_save_failed',
                  `Could not save the increased polling interval. Check local file permissions and run \`${loginCommand}\` to authorize again.`,
                );
              }
            }
          }
          const recovery = authorization.error.canResume
            ? `Continue with \`${continuation.command}\`.`
            : `Run \`${loginCommand}\` to authorize again.`;
          const message = `${authorization.error.message} ${recovery}`;
          return {
            ok: false,
            error:
              authorization.error.code === 'transport_error'
                ? transportError(message)
                : new CliError({
                    errorCode: 'authorization_failed',
                    message,
                    exitCode: exitCodeForErrorCode('authorization_failed'),
                  }),
          };
        }
        return saveCredentials(authorization.token);
      }
      const verificationUrl =
        device.verification_uri_complete ?? device.verification_uri;
      return {
        ok: true,
        exitCode: 0,
        output: {
          status: 'requires_auth',
          message: `Open ${verificationUrl} and confirm code ${device.user_code}, then run \`${continuation.command}\`.`,
          data: {
            profile: profileName,
            base_url: baseUrl,
            user_code: device.user_code,
            verification_uri: device.verification_uri,
            verification_uri_complete: device.verification_uri_complete,
            expires_at: entry.expires_at,
            expires_in_seconds: device.expires_in,
            replaced_pending: replacedPending,
            continuation,
          },
        },
      };
    }
    default:
      response satisfies never;
      return {
        ok: false,
        error: new CliError({
          message: 'The signup service returned an unexpected response.',
          errorCode: 'unexpected_response',
          exitCode: 1,
        }),
      };
  }
}
