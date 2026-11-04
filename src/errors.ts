import { z } from 'zod';

export const strictProblemDetailsSchema = z.object({
  title: z.string().optional(),
  status: z.number().optional(),
  detail: z.string().nullable().optional(),
  error_code: z.string().optional(),
  retryable: z.boolean().optional(),
  validation_errors: z
    .array(
      z.object({ field: z.string(), message: z.string(), code: z.string() }),
    )
    .nullable()
    .optional(),
});
// General error handling keeps valid diagnostics even if another field is bad.
const problemDetailsSchema = strictProblemDetailsSchema.extend({
  title: strictProblemDetailsSchema.shape.title.catch(undefined),
  status: strictProblemDetailsSchema.shape.status.catch(undefined),
  detail: strictProblemDetailsSchema.shape.detail.catch(undefined),
  error_code: strictProblemDetailsSchema.shape.error_code.catch(undefined),
  retryable: strictProblemDetailsSchema.shape.retryable.catch(undefined),
  validation_errors:
    strictProblemDetailsSchema.shape.validation_errors.catch(undefined),
});
type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export function asProblem(body: unknown): ProblemDetails | undefined {
  const result = problemDetailsSchema.safeParse(body);
  if (!result.success) {
    return undefined;
  }

  const candidate = result.data;
  if (
    typeof candidate.error_code === 'string' ||
    typeof candidate.title === 'string'
  ) {
    return candidate;
  }

  return undefined;
}

export function hintForErrorCode(
  errorCode: string | undefined,
  retryable?: boolean,
): string | undefined {
  switch (errorCode) {
    case 'authentication_required':
    case 'invalid_token':
      return 'Authenticate with `amp auth login`, or set AMP_TOKEN. Run `amp auth --help` for all authentication commands.';
    case 'insufficient_scope':
      return 'Run `amp context` to inspect your token, then re-authenticate with the required access (`amp auth login`).';
    case 'validation_error':
      return 'Check required flags with `amp <command> --help`.';
    case 'not_found':
      return 'Verify identifiers such as --project, --flag, and --event.';
    case 'project_selection_required':
      return 'Run `amp projects list` to find a project, and supply --project <project_id>.';
    case 'project_not_found':
      return 'Verify --project and your access to that project.';
    case 'project_key_access_denied':
      return "Ask an organization administrator to review your permission to view this project's API key.";
    case 'project_api_key_not_available':
      return 'Choose a project that supports ingestion API keys.';
    case 'project_api_key_unavailable':
      return "Ask an organization administrator to review the project's API key settings.";
    case 'operation_availability_unavailable':
      return retryable === true ? 'Retry the request later.' : undefined;
    case 'rate_limit_exceeded':
      return 'Retry after the rate-limit window has passed.';
    case 'auth_unavailable':
    case 'upstream_error':
      return 'Retry the request. If it persists, check API status or try a different region with --region.';
    case 'transport_error':
      return 'Check network connectivity and retry.';
    default:
      return undefined;
  }
}
