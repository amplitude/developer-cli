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

function asProblem(body: unknown): ProblemDetails | undefined {
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

function hintForErrorCode(errorCode: string | undefined): string | undefined {
  switch (errorCode) {
    case 'authentication_required':
    case 'invalid_token':
      return 'Run `amp auth login`, or set AMP_TOKEN for a single shell.';
    case 'insufficient_scope':
      return 'Run `amp context` to inspect your token, then re-authenticate with the required access (`amp auth login`).';
    case 'validation_error':
      return 'Check required flags with `amp help <command>`.';
    case 'not_found':
      return 'Verify identifiers such as --project, --flag, and --event.';
    case 'auth_unavailable':
    case 'upstream_error':
      return 'Retry the request. If it persists, check API status or use --base-url for a different host.';
    default:
      return undefined;
  }
}

export function formatApiError(
  status: number,
  statusText: string,
  body: unknown,
): string {
  const problem = asProblem(body);
  const lines: string[] = [];

  if (problem) {
    const title = problem.title ?? `HTTP ${status}`;
    lines.push(`${title} (${status} ${statusText})`);

    if (problem.detail) {
      lines.push(problem.detail);
    }

    if (problem.validation_errors && problem.validation_errors.length > 0) {
      lines.push('');
      lines.push('Validation errors:');
      for (const error of problem.validation_errors) {
        lines.push(`  - ${error.field}: ${error.message}`);
      }
    }

    const hint = hintForErrorCode(problem.error_code);
    if (hint) {
      lines.push('');
      lines.push(hint);
    }

    return lines.join('\n');
  }

  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed) {
      return `Request failed (${status} ${statusText}):\n${trimmed}`;
    }
  }

  if (body !== null && body !== undefined) {
    return `Request failed (${status} ${statusText}):\n${JSON.stringify(body, null, 2)}`;
  }

  return `Request failed (${status} ${statusText}).`;
}
