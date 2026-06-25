import { afterEach, describe, expect, it } from 'vitest';

import { resolveBaseUrl } from './config';

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('resolveBaseUrl', () => {
  const original = {
    base: process.env.AMP_API_BASE_URL,
  };

  afterEach(() => {
    restoreEnvValue('AMP_API_BASE_URL', original.base);
  });

  it('resolves flag > AMP_API_BASE_URL > default and strips trailing slash', () => {
    delete process.env.AMP_API_BASE_URL;
    expect(resolveBaseUrl({})).toBe('https://developer-api.amplitude.com');

    process.env.AMP_API_BASE_URL = 'https://canonical.example.com//';
    expect(resolveBaseUrl({})).toBe('https://canonical.example.com/');

    expect(resolveBaseUrl({ 'base-url': 'https://flag.example.com/' })).toBe(
      'https://flag.example.com',
    );
  });

  it('throws when --base-url is passed without a value', () => {
    expect(() => resolveBaseUrl({ 'base-url': true })).toThrowError(
      'Expected --base-url to have a value.',
    );
  });
});
