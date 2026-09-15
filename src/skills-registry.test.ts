import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_API_BASE_URL } from './config';
import {
  type CredentialStore,
  type Profile,
  emptyStore,
  saveStore,
  setDefault,
  setProfile,
} from './credential-store';
import {
  fetchSkillDocument,
  fetchSkillIndex,
  resolveSkillsGetBaseUrl,
  resolveSkillsListBaseUrl,
} from './skills-registry';

vi.mock('./client-identity', () => ({
  deviceIdHeader: () => ({ 'Amp-Device-Id': 'device-123' }),
}));

const tempDirectories: string[] = [];

function tempStorePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'amp-skills-registry-'));
  tempDirectories.push(directory);
  return join(directory, 'credentials.json');
}

function oauthProfile(
  baseUrl: string,
  expiresAt = '2999-01-01T00:00:00.000Z',
): Profile {
  return {
    base_url: baseUrl,
    credential: {
      type: 'oauth',
      access_token: 'stored-access-token',
      token_type: 'Bearer',
      expires_at: expiresAt,
    },
    saved_at: '2026-08-05T00:00:00.000Z',
    store: 'file',
  };
}

function saveDefaultProfile(baseUrl: string, expiresAt?: string): string {
  const path = tempStorePath();
  const store = setDefault(
    setProfile(emptyStore(), 'active', oauthProfile(baseUrl, expiresAt)),
    'active',
  );
  saveStore(store, path);
  return path;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveSkillsListBaseUrl', () => {
  it.each([
    [
      'US',
      'https://developer-api.amplitude.com/',
      'https://developer-api.amplitude.com',
    ],
    [
      'EU',
      'https://developer-api.eu.amplitude.com/',
      'https://developer-api.eu.amplitude.com',
    ],
    ['local', 'http://localhost:3036/', 'http://localhost:3036'],
    [
      'staging',
      'https://developer-api.stag2.amplitude.com/',
      'https://developer-api.stag2.amplitude.com',
    ],
    ['custom', 'https://skills.example.test/', 'https://skills.example.test'],
  ])('uses the default profile %s endpoint', (_, baseUrl, expected) => {
    expect(
      resolveSkillsListBaseUrl({}, { path: saveDefaultProfile(baseUrl) }),
    ).toBe(expected);
  });

  it('falls back to US production when the store is missing', () => {
    expect(resolveSkillsListBaseUrl({}, { path: tempStorePath() })).toBe(
      DEFAULT_API_BASE_URL,
    );
  });

  it('falls back to US production when profiles exist but none is active', () => {
    const path = tempStorePath();
    saveStore(
      setProfile(
        emptyStore(),
        'inactive',
        oauthProfile('https://inactive.example.test'),
      ),
      path,
    );

    expect(resolveSkillsListBaseUrl({}, { path })).toBe(DEFAULT_API_BASE_URL);
  });

  it('falls back to US production for an orphaned default pointer', () => {
    const path = tempStorePath();
    const store: CredentialStore = { ...emptyStore(), default: 'missing' };
    saveStore(store, path);

    expect(resolveSkillsListBaseUrl({}, { path })).toBe(DEFAULT_API_BASE_URL);
  });

  it('falls back to US production when the credential path is unreadable', () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      expect(resolveSkillsListBaseUrl({}, { path: '/dev/null/nope' })).toBe(
        DEFAULT_API_BASE_URL,
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('does not use AMP_API_BASE_URL', () => {
    vi.stubEnv('AMP_API_BASE_URL', 'https://ignored.example.test');

    expect(resolveSkillsListBaseUrl({}, { path: tempStorePath() })).toBe(
      DEFAULT_API_BASE_URL,
    );
  });

  it('lets --env local override the default profile', () => {
    expect(
      resolveSkillsListBaseUrl(
        { env: 'local' },
        { path: saveDefaultProfile('https://active.example.test') },
      ),
    ).toBe('http://localhost:3036');
  });

  it.each([
    ['us', 'https://developer-api.amplitude.com'],
    ['eu', 'https://developer-api.eu.amplitude.com'],
  ])('routes --region %s to its endpoint', (region, expected) => {
    expect(
      resolveSkillsListBaseUrl({ region }, { path: tempStorePath() }),
    ).toBe(expected);
  });

  it.each(['local', 'staging', 'dev'])(
    'rejects unsupported list region %s',
    (region) => {
      expect(() =>
        resolveSkillsListBaseUrl({ region }, { path: tempStorePath() }),
      ).toThrowError(`Unknown --region "${region}". Known: us, eu.`);
    },
  );

  it('keeps the existing unknown-environment usage error', () => {
    expect(() =>
      resolveSkillsListBaseUrl({ env: 'unknown' }, { path: tempStorePath() }),
    ).toThrowError(/Unknown --env/);
  });
});

describe('resolveSkillsGetBaseUrl', () => {
  it('resolves an explicit region without a credential store', () => {
    expect(
      resolveSkillsGetBaseUrl({ region: 'eu' }, { path: tempStorePath() }),
    ).toBe('https://developer-api.eu.amplitude.com');
  });

  it.each([
    ['us', 'https://developer-api.amplitude.com'],
    ['eu', 'https://developer-api.eu.amplitude.com'],
  ])('lets --region %s override the default profile', (region, expected) => {
    expect(
      resolveSkillsGetBaseUrl(
        { region },
        { path: saveDefaultProfile('http://localhost:3036') },
      ),
    ).toBe(expected);
  });

  it('uses the default profile endpoint when --region is absent', () => {
    expect(
      resolveSkillsGetBaseUrl(
        {},
        { path: saveDefaultProfile('https://custom.example.test/') },
      ),
    ).toBe('https://custom.example.test');
  });

  it('ignores AMP_PROFILE and uses only store.default', () => {
    const path = tempStorePath();
    const store = setDefault(
      setProfile(
        setProfile(
          emptyStore(),
          'active',
          oauthProfile('https://active.example.test'),
        ),
        'other',
        oauthProfile('https://other.example.test'),
      ),
      'active',
    );
    saveStore(store, path);
    vi.stubEnv('AMP_PROFILE', 'other');

    expect(resolveSkillsGetBaseUrl({}, { path })).toBe(
      'https://active.example.test',
    );
  });

  it('uses an expired profile credential only for its endpoint', () => {
    const path = saveDefaultProfile(
      'https://expired.example.test/',
      '2000-01-01T00:00:00.000Z',
    );

    expect(resolveSkillsListBaseUrl({}, { path })).toBe(
      'https://expired.example.test',
    );
    expect(resolveSkillsGetBaseUrl({}, { path })).toBe(
      'https://expired.example.test',
    );
  });

  it('requires --region when no usable default profile exists', () => {
    const error = (() => {
      try {
        resolveSkillsGetBaseUrl({}, { path: tempStorePath() });
      } catch (caught) {
        return caught;
      }

      throw new Error('resolveSkillsGetBaseUrl should have thrown');
    })();

    expect(error).toMatchObject({ errorCode: 'usage_error', exitCode: 2 });
  });

  it('keeps the existing invalid-region usage error', () => {
    expect(() =>
      resolveSkillsGetBaseUrl(
        { region: 'apac' },
        { path: saveDefaultProfile('https://active.example.test') },
      ),
    ).toThrowError('Unknown --region "apac". Known: us, eu.');
  });

  it('lets --env local override the default profile', () => {
    expect(
      resolveSkillsGetBaseUrl(
        { env: 'local' },
        { path: saveDefaultProfile('https://active.example.test') },
      ),
    ).toBe('http://localhost:3036');
  });

  it('rejects combining --env and --region', () => {
    expect(() =>
      resolveSkillsGetBaseUrl(
        { env: 'local', region: 'us' },
        { path: tempStorePath() },
      ),
    ).toThrowError('Pass either --region or --env, not both.');
  });
});

describe('fetchSkillIndex', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('classifies a malformed 200 body as upstream_error rather than throwing a raw parse error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response('not json', { status: 200 })),
      ),
    );

    await expect(fetchSkillIndex('https://example.test')).rejects.toMatchObject(
      { errorCode: 'upstream_error', exitCode: 5 },
    );
  });

  it('sends the stable device id when retrieving the skills index', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSkillIndex('https://example.test');

    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get('amp-device-id')).toBe('device-123');
  });

  it('classifies an index 404 as an upstream endpoint error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ detail: 'No skill named "unknown".' }),
            {
              status: 404,
              headers: { 'content-type': 'application/problem+json' },
            },
          ),
        ),
      ),
    );

    let caught: unknown;
    try {
      await fetchSkillIndex('https://example.test');
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      message:
        'The skills registry index at https://example.test/v1/skills returned HTTP 404.',
      errorCode: 'upstream_error',
      exitCode: 5,
      httpStatus: 404,
      hint: 'Inspect the active profile endpoint with `amp auth status` or switch profiles with `amp auth use <profile>`.',
    });
    expect(caught).not.toMatchObject({
      hint: 'Run `amp skills list` to see what is available.',
    });
  });

  it('guides transport failures through supported profile commands', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.reject(new Error('offline'))),
    );

    await expect(fetchSkillIndex('https://example.test')).rejects.toMatchObject(
      {
        errorCode: 'transport_error',
        hint: 'Check network connectivity and retry. Inspect the active profile endpoint with `amp auth status` or switch profiles with `amp auth use <profile>`.',
      },
    );
  });
});

const DOCUMENT = `---
name: integrating-amplitude
description: Use when finding a skill.
---

# Using Amplitude
`;

function stubResponse(body: string, headers: Record<string, string>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(body, { status: 200, headers })),
    ),
  );
}

describe('fetchSkillDocument', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the body verbatim for text/markdown', async () => {
    stubResponse(DOCUMENT, { 'content-type': 'text/markdown; charset=utf-8' });

    await expect(
      fetchSkillDocument('https://example.test', 'integrating-amplitude'),
    ).resolves.toBe(DOCUMENT);
  });

  it('guides transport failures through the supported region override', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.reject(new Error('offline'))),
    );

    await expect(
      fetchSkillDocument('https://example.test', 'integrating-amplitude'),
    ).rejects.toMatchObject({
      errorCode: 'transport_error',
      hint: 'Check network connectivity and retry. If the endpoint is wrong, pass --region <us|eu>.',
    });
  });

  it('accepts text/markdown with no parameters', async () => {
    stubResponse(DOCUMENT, { 'content-type': 'text/markdown' });

    await expect(
      fetchSkillDocument('https://example.test', 'integrating-amplitude'),
    ).resolves.toBe(DOCUMENT);
  });

  // A captive portal or proxy interstitial answers 200 with an HTML login page.
  // Returning it would have the caller write it to SKILL.md and follow it.
  it('rejects a 200 that is not markdown as upstream_error', async () => {
    stubResponse('<html><body>Sign in to continue</body></html>', {
      'content-type': 'text/html; charset=utf-8',
    });

    await expect(
      fetchSkillDocument('https://example.test', 'integrating-amplitude'),
    ).rejects.toMatchObject({ errorCode: 'upstream_error', exitCode: 5 });
  });

  it('rejects a 200 with no content type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(DOCUMENT, {
            status: 200,
            headers: { 'content-type': '' },
          }),
        ),
      ),
    );

    await expect(
      fetchSkillDocument('https://example.test', 'integrating-amplitude'),
    ).rejects.toMatchObject({ errorCode: 'upstream_error', exitCode: 5 });
  });

  it('still classifies a 404 as not_found rather than a content-type failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ detail: 'No skill named "nope".' }), {
            status: 404,
            headers: { 'content-type': 'application/problem+json' },
          }),
        ),
      ),
    );

    await expect(
      fetchSkillDocument('https://example.test', 'nope'),
    ).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});
