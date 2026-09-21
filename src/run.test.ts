import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlagValue } from './args';
import { CliError } from './cli-error';
import * as credentialResolver from './credential-resolver';
import type { OAuthCredential } from './credential-store';
import * as credentialStore from './credential-store';
import type { CliOperation } from './generated/cli-manifest';
import { findOperation } from './help';
import { deleteGateDecision, runOperation } from './run';
import * as tokenRefresh from './token-refresh';

// `loadStore` reads real `~/.amplitude/amp/credentials.json` by default;
// give it a safe empty-store default so the raw --token tests below (which
// never touch it) can't be affected, and the profile-based tests can inject
// their own store.
vi.mock('./credential-store', async () => {
  const actual =
    await vi.importActual<typeof import('./credential-store')>(
      './credential-store',
    );
  return {
    ...actual,
    loadStore: vi.fn(),
  };
});

vi.mock('node:timers/promises', () => ({
  setTimeout: (delayMs: number) =>
    new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs)),
}));

vi.mock('./client-identity', () => ({
  deviceIdHeader: () => ({ 'Amp-Device-Id': 'device-123' }),
}));

function operation(command: string[]): CliOperation {
  const found = findOperation(command);

  if (!found) {
    throw new Error(`Missing CLI operation ${command.join(' ')}.`);
  }

  return found;
}

const deleteWithoutDryRun: CliOperation = {
  command: ['widgets', 'delete'],
  method: 'DELETE',
  operationId: 'deleteWidget',
  path: '/v1/widgets/{id}',
  requiredScopes: [],
  summary: 'Delete a widget',
  successStatus: 204,
  parameters: [
    { name: 'id', in: 'path', required: true, aliases: ['id'], type: 'string' },
  ],
  body: [],
};

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(
    status === 204
      ? null
      : typeof body === 'string'
        ? body
        : JSON.stringify(body),
    { status, headers },
  );
}

function ingestionEnvelope(
  status: 'inconclusive' | 'not_observed' | 'observed',
  count: number,
  id = 'check_123',
  pollAfterSeconds?: number,
) {
  return {
    data: {
      id,
      object: 'recent_event_ingestion_check',
      project_id: '187520',
      status,
      count,
      ...(pollAfterSeconds === undefined
        ? {}
        : { poll_after_seconds: pollAfterSeconds }),
      window: {
        start: '2026-08-24T16:00:00.000Z',
        end: '2026-08-24T16:15:00.000Z',
        basis: 'server_upload_time',
      },
    },
  };
}

function oauthStore(credential: {
  access_token: string;
  expires_at?: string;
  refresh_token?: string;
}) {
  const store = credentialStore.setProfile(
    credentialStore.emptyStore(),
    'default',
    {
      base_url: 'https://api',
      credential: {
        type: 'oauth',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        ...credential,
      },
      saved_at: '2026-06-23T00:00:00.000Z',
      store: 'file',
    },
  );
  return credentialStore.setDefault(store, 'default');
}

describe('deleteGateDecision', () => {
  const base = {
    dryRunRequested: false,
    dryRunSupported: false,
    isDelete: true,
    isTTY: false,
    yes: false,
  };

  it('always proceeds for non-DELETE operations', () => {
    expect(deleteGateDecision({ ...base, isDelete: false })).toBe('proceed');
  });

  it('proceeds when --dry-run is supported by the operation', () => {
    expect(
      deleteGateDecision({
        ...base,
        dryRunRequested: true,
        dryRunSupported: true,
      }),
    ).toBe('proceed');
  });

  it('proceeds when --yes is set', () => {
    expect(deleteGateDecision({ ...base, yes: true })).toBe('proceed');
  });

  it('confirms interactively when no bypass is given in a TTY', () => {
    expect(deleteGateDecision({ ...base, isTTY: true })).toBe('confirm');
  });

  it('blocks non-interactively when no bypass is given', () => {
    expect(deleteGateDecision(base)).toBe('block');
  });

  it('does not let an unsupported --dry-run bypass the gate', () => {
    expect(
      deleteGateDecision({
        ...base,
        dryRunRequested: true,
        dryRunSupported: false,
      }),
    ).toBe('block');
  });

  it('does not let --yes bypass the gate when --dry-run is unsupported', () => {
    expect(
      deleteGateDecision({
        ...base,
        dryRunRequested: true,
        dryRunSupported: false,
        yes: true,
      }),
    ).toBe('block');
  });
});

describe('runOperation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(credentialStore.loadStore).mockReturnValue(
      credentialStore.emptyStore(),
    );
    // Force non-interactive so the destructive gate is deterministic.
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    logSpy.mockRestore();
  });

  it('preserves the complete ingestion check envelope as compact JSON', async () => {
    const envelope = {
      data: {
        id: 'check_123',
        object: 'recent_event_ingestion_check',
        project_id: '187520',
        event_type: 'Checkout Completed',
        status: 'inconclusive',
        count: 0,
        poll_after_seconds: 1,
        window: {
          start: '2026-08-24T16:00:00.000Z',
          end: '2026-08-24T16:15:00.000Z',
        },
      },
    };
    fetchMock.mockResolvedValue(jsonResponse(200, envelope));

    await runOperation(operation(['events', 'check-ingestion']), {
      token: 'amp_test',
      project: '187520',
      'event-type': 'Checkout Completed',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(envelope));
  });

  it('sends the stable device id on Developer API operations', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));

    await runOperation(operation(['projects', 'list']), { token: 'amp_test' });

    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get('amp-device-id')).toBe('device-123');
  });

  it('checks ingestion by API key without resolving or sending OAuth credentials', async () => {
    const envelope = {
      data: {
        status: 'observed',
        window: {
          lookback_hours: 8,
          start: '2026-09-03T09:00:00Z',
          end: '2026-09-03T17:00:00Z',
          basis: 'server_upload_time',
        },
      },
    };
    const resolveAuthSpy = vi.spyOn(
      credentialResolver,
      'resolveAuthWithRefresh',
    );
    fetchMock.mockResolvedValue(jsonResponse(200, envelope));

    await runOperation(operation(['events', 'check-ingestion-by-api-key']), {
      'api-key': 'project-api-key',
      'base-url': 'https://developer-api.example.com',
    });

    expect(resolveAuthSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://developer-api.example.com/v1/events/check-recent-ingestion',
    );
    expect(init).toMatchObject({
      body: '{"api_key":"project-api-key"}',
      method: 'POST',
    });
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(envelope));
  });

  it('suggests the authenticated ingestion check after an API-key rate limit', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { title: 'Rate limited' }));

    const error: unknown = await runOperation(
      operation(['events', 'check-ingestion-by-api-key']),
      {
        'api-key': 'project-api-key',
        'base-url': 'https://developer-api.example.com',
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) {
      throw new Error('Expected a CliError.');
    }
    expect(error.httpStatus).toBe(429);
    expect(error.hint).toBe(
      'If you continue to see this error, retry with `amp events check-ingestion`.',
    );
  });

  it('requires an explicit endpoint for an API-key ingestion check', async () => {
    vi.stubEnv('AMP_API_BASE_URL', 'https://configured.example.com');

    await expect(
      runOperation(operation(['events', 'check-ingestion-by-api-key']), {
        'api-key': 'project-api-key',
      }),
    ).rejects.toMatchObject({
      errorCode: 'usage_error',
      message: 'Checking ingestion by API key requires --region <us|eu>.',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keys the API-key endpoint requirement to its generated operation ID', async () => {
    const apiKeyIngestionOperation: CliOperation = {
      ...operation(['events', 'check-ingestion-by-api-key']),
      command: ['events', 'renamed-ingestion-check'],
    };

    await expect(
      runOperation(apiKeyIngestionOperation, { 'api-key': 'project-api-key' }),
    ).rejects.toMatchObject({
      errorCode: 'usage_error',
      message: 'Checking ingestion by API key requires --region <us|eu>.',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not disclose an invalid hidden environment selector for an API-key ingestion check', async () => {
    await expect(
      runOperation(operation(['events', 'check-ingestion-by-api-key']), {
        'api-key': 'project-api-key',
        env: 'not-a-real-environment',
      }),
    ).rejects.toMatchObject({
      errorCode: 'usage_error',
      message: 'Checking ingestion by API key requires --region <us|eu>.',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  const hiddenEndpointFlagSets: Array<Record<string, FlagValue>> = [
    { 'base-url': true },
    { env: 'staging', region: 'us' },
  ];

  it.each(hiddenEndpointFlagSets)(
    'does not disclose hidden endpoint selectors in API-key ingestion errors',
    async (hiddenFlags) => {
      await expect(
        runOperation(operation(['events', 'check-ingestion-by-api-key']), {
          'api-key': 'project-api-key',
          ...hiddenFlags,
        }),
      ).rejects.toMatchObject({
        errorCode: 'usage_error',
        message: 'Checking ingestion by API key requires --region <us|eu>.',
      });

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('targets the selected region for an API-key ingestion check', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: {
          status: 'observed',
          window: {
            lookback_hours: 8,
            start: '2026-09-03T09:00:00Z',
            end: '2026-09-03T17:00:00Z',
            basis: 'server_upload_time',
          },
        },
      }),
    );

    await runOperation(operation(['events', 'check-ingestion-by-api-key']), {
      'api-key': 'project-api-key',
      region: 'eu',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://developer-api.eu.amplitude.com/v1/events/check-recent-ingestion',
    );
  });

  it('targets an explicit environment for an API-key ingestion check', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: {
          status: 'observed',
          window: {
            lookback_hours: 8,
            start: '2026-09-03T09:00:00Z',
            end: '2026-09-03T17:00:00Z',
            basis: 'server_upload_time',
          },
        },
      }),
    );

    await runOperation(operation(['events', 'check-ingestion-by-api-key']), {
      'api-key': 'project-api-key',
      env: 'staging',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://developer-api.stag2.amplitude.com/v1/events/check-recent-ingestion',
    );
  });

  it('polls API-key ingestion checks using server guidance', async () => {
    vi.useFakeTimers();
    const window = {
      lookback_hours: 8,
      start: '2026-09-03T09:00:00Z',
      end: '2026-09-03T17:00:00Z',
      basis: 'server_upload_time',
    };
    const observed = { data: { status: 'observed', window } };
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { status: 'not_observed', poll_after_seconds: 1, window },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, observed));

    const result = runOperation(
      operation(['events', 'check-ingestion-by-api-key']),
      {
        'api-key': 'project-api-key',
        'base-url': 'https://developer-api.example.com',
        'timeout-seconds': '3',
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.body)).toEqual([
      '{"api_key":"project-api-key","polling_timeout_seconds":3}',
      '{"api_key":"project-api-key","polling_timeout_seconds":3}',
    ]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(observed));
  });

  it('stops API-key ingestion polling when the server omits guidance', async () => {
    const window = {
      lookback_hours: 8,
      start: '2026-09-03T09:00:00Z',
      end: '2026-09-03T17:00:00Z',
      basis: 'server_upload_time',
    };
    const notObserved = { data: { status: 'not_observed', window } };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, notObserved))
      .mockResolvedValueOnce(jsonResponse(200, notObserved));

    await runOperation(operation(['events', 'check-ingestion-by-api-key']), {
      'api-key': 'project-api-key',
      'base-url': 'https://developer-api.example.com',
      'timeout-seconds': '6',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(notObserved));
  });

  it('stops after one check when the server omits poll_after_seconds', async () => {
    const inconclusive = ingestionEnvelope('inconclusive', 0);
    fetchMock.mockResolvedValue(jsonResponse(200, inconclusive));

    await runOperation(operation(['events', 'check-ingestion']), {
      token: 'amp_test',
      project: '187520',
      'timeout-seconds': '120',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(inconclusive));
  });

  it('uses the latest server poll_after_seconds delay for each ingestion check', async () => {
    vi.useFakeTimers();
    const notObserved = ingestionEnvelope('not_observed', 0, 'check_123', 1);
    const inconclusive = ingestionEnvelope('inconclusive', 0, 'check_124', 2);
    const observed = ingestionEnvelope('observed', 1, 'check_125');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, notObserved))
      .mockResolvedValueOnce(jsonResponse(200, inconclusive))
      .mockResolvedValueOnce(jsonResponse(200, observed));

    const result = runOperation(operation(['events', 'check-ingestion']), {
      token: 'amp_test',
      project: '187520',
      'timeout-seconds': '5',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => init?.body)).toEqual([
      '{"polling_timeout_seconds":5}',
      '{"polling_timeout_seconds":5}',
      '{"polling_timeout_seconds":5}',
    ]);
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(observed));
  });

  it('refreshes an expired credential before the next poll', async () => {
    vi.useFakeTimers();
    let store = oauthStore({
      access_token: 'stale',
      expires_at: new Date(Date.now() + 500).toISOString(),
      refresh_token: 'rt1',
    });
    vi.mocked(credentialStore.loadStore).mockImplementation(() => store);
    const refreshSpy = vi
      .spyOn(tokenRefresh, 'refreshProfileTokenLocked')
      .mockImplementation(async () => {
        const credential: OAuthCredential = {
          type: 'oauth',
          access_token: 'fresh',
          token_type: 'Bearer',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          refresh_token: 'rt2',
        };
        store = oauthStore(credential);
        return { credential, rotated: true };
      });
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, ingestionEnvelope('not_observed', 0, 'check_123', 1)),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, ingestionEnvelope('observed', 1, 'check_124')),
      );

    const result = runOperation(operation(['events', 'check-ingestion']), {
      project: '187520',
      'timeout-seconds': '5',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await result;

    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
      'Bearer fresh',
    );
  });

  it('applies 401 recovery to a polling attempt', async () => {
    vi.useFakeTimers();
    let store = oauthStore({ access_token: 'stale', refresh_token: 'rt1' });
    vi.mocked(credentialStore.loadStore).mockImplementation(() => store);
    const refreshSpy = vi
      .spyOn(tokenRefresh, 'refreshProfileTokenLocked')
      .mockImplementation(async () => {
        const credential: OAuthCredential = {
          type: 'oauth',
          access_token: 'fresh',
          token_type: 'Bearer',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          refresh_token: 'rt2',
        };
        store = oauthStore(credential);
        return { credential, rotated: true };
      });
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, ingestionEnvelope('not_observed', 0, 'check_123', 1)),
      )
      .mockResolvedValueOnce(jsonResponse(401, { error_code: 'invalid_token' }))
      .mockResolvedValueOnce(
        jsonResponse(200, ingestionEnvelope('observed', 1, 'check_124')),
      );

    const result = runOperation(operation(['events', 'check-ingestion']), {
      project: '187520',
      'timeout-seconds': '5',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await result;

    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe(
      'Bearer fresh',
    );
  });

  it('does not add polling telemetry headers to ingestion requests', async () => {
    vi.useFakeTimers();
    const notObserved = ingestionEnvelope('not_observed', 0, 'check_123', 1);
    const observed = ingestionEnvelope('observed', 1, 'check_124');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, notObserved))
      .mockResolvedValueOnce(jsonResponse(200, observed));

    const result = runOperation(operation(['events', 'check-ingestion']), {
      token: 'amp_test',
      project: '187520',
      'timeout-seconds': '5',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await result;

    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    for (const headers of [firstHeaders, secondHeaders]) {
      expect(headers.get('Amp-Command-Id')).toBeNull();
      expect(headers.get('Amp-Poll-Attempt')).toBeNull();
      expect(headers.get('Amp-Poll-Elapsed-Seconds')).toBeNull();
    }
  });

  it('completes the initial request after the polling window expires', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(5_000);
    fetchMock.mockResolvedValue(
      jsonResponse(200, ingestionEnvelope('observed', 1)),
    );

    await runOperation(operation(['events', 'check-ingestion']), {
      token: 'amp_test',
      project: '187520',
      'timeout-seconds': '5',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  it('emits the last response when an in-flight poll is aborted', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abortController.signal);
    const notObserved = ingestionEnvelope('not_observed', 0, 'check_123', 1);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, notObserved))
      .mockImplementationOnce(async (_url, init) => {
        expect(init?.signal).toBe(abortController.signal);
        abortController.abort();
        throw new DOMException('Aborted', 'AbortError');
      });

    const result = runOperation(operation(['events', 'check-ingestion']), {
      token: 'amp_test',
      project: '187520',
      'timeout-seconds': '5',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(notObserved));
  });

  it('does not resolve auth after the polling window expires', async () => {
    vi.useFakeTimers();
    let currentTimeMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => currentTimeMs);
    const resolveAuthSpy = vi.spyOn(
      credentialResolver,
      'resolveAuthWithRefresh',
    );
    const notObserved = ingestionEnvelope('not_observed', 0, 'check_123', 1);
    fetchMock.mockResolvedValue(jsonResponse(200, notObserved));

    const result = runOperation(operation(['events', 'check-ingestion']), {
      token: 'amp_test',
      project: '187520',
      'timeout-seconds': '5',
    });
    await vi.advanceTimersByTimeAsync(0);
    currentTimeMs = 5_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await result;

    expect(resolveAuthSpy).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry when the server delay reaches the timeout deadline', async () => {
    const notObserved = ingestionEnvelope('not_observed', 0, 'check_123', 5);
    fetchMock.mockResolvedValue(jsonResponse(200, notObserved));

    await runOperation(operation(['events', 'check-ingestion']), {
      token: 'amp_test',
      project: '187520',
      'timeout-seconds': '5',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(notObserved));
  });

  it.each(['-1', '0', '121', '1.5'])(
    'rejects ingestion check timeout %s before sending a request',
    async (timeoutSeconds) => {
      const error: unknown = await runOperation(
        operation(['events', 'check-ingestion']),
        {
          token: 'amp_test',
          project: '187520',
          'timeout-seconds': timeoutSeconds,
        },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CliError);
      if (!(error instanceof CliError)) {
        throw new Error('Expected a CliError.');
      }
      expect(error).toMatchObject({ errorCode: 'usage_error', exitCode: 2 });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('does not treat Retry-After on an API error as ingestion polling guidance', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        503,
        {
          title: 'Operation availability unavailable',
          detail: 'Retry the request.',
          error_code: 'operation_availability_unavailable',
          retryable: true,
        },
        { 'Retry-After': '1' },
      ),
    );

    const error = await runOperation(operation(['events', 'check-ingestion']), {
      token: 'amp_test',
      project: '187520',
      'timeout-seconds': '5',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps ingestion check API failures in the structured error path', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, {
        title: 'Operation availability unavailable',
        detail: 'Retry the request.',
        error_code: 'operation_availability_unavailable',
        retryable: true,
      }),
    );

    const error: unknown = await runOperation(
      operation(['events', 'check-ingestion']),
      {
        token: 'amp_test',
        project: '187520',
        'timeout-seconds': '120',
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) {
      throw new Error('Expected a CliError.');
    }
    expect(error).toMatchObject({
      errorCode: 'operation_availability_unavailable',
      exitCode: 5,
      httpStatus: 503,
    });
  });

  it('prints compact JSON when piped (non-interactive), the agent path', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { id: 'evt_1' } }));

    await runOperation(operation(['events', 'get']), {
      token: 'amp_test',
      project: '187520',
      event: 'signup',
      json: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    // No indentation: stdout is not a TTY in this suite, so output is compact.
    expect(logSpy).toHaveBeenCalledWith('{"data":{"id":"evt_1"}}');
  });

  it('pretty-prints JSON when --json is used at a real terminal', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { id: 'evt_1' } }));

    await runOperation(operation(['events', 'get']), {
      token: 'amp_test',
      project: '187520',
      event: 'signup',
      json: true,
    });

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ data: { id: 'evt_1' } }, null, 2),
    );
  });

  it('threads the resolved base_url and Authorization header into the request', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { id: 'evt_1' } }));

    await runOperation(operation(['events', 'get']), {
      token: 'amp_secret',
      'base-url': 'https://developer-api.staging.amplitude.com',
      project: '187520',
      event: 'signup',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      /^https:\/\/developer-api\.staging\.amplitude\.com\//,
    );
    expect(init.headers.Authorization).toBe('Bearer PAT=amp_secret');
  });

  it('validates flags before resolving credentials: a missing required flag surfaces usage_error even with an unresolvable profile', async () => {
    const error: unknown = await runOperation(operation(['events', 'get']), {
      profile: '__nope__',
      event: 'signup',
      // --project omitted: should fail validation before touching auth.
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) {
      throw new Error('Expected a CliError.');
    }
    expect(error.errorCode).toBe('usage_error');
    expect(error.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a formatted error on non-2xx responses', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { detail: 'insufficient scope' }),
    );

    await expect(
      runOperation(operation(['events', 'get']), {
        token: 'amp_test',
        project: '187520',
        event: 'signup',
      }),
    ).rejects.toThrow(/403/);
  });

  it('throws a CliError with exitCode 3 for a 403 insufficient_scope response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error_code: 'insufficient_scope',
        title: 'Forbidden',
        detail: 'Missing scope write:flags',
      }),
    );

    const error: unknown = await runOperation(operation(['events', 'get']), {
      token: 'amp_test',
      project: '187520',
      event: 'signup',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) {
      throw new Error('Expected a CliError.');
    }
    expect(error.errorCode).toBe('insufficient_scope');
    expect(error.exitCode).toBe(3);
    expect(error.httpStatus).toBe(403);
  });

  it('throws a transport CliError when the fetch call rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const error: unknown = await runOperation(operation(['events', 'get']), {
      token: 'amp_test',
      project: '187520',
      event: 'signup',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) {
      throw new Error('Expected a CliError.');
    }
    expect(error.errorCode).toBe('transport_error');
    expect(error.exitCode).toBe(5);
    expect(error.message).toMatch(/Could not reach the API/);
  });

  describe('reactive 401 refresh', () => {
    it('refreshes and retries once on a 401, then succeeds', async () => {
      vi.mocked(credentialStore.loadStore).mockReturnValue(
        oauthStore({ access_token: 'stale', refresh_token: 'rt1' }),
      );
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(401, { error_code: 'invalid_token' }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: 'evt_1' } }));
      const refreshSpy = vi
        .spyOn(tokenRefresh, 'refreshProfileTokenLocked')
        .mockResolvedValue({
          credential: {
            type: 'oauth',
            access_token: 'fresh',
            token_type: 'Bearer',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            refresh_token: 'rt2',
          },
          rotated: true,
        });

      await expect(
        runOperation(operation(['events', 'get']), {
          project: '187520',
          event: 'signup',
        }),
      ).resolves.toBeUndefined();

      expect(refreshSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'default',
          staleAccessToken: 'stale',
          expectedProfileBaseUrl: 'https://api',
        }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
        'Bearer fresh',
      );
    });

    it('does not refresh again after a proactive refresh (single rotation)', async () => {
      const expired = credentialStore.setDefault(
        credentialStore.setProfile(credentialStore.emptyStore(), 'default', {
          base_url: 'https://api',
          credential: {
            type: 'oauth',
            token_type: 'Bearer',
            access_token: 'expired',
            refresh_token: 'rt1',
            expires_at: new Date(Date.now() - 1000).toISOString(),
          },
          saved_at: '2026-06-23T00:00:00.000Z',
          store: 'file',
        }),
        'default',
      );
      vi.mocked(credentialStore.loadStore)
        .mockReturnValueOnce(expired) // proactive read: expired
        .mockReturnValue(
          oauthStore({
            access_token: 'proactively-fresh',
            refresh_token: 'rt2',
          }),
        );
      const refreshSpy = vi
        .spyOn(tokenRefresh, 'refreshProfileTokenLocked')
        .mockResolvedValue({
          credential: {
            type: 'oauth',
            access_token: 'proactively-fresh',
            token_type: 'Bearer',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            refresh_token: 'rt2',
          },
          rotated: true,
        });
      fetchMock.mockResolvedValue(
        jsonResponse(401, { error_code: 'invalid_token' }),
      );

      const error = await runOperation(operation(['events', 'get']), {
        project: '187520',
        event: 'signup',
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CliError);
      if (!(error instanceof CliError)) {
        throw new Error('Expected a CliError.');
      }
      expect(error.exitCode).toBe(3);
      expect(error.hint).toContain('amp auth login');
      expect(refreshSpy).toHaveBeenCalledTimes(1); // proactive only — no second refresh
      expect(fetchMock).toHaveBeenCalledTimes(1); // no reactive retry
    });

    it('still retries on a 401 when the proactive pass only adopted a peer token', async () => {
      const expired = credentialStore.setDefault(
        credentialStore.setProfile(credentialStore.emptyStore(), 'default', {
          base_url: 'https://api',
          credential: {
            type: 'oauth',
            token_type: 'Bearer',
            access_token: 'expired',
            refresh_token: 'rt1',
            expires_at: new Date(Date.now() - 1000).toISOString(),
          },
          saved_at: '2026-06-23T00:00:00.000Z',
          store: 'file',
        }),
        'default',
      );
      vi.mocked(credentialStore.loadStore)
        .mockReturnValueOnce(expired) // proactive read: expired
        .mockReturnValue(
          oauthStore({ access_token: 'peer-at', refresh_token: 'rt1' }),
        );
      const refreshSpy = vi
        .spyOn(tokenRefresh, 'refreshProfileTokenLocked')
        .mockResolvedValueOnce({
          // Proactive: a peer had already refreshed, so nothing rotated here.
          credential: {
            type: 'oauth',
            access_token: 'peer-at',
            token_type: 'Bearer',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            refresh_token: 'rt1',
          },
          rotated: false,
        })
        .mockResolvedValueOnce({
          credential: {
            type: 'oauth',
            access_token: 'fresh',
            token_type: 'Bearer',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            refresh_token: 'rt2',
          },
          rotated: true,
        });
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(401, { error_code: 'invalid_token' }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { data: { id: 'evt_1' } }));

      await expect(
        runOperation(operation(['events', 'get']), {
          project: '187520',
          event: 'signup',
        }),
      ).resolves.toBeUndefined();

      expect(refreshSpy).toHaveBeenCalledTimes(2); // proactive adopt, then a real rotation
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
        'Bearer fresh',
      );
    });

    it('does not retry when there is no refresh token (raw --token path)', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(401, { error_code: 'invalid_token' }),
      );
      const refreshSpy = vi
        .spyOn(tokenRefresh, 'refreshProfileTokenLocked')
        .mockRejectedValue(new Error('refresh must not run for a raw token'));

      const error: unknown = await runOperation(operation(['events', 'get']), {
        token: 'amp_test',
        project: '187520',
        event: 'signup',
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CliError);
      if (!(error instanceof CliError)) {
        throw new Error('Expected a CliError.');
      }
      expect(error.exitCode).toBe(3);
      expect(refreshSpy).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('blocks a DELETE without --yes in a non-interactive shell', async () => {
    await expect(
      runOperation(operation(['events', 'delete']), {
        token: 'amp_test',
        project: '187520',
        event: 'signup',
      }),
    ).rejects.toThrow('Pass --yes to run a DELETE command');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs a DELETE when --yes is set', async () => {
    fetchMock.mockResolvedValue(jsonResponse(204, ''));

    await runOperation(operation(['events', 'delete']), {
      token: 'amp_test',
      project: '187520',
      event: 'signup',
      yes: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
    expect(logSpy).toHaveBeenCalledWith('null');
  });

  it('pretty-prints null for a 204 when --json is used at a real terminal', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    fetchMock.mockResolvedValue(jsonResponse(204, ''));

    await runOperation(operation(['events', 'delete']), {
      token: 'amp_test',
      project: '187520',
      event: 'signup',
      yes: true,
      json: true,
    });

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(null, null, 2));
  });

  it('prints a short message for a 204 DELETE at an interactive terminal', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    fetchMock.mockResolvedValue(jsonResponse(204, ''));

    await runOperation(operation(['events', 'delete']), {
      token: 'amp_test',
      project: '187520',
      event: 'signup',
      yes: true,
    });

    expect(logSpy).toHaveBeenCalledWith('Deleted.');
  });

  it('prints a short message for a 204 archive at an interactive terminal', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    fetchMock.mockResolvedValue(jsonResponse(204, ''));

    await runOperation(operation(['flags', 'archive']), {
      token: 'amp_test',
      project: '187520',
      flag: 'my-flag',
      yes: true,
    });

    expect(logSpy).toHaveBeenCalledWith('Archived.');
  });

  it('passes --dry-run through to the server when supported', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { dry_run: true } }));

    await runOperation(operation(['events', 'delete']), {
      token: 'amp_test',
      project: '187520',
      event: 'signup',
      'dry-run': true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('dry_run=true');
  });

  it('refuses an unsupported --dry-run instead of silently deleting', async () => {
    await expect(
      runOperation(deleteWithoutDryRun, {
        token: 'amp_test',
        id: 'w_1',
        'dry-run': true,
      }),
    ).rejects.toThrow('does not support --dry-run');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses --dry-run --yes on unsupported DELETE instead of silently deleting', async () => {
    await expect(
      runOperation(deleteWithoutDryRun, {
        token: 'amp_test',
        id: 'w_1',
        'dry-run': true,
        yes: true,
      }),
    ).rejects.toThrow('does not support --dry-run');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
