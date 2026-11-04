import { describe, expect, it } from 'vitest';

import { asProblem, hintForErrorCode } from './errors';
import { parseProjectApiKeyProblem } from './project-api-key';

describe('asProblem', () => {
  it.each([
    { title: 123 },
    { status: '429' },
    { detail: {} },
    { error_code: 123 },
    { retryable: 'false' },
    { validation_errors: [{ field: 'project', message: 'Required' }] },
  ])('drops only the malformed field: %j', (malformed) => {
    const body = {
      title: 'Upstream failure',
      status: 502,
      detail: 'Try later',
      error_code: 'upstream_error',
      retryable: false,
      validation_errors: null,
    };
    const problem = asProblem({ ...body, ...malformed });
    expect(problem).toEqual({
      ...body,
      ...Object.fromEntries(
        Object.keys(malformed).map((field) => [field, undefined]),
      ),
    });
  });

  it('rejects bodies without a valid title or error code', () => {
    expect(asProblem({ title: 123, error_code: false })).toBeUndefined();
  });

  it('accepts future error codes while validating documented fields', () => {
    expect(
      asProblem({ error_code: 'future_error', retryable: false }),
    ).toMatchObject({
      error_code: 'future_error',
      retryable: false,
    });
  });

  it('recognizes an RFC 7807 problem body', () => {
    const problem = asProblem({
      title: 'Insufficient scope',
      error_code: 'insufficient_scope',
    });
    expect(problem?.title).toBe('Insufficient scope');
  });

  it('returns undefined for a non-problem body', () => {
    expect(asProblem({ message: 'boom' })).toBeUndefined();
    expect(asProblem('<html>gateway unavailable</html>')).toBeUndefined();
    expect(asProblem(null)).toBeUndefined();
  });
});

describe('project API key problem validation', () => {
  it.each([
    { title: 123 },
    { status: '502' },
    { detail: {} },
    { error_code: 123 },
    { retryable: 'false' },
    { validation_errors: [{ field: 'project', message: 'Required' }] },
  ])('continues rejecting malformed fields: %j', (malformed) => {
    expect(
      parseProjectApiKeyProblem({
        type: 'https://developer-api.amplitude.com/problems/upstream-error',
        title: 'Upstream failure',
        status: 502,
        error_code: 'upstream_error',
        retryable: false,
        ...malformed,
      }).success,
    ).toBe(false);
  });
});

describe('hintForErrorCode', () => {
  it('returns a remediation hint for known error codes', () => {
    expect(hintForErrorCode('insufficient_scope')).toMatch(/amp context/);
    expect(hintForErrorCode('validation_error')).toMatch(
      /amp <command> --help/,
    );
  });

  it('keeps the auth hint semantic — no audience-targeting or scripted recipe', () => {
    const hint = hintForErrorCode('authentication_required');
    expect(hint).toMatch(/amp auth login/);
    expect(hint).not.toMatch(/Agents\/CI|Interactive:|login start` then/);
    expect(hintForErrorCode('invalid_token')).toBe(hint);
  });

  it('returns undefined for unknown error codes', () => {
    expect(hintForErrorCode('something_new')).toBeUndefined();
    expect(hintForErrorCode(undefined)).toBeUndefined();
  });
});
