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

  it('gives a transport failure an actionable hint', () => {
    const err = transportError(
      'Could not reach the API at https://example.test.',
    );

    expect(err.hint).toBe('Check network connectivity and retry.');
    expect(formatErrorText(err)).not.toMatch(/--base-url|--env/);
  });
});
