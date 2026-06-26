import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import { toOAuthError } from './oauthError';
import {
  type DeviceAuthorizationResponse,
  deviceAuthorizationResponseSchema,
  type TokenResponse,
  tokenResponseSchema,
} from './oauthResponseSchemas';
import { DEVICE_CODE_GRANT_TYPE } from './schemas';

// Best readable message from an OAuth error body: prefer the human description,
// then the server's hint, then the bare error code. Reuses toOAuthError so the
// parse-and-fallback logic lives in one place.
function oauthErrorMessage(body: unknown): string {
  const error = toOAuthError(body);

  return error.error_description ?? error.error_hint ?? error.error;
}

// The token and device-authorization bodies are validated at the CLI boundary.
// A malformed success body is a server bug, not user error — surface a plain
// sentence rather than letting a raw ZodError dump reach the terminal.
function parseResponse<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
  description: string,
): z.infer<Schema> {
  const result = schema.safeParse(body);
  if (result.success) {
    return result.data;
  }

  throw new Error(
    `The authorization server returned an unexpected ${description} response.`,
  );
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

// RFC 7636: a 32-byte base64url verifier (43 chars, no padding) and its S256
// challenge. Kept entirely in memory — never written to disk.
export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return { codeVerifier, codeChallenge };
}

// The human-facing prompt (goes to stderr). Shows the verification URL with the
// user_code already embedded — the /device route reads it from the param, so
// the user never types it; deliberately omits the secret `device_code`.
export function formatVerificationPrompt(
  device: DeviceAuthorizationResponse,
): string {
  const url = device.verification_uri_complete ?? device.verification_uri;

  return [
    'To authorize, open this URL in a browser and sign in:',
    '',
    url,
    '',
    'Waiting for approval…',
  ].join('\n');
}

interface ExchangeResult {
  status: number;
  body: unknown;
}

// Mirror fetch's Response.ok (a 2xx status). createAnonymousRequest flattens
// the fetch Response to {status, body}, so the .ok convenience is reproduced
// here for the callers that work with ExchangeResult.
function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

// Optional lifetime bound: stop polling once the device code's `expires_in`
// elapses, so a server stuck on authorization_pending can't make the CLI poll
// forever. `now` returns milliseconds. Paired as one object so the type system
// enforces all-or-nothing — supplying one half without the other is impossible.
interface PollDeadline {
  now: () => number;
  expiresInSeconds: number;
}

interface PollForTokenOptions {
  // A single token-exchange attempt against POST /v1/auth/token.
  exchange: () => Promise<ExchangeResult>;
  // Injected so tests don't wait on real time.
  sleep: (seconds: number) => Promise<void>;
  intervalSeconds: number;
  deadline?: PollDeadline;
}

export async function pollForToken({
  exchange,
  sleep,
  intervalSeconds,
  deadline,
}: PollForTokenOptions): Promise<TokenResponse> {
  let interval = intervalSeconds;
  const deadlineMs = deadline
    ? deadline.now() + deadline.expiresInSeconds * 1000
    : undefined;

  for (;;) {
    const { status, body } = await exchange();

    if (isOk(status)) {
      return parseResponse(tokenResponseSchema, body, 'token');
    }

    const code = toOAuthError(body).error;

    if (code === 'slow_down') {
      // RFC 8628 §3.5: slow_down permanently raises the interval by 5s.
      interval += 5;
    } else if (code !== 'authorization_pending') {
      throw new Error(oauthErrorMessage(body));
    }

    // Give up only after a poll has just come back pending/slow_down and the
    // code's lifetime is spent — checked here, not before exchange(), so the
    // attempt that lands on the deadline still runs and can return a token the
    // user approved during the preceding sleep.
    if (deadline && deadlineMs !== undefined && deadline.now() >= deadlineMs) {
      throw new Error('The device code has expired before approval.');
    }

    await sleep(interval);
  }
}

export type AnonymousRequest = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<ExchangeResult>;

// The OAuth endpoints are anonymous (the service injects the confidential
// client) and signal flow state via non-2xx OAuth errors the caller must
// inspect. So this sends no Authorization header and, unlike the CLI's
// getJson/requestJson, never throws on a non-2xx — it returns the status and
// parsed body for the poll loop to interpret. A non-JSON body (e.g. an HTML
// error page) degrades to the raw text rather than throwing a parse error.
export function createAnonymousRequest(baseUrl: string): AnonymousRequest {
  return async (method, path, body) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, init);
    } catch {
      throw new Error(`Could not reach the API at ${baseUrl}.`);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    return { status: response.status, body: parsed };
  };
}

export interface DeviceFlowOptions {
  flow: string | undefined;
  scope?: string;
  // Token-optional, non-throwing HTTP call against the Developer API endpoints.
  request: AnonymousRequest;
  sleep?: (seconds: number) => Promise<void>;
  now?: () => number;
  // The human prompt (verification URL) goes to stderr.
  stderr?: (line: string) => void;
}

export interface RunAuthTokenOptions extends DeviceFlowOptions {
  stdout?: (line: string) => void;
}

/**
 * Runs the OAuth device-authorization flow and returns the token. Shared by
 * `auth token` (which prints it) and `auth login` (which saves it to a
 * profile) so the flow lives in one place.
 */
export async function requestDeviceToken(
  options: DeviceFlowOptions,
): Promise<TokenResponse> {
  if (!options.flow) {
    throw new Error('Missing --flow. The only supported value is "device".');
  }

  if (options.flow !== 'device') {
    throw new Error(
      `Unsupported --flow "${options.flow}". The only supported value is "device".`,
    );
  }

  const { request, scope } = options;
  const sleep = options.sleep ?? ((seconds) => delay(seconds * 1000));
  const now = options.now ?? (() => Date.now());
  const emitStderr =
    options.stderr ?? ((line) => process.stderr.write(`${line}\n`));

  const { codeVerifier, codeChallenge } = generatePkcePair();

  const deviceResponse = await request(
    'POST',
    '/v1/auth/device-authorization',
    {
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: scope ?? undefined,
    },
  );

  if (!isOk(deviceResponse.status)) {
    throw new Error(oauthErrorMessage(deviceResponse.body));
  }

  const deviceAuthorization = parseResponse(
    deviceAuthorizationResponseSchema,
    deviceResponse.body,
    'device-authorization',
  );

  emitStderr(formatVerificationPrompt(deviceAuthorization));

  return pollForToken({
    exchange: () =>
      request('POST', '/v1/auth/token', {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: deviceAuthorization.device_code,
        code_verifier: codeVerifier,
      }),
    sleep,
    intervalSeconds: deviceAuthorization.interval ?? 5,
    deadline: { now, expiresInSeconds: deviceAuthorization.expires_in },
  });
}

export async function runAuthTokenCommand(
  options: RunAuthTokenOptions,
): Promise<void> {
  const token = await requestDeviceToken(options);
  // Token JSON goes to stdout (so `… | jq -r .access_token` works).
  const emitStdout =
    options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  emitStdout(JSON.stringify(token, null, 2));
}
