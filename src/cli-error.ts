import { asProblem, hintForErrorCode } from './errors';
import { formatJsonOutput } from './output';

export interface CliErrorFields {
  errorCode: string;
  exitCode: number;
  httpStatus?: number;
  detail?: string;
  validationErrors?: Array<{ field: string; message: string; code: string }>;
  hint?: string;
}

const AUTH_CODES = new Set([
  'authentication_required',
  'invalid_token',
  'insufficient_scope',
]);
const TRANSPORT_CODES = new Set(['auth_unavailable', 'upstream_error']);

export function exitCodeForErrorCode(
  errorCode: string,
  httpStatus?: number,
): number {
  if (
    errorCode === 'validation_error' ||
    errorCode === 'usage_error' ||
    httpStatus === 400 ||
    httpStatus === 422
  ) {
    return 2;
  }
  if (AUTH_CODES.has(errorCode) || httpStatus === 401 || httpStatus === 403) {
    return 3;
  }
  if (errorCode === 'not_found' || httpStatus === 404) {
    return 4;
  }
  if (
    TRANSPORT_CODES.has(errorCode) ||
    (httpStatus !== undefined && httpStatus >= 500)
  ) {
    return 5;
  }
  return 1;
}

export class CliError extends Error implements CliErrorFields {
  errorCode: string;
  exitCode: number;
  httpStatus?: number;
  detail?: string;
  validationErrors?: Array<{ field: string; message: string; code: string }>;
  hint?: string;

  constructor(fields: CliErrorFields & { message: string }) {
    super(fields.message);
    this.name = 'CliError';
    this.errorCode = fields.errorCode;
    this.exitCode = fields.exitCode;
    this.httpStatus = fields.httpStatus;
    this.detail = fields.detail;
    this.validationErrors = fields.validationErrors;
    this.hint = fields.hint;
  }
}

function rawBodyDetail(body: unknown): string | undefined {
  if (typeof body === 'string') {
    const trimmed = body.trim();
    return trimmed ? trimmed : undefined;
  }
  if (body !== null && typeof body === 'object') {
    return JSON.stringify(body);
  }
  return undefined;
}

export function cliErrorFromResponse(
  status: number,
  statusText: string,
  body: unknown,
): CliError {
  const problem = asProblem(body);
  const errorCode = problem?.error_code ?? 'request_failed';
  const title = problem?.title ?? `HTTP ${status}`;
  const detail = problem ? (problem.detail ?? undefined) : rawBodyDetail(body);
  return new CliError({
    message: detail
      ? `${title}: ${detail}`
      : `${title} (${status} ${statusText})`,
    errorCode,
    exitCode: exitCodeForErrorCode(errorCode, status),
    httpStatus: status,
    detail,
    validationErrors: problem?.validation_errors ?? undefined,
    hint: hintForErrorCode(errorCode),
  });
}

export function usageError(message: string): CliError {
  return new CliError({ message, errorCode: 'usage_error', exitCode: 2 });
}

export function authError(
  message: string,
  errorCode:
    | 'authentication_required'
    | 'invalid_token' = 'authentication_required',
): CliError {
  return new CliError({
    message,
    errorCode,
    exitCode: exitCodeForErrorCode(errorCode),
    hint: hintForErrorCode(errorCode),
  });
}

export function transportError(message: string): CliError {
  return new CliError({
    message,
    errorCode: 'transport_error',
    exitCode: 5,
  });
}

export function formatErrorText(error: CliError): string {
  const lines: string[] = [error.message];

  if (error.validationErrors && error.validationErrors.length > 0) {
    lines.push('');
    lines.push('Validation errors:');
    for (const validationError of error.validationErrors) {
      lines.push(`  - ${validationError.field}: ${validationError.message}`);
    }
  }

  if (error.hint) {
    lines.push('');
    lines.push(error.hint);
  }

  return lines.join('\n');
}

export function formatErrorEnvelope(error: CliError, isTTY: boolean): string {
  return formatJsonOutput(
    {
      status: 'error',
      message: error.message,
      error: {
        error_code: error.errorCode,
        http_status: error.httpStatus,
        detail: error.detail,
        validation_errors: error.validationErrors,
        hint: error.hint,
      },
    },
    isTTY,
  );
}
