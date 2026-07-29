import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliError } from './cli-error';
import { CLI_OPERATIONS, type CliOperation } from './generated/cli-manifest';
import { deleteGateDecision, runOperation } from './run';

function operation(command: string[]): CliOperation {
  const found = CLI_OPERATIONS.find(
    (candidate) =>
      candidate.command.length === command.length &&
      candidate.command.every((part, index) => part === command[index]),
  );

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

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
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
    vi.unstubAllGlobals();
    logSpy.mockRestore();
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
