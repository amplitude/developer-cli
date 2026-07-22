import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAnonymousRequest,
  formatVerificationPrompt,
  generatePkcePair,
  pollDeviceTokenBounded,
  pollForToken,
  requestDeviceToken,
  runAuthTokenCommand,
  startWaitingIndicator,
} from './authToken';

describe('generatePkcePair', () => {
  it('derives an S256 challenge from a base64url verifier', () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();

    // 32 random bytes, base64url, no padding => 43 chars from the URL-safe set.
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallenge).toBe(
      createHash('sha256').update(codeVerifier).digest('base64url'),
    );
  });
});

describe('formatVerificationPrompt', () => {
  it('shows the user_code and verification URL but never the device_code', () => {
    const message = formatVerificationPrompt({
      device_code: 'SECRET-DEVICE-CODE',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://amp.example/device',
      verification_uri_complete:
        'https://amp.example/device?user_code=WDJB-MJHT',
      expires_in: 600,
    });

    expect(message).toContain('WDJB-MJHT');
    expect(message).toContain('https://amp.example/device');
    expect(message).not.toContain('SECRET-DEVICE-CODE');
  });
});

describe('requestDeviceToken open affordance', () => {
  const deviceAuthorization = {
    status: 200,
    body: {
      device_code: 'DEVICE-CODE-SECRET',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://amp.example/device',
      verification_uri_complete:
        'https://amp.example/device?user_code=WDJB-MJHT',
      expires_in: 600,
      interval: 1,
    },
  };

  it('opens the verification URL when Enter is pressed at a TTY', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    // The affordance needs stderr to be a TTY too (that's where the "Press
    // Enter" hint shows); restore it so the stub can't leak to other tests.
    const originalStderrIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    const opened: string[] = [];

    let tokenAttempts = 0;
    const request = (method: string, path: string) => {
      if (path.endsWith('/v1/auth/device-authorization')) {
        return Promise.resolve(deviceAuthorization);
      }
      tokenAttempts += 1;
      if (tokenAttempts < 2) {
        return Promise.resolve({
          status: 400,
          body: { error: 'authorization_pending' },
        });
      }
      return Promise.resolve({
        status: 200,
        body: {
          access_token: 'ACCESS-TOKEN',
          token_type: 'bearer',
          expires_in: 3600,
        },
      });
    };

    // Press Enter while the first poll is sleeping, then resolve a tick later so
    // the stdin data listener (and the open it triggers) has run.
    const sleep = () => {
      stdin.write('\n');
      return new Promise<void>((resolve) => setImmediate(resolve));
    };

    try {
      await requestDeviceToken({
        flow: 'device',
        request,
        sleep,
        now: () => 0,
        stderr: () => {},
        stdin,
        openUrl: (url) => {
          opened.push(url);
          return Promise.resolve();
        },
      });
    } finally {
      process.stderr.isTTY = originalStderrIsTTY;
    }

    expect(opened).toEqual(['https://amp.example/device?user_code=WDJB-MJHT']);
  });

  it('skips the affordance (no hint, no open) when stdin is not a TTY', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    const opened: string[] = [];
    const err: string[] = [];

    const request = (method: string, path: string) =>
      path.endsWith('/v1/auth/device-authorization')
        ? Promise.resolve(deviceAuthorization)
        : Promise.resolve({
            status: 200,
            body: {
              access_token: 'ACCESS-TOKEN',
              token_type: 'bearer',
              expires_in: 3600,
            },
          });

    await requestDeviceToken({
      flow: 'device',
      request,
      sleep: () => Promise.resolve(),
      now: () => 0,
      stderr: (line) => err.push(line),
      stdin,
      openUrl: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });

    expect(opened).toEqual([]);
    expect(err.join('\n')).not.toContain('Press Enter');
  });
});

describe('startWaitingIndicator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('animates frames in place at a TTY and clears the line on stop', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const stop = startWaitingIndicator('Waiting…', () => {}, {
      isInteractive: true,
      write: (chunk) => writes.push(chunk),
    });

    expect(writes[0]).toBe('\r⠋ Waiting…');

    vi.advanceTimersByTime(80);
    expect(writes[1]).toBe('\r⠙ Waiting…');

    stop();
    expect(writes.at(-1)).toBe('\r\u001b[K');

    // No further frames render once stopped.
    vi.advanceTimersByTime(240);
    expect(writes.filter((chunk) => chunk.includes('Waiting…')).length).toBe(2);
  });

  it('prints a single static line when stderr is not a TTY', () => {
    const lines: string[] = [];
    const writes: string[] = [];
    const stop = startWaitingIndicator('Waiting…', (line) => lines.push(line), {
      isInteractive: false,
      write: (chunk) => writes.push(chunk),
    });
    stop();

    expect(lines).toEqual(['Waiting…']);
    expect(writes).toEqual([]);
  });
});

describe('runAuthTokenCommand', () => {
  const unusedRequest = () => Promise.resolve({ status: 200, body: {} });

  it('requires --flow', async () => {
    await expect(
      runAuthTokenCommand({ flow: undefined, request: unusedRequest }),
    ).rejects.toThrow(/--flow/);
  });

  it('rejects an unsupported flow', async () => {
    await expect(
      runAuthTokenCommand({ flow: 'web', request: unusedRequest }),
    ).rejects.toThrow(/flow/i);
  });

  it('prompts on stderr, polls, and prints the token on stdout', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    let tokenAttempts = 0;

    const request = (method: string, path: string, body?: unknown) => {
      calls.push({ path, body });

      if (path.endsWith('/v1/auth/device-authorization')) {
        return Promise.resolve({
          status: 200,
          body: {
            device_code: 'DEVICE-CODE-SECRET',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://amp.example/device',
            verification_uri_complete:
              'https://amp.example/device?user_code=WDJB-MJHT',
            expires_in: 600,
            interval: 5,
          },
        });
      }

      tokenAttempts += 1;
      if (tokenAttempts < 2) {
        return Promise.resolve({
          status: 400,
          body: { error: 'authorization_pending' },
        });
      }
      return Promise.resolve({
        status: 200,
        body: {
          access_token: 'ACCESS-TOKEN',
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'openid',
        },
      });
    };

    const out: string[] = [];
    const err: string[] = [];

    await runAuthTokenCommand({
      flow: 'device',
      request,
      sleep: () => Promise.resolve(),
      now: () => 0,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });

    // Token (with its metadata) printed to stdout.
    const stdout = out.join('\n');
    expect(stdout).toContain('ACCESS-TOKEN');
    expect(stdout).toContain('openid');

    // device_code was sent in the token request body...
    const tokenCall = calls.find((c) => c.path.endsWith('/v1/auth/token'));
    expect(tokenCall?.body).toMatchObject({
      device_code: 'DEVICE-CODE-SECRET',
    });

    // ...but never surfaced to the user.
    expect(err.join('\n')).toContain('WDJB-MJHT');
    expect(err.join('\n')).not.toContain('DEVICE-CODE-SECRET');
    expect(stdout).not.toContain('DEVICE-CODE-SECRET');
  });
});

describe('pollForToken', () => {
  it('polls through authorization_pending and slow_down until a token is issued', async () => {
    const exchanges = [
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'slow_down' } },
      {
        status: 200,
        body: { access_token: 'tok', token_type: 'bearer', expires_in: 3600 },
      },
    ];
    let attempt = 0;
    const sleeps: number[] = [];

    const token = await pollForToken({
      exchange: () => Promise.resolve(exchanges[attempt++]),
      sleep: (seconds) => {
        sleeps.push(seconds);
        return Promise.resolve();
      },
      intervalSeconds: 5,
    });

    expect(token.access_token).toBe('tok');
    // pending slept the base interval; slow_down bumped it by 5 before sleeping.
    expect(sleeps).toEqual([5, 10]);
  });

  it('throws a readable error when the device code expires', async () => {
    await expect(
      pollForToken({
        exchange: () =>
          Promise.resolve({
            status: 400,
            body: {
              error: 'expired_token',
              error_description: 'The device code has expired.',
            },
          }),
        sleep: () => Promise.resolve(),
        intervalSeconds: 5,
      }),
    ).rejects.toThrow('The device code has expired.');
  });

  it(
    'stops polling once the device code lifetime is exceeded',
    { timeout: 500 },
    async () => {
      let clock = 0;

      await expect(
        pollForToken({
          exchange: () =>
            Promise.resolve({
              status: 400,
              body: { error: 'authorization_pending' },
            }),
          // Advance the clock and yield a macrotask so an unbounded loop times
          // out cleanly instead of starving the runner on microtasks.
          sleep: () => {
            clock += 5000;
            return new Promise((resolve) => {
              setTimeout(resolve, 0);
            });
          },
          intervalSeconds: 5,
          deadline: { now: () => clock, expiresInSeconds: 8 },
        }),
      ).rejects.toThrow(/expired/i);
    },
  );

  it('makes the exchange that lands on the deadline instead of giving up first', async () => {
    let clock = 0;
    const exchanges = [
      { status: 400, body: { error: 'authorization_pending' } },
      {
        status: 200,
        body: {
          access_token: 'approved-at-the-buzzer',
          token_type: 'bearer',
          expires_in: 3600,
        },
      },
    ];
    let attempt = 0;

    // interval and lifetime are both 5s, so the second exchange happens exactly
    // when the deadline is reached. It must still run (the user approved during
    // the sleep) rather than the loop throwing "expired" without polling again.
    const token = await pollForToken({
      exchange: () => Promise.resolve(exchanges[attempt++]),
      sleep: () => {
        clock += 5000;
        return Promise.resolve();
      },
      intervalSeconds: 5,
      deadline: { now: () => clock, expiresInSeconds: 5 },
    });

    expect(token.access_token).toBe('approved-at-the-buzzer');
  });

  it('degrades an unrecognized error body to a generic message without echoing it', async () => {
    const promise = pollForToken({
      exchange: () =>
        Promise.resolve({
          status: 400,
          body: { internal_detail: 'SENSITIVE-UPSTREAM-STATE' },
        }),
      sleep: () => Promise.resolve(),
      intervalSeconds: 5,
    });

    await expect(promise).rejects.toThrow(
      'The authorization server returned an unexpected response.',
    );
    await expect(promise).rejects.not.toThrow(/SENSITIVE-UPSTREAM-STATE/);
  });
});

describe('createAnonymousRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends no Authorization header and returns the status and parsed body', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = createAnonymousRequest('https://api.test');
    const result = await request('POST', '/v1/auth/token', { grant_type: 'x' });

    expect(result).toEqual({ status: 200, body: { ok: true } });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/v1/auth/token');
    expect(init?.headers).not.toHaveProperty('Authorization');
    // Identifies the API client to the server for analytics.
    expect(new Headers(init?.headers).get('user-agent')).toMatch(
      /^amp-cli\/\S+$/,
    );
    // No device id was supplied, so no header is sent.
    expect(new Headers(init?.headers).get('amp-device-id')).toBeNull();
  });

  it('sends the persistent device_id as the Amp-Device-Id header', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = createAnonymousRequest('https://api.test', 'install-xyz');
    await request('POST', '/v1/auth/device-authorization', { x: 1 });

    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get('amp-device-id')).toBe('install-xyz');
  });

  it('throws a readable error when the API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNREFUSED'))),
    );

    const request = createAnonymousRequest('https://api.test');

    await expect(request('POST', '/v1/auth/token')).rejects.toThrow(
      'Could not reach the API at https://api.test.',
    );
  });

  it('falls back to the raw text when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response('<html>502 Bad Gateway</html>', { status: 502 }),
        ),
      ),
    );

    const request = createAnonymousRequest('https://api.test');
    const result = await request('POST', '/v1/auth/token');

    expect(result).toEqual({
      status: 502,
      body: '<html>502 Bad Gateway</html>',
    });
  });
});

const noSleep = async () => {};
const token = { access_token: 'at', token_type: 'bearer', expires_in: 3600 };

describe('pollDeviceTokenBounded', () => {
  it('returns authorized when the exchange succeeds', async () => {
    const res = await pollDeviceTokenBounded({
      request: async () => ({ status: 200, body: token }),
      deviceCode: 'dc',
      codeVerifier: 'cv',
      intervalSeconds: 1,
      codeExpiresAtMs: 10_000,
      timeoutSeconds: 5,
      now: () => 0,
      sleep: noSleep,
    });
    expect(res).toEqual({ status: 'authorized', token });
  });

  it('returns pending when the bounded timeout elapses but the code is still valid', async () => {
    let t = 0;
    const res = await pollDeviceTokenBounded({
      request: async () => ({
        status: 400,
        body: { error: 'authorization_pending' },
      }),
      deviceCode: 'dc',
      codeVerifier: 'cv',
      intervalSeconds: 1,
      codeExpiresAtMs: 1_000_000,
      timeoutSeconds: 2,
      now: () => (t += 1000),
      sleep: noSleep,
    });
    expect(res).toEqual({ status: 'pending', interval: 1 });
  });

  it('stops polling once a full interval no longer fits the timeout budget', async () => {
    // Clock advances only by what we sleep, so wall-clock == sum(sleeps).
    const sleeps: number[] = [];
    let calls = 0;
    const res = await pollDeviceTokenBounded({
      request: async () => {
        calls += 1;
        return { status: 400, body: { error: 'authorization_pending' } };
      },
      deviceCode: 'dc',
      codeVerifier: 'cv',
      intervalSeconds: 5,
      codeExpiresAtMs: 1_000_000,
      timeoutSeconds: 12,
      now: () => sleeps.reduce((sum, s) => sum + s, 0) * 1000,
      sleep: (s) => {
        sleeps.push(s);
        return Promise.resolve();
      },
    });
    // Polls at t=0 and t=5 (each +5s still fits the 12s budget), then at t=10 a
    // further 5s sleep would overshoot to 15s — so it returns pending instead of
    // sleeping past --timeout. Total slept 10s, never exceeding the budget.
    expect(res).toEqual({ status: 'pending', interval: 5 });
    expect(sleeps).toEqual([5, 5]);
    expect(calls).toBe(3);
  });

  it('retries transient server_error within the window (pending, not error)', async () => {
    let t = 0;
    const res = await pollDeviceTokenBounded({
      request: async () => ({ status: 500, body: { error: 'server_error' } }),
      deviceCode: 'dc',
      codeVerifier: 'cv',
      intervalSeconds: 1,
      codeExpiresAtMs: 1_000_000,
      timeoutSeconds: 2,
      now: () => (t += 1000),
      sleep: noSleep,
    });
    expect(res).toEqual({ status: 'pending', interval: 1 });
  });

  it('raises the interval on slow_down and reports it on pending', async () => {
    let t = 0;
    const res = await pollDeviceTokenBounded({
      request: async () => ({ status: 400, body: { error: 'slow_down' } }),
      deviceCode: 'dc',
      codeVerifier: 'cv',
      intervalSeconds: 1,
      codeExpiresAtMs: 1_000_000,
      timeoutSeconds: 2,
      now: () => (t += 1000),
      sleep: noSleep,
    });
    expect(res).toEqual({ status: 'pending', interval: 6 });
  });

  it('returns expired when the device code lifetime passes', async () => {
    let t = 0;
    const res = await pollDeviceTokenBounded({
      request: async () => ({
        status: 400,
        body: { error: 'authorization_pending' },
      }),
      deviceCode: 'dc',
      codeVerifier: 'cv',
      intervalSeconds: 1,
      codeExpiresAtMs: 1500,
      timeoutSeconds: 999,
      now: () => (t += 1000),
      sleep: noSleep,
    });
    expect(res).toEqual({ status: 'expired' });
  });

  it('returns error on access_denied', async () => {
    const res = await pollDeviceTokenBounded({
      request: async () => ({ status: 400, body: { error: 'access_denied' } }),
      deviceCode: 'dc',
      codeVerifier: 'cv',
      intervalSeconds: 1,
      codeExpiresAtMs: 10_000,
      timeoutSeconds: 5,
      now: () => 0,
      sleep: noSleep,
    });
    expect(res.status).toBe('error');
  });

  it('preserves the structured OAuth error on a non-expired_token error', async () => {
    const res = await pollDeviceTokenBounded({
      request: async () => ({
        status: 400,
        body: {
          error: 'access_denied',
          error_description: 'The user denied the request.',
          error_hint: 'Ask the user to approve the code.',
        },
      }),
      deviceCode: 'dc',
      codeVerifier: 'cv',
      intervalSeconds: 1,
      codeExpiresAtMs: 10_000,
      timeoutSeconds: 5,
      now: () => 0,
      sleep: noSleep,
    });
    expect(res).toEqual({
      status: 'error',
      error: {
        code: 'access_denied',
        description: 'The user denied the request.',
        hint: 'Ask the user to approve the code.',
      },
    });
  });
});
