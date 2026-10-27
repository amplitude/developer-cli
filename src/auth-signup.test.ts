import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type FlagValue } from './args';
import { runAuthLoginPoll } from './auth-commands';
import { type AuthSignupDeps, runAuthSignup } from './auth-signup';
import { type AnonymousRequest } from './authToken';
import { ENV_BASE_URLS } from './config';
import {
  emptyStore,
  loadStore,
  type Profile,
  saveStore,
  setDefault,
  setProfile,
  updateStore,
} from './credential-store';
import {
  emptyPending,
  getPending,
  loadPending,
  savePending,
  setPending,
} from './pending-store';
import { SIGNUP_DOCUMENT_URLS } from './signup-response';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const token = {
  access_token: 'secret-access',
  refresh_token: 'secret-refresh',
  id_token: 'secret-id',
  token_type: 'Bearer',
  expires_in: 3600,
};
const flags: Record<string, FlagValue> = {
  'non-interactive': true,
  email: 'new@example.com',
  'full-name': 'Alex Morgan',
  region: 'us',
  'accept-tos': true,
};
function deviceResponse(interval?: number) {
  return {
    type: 'requires_auth',
    requires_auth: {
      type: 'device_authorization',
      device_authorization: {
        device_code: 'secret-device',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.example.com/device',
        verification_uri_complete:
          'https://auth.example.com/device?user_code=ABCD-EFGH',
        expires_in: 600,
        ...(interval === undefined ? {} : { interval }),
        access_token: 'secret-extra',
      },
    },
  };
}

describe('auth signup', () => {
  let dir: string;
  let path: string;
  let pendingPath: string;
  let request: ReturnType<typeof vi.fn<AnonymousRequest>>;
  const originalExit = process.exitCode;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amp-signup-'));
    path = join(dir, 'credentials.json');
    pendingPath = join(dir, 'pending.json');
    request = vi.fn<AnonymousRequest>(async () => ({
      status: 200,
      body: { type: 'credentials', credentials: token },
    }));
    process.exitCode = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = originalExit;
  });
  const deps = (extra: AuthSignupDeps = {}): AuthSignupDeps => ({
    path,
    pendingPath,
    request,
    now: () => NOW,
    ...extra,
  });
  function seedProfile() {
    const profile: Profile = {
      base_url: ENV_BASE_URLS.prod,
      credential: { type: 'pat', pat: 'previous-secret' },
      saved_at: new Date(NOW - 1000).toISOString(),
      store: 'file',
    };
    const store = setDefault(
      setProfile(setProfile(emptyStore(), 'active', profile), 'other', profile),
      'active',
    );
    saveStore(store, path);
    return store;
  }
  function seedPending() {
    const pending = setPending(emptyPending(), 'active', {
      device_code: 'previous-device',
      base_url: ENV_BASE_URLS.prod,
      expires_at: new Date(NOW + 1000).toISOString(),
      interval: 5,
      started_at: new Date(NOW - 1000).toISOString(),
    });
    savePending(pending, pendingPath);
    return pending;
  }

  it('saves and activates immediate credentials with an acceptance receipt and no secrets', async () => {
    const result = await runAuthSignup(flags, deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      status: 'authorized',
      message:
        'Authentication complete. You can now run authenticated CLI commands',
      data: {
        profile: 'default',
        base_url: ENV_BASE_URLS.prod,
        terms_acceptance: SIGNUP_DOCUMENT_URLS,
      },
    });
    expect(loadStore(path).default).toBe('default');
    expect(loadStore(path).profiles.default.credential).toMatchObject({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
    });
    expect(statSync(path).mode % 0o1000).toBe(0o600);
    for (const secret of ['secret-access', 'secret-refresh', 'secret-id'])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('POST', '/v1/auth/signup', {
      email: flags.email,
      full_name: flags['full-name'],
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
  });

  it.each([undefined, false, 'false'])(
    'requires explicit noninteractive mode: %s',
    async (mode) => {
      const input: Record<string, FlagValue> = { ...flags, json: true };
      if (mode === undefined) delete input['non-interactive'];
      else input['non-interactive'] = mode;
      const result = await runAuthSignup(input, deps());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.exitCode).toBe(2);
      expect(request).not.toHaveBeenCalled();
      expect(loadStore(path)).toEqual(emptyStore());
    },
  );

  it('requires email locally without inventing a terms requirement', async () => {
    const result = await runAuthSignup(
      { 'non-interactive': true, region: 'us', yes: true },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorCode).toBe('usage_error');
      expect(result.error.message).toBe('Signup requires --email <email>.');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it.each([undefined, false, 'false'])(
    'lets the backend authorize without consent when --accept-tos is %s',
    async (consent) => {
      const input: Record<string, FlagValue> = { ...flags, yes: true };
      if (consent === undefined) delete input['accept-tos'];
      else input['accept-tos'] = consent;
      const result = await runAuthSignup(input, deps());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output.status).toBe('authorized');
        expect(result.output.data).not.toHaveProperty('terms_acceptance');
      }
      expect(request).toHaveBeenCalledWith('POST', '/v1/auth/signup', {
        email: 'new@example.com',
        full_name: 'Alex Morgan',
      });
      expect(loadStore(path).profiles.default.credential).toMatchObject({
        access_token: token.access_token,
      });
    },
  );

  it.each([
    { required: ['terms_acceptance'], missingFlags: ['--accept-tos'] },
    { required: ['full_name'], missingFlags: ['--full-name'] },
    {
      required: ['full_name', 'terms_acceptance'],
      missingFlags: ['--full-name', '--accept-tos'],
    },
  ])(
    'reports backend-required fields together: $required',
    async ({ required, missingFlags }) => {
      const before = seedProfile();
      const pending = seedPending();
      request.mockResolvedValue({
        status: 200,
        body: {
          type: 'needs_information',
          needs_information: { schema: { type: 'object', required } },
        },
      });
      const input = { ...flags };
      delete input['accept-tos'];
      delete input['full-name'];
      const result = await runAuthSignup(input, deps());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.errorCode).toBe('usage_error');
        expect(result.error.exitCode).toBe(2);
        for (const flag of missingFlags)
          expect(result.error.message).toContain(flag);
        if (required.includes('terms_acceptance')) {
          expect(result.error.message).toContain(
            'agree to the Terms of Service (https://amplitude.com/terms)',
          );
          expect(result.error.message).toContain(
            'acknowledge that the Amplitude Privacy Policy (https://amplitude.com/privacy) applies',
          );
        }
      }
      expect(request).toHaveBeenCalledTimes(1);
      expect(loadStore(path)).toEqual(before);
      expect(loadPending(pendingPath)).toEqual(pending);
    },
  );

  const invalidInputs: Record<string, FlagValue>[] = [
    { email: 'bad' },
    { email: true },
    { 'full-name': true },
    { 'full-name': ' ' },
  ];
  it.each(invalidInputs)(
    'rejects invalid request inputs before the network: %j',
    async (input) => {
      const result = await runAuthSignup({ ...flags, ...input }, deps());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.exitCode).toBe(2);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('sends an omitted full name and preserves future server requirements', async () => {
    const before = seedProfile();
    const input = { ...flags };
    delete input['full-name'];
    const schema = {
      type: 'object',
      required: ['company_domain', 'full_name'],
      properties: {
        company_domain: { description: 'Work domain', type: 'string' },
      },
      $defs: { nested: { enum: ['one', 'two'] } },
      'x-extra': { opaque: true },
    };
    request.mockResolvedValue({
      status: 200,
      body: { type: 'needs_information', needs_information: { schema } },
    });
    const result = await runAuthSignup(input, deps());
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.output).toMatchObject({
        status: 'needs_information',
        data: { schema, supported_flags: { full_name: '--full-name' } },
      });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][2]).not.toHaveProperty('full_name');
    expect(loadStore(path)).toEqual(before);
    expect(result).not.toHaveProperty('output.data.terms_acceptance');
    if (result.ok)
      expect(result.output.message).not.toMatch(/newer client|upgrade/i);
  });

  it.each(['cold', 'active', 'named'])(
    'requires an explicit target with a %s profile',
    async (selection) => {
      if (selection !== 'cold') {
        seedProfile();
        await updateStore(path, (store) =>
          setProfile(store, 'active', {
            ...store.profiles.active,
            base_url: ENV_BASE_URLS['prod-eu'],
          }),
        );
      }
      const before = loadStore(path);
      const input: Record<string, FlagValue> = { ...flags };
      delete input.region;
      if (selection === 'named') input.profile = 'active';
      const result = await runAuthSignup(input, deps());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.exitCode).toBe(2);
        expect(result.error.message).toContain('--region');
      }
      expect(request).not.toHaveBeenCalled();
      expect(loadStore(path)).toEqual(before);
      expect(loadPending(pendingPath)).toEqual(emptyPending());
    },
  );

  it.each([
    {
      flag: 'env',
      value: 'dev',
      target: 'https://developer-api.dev.amplitude.com',
    },
    {
      flag: 'base-url',
      value: 'http://localhost:3036',
      target: 'http://localhost:3036',
    },
  ])(
    'accepts an explicit development target --$flag',
    async ({ flag, value, target }) => {
      const input: Record<string, FlagValue> = { ...flags };
      input[flag] = value;
      delete input.region;
      const result = await runAuthSignup(input, deps());
      expect(result.ok).toBe(true);
      if (!result.ok || result.output.status !== 'authorized') return;
      expect(result.output.data.base_url).toBe(target);
      expect(loadStore(path).profiles.default.base_url).toBe(target);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('replaces same-endpoint credentials without force with an explicit region', async () => {
    const before = seedProfile();
    seedPending();
    const result = await runAuthSignup(flags, deps());
    expect(result.ok).toBe(true);
    const saved = loadStore(path);
    expect(saved.default).toBe('active');
    expect(saved.profiles.active.credential).toMatchObject({
      access_token: token.access_token,
    });
    expect(saved.profiles.other).toEqual(before.profiles.other);
    expect(getPending(loadPending(pendingPath), 'active')).toBeUndefined();
  });

  it('creates a requested named profile only on immediate success', async () => {
    const before = seedProfile();
    const result = await runAuthSignup(
      { ...flags, profile: 'new-name' },
      deps(),
    );
    expect(result.ok).toBe(true);
    expect(loadStore(path).default).toBe('new-name');
    expect(loadStore(path).profiles.active).toEqual(before.profiles.active);
  });

  it('refuses a retarget without force before any signup request', async () => {
    const before = seedProfile();
    const pending = seedPending();
    const result = await runAuthSignup({ ...flags, region: 'eu' }, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.exitCode).toBe(2);
      expect(result.error.message).toContain('--force');
    }
    expect(request).not.toHaveBeenCalled();
    expect(loadStore(path)).toEqual(before);
    expect(loadPending(pendingPath)).toEqual(pending);
  });

  it.each([undefined, 7])(
    'persists the supplied challenge with interval %s without replacing credentials',
    async (interval) => {
      const before = seedProfile();
      seedPending();
      request.mockResolvedValue({
        status: 200,
        body: deviceResponse(interval),
      });
      const result = await runAuthSignup(
        { ...flags, region: 'eu', force: true },
        deps(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.output.status !== 'requires_auth') return;
      expect(result.exitCode).toBe(0);
      expect(result.output.data).toMatchObject({
        profile: 'active',
        base_url: ENV_BASE_URLS['prod-eu'],
        replaced_pending: true,
        continuation: {
          argv: [
            'amp',
            'auth',
            'login',
            'poll',
            '--profile',
            'active',
            '--json',
          ],
        },
      });
      expect(result.output.message).not.toMatch(/replac/i);
      expect(result.output.message).not.toMatch(/--timeout|poll waits/i);
      expect(JSON.stringify(result)).not.toContain('secret-device');
      expect(JSON.stringify(result)).not.toContain('secret-extra');
      expect(result.output.data).not.toHaveProperty('terms_acceptance');
      expect(result.output.data).not.toHaveProperty('interval');
      expect(loadStore(path)).toEqual(before);
      expect(getPending(loadPending(pendingPath), 'active')).toEqual({
        device_code: 'secret-device',
        base_url: ENV_BASE_URLS['prod-eu'],
        interval: interval ?? 5,
        started_at: new Date(NOW).toISOString(),
        expires_at: new Date(NOW + 600000).toISOString(),
      });
      expect(statSync(pendingPath).mode % 0o1000).toBe(0o600);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a new profile inactive until the returned challenge is authorized', async () => {
    const before = seedProfile();
    request.mockResolvedValue({ status: 200, body: deviceResponse(5) });
    await runAuthSignup({ ...flags, profile: 'new-name' }, deps());
    expect(loadStore(path)).toEqual(before);
    expect(getPending(loadPending(pendingPath), 'new-name')).toBeDefined();
  });

  it('continues signup using the existing poll command and original device code', async () => {
    const before = seedProfile();
    request.mockResolvedValue({ status: 200, body: deviceResponse(5) });
    await runAuthSignup({ ...flags, region: 'eu', force: true }, deps());
    expect(loadStore(path)).toEqual(before);
    const pollRequest = vi.fn<AnonymousRequest>(async () => ({
      status: 200,
      body: token,
    }));
    const stdout = vi.fn<(line: string) => void>();
    await runAuthLoginPoll(
      { profile: 'active', timeout: '0' },
      { path, pendingPath, request: pollRequest, stdout, now: () => NOW },
    );
    expect(pollRequest).toHaveBeenCalledWith(
      'POST',
      '/v1/auth/token',
      expect.objectContaining({ device_code: 'secret-device' }),
    );
    expect(loadStore(path).profiles.active).toMatchObject({
      base_url: ENV_BASE_URLS['prod-eu'],
      credential: { access_token: token.access_token },
    });
    expect(loadStore(path).default).toBe('active');
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('authorized'));
  });

  it('preserves concurrent unrelated profile writes', async () => {
    seedProfile();
    request.mockImplementation(async () => {
      await updateStore(path, (latest) =>
        setProfile(latest, 'concurrent', latest.profiles.other),
      );
      return { status: 200, body: { type: 'credentials', credentials: token } };
    });
    await runAuthSignup(flags, deps());
    expect(loadStore(path).profiles.concurrent).toBeDefined();
  });

  it('returns recovery after real credential persistence fails, preserving prior state', async () => {
    const before = seedProfile();
    const pending = seedPending();
    const save = vi.fn<typeof saveStore>().mockImplementation(() => {
      throw new Error('secret-access');
    });
    const persist: typeof updateStore = (file, mutate) =>
      updateStore(file, mutate, { save });
    const result = await runAuthSignup(flags, deps({ updateStore: persist }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('amp auth login');
    expect(JSON.stringify(result)).not.toContain('secret-access');
    expect(loadStore(path)).toEqual(before);
    expect(loadPending(pendingPath)).toEqual(pending);
  });

  it('reports challenge storage failure without replacing stored credentials', async () => {
    const before = seedProfile();
    const pending = seedPending();
    request.mockResolvedValue({ status: 200, body: deviceResponse() });
    const persist = vi.fn<typeof savePending>().mockImplementation(() => {
      throw new Error('secret-device');
    });
    const result = await runAuthSignup(flags, deps({ savePending: persist }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-device');
    expect(loadStore(path)).toEqual(before);
    expect(loadPending(pendingPath)).toEqual(pending);
  });

  it('reports cleanup failure accurately after credentials have already been saved', async () => {
    seedProfile();
    seedPending();
    const persist = vi.fn<typeof savePending>().mockImplementation(() => {
      throw new Error('cleanup');
    });
    const result = await runAuthSignup(flags, deps({ savePending: persist }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('saved');
    expect(loadStore(path).profiles.active.credential).toMatchObject({
      access_token: token.access_token,
    });
  });

  it.each([
    {
      status: 200,
      body: {
        type: 'credentials',
        credentials: { access_token: 'secret-access' },
      },
    },
    { status: 502, body: '<html>secret-access</html>' },
  ])('safely rejects malformed responses: %j', async (response) => {
    const before = seedProfile();
    request.mockResolvedValue(response);
    const result = await runAuthSignup(flags, deps());
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-access');
    expect(request).toHaveBeenCalledTimes(1);
    expect(loadStore(path)).toEqual(before);
  });

  it('does not retry or echo details after transport failure', async () => {
    request.mockRejectedValue(new Error('secret-access'));
    const result = await runAuthSignup(flags, deps());
    expect(result.ok).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('secret-access');
  });

  it('returns the exact server-owned outdated-document error', async () => {
    request.mockResolvedValue({
      status: 400,
      body: {
        type: 'error',
        error: {
          code: 'terms_documents_outdated',
          message: 'Update this client.',
        },
      },
    });
    const result = await runAuthSignup(flags, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Update this client.');
      expect(result.error.errorCode).toBe('terms_documents_outdated');
      expect(result.error.exitCode).toBe(2);
      expect(result.error.hint).toBeUndefined();
    }
  });
});
