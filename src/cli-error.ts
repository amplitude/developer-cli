import { asProblem, hintForErrorCode } from './errors';
import { formatJsonOutput, sanitizeTerminalText } from './output';

export interface CliErrorFields {
  errorCode: string;
  exitCode: number;
  httpStatus?: number;
  detail?: string;
  validationErrors?: Array<{ field: string; message: string; code: string }>;
  hint?: string;
  retryable?: boolean;
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
  retryable?: boolean;

  constructor(fields: CliErrorFields & { message: string }) {
    super(fields.message);
    this.name = 'CliError';
    this.errorCode = fields.errorCode;
    this.exitCode = fields.exitCode;
    this.httpStatus = fields.httpStatus;
    this.detail = fields.detail;
    this.validationErrors = fields.validationErrors;
    this.hint = fields.hint;
    this.retryable = fields.retryable;
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
    retryable: problem?.retryable,
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

export function transportError(
  message: string,
  hint = hintForErrorCode('transport_error'),
): CliError {
  return new CliError({
    message,
    errorCode: 'transport_error',
    exitCode: 5,
    hint,
  });
}

export function formatErrorText(error: CliError): string {
  const lines: string[] = [sanitizeTerminalText(error.message)];

  if (error.validationErrors && error.validationErrors.length > 0) {
    lines.push('');
    lines.push('Validation errors:');
    for (const validationError of error.validationErrors) {
      lines.push(
        `  - ${sanitizeTerminalText(validationError.field)}: ${sanitizeTerminalText(validationError.message)}`,
      );
    }
  }

  if (error.hint) {
    lines.push('');
    // Hints are CLI-authored paragraphs. Keep the breaks between them, and
    // sanitize each line so a control character still cannot act on the terminal.
    lines.push(
      error.hint
        .split('\n')
        .map((line) => sanitizeTerminalText(line))
        .join('\n'),
    );
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
        retryable: error.retryable,
      },
    },
    isTTY,
  );
}
