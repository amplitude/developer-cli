import { z } from 'zod';

import {
  CliError,
  cliErrorFromResponse,
  exitCodeForErrorCode,
} from './cli-error';
import {
  type DeviceAuthorizationResponse,
  deviceAuthorizationResponseSchema,
  tokenResponseSchema,
} from './oauthResponseSchemas';
import { jsonRecordSchema } from './schemas';

// Stable references shipped with the client; the server validates them.
export const SIGNUP_DOCUMENT_URLS = {
  terms_of_service: 'https://amplitude.com/terms',
  privacy_policy: 'https://amplitude.com/privacy',
};

export const signupRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email(),
  full_name: z.string().trim().min(1).optional(),
  terms_acceptance: z.object({
    terms_of_service: z.object({
      url: z.literal(SIGNUP_DOCUMENT_URLS.terms_of_service),
      accepted: z.literal(true),
    }),
    privacy_policy: z.object({
      url: z.literal(SIGNUP_DOCUMENT_URLS.privacy_policy),
      accepted: z.literal(true),
    }),
  }),
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

// Signup has its own error envelope; other failures can use the standard API
// problem format.
const signupProblemSchema = z.object({
  title: z.string(),
  error_code: z.string(),
  status: z.number().int().optional(),
  detail: z.string().nullable().optional(),
  validation_errors: z
    .array(
      z.object({
        field: z.string(),
        message: z.string(),
        code: z.string(),
      }),
    )
    .nullable()
    .optional(),
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
  const problem = signupProblemSchema.safeParse(body);
  if (problem.success)
    return cliErrorFromResponse(status, statusText, problem.data);
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
      data: SignupTarget & { terms_acceptance: typeof SIGNUP_DOCUMENT_URLS };
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

export function signupPollContinuation(profile: string): {
  command: string;
  argv: string[];
} {
  const quoted = `'${profile.replaceAll("'", "'\\''")}'`;
  return {
    command: `amp auth login poll --profile ${quoted} --json`,
    argv: ['amp', 'auth', 'login', 'poll', '--profile', profile, '--json'],
  };
}

export function formatSignupText(output: SignupOutput): string {
  return `${output.message}\n\n${JSON.stringify(output.data, null, 2)}`;
}
