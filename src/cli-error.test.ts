import { describe, expect, it } from 'vitest';

import {
  CliError,
  cliErrorFromResponse,
  exitCodeForErrorCode,
  formatErrorEnvelope,
  formatErrorText,
  transportError,
  usageError,
} from './cli-error';

describe('CliError', () => {
  it('preserves server diagnostics when retryability is malformed', () => {
    const error = cliErrorFromResponse(503, 'Service Unavailable', {
      error_code: 'operation_availability_unavailable',
      title: 'Operation unavailable',
      detail: 'Try later',
      retryable: 'false',
    });
    expect(error.errorCode).toBe('operation_availability_unavailable');
    expect(error.message).toBe('Operation unavailable: Try later');
    expect(error.exitCode).toBe(5);
    expect(error.retryable).toBeUndefined();
    expect(error.hint).toBeUndefined();
    expect(JSON.parse(formatErrorEnvelope(error, false)).error.error_code).toBe(
      'operation_availability_unavailable',
    );
  });

  it.each([
    { retryable: true, hint: 'Retry the request later.' },
    { retryable: false, hint: undefined },
    { retryable: undefined, hint: undefined },
  ])(
    'hints to retry an unavailable operation only when retryable is $retryable',
    ({ retryable, hint }) => {
      const error = cliErrorFromResponse(503, 'Service Unavailable', {
        error_code: 'operation_availability_unavailable',
        retryable,
      });
      expect(error.hint).toBe(hint);
    },
  );

  it.each([
    { status: 501, code: 'not_implemented', retryable: false, exit: 5 },
    { status: 501, code: 'not_implemented', retryable: true, exit: 5 },
    { status: 501, code: 'not_implemented', retryable: undefined, exit: 5 },
    {
      status: 503,
      code: 'project_api_key_unavailable',
      retryable: false,
      exit: 1,
    },
    {
      status: 503,
      code: 'project_api_key_unavailable',
      retryable: true,
      exit: 5,
    },
    {
      status: 503,
      code: 'project_api_key_unavailable',
      retryable: undefined,
      exit: 5,
    },
    { status: 503, code: 'some_future_error', retryable: false, exit: 5 },
    { status: 502, code: 'upstream_error', retryable: false, exit: 5 },
    { status: 502, code: 'upstream_error', retryable: true, exit: 5 },
    { status: 429, code: 'rate_limit_exceeded', retryable: true, exit: 1 },
    { status: 429, code: 'rate_limit_exceeded', retryable: false, exit: 1 },
    { status: 401, code: 'authentication_required', retryable: false, exit: 3 },
    { status: 422, code: 'validation_error', retryable: false, exit: 2 },
    { status: 404, code: 'not_found', retryable: false, exit: 4 },
    { status: 500, code: 'validation_error', retryable: false, exit: 2 },
    { status: 503, code: 'invalid_token', retryable: false, exit: 3 },
    { status: 500, code: 'not_found', retryable: false, exit: 4 },
    { status: 429, code: 'upstream_error', retryable: false, exit: 5 },
  ])(
    '$code (HTTP $status, retryable: $retryable) exits $exit and preserves retryability',
    ({ status, code, retryable, exit }) => {
      const error = cliErrorFromResponse(status, 'Request failed', {
        error_code: code,
        title: 'Request failed',
        retryable,
      });
      expect(error.exitCode).toBe(exit);
      expect(
        JSON.parse(formatErrorEnvelope(error, false)).error.retryable,
      ).toBe(retryable);
    },
  );

  it('keeps exit 5 for a server error without a body', () => {
    const error = cliErrorFromResponse(503, 'Service Unavailable', null);
    expect(error.exitCode).toBe(5);
    expect(error.retryable).toBeUndefined();
  });

  it('does not invent retryability when it is absent', () => {
    const error = cliErrorFromResponse(503, 'Service Unavailable', {
      error_code: 'some_future_error',
      title: 'Request failed',
    });
    expect(
      JSON.parse(formatErrorEnvelope(error, false)).error,
    ).not.toHaveProperty('retryable');
  });

  it('maps error codes to exit codes', () => {
    expect(exitCodeForErrorCode('insufficient_scope', 403)).toBe(3);
    expect(exitCodeForErrorCode('validation_error', 422)).toBe(2);
    expect(exitCodeForErrorCode('not_found', 404)).toBe(4);
    expect(exitCodeForErrorCode('upstream_error', 502)).toBe(5);
    expect(exitCodeForErrorCode('something_new', 418)).toBe(1);
  });

  it('builds a CliError from an API problem+json body', () => {
    const err = cliErrorFromResponse(403, 'Forbidden', {
      error_code: 'insufficient_scope',
      title: 'Forbidden',
      detail: 'Missing scope write:flags',
    });
    expect(err.errorCode).toBe('insufficient_scope');
    expect(err.exitCode).toBe(3);
    expect(err.httpStatus).toBe(403);
    expect(err.hint).toMatch(/amp context/);
  });

  it('serializes the agreed envelope shape', () => {
    const env = JSON.parse(
      formatErrorEnvelope(usageError('Missing --project <project_id>.'), false),
    );
    expect(env.status).toBe('error');
    expect(env.error.error_code).toBe('usage_error');
    expect(typeof env.message).toBe('string');
  });

  it('captures a non-problem string body into detail (raw-body fallback)', () => {
    const err = cliErrorFromResponse(
      502,
      'Bad Gateway',
      '<html>gateway unavailable</html>',
    );
    expect(err.detail).toContain('<html>gateway unavailable</html>');
  });

  it('captures a non-problem object body into detail as JSON', () => {
    const err = cliErrorFromResponse(500, 'Internal Server Error', {
      message: 'boom',
    });
    expect(err.detail).toContain('"boom"');
  });

  it('leaves detail undefined for a null body', () => {
    const err = cliErrorFromResponse(500, 'Internal Server Error', null);
    expect(err.detail).toBeUndefined();
  });
});

describe('formatErrorText', () => {
  it('formats RFC 7807 problem responses with hints', () => {
    const err = cliErrorFromResponse(403, 'Forbidden', {
      title: 'Insufficient scope',
      detail: 'Token missing required scopes.',
      error_code: 'insufficient_scope',
    });

    const text = formatErrorText(err);
    expect(text).toContain(
      'Insufficient scope: Token missing required scopes.',
    );
    expect(text).toContain('amp context');
  });

  it('includes validation errors when present', () => {
    const err = cliErrorFromResponse(400, 'Bad Request', {
      title: 'Validation failed',
      error_code: 'validation_error',
      validation_errors: [
        { field: 'event_type', message: 'Required', code: 'required' },
      ],
    });

    const text = formatErrorText(err);
    expect(text).toContain('Validation errors:');
    expect(text).toContain('  - event_type: Required');
    expect(text).toContain('amp <command> --help');
  });

  it('falls back to showing a non-problem body', () => {
    const err = cliErrorFromResponse(500, 'Internal Server Error', {
      message: 'boom',
    });

    const text = formatErrorText(err);
    expect(text).toContain('500');
    expect(text).toContain('"boom"');
  });

  it('prints non-JSON error bodies directly', () => {
    const err = cliErrorFromResponse(
      502,
      'Bad Gateway',
      '<html>gateway unavailable</html>',
    );

    const text = formatErrorText(err);
    expect(text).toContain('502');
    expect(text).toContain('<html>gateway unavailable</html>');
  });

  it('renders message, validation errors, and hint in order', () => {
    const err = new CliError({
      message: 'Validation failed',
      errorCode: 'validation_error',
      exitCode: 2,
      validationErrors: [
        { field: 'a', message: 'A is required', code: 'required' },
        { field: 'b', message: 'B is invalid', code: 'invalid' },
      ],
      hint: 'Check required flags with `amp <command> --help`.',
    });

    expect(formatErrorText(err)).toBe(
      [
        'Validation failed',
        '',
        'Validation errors:',
        '  - a: A is required',
        '  - b: B is invalid',
        '',
        'Check required flags with `amp <command> --help`.',
      ].join('\n'),
    );
  });

  it('omits the validation/hint sections when absent', () => {
    const err = new CliError({
      message: 'Something broke',
      errorCode: 'error',
      exitCode: 1,
    });

    expect(formatErrorText(err)).toBe('Something broke');
  });

  it('keeps paragraph breaks in a hint and still hides controls', () => {
    const err = new CliError({
      message: 'Could not save skill: disk full.',
      errorCode: 'transport_error',
      exitCode: 5,
      hint: 'Check permissions for the skill cache.\n\nAlternatively, omit `--save`.\nline\u001b[31m',
    });

    const text = formatErrorText(err);
    expect(text).toContain(
      'Check permissions for the skill cache.\n\nAlternatively, omit `--save`.',
    );
    expect(text).toContain('line^[[31m');
    expect(text.includes('\u001b')).toBe(false);
  });

  it('gives a transport failure an actionable hint', () => {
    const err = transportError(
      'Could not reach the API at https://example.test.',
    );

    expect(err.hint).toBe('Check network connectivity and retry.');
    expect(formatErrorText(err)).not.toMatch(/--base-url|--env/);
  });
});
