import { describe, expect, it } from 'vitest';

import {
  exitCodeForErrorCode,
  formatErrorEnvelope,
  usageError,
} from './cli-error';

describe('error contract: exit-code map', () => {
  const cases: Array<{
    label: string;
    errorCode: string;
    httpStatus?: number;
    exitCode: number;
  }> = [
    // usage / validation → 2
    {
      label: 'validation_error code, no status',
      errorCode: 'validation_error',
      exitCode: 2,
    },
    {
      label: 'usage_error code, no status',
      errorCode: 'usage_error',
      exitCode: 2,
    },
    {
      label: '400 status fallback',
      errorCode: 'something_else',
      httpStatus: 400,
      exitCode: 2,
    },
    {
      label: '422 status fallback',
      errorCode: 'something_else',
      httpStatus: 422,
      exitCode: 2,
    },
    // auth → 3
    {
      label: 'authentication_required code',
      errorCode: 'authentication_required',
      exitCode: 3,
    },
    { label: 'invalid_token code', errorCode: 'invalid_token', exitCode: 3 },
    {
      label: 'insufficient_scope code',
      errorCode: 'insufficient_scope',
      exitCode: 3,
    },
    {
      label: '401 status fallback',
      errorCode: 'something_else',
      httpStatus: 401,
      exitCode: 3,
    },
    {
      label: '403 status fallback',
      errorCode: 'something_else',
      httpStatus: 403,
      exitCode: 3,
    },
    // not-found → 4
    { label: 'not_found code, no status', errorCode: 'not_found', exitCode: 4 },
    {
      label: '404 status fallback',
      errorCode: 'something_else',
      httpStatus: 404,
      exitCode: 4,
    },
    // transport → 5
    {
      label: 'auth_unavailable code',
      errorCode: 'auth_unavailable',
      exitCode: 5,
    },
    { label: 'upstream_error code', errorCode: 'upstream_error', exitCode: 5 },
    {
      label: '500 status fallback',
      errorCode: 'something_else',
      httpStatus: 500,
      exitCode: 5,
    },
    {
      label: '502 status fallback',
      errorCode: 'something_else',
      httpStatus: 502,
      exitCode: 5,
    },
    {
      label: '599 status fallback (>=500 catch-all)',
      errorCode: 'something_else',
      httpStatus: 599,
      exitCode: 5,
    },
    // generic → 1
    {
      label: 'unknown code, no status',
      errorCode: 'something_new',
      exitCode: 1,
    },
    {
      label: 'unknown code, unmapped status',
      errorCode: 'something_new',
      httpStatus: 418,
      exitCode: 1,
    },
  ];

  it.each(cases)(
    '$label → exit $exitCode',
    ({ errorCode, httpStatus, exitCode }) => {
      expect(exitCodeForErrorCode(errorCode, httpStatus)).toBe(exitCode);
    },
  );
});

describe('error contract: envelope shape', () => {
  it('always has status:"error" and error.error_code', () => {
    const envelope = JSON.parse(
      formatErrorEnvelope(usageError('Missing --project <project_id>.'), false),
    );
    expect(envelope.status).toBe('error');
    expect(typeof envelope.error.error_code).toBe('string');
    expect(envelope.error.error_code).toBe('usage_error');
  });
});
