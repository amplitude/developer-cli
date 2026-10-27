import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  formatSignupText,
  SIGNUP_DOCUMENT_URLS,
  signupErrorFromResponse,
  signupMissingInformationError,
  signupPollContinuation,
  signupRequestSchema,
  signupResponseSchema,
  signupSupportedFlags,
} from './signup-response';

const requiredSchema = {
  type: 'object',
  required: ['company_domain', 'full_name'],
  properties: {
    company_domain: { type: 'string', description: 'Work domain' },
  },
  $defs: { address: { properties: { country: { enum: ['US', 'DE'] } } } },
  'x-example': { nested: ['value'] },
};

describe('signup response contract', () => {
  it.each([
    { label: 'Terms of Service', url: SIGNUP_DOCUMENT_URLS.terms_of_service },
    { label: 'Privacy Policy', url: SIGNUP_DOCUMENT_URLS.privacy_policy },
  ])(
    'keeps the README $label link aligned with submitted consent',
    ({ label, url }) => {
      const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
      const link = readme.match(new RegExp(`\\[${label}\\]\\(([^)]+)\\)`));
      expect(link?.[1]).toBe(url);
    },
  );

  it('retains unfamiliar required fields and nested metadata', () => {
    const body = {
      type: 'needs_information',
      needs_information: { schema: requiredSchema },
    };
    expect(signupResponseSchema.parse(body)).toEqual(body);
    expect(signupSupportedFlags(requiredSchema)).toEqual({
      full_name: '--full-name',
    });
  });

  it('keeps the same full schema in human output', () => {
    const text = formatSignupText({
      status: 'needs_information',
      message: 'More information required.',
      data: {
        schema: requiredSchema,
        supported_flags: { full_name: '--full-name' },
      },
    });
    expect(text).toContain(
      JSON.stringify(requiredSchema, null, 2).split('\n')[1].trim(),
    );
    expect(text).toContain('Work domain');
    expect(text).toContain('x-example');
    expect(text).toContain('$defs');
  });

  it.each([
    { type: 'credentials', credentials: { access_token: 'sensitive' } },
    {
      type: 'requires_auth',
      requires_auth: { type: 'device_authorization', device_authorization: {} },
    },
    { type: 'needs_information', needs_information: { schema: [] } },
    { type: 'new_outcome' },
  ])('rejects malformed success %j', (input) => {
    expect(signupResponseSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    [
      { kind: 'terms_of_service', url: 'https://amplitude.com/terms/v2' },
      { kind: 'privacy_policy', url: 'https://amplitude.com/privacy' },
    ],
    [
      { kind: 'terms_of_service', url: 'https://amplitude.com/terms' },
      { kind: 'privacy_policy', url: 'https://amplitude.com/privacy' },
      { kind: 'new_document', url: 'https://amplitude.com/new-document' },
    ],
  ])(
    'preserves unfamiliar backend legal document requirements: %j',
    (...documents) => {
      expect(
        signupMissingInformationError({
          required: ['terms_acceptance'],
          properties: { terms_acceptance: { type: 'object', documents } },
        }),
      ).toBeUndefined();
    },
  );

  it('formats canonical backend document requirements as a usage error', () => {
    const error = signupMissingInformationError({
      required: ['terms_acceptance'],
      properties: {
        terms_acceptance: {
          type: 'object',
          documents: [
            { kind: 'terms_of_service', url: 'https://amplitude.com/terms' },
            { kind: 'privacy_policy', url: 'https://amplitude.com/privacy' },
          ],
        },
      },
    });
    expect(error?.errorCode).toBe('usage_error');
    expect(error?.message).toContain('--accept-tos');
  });

  it('preserves server error code/message without a locally generated hint', () => {
    const error = signupErrorFromResponse(400, 'Bad Request', {
      type: 'error',
      error: {
        code: 'terms_documents_outdated',
        message: 'Update this client.',
      },
    });
    expect(error.message).toBe('Update this client.');
    expect(error.errorCode).toBe('terms_documents_outdated');
    expect(error.exitCode).toBe(2);
    expect(error.hint).toBeUndefined();
  });

  it.each([
    'secret-access',
    { access_token: 'secret-access' },
    { type: 'error', error: { code: 'bad' } },
  ])('does not echo a malformed error body: %j', (body) => {
    const error = signupErrorFromResponse(502, 'Bad Gateway', body);
    expect(error.exitCode).toBe(5);
    expect(error.message).not.toContain('secret-access');
    expect(error.detail).toBeUndefined();
  });

  it('retains common API problem details', () => {
    const error = signupErrorFromResponse(400, 'Bad Request', {
      type: 'about:blank',
      title: 'Invalid Request',
      status: 400,
      error_code: 'validation_error',
      detail: 'Supply a valid email address.',
    });
    expect(error.errorCode).toBe('validation_error');
    expect(error.message).toContain('Supply a valid email address.');
  });

  it('returns exact argv and shell-quotes the profile', () => {
    const profile = "team $(command) 'quoted'";
    const continuation = signupPollContinuation(profile);
    expect(continuation.argv).toEqual([
      'amp',
      'auth',
      'login',
      'poll',
      '--profile',
      profile,
      '--json',
    ]);
    expect(continuation.command).toBe(
      "amp auth login poll --profile 'team $(command) '\\''quoted'\\''' --json",
    );
  });

  it('validates explicit acceptance but allows it to be omitted', () => {
    const request = signupRequestSchema.safeParse({
      email: ' Alex@Example.com ',
      terms_acceptance: {
        terms_of_service: {
          url: SIGNUP_DOCUMENT_URLS.terms_of_service,
          accepted: true,
        },
        privacy_policy: {
          url: SIGNUP_DOCUMENT_URLS.privacy_policy,
          accepted: true,
        },
      },
    });
    expect(request.success).toBe(true);
    if (request.success) expect(request.data.email).toBe('alex@example.com');
    expect(
      signupRequestSchema.safeParse({ email: 'alex@example.com' }).success,
    ).toBe(true);
    expect(
      signupRequestSchema.safeParse({ email: 'alex@example.com', answers: {} })
        .success,
    ).toBe(false);
  });
});
