import { describe, expect, it } from 'vitest';

import { asProblem, hintForErrorCode } from './errors';

describe('asProblem', () => {
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
