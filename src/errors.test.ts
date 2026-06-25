import { describe, expect, it } from 'vitest';

import { formatApiError } from './errors';

describe('formatApiError', () => {
  it('formats RFC 7807 problem responses with hints', () => {
    const message = formatApiError(403, 'Forbidden', {
      title: 'Insufficient scope',
      detail: 'Token missing required scopes.',
      error_code: 'insufficient_scope',
    });

    expect(message).toContain('Insufficient scope (403 Forbidden)');
    expect(message).toContain('Token missing required scopes.');
    expect(message).toContain('amp context');
  });

  it('includes validation errors when present', () => {
    const message = formatApiError(400, 'Bad Request', {
      title: 'Validation failed',
      error_code: 'validation_error',
      validation_errors: [
        { field: 'event_type', message: 'Required', code: 'required' },
      ],
    });

    expect(message).toContain('event_type: Required');
    expect(message).toContain('amp help');
  });

  it('falls back to JSON for unknown error bodies', () => {
    const message = formatApiError(500, 'Internal Server Error', {
      message: 'boom',
    });

    expect(message).toContain('500 Internal Server Error');
    expect(message).toContain('"boom"');
  });

  it('prints non-JSON error bodies directly', () => {
    const message = formatApiError(
      502,
      'Bad Gateway',
      '<html>gateway unavailable</html>',
    );

    expect(message).toContain('502 Bad Gateway');
    expect(message).toContain('<html>gateway unavailable</html>');
  });
});
