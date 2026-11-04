import { z } from 'zod';

import {
  CliError,
  cliErrorFromResponse,
  exitCodeForErrorCode,
  usageError,
} from './cli-error';
import { REGION_BASE_URLS } from './config';
import { asProblem } from './errors';
import {
  type DeviceAuthorizationResponse,
  deviceAuthorizationResponseSchema,
  tokenResponseSchema,
} from './oauthResponseSchemas';
import { sanitizeTerminalText } from './output';
import { jsonRecordSchema } from './schemas';

// Stable references shipped with the client; the server validates them.
export const SIGNUP_DOCUMENT_URLS = {
  terms_of_service: 'https://amplitude.com/terms',
  privacy_policy: 'https://amplitude.com/privacy',
};

export const signupRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email(),
  full_name: z.string().trim().min(1).optional(),
  terms_acceptance: z
    .object({
      terms_of_service: z.object({
        url: z.literal(SIGNUP_DOCUMENT_URLS.terms_of_service),
        accepted: z.literal(true),
      }),
      privacy_policy: z.object({
        url: z.literal(SIGNUP_DOCUMENT_URLS.privacy_policy),
        accepted: z.literal(true),
      }),
    })
    .optional(),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const signupResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('credentials'),
    credentials: tokenResponseSchema,
  }),
  z.object({
    type: z.literal('requires_auth'),
    requires_auth: z.object({
      type: z.literal('device_authorization'),
      device_authorization: deviceAuthorizationResponseSchema,
    }),
  }),
  z.object({
    type: z.literal('needs_information'),
    needs_information: z.object({ schema: jsonRecordSchema }),
  }),
]);
export type SignupResponse = z.infer<typeof signupResponseSchema>;

const signupErrorSchema = z.object({
  type: z.literal('error'),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
});

export function signupErrorFromResponse(
  status: number,
  statusText: string,
  body: unknown,
): CliError {
  const parsed = signupErrorSchema.safeParse(body);
  if (parsed.success) {
    return new CliError({
      message: parsed.data.error.message,
      errorCode: parsed.data.error.code,
      httpStatus: status,
      exitCode: exitCodeForErrorCode(parsed.data.error.code, status),
    });
  }
  const problem = asProblem(body);
  if (problem) return cliErrorFromResponse(status, statusText, problem);
  return new CliError({
    message: `Signup failed (HTTP ${status}).`,
    errorCode: 'request_failed',
    httpStatus: status,
    exitCode: exitCodeForErrorCode('request_failed', status),
  });
}

interface SignupTarget {
  profile: string;
  base_url: string;
}

/** Locally constructed outcomes; API input remains schema-validated above. */
export type SignupOutput =
  | {
      status: 'authorized';
      message: string;
      data: SignupTarget & { terms_acceptance?: typeof SIGNUP_DOCUMENT_URLS };
    }
  | {
      status: 'requires_auth';
      message: string;
      data: SignupTarget &
        Pick<
          DeviceAuthorizationResponse,
          'user_code' | 'verification_uri' | 'verification_uri_complete'
        > & {
          expires_at: string;
          expires_in_seconds: number;
          replaced_pending: boolean;
          continuation: ReturnType<typeof signupPollContinuation>;
        };
    }
  | {
      status: 'needs_information';
      message: string;
      data: {
        schema: Record<string, unknown>;
        supported_flags: Record<string, string>;
      };
    };

const requiredFieldsSchema = z.array(z.string());
const knownTermsRequirementSchema = z.object({
  properties: z
    .object({
      terms_acceptance: z
        .object({
          documents: z
            .array(
              z.discriminatedUnion('kind', [
                z.object({
                  kind: z.literal('terms_of_service'),
                  url: z.literal(SIGNUP_DOCUMENT_URLS.terms_of_service),
                }),
                z.object({
                  kind: z.literal('privacy_policy'),
                  url: z.literal(SIGNUP_DOCUMENT_URLS.privacy_policy),
                }),
              ]),
            )
            .length(2)
            .refine(
              (documents) =>
                new Set(documents.map((doc) => doc.kind)).size === 2,
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

const supportedFlags: Record<string, string> = {
  email: '--email',
  full_name: '--full-name',
  terms_acceptance: '--accept-tos',
};

export function signupSupportedFlags(
  schema: Record<string, unknown>,
): Record<string, string> {
  const required = requiredFieldsSchema.safeParse(schema.required);
  if (!required.success) return {};
  return Object.fromEntries(
    required.data.flatMap((field) => {
      const flag = Object.hasOwn(supportedFlags, field)
        ? supportedFlags[field]
        : undefined;
      return flag ? [[field, flag]] : [];
    }),
  );
}

/** Known requirements use standard CLI errors; unfamiliar schemas remain lossless. */
export function signupMissingInformationError(
  schema: Record<string, unknown>,
): CliError | undefined {
  const required = requiredFieldsSchema.safeParse(schema.required);
  if (!required.success || required.data.length === 0) return undefined;
  const flags = signupSupportedFlags(schema);
  if (required.data.some((field) => !Object.hasOwn(flags, field)))
    return undefined;

  if (
    Object.hasOwn(flags, 'terms_acceptance') &&
    !knownTermsRequirementSchema.safeParse(schema).success
  )
    return undefined;

  const missing = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    Object.values(flags),
  );
  const termsNotice = Object.hasOwn(flags, 'terms_acceptance')
    ? ` --accept-tos indicates you agree to the Terms of Service (${SIGNUP_DOCUMENT_URLS.terms_of_service}) and acknowledge that the Amplitude Privacy Policy (${SIGNUP_DOCUMENT_URLS.privacy_policy}) applies.`
    : '';
  return usageError(`Signup requires ${missing}.${termsNotice}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function signupLoginCommand(
  profile: string,
  baseUrl: string,
  force: boolean,
  flow: 'browser' | 'device' = 'browser',
): string {
  const region = Object.entries(REGION_BASE_URLS).find(
    ([, url]) => url === baseUrl,
  )?.[0];
  const target = region
    ? `--region ${region}`
    : `--base-url ${shellQuote(baseUrl)}`;
  return `amp auth login${flow === 'device' ? ' start' : ''} --profile ${shellQuote(profile)} ${target}${force ? ' --force' : ''}${flow === 'device' ? ' --json' : ''}`;
}

export function signupPollContinuation(profile: string): {
  command: string;
  argv: string[];
} {
  return {
    command: `amp auth login poll --profile ${shellQuote(profile)} --json`,
    argv: ['amp', 'auth', 'login', 'poll', '--profile', profile, '--json'],
  };
}

export function formatSignupText(output: SignupOutput): string {
  return `${sanitizeTerminalText(output.message)}\n\n${JSON.stringify(output.data, null, 2)}`;
}
