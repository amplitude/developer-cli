import { describe, expect, it } from 'vitest';

import { loginIdHeader } from './login-id';

describe('loginIdHeader', () => {
  it('trims surrounding whitespace without changing case', () => {
    expect(loginIdHeader('  Person+CLI@example.com  ')).toEqual({
      'Amp-Login-Id': 'Person+CLI@example.com',
    });
  });

  it('passes a non-email identifier unchanged', () => {
    expect(loginIdHeader('Account-123')).toEqual({
      'Amp-Login-Id': 'Account-123',
    });
  });

  it.each([undefined, '', ' ', 'x\r\ny', 'x\u0000y', '用户', 'x'.repeat(1025)])(
    'omits missing or unsafe values: %j',
    (loginId) => {
      expect(loginIdHeader(loginId)).toEqual({});
    },
  );
});
