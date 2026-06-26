import { afterEach, describe, expect, it } from 'vitest';

import {
  authSetupInstructions,
  EU_APP_ORIGIN,
  missingTokenMessage,
  personalAccessTokenSetupUrl,
  resolveAppOrigin,
} from './auth-guidance';

describe('auth guidance', () => {
  it('builds the default PAT settings URL', () => {
    expect(
      personalAccessTokenSetupUrl({
        appOrigin: 'https://app.amplitude.com',
      }),
    ).toBe(
      'https://app.amplitude.com/analytics/amplitude/settings/profile/personal-access-tokens',
    );
  });

  it('includes org slug when provided', () => {
    expect(
      personalAccessTokenSetupUrl({
        appOrigin: 'https://app.amplitude.com',
        orgUrl: 'acme-corp',
      }),
    ).toBe(
      'https://app.amplitude.com/analytics/acme-corp/settings/profile/personal-access-tokens',
    );
  });

  it('detects EU app origin from an explicit API base URL', () => {
    expect(
      personalAccessTokenSetupUrl({
        apiBaseUrl: 'https://developer-api.eu.amplitude.com',
      }),
    ).toBe(
      'https://eu.amplitude.com/analytics/amplitude/settings/profile/personal-access-tokens',
    );
  });

  it('lets AMP_APP_URL override an explicit API base URL', () => {
    const original = process.env.AMP_APP_URL;
    process.env.AMP_APP_URL = 'https://custom-app.example.com/';
    try {
      expect(
        personalAccessTokenSetupUrl({
          apiBaseUrl: 'https://developer-api.eu.amplitude.com',
        }),
      ).toBe(
        'https://custom-app.example.com/analytics/amplitude/settings/profile/personal-access-tokens',
      );
    } finally {
      restoreEnvValue('AMP_APP_URL', original);
    }
  });

  it('mentions the PAT setup URL when token is missing', () => {
    expect(missingTokenMessage()).toContain(
      'https://app.amplitude.com/analytics/amplitude/settings/profile/personal-access-tokens',
    );
    expect(missingTokenMessage()).toContain('amp auth pat');
  });

  it('uses the explicit API base URL in missing-token guidance', () => {
    expect(
      missingTokenMessage({
        apiBaseUrl: 'https://developer-api.eu.amplitude.com',
      }),
    ).toContain(
      'https://eu.amplitude.com/analytics/amplitude/settings/profile/personal-access-tokens',
    );
  });

  it('documents setup steps in auth instructions', () => {
    expect(authSetupInstructions()).toContain('amp context');
    expect(authSetupInstructions()).toContain('personal-access-tokens');
  });

  describe('app origin from shared base URL env helper', () => {
    const original = {
      appUrl: process.env.AMP_APP_URL,
      base: process.env.AMP_API_BASE_URL,
    };

    afterEach(() => {
      restoreEnvValue('AMP_APP_URL', original.appUrl);
      restoreEnvValue('AMP_API_BASE_URL', original.base);
    });

    it('detects EU from AMP_API_BASE_URL', () => {
      delete process.env.AMP_APP_URL;
      process.env.AMP_API_BASE_URL = 'https://api.eu.amplitude.com';

      expect(resolveAppOrigin()).toBe(EU_APP_ORIGIN);
    });
  });
});

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
