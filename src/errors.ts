interface ProblemDetails {
  title?: string;
  status?: number;
  detail?: string | null;
  error_code?: string;
  validation_errors?: Array<{
    field: string;
    message: string;
    code: string;
  }> | null;
}

export function asProblem(body: unknown): ProblemDetails | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const candidate = body as ProblemDetails;
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
    case 'auth_unavailable':
    case 'upstream_error':
      return 'Retry the request. If it persists, check API status or try a different region with --region.';
    default:
      return undefined;
  }
}
