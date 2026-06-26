import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import open from 'open';
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

// Prefer the code-embedded URL (the /device route reads user_code from the
// param, so the user never types it) and fall back to the bare verification_uri.
function verificationUrl(device: DeviceAuthorizationResponse): string {
  return device.verification_uri_complete ?? device.verification_uri;
}

// The human-facing prompt (goes to stderr). Surfaces the user_code as the thing
// to verify — the browser confirmation page shows the same code, and matching
// the two is what proves this CLI (not an attacker) initiated the request. We
// deliberately omit the secret `device_code`. The "Press Enter…" hint and the
// trailing "Waiting…" line are emitted by the caller, since the hint only
// applies at a TTY.
export function formatVerificationPrompt(
  device: DeviceAuthorizationResponse,
): string {
  return [
    'To authorize, confirm this code in your browser:',
    '',
    `  ${device.user_code}`,
    '',
    'At the following url:',
    '',
    `  ${verificationUrl(device)}`,
  ].join('\n');
}

type InteractiveStdin = Readable & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

// Opens the verification URL when the user presses Enter, without blocking the
// poll loop (the listener runs on the event loop; the poll keeps awaiting its
// sleeps). Returns a teardown that restores the terminal and lets the process
// exit (a resumed stdin keeps Node alive). `open` is fire-and-forget; a spawn
// failure (sync throw or rejected promise) degrades to a hint, not a dead login.
//
// Raw mode is what makes this usable: in cooked mode the TTY echoes every
// keystroke and turns Enter into a visible newline. Raw mode suppresses both —
// stray typing is swallowed and only Enter acts — but it also stops Ctrl+C from
// reaching the default SIGINT handler, so we restore the terminal and re-raise
// SIGINT ourselves to keep abort working.
function listenForOpen(
  url: string,
  openUrl: (url: string) => Promise<unknown>,
  stdin: InteractiveStdin,
  emitStderr: (line: string) => void,
): () => void {
  const useRawMode =
    stdin.isTTY === true && typeof stdin.setRawMode === 'function';

  function restore(): void {
    stdin.off('data', onData);
    if (useRawMode) {
      stdin.setRawMode?.(false);
    }
    stdin.pause();
  }

  function onData(chunk: Buffer | string): void {
    const input = chunk.toString();
    if (input.includes('\u0003')) {
      restore();
      process.kill(process.pid, 'SIGINT');
      return;
    }
    if (input.includes('\r') || input.includes('\n')) {
      Promise.resolve()
        .then(() => openUrl(url))
        .catch(() =>
          emitStderr('Could not open a browser. Open the URL above manually.'),
        );
    }
  }

  if (useRawMode) {
    stdin.setRawMode?.(true);
  }
  stdin.on('data', onData);
  stdin.resume();

  return restore;
}

// Wires the "Press Enter to open" affordance and returns its teardown. Needs
// both stdin and stderr to be a TTY: stdin to read the keypress, stderr (where
// every prompt goes) so the hint is actually visible. Returns undefined when
// either isn't interactive — piped stdin (agent/CI) has no keypress to listen
// for, and a redirected stderr would otherwise enable raw mode (the terminal
// stops echoing) with no on-screen prompt explaining why.
function startOpenAffordance(
  device: DeviceAuthorizationResponse,
  options: DeviceFlowOptions,
  emitStderr: (line: string) => void,
): (() => void) | undefined {
  const stdin = options.stdin ?? process.stdin;
  if (!stdin.isTTY || process.stderr.isTTY !== true) {
    return undefined;
  }
  emitStderr('\nPress Enter to open it in your browser.');
  return listenForOpen(
    verificationUrl(device),
    options.openUrl ?? open,
    stdin,
    emitStderr,
  );
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

interface WaitingIndicatorOptions {
  // Defaults to whether stderr is a real terminal. Piped output gets a single
  // static line instead of an animation (no \r tricks, no ANSI escapes).
  isInteractive?: boolean;
  // Raw write seam (no trailing newline), for the in-place animation. Defaults
  // to process.stderr; injected in tests.
  write?: (chunk: string) => void;
}

// A braille spinner for the "Waiting…" line. At a TTY it animates in place via
// carriage return; otherwise it prints the label once. Returns a stop() that
// halts the timer and clears the spinner line so the next output starts clean.
// The interval is unref'd so it can never, by itself, keep the process alive.
export function startWaitingIndicator(
  label: string,
  emitStderr: (line: string) => void,
  options: WaitingIndicatorOptions = {},
): () => void {
  const isInteractive = options.isInteractive ?? process.stderr.isTTY === true;
  if (!isInteractive) {
    emitStderr(label);
    return () => {};
  }

  const write = options.write ?? ((chunk) => void process.stderr.write(chunk));
  let frame = 0;
  const render = (): void => {
    write(`\r${SPINNER_FRAMES[frame]} ${label}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  };

  render();
  const timer = setInterval(render, SPINNER_INTERVAL_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    // Carriage return + clear-to-end-of-line wipes the spinner before the next
    // line (a success message, or the SIGINT-killed prompt) is written.
    write('\r\u001b[K');
  };
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
  // Interactive input for the "Press Enter to open" affordance. Defaults to the
  // real process.stdin; the affordance only engages when it's a TTY.
  stdin?: InteractiveStdin;
  // Test seam for the browser-open side effect; defaults to the `open` package.
  openUrl?: (url: string) => Promise<unknown>;
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

  const stopListening = startOpenAffordance(
    deviceAuthorization,
    options,
    emitStderr,
  );

  emitStderr('');
  const stopWaiting = startWaitingIndicator(
    'Waiting for confirmation…',
    emitStderr,
  );

  try {
    return await pollForToken({
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
  } finally {
    stopWaiting();
    stopListening?.();
  }
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
