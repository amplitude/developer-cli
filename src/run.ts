/* eslint-disable no-console */
import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

import { type FlagValue, isFlagEnabled, stringFlag } from './args';
import {
  CliError,
  cliErrorFromResponse,
  transportError,
  usageError,
} from './cli-error';
import { deviceIdHeader } from './client-identity';
import { resolveBaseUrl, resolveExplicitBaseUrl } from './config';
import {
  authorizationHeaderForToken,
  resolveAuthWithRefresh,
} from './credential-resolver';
import type { CliOperation } from './generated/cli-manifest';
import {
  formatJsonOutput,
  formatNoContentSuccess,
  formatSuccessOutput,
  isNoContentSuccess,
  shouldUseJsonOutput,
} from './output';
import { confirm } from './prompt';
import {
  buildRequest,
  operationSupportsDryRun,
  parseResponseBody,
} from './request';
import { refreshProfileTokenLocked } from './token-refresh';

export type DeleteGateDecision = 'block' | 'confirm' | 'proceed';

const ingestionPollingRequestSchema = z.object({
  polling_timeout_seconds: z.number().int().min(1).max(120).optional(),
});
const ingestionCheckResponseSchema = z.object({
  data: z.object({
    status: z.enum(['observed', 'not_observed', 'inconclusive']),
    poll_after_seconds: z.number().int().positive().optional(),
  }),
});

const API_KEY_INGESTION_RATE_LIMIT_HINT =
  'If you continue to see this error, retry with `amp events check-ingestion`.';

function errorForOperationResponse(options: {
  operation: CliOperation;
  response: Response;
  responseBody: unknown;
}): CliError {
  const error = cliErrorFromResponse(
    options.response.status,
    options.response.statusText,
    options.responseBody,
  );
  if (
    options.operation.operationId === 'checkRecentEventIngestionByApiKey' &&
    options.response.status === 429
  ) {
    error.hint = API_KEY_INGESTION_RATE_LIMIT_HINT;
  }
  return error;
}

function resolveUnauthenticatedOperationBaseUrl(
  operation: CliOperation,
  flags: Record<string, FlagValue>,
): string {
  if (operation.operationId !== 'checkRecentEventIngestionByApiKey') {
    return resolveBaseUrl(flags);
  }

  const hasHiddenEndpointSelector =
    flags['base-url'] !== undefined || flags.env !== undefined;
  let explicitBaseUrl: string | undefined;
  try {
    explicitBaseUrl = resolveExplicitBaseUrl({
      baseUrlFlag: stringFlag(flags, ['base-url']),
      envFlag: stringFlag(flags, ['env']),
      regionFlag: stringFlag(flags, ['region']),
    });
  } catch (error) {
    if (hasHiddenEndpointSelector && error instanceof CliError) {
      throw usageError(
        'Checking ingestion by API key requires --region <us|eu>.',
      );
    }
    throw error;
  }
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }
  throw usageError('Checking ingestion by API key requires --region <us|eu>.');
}

function resolveRequestPollingDurationSeconds(
  operation: CliOperation,
  body: Record<string, unknown> | undefined,
): number | undefined {
  if (
    operation.operationId !== 'checkRecentEventIngestion' &&
    operation.operationId !== 'checkRecentEventIngestionByApiKey'
  ) {
    return undefined;
  }
  const ingestionPollingRequest = ingestionPollingRequestSchema.safeParse(
    body ?? {},
  );
  if (!ingestionPollingRequest.success) {
    throw usageError(
      'Expected --timeout-seconds to be an integer from 1 to 120.',
    );
  }
  return ingestionPollingRequest.data.polling_timeout_seconds;
}

function resolveSecondsToNextPoll(options: {
  maxRuntimeMs: number;
  elapsedMs: number;
  responseBody: unknown;
  response: Response;
}): number | undefined {
  if (!options.response.ok) {
    return undefined;
  }

  const ingestionCheckResponse = ingestionCheckResponseSchema.safeParse(
    options.responseBody,
  );
  if (!ingestionCheckResponse.success) {
    return undefined;
  }
  const { data: ingestionCheck } = ingestionCheckResponse.data;
  if (ingestionCheck.status === 'observed') return undefined;

  const pollAfterSeconds = ingestionCheck.poll_after_seconds;
  if (
    pollAfterSeconds === undefined ||
    options.elapsedMs + pollAfterSeconds * 1000 >= options.maxRuntimeMs
  ) {
    return undefined;
  }
  return pollAfterSeconds;
}

type TimedOut = {
  kind: 'timed_out';
};

const TIMED_OUT: TimedOut = { kind: 'timed_out' };

type CompletedRequest = {
  kind: 'response';
  response: Response;
  responseBody: unknown;
};

type RequestAttemptResult = TimedOut | CompletedRequest;

/**
 * Decides whether a destructive (DELETE) command may run. A `--dry-run` only
 * bypasses confirmation when the operation actually supports it server-side;
 * otherwise we confirm (interactive) or block (non-interactive) so `--dry-run`
 * can never silently perform a real delete.
 */
export function deleteGateDecision(options: {
  dryRunRequested: boolean;
  dryRunSupported: boolean;
  isDelete: boolean;
  isTTY: boolean;
  yes: boolean;
}): DeleteGateDecision {
  if (!options.isDelete) {
    return 'proceed';
  }
  if (options.dryRunRequested && options.dryRunSupported) {
    return 'proceed';
  }
  if (options.dryRunRequested && !options.dryRunSupported) {
    return 'block';
  }
  if (options.yes) {
    return 'proceed';
  }
  return options.isTTY ? 'confirm' : 'block';
}

const SYNTHETIC_OK = { data: { ok: true } };

async function ensureDeleteAllowed(
  operation: CliOperation,
  flags: Record<string, FlagValue>,
): Promise<void> {
  const dryRunRequested = isFlagEnabled(flags['dry-run']);
  const dryRunSupported = operationSupportsDryRun(operation);
  const decision = deleteGateDecision({
    dryRunRequested,
    dryRunSupported,
    isDelete: operation.method === 'DELETE',
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    yes: isFlagEnabled(flags.yes),
  });

  if (decision === 'proceed') {
    return;
  }

  if (decision === 'block') {
    if (dryRunRequested && !dryRunSupported) {
      throw usageError(
        `\`amp ${operation.command.join(' ')}\` does not support --dry-run. Drop --dry-run and pass --yes to confirm a real delete, or run it in an interactive terminal.`,
      );
    }
    throw usageError(
      'Pass --yes to run a DELETE command, or use --dry-run if the command supports it.',
    );
  }

  const approved = await confirm(
    `This runs DELETE \`amp ${operation.command.join(' ')}\`. Continue?`,
  );
  if (!approved) {
    throw new Error('Aborted.'); // plain-error-ok: TTY-only user cancellation; unreachable non-interactively.
  }
}

export async function runOperation(
  operation: CliOperation,
  flags: Record<string, FlagValue>,
): Promise<void> {
  const request = buildRequest(operation, flags);
  const headers = { ...request.headers, ...deviceIdHeader() };
  const requestPollingDurationSeconds = resolveRequestPollingDurationSeconds(
    operation,
    request.body,
  );
  await ensureDeleteAllowed(operation, flags);
  const maxRuntimeMs =
    requestPollingDurationSeconds === undefined
      ? undefined
      : performance.now() + requestPollingDurationSeconds * 1000;
  const sendHttpRequest = async (options: {
    baseUrl: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<CompletedRequest> => {
    try {
      const response = await fetch(`${options.baseUrl}${request.path}`, {
        method: operation.method,
        headers: options.headers,
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: options.signal,
      });
      return {
        kind: 'response',
        response,
        responseBody: parseResponseBody(await response.text()),
      };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw transportError(`Could not reach the API at ${options.baseUrl}.`);
    }
  };
  const sendAuthenticatedRequest = async (
    signal?: AbortSignal,
  ): Promise<CompletedRequest> => {
    const apiAccess = await resolveAuthWithRefresh(flags);
    const sendAuthenticatedHttpRequest = (token: string) =>
      sendHttpRequest({
        baseUrl: apiAccess.baseUrl,
        headers: {
          ...headers,
          Authorization: authorizationHeaderForToken(token),
        },
        signal,
      });

    const requestAttempt = await sendAuthenticatedHttpRequest(apiAccess.token);
    if (
      requestAttempt.response.status === 401 &&
      apiAccess.refreshable &&
      apiAccess.profile &&
      !apiAccess.refreshed
    ) {
      const refreshedCredentials = await refreshProfileTokenLocked({
        name: apiAccess.profile,
        now: Date.now(),
        staleAccessToken: apiAccess.token,
        expectedProfileBaseUrl: apiAccess.profileBaseUrl,
      });
      return sendAuthenticatedHttpRequest(
        refreshedCredentials.credential.access_token,
      );
    }
    return requestAttempt;
  };
  const sendUnauthenticatedRequest = async (
    signal?: AbortSignal,
  ): Promise<CompletedRequest> =>
    sendHttpRequest({
      baseUrl: resolveUnauthenticatedOperationBaseUrl(operation, flags),
      headers,
      signal,
    });
  const sendRequest =
    operation.authentication === 'none'
      ? sendUnauthenticatedRequest
      : sendAuthenticatedRequest;

  const sendPollingAttempt = async (
    maxRuntimeForRequestMs: number,
  ): Promise<RequestAttemptResult> => {
    const remainingMsOfRequestedRuntime =
      maxRuntimeForRequestMs - performance.now();
    if (remainingMsOfRequestedRuntime <= 0) return TIMED_OUT;

    const signal = AbortSignal.timeout(
      Math.max(1, Math.ceil(remainingMsOfRequestedRuntime)),
    );
    try {
      // Let an in-flight credential rotation finish safely; aborting it can
      // strand the saved profile on a consumed refresh token.
      const completedRequest = await sendRequest(signal);
      return performance.now() >= maxRuntimeForRequestMs
        ? TIMED_OUT
        : completedRequest;
    } catch (error) {
      if (signal.aborted || performance.now() >= maxRuntimeForRequestMs) {
        return TIMED_OUT;
      }
      throw error;
    }
  };

  // The initial request counts toward the polling window but is never
  // interrupted or discarded.
  const initialAttempt = await sendRequest();

  let { response, responseBody } = initialAttempt;
  if (maxRuntimeMs !== undefined) {
    let secondsToNextPoll = resolveSecondsToNextPoll({
      maxRuntimeMs,
      elapsedMs: performance.now(),
      response,
      responseBody,
    });

    while (secondsToNextPoll !== undefined) {
      await sleep(secondsToNextPoll * 1000);
      const pollingAttempt = await sendPollingAttempt(maxRuntimeMs);
      if (pollingAttempt.kind === 'timed_out') break;
      ({ response, responseBody } = pollingAttempt);
      secondsToNextPoll = resolveSecondsToNextPoll({
        maxRuntimeMs,
        elapsedMs: performance.now(),
        response,
        responseBody,
      });
    }
  }

  if (!response.ok) {
    throw errorForOperationResponse({ operation, response, responseBody });
  }

  const isTTY = Boolean(process.stdout.isTTY);
  const useJson = shouldUseJsonOutput({
    jsonFlag: isFlagEnabled(flags.json),
    isTTY,
  });

  if (isNoContentSuccess(response.status, responseBody)) {
    const output = useJson
      ? formatJsonOutput(null, isTTY)
      : formatNoContentSuccess(operation);
    console.log(output);
    return;
  }

  const payload = responseBody ?? SYNTHETIC_OK;

  // When piped or non-interactive (the path agents and scripts take), emit
  // compact JSON to avoid spending tokens on indentation. Pretty-print only
  // when a human asked for JSON at a real terminal.
  const output = useJson
    ? formatJsonOutput(payload, isTTY)
    : formatSuccessOutput(payload, operation);

  console.log(output);
}
