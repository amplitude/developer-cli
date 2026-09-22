import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveBaseUrl,
  resolveExplicitBaseUrl,
  resolveNamedBaseUrl,
  resolveRegionBaseUrl,
} from './config';

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

describe('resolveRegionBaseUrl', () => {
  it('maps us and eu to the prod / prod-eu hosts', () => {
    expect(resolveRegionBaseUrl('us')).toBe(
      'https://developer-api.amplitude.com',
    );
    expect(resolveRegionBaseUrl('eu')).toBe(
      'https://developer-api.eu.amplitude.com',
    );
  });

  it('throws on an unknown region', () => {
    expect(() => resolveRegionBaseUrl('apac')).toThrow(
      'Unknown --region "apac". Known: us, eu.',
    );
  });
});

describe('resolveNamedBaseUrl', () => {
  it('resolves --region', () => {
    expect(resolveNamedBaseUrl({ regionFlag: 'us' })).toBe(
      'https://developer-api.amplitude.com',
    );
  });

  it('resolves --env', () => {
    expect(resolveNamedBaseUrl({ envFlag: 'staging' })).toBe(
      'https://developer-api.stag2.amplitude.com',
    );
  });

  it('returns undefined when neither is given', () => {
    expect(resolveNamedBaseUrl({})).toBeUndefined();
  });

  it('throws when both --region and --env are given', () => {
    expect(() =>
      resolveNamedBaseUrl({ regionFlag: 'us', envFlag: 'staging' }),
    ).toThrow('Pass either --region or --env, not both.');
  });
});

describe('resolveExplicitBaseUrl', () => {
  it('uses a trailing-slash-trimmed base URL over a selected region', () => {
    expect(
      resolveExplicitBaseUrl({
        baseUrlFlag: 'https://preview.example.com/',
        regionFlag: 'eu',
      }),
    ).toBe('https://preview.example.com');
  });

  it('returns undefined when no endpoint selector is supplied', () => {
    expect(resolveExplicitBaseUrl({})).toBeUndefined();
  });

  it('rejects region and environment selectors together', () => {
    expect(() =>
      resolveExplicitBaseUrl({ regionFlag: 'us', envFlag: 'staging' }),
    ).toThrow('Pass either --region or --env, not both.');
  });
});
