import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli';
import * as credentialResolver from './credential-resolver';
import { formatProjectApiKeyOutput } from './project-api-key';

vi.mock('./client-identity', () => ({
  deviceIdHeader: () => ({ 'Amp-Device-Id': 'test-device' }),
}));

const resource = {
  object: 'project_api_key',
  project_id: '12345',
  project_name: 'Example Project',
  api_key: 'example-project-api-key',
};

describe('formatProjectApiKeyOutput', () => {
  it.each([
    {
      kind: 'ESC screen controls',
      name: 'Demo\u001b[2J\u001b[H',
      displayedName: 'Demo^[[2J^[[H',
    },
    {
      kind: 'OSC title and BEL',
      name: 'Demo\u001b]0;title\u0007',
      displayedName: 'Demo^[]0;title^G',
    },
    {
      kind: 'OSC clipboard and string terminator',
      name: 'Demo\u001b]52;c;dGVzdA==\u001b\\',
      displayedName: 'Demo^[]52;c;dGVzdA==^[\\',
    },
    {
      kind: 'C1 controls',
      name: 'Demo\u009b2J\u009d0;title\u009c',
      displayedName: 'Demo\\u009b2J\\u009d0;title\\u009c',
    },
    {
      kind: 'backspace and DEL',
      name: 'Demo\u0008\u007f',
      displayedName: 'Demo^H^?',
    },
  ])('neutralizes $kind in project names', ({ name, displayedName }) => {
    expect(
      formatProjectApiKeyOutput({
        ...resource,
        object: 'project_api_key',
        project_name: name,
      }),
    ).toBe(
      `Project: ${displayedName} (12345)\nAPI key: example-project-api-key`,
    );
  });
});

describe('project API key command', () => {
  const originalArgv = process.argv;
  const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  function setTTY(isTTY: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: isTTY,
    });
  }

  async function run(
    flags: string[] = [],
    command = ['projects', 'api-keys', 'get'],
  ) {
    process.argv = [
      'node',
      'amp',
      ...command,
      '--token',
      'amp_synthetic',
      '--region',
      'us',
      ...flags,
    ];
    await main();
  }

  beforeEach(() => {
    process.exitCode = undefined;
    setTTY(false);
    stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ data: resource }))),
      );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalTTY);
    } else {
      Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it.each([
    { command: ['projects'] },
    { command: ['projects', 'api-keys'] },
    { command: ['help', 'projects', 'api-keys'] },
  ])(
    'discovers key retrieval through $command without authentication',
    async ({ command }) => {
      const resolve = vi.spyOn(credentialResolver, 'resolveAuthWithRefresh');
      await run(['--help'], command);
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      const output = JSON.parse(stdout.mock.calls[0][0]);
      expect(output.commands).toContainEqual(
        expect.objectContaining({
          command: 'projects api-keys get',
          requiredScopes: ['projects:read'],
        }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('rejects the singular command without requesting a key', async () => {
    await run([], ['projects', 'api-key', 'get']);
    expect(process.exitCode).toBe(2);
    expect(stdout).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the project identity and full key at a terminal', async () => {
    setTTY(true);
    await run(['--project', '12345']);
    expect(stdout.mock.calls).toEqual([
      ['Project: Example Project (12345)\nAPI key: example-project-api-key'],
    ]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('neutralizes control characters in a terminal key', async () => {
    setTTY(true);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { ...resource, api_key: 'key\u001b[2J' } }),
      ),
    );
    await run();
    expect(stdout.mock.calls).toEqual([
      ['Project: Example Project (12345)\nAPI key: key^[[2J'],
    ]);
  });

  it('preserves control characters in a raw key', async () => {
    setTTY(true);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { ...resource, api_key: 'key\u001b[2J' } }),
      ),
    );
    await run(['--raw']);
    expect(stdout.mock.calls).toEqual([['key\u001b[2J']]);
  });

  it.each([null, '', ' \n\t'])(
    'shows an ID-only label for name %j',
    async (name) => {
      setTTY(true);
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { ...resource, project_name: name } }),
        ),
      );
      await run();
      expect(stdout.mock.calls).toEqual([
        ['Project: 12345\nAPI key: example-project-api-key'],
      ]);
    },
  );

  it('normalizes display-name whitespace without truncating the key', async () => {
    setTTY(true);
    const longKey = 'example-key-'.repeat(30);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            ...resource,
            project_name: ' Example\n Project\t',
            api_key: longKey,
          },
        }),
      ),
    );
    await run();
    expect(stdout.mock.calls).toEqual([
      [`Project: Example Project (12345)\nAPI key: ${longKey}`],
    ]);
  });

  it.each([false, true])(
    'prints only the key with --raw (TTY: %s)',
    async (tty) => {
      setTTY(tty);
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { ...resource, project_name: 'Demo\u001b[2J\u0007\u009b' },
          }),
        ),
      );
      await run(['--raw']);
      expect(stdout.mock.calls).toEqual([['example-project-api-key']]);
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://developer-api.amplitude.com/v1/projects/api-key',
      );
      expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    },
  );

  it.each(['--raw=false', '--raw=true'])(
    'honors explicit boolean output selection: %s',
    async (flag) => {
      await run([flag]);
      expect(stdout.mock.calls).toEqual([
        [
          flag === '--raw=true'
            ? 'example-project-api-key'
            : JSON.stringify({ data: resource }),
        ],
      ]);
    },
  );

  it('preserves null names and additive response fields in piped JSON', async () => {
    const body = {
      data: { ...resource, project_name: null, future_field: 'retained' },
      request_id: 'request-123',
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));
    await run();
    expect(stdout.mock.calls).toEqual([[JSON.stringify(body)]]);
  });

  it('forces JSON at a terminal', async () => {
    setTTY(true);
    await run(['--json']);
    expect(stdout.mock.calls).toEqual([
      [JSON.stringify({ data: resource }, null, 2)],
    ]);
  });

  it.each([false, true])(
    'preserves project-name controls in JSON (TTY: %s)',
    async (tty) => {
      setTTY(tty);
      const body = {
        data: { ...resource, project_name: 'Demo\u001b[2J\u0007\u009b' },
      };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));
      await run(tty ? ['--json'] : []);
      expect(stdout.mock.calls).toEqual([
        [JSON.stringify(body, null, tty ? 2 : undefined)],
      ]);
    },
  );

  it('allows disabled raw with JSON', async () => {
    await run(['--raw=false', '--json']);
    expect(stdout.mock.calls).toEqual([[JSON.stringify({ data: resource })]]);
  });

  it('allows raw with explicitly disabled JSON', async () => {
    await run(['--raw', '--json=false']);
    expect(stdout.mock.calls).toEqual([['example-project-api-key']]);
  });

  it.each(['project', 'project-id', 'project_id'])(
    'preserves large string project IDs through --%s',
    async (alias) => {
      await run([`--${alias}`, '900719925474099312345']);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://developer-api.amplitude.com/v1/projects/api-key?project_id=900719925474099312345',
      );
    },
  );

  it.each([
    ['--raw', '--json'],
    ['--raw=invalid'],
    ['--project', ''],
    ['--project', '0'],
    ['--project', '-1'],
    ['--project-id', '01'],
    ['--project_id', '1.5'],
    ['--project', ' 12345'],
  ])('rejects invalid options before auth/network: %j', async (...flags) => {
    const resolveAuth = vi.spyOn(credentialResolver, 'resolveAuthWithRefresh');
    await run(flags);
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(stderr.mock.calls[0][0])).error.error_code).toBe(
      'usage_error',
    );
    expect(resolveAuth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['projects', 'list'],
    ['events', 'list'],
    ['auth', 'status'],
  ])('rejects raw on another command: %j', async (...command) => {
    await run(['--raw'], command);
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { data: { ...resource, api_key: undefined } },
    { data: { ...resource, api_key: '' } },
    { data: { ...resource, object: 'other_resource' } },
    { data: { ...resource, project_name: undefined } },
    { data: { ...resource, project_id: 12345 } },
    { data: { ...resource, project_id: '0' } },
    'example-project-api-key is not JSON',
    null,
  ])('rejects invalid success without revealing its body: %j', async (body) => {
    fetchMock.mockResolvedValueOnce(
      new Response(typeof body === 'string' ? body : JSON.stringify(body)),
    );
    await run(['--raw']);
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(stderr.mock.calls[0][0])).error.error_code).toBe(
      'unexpected_response',
    );
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(
      'example-project-api-key',
    );
  });

  it('rejects a no-content success instead of emitting null as a key', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await run(['--raw']);
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(stderr.mock.calls[0][0])).error.error_code).toBe(
      'unexpected_response',
    );
  });

  it('validates JSON-mode successes before exposing their contents', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { ...resource, project_id: null } })),
    );
    await run(['--json']);
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(
      'example-project-api-key',
    );
  });

  const failures: Array<{
    status: number;
    code: string;
    retryable: boolean;
    exit: number;
    hint: string;
  }> = [
    {
      status: 400,
      code: 'project_selection_required',
      retryable: false,
      exit: 2,
      hint: 'amp projects list',
    },
    {
      status: 403,
      code: 'project_key_access_denied',
      retryable: false,
      exit: 3,
      hint: 'administrator',
    },
    {
      status: 404,
      code: 'project_not_found',
      retryable: false,
      exit: 4,
      hint: '--project',
    },
    {
      status: 422,
      code: 'project_api_key_not_available',
      retryable: false,
      exit: 2,
      hint: 'project',
    },
    {
      status: 503,
      code: 'project_api_key_unavailable',
      retryable: false,
      exit: 1,
      hint: 'administrator',
    },
    {
      status: 502,
      code: 'upstream_error',
      retryable: true,
      exit: 5,
      hint: 'Retry',
    },
    {
      status: 503,
      code: 'operation_availability_unavailable',
      retryable: true,
      exit: 5,
      hint: 'Retry',
    },
    {
      status: 429,
      code: 'rate_limit_exceeded',
      retryable: true,
      exit: 1,
      hint: 'Retry',
    },
  ];

  it.each(failures)(
    'preserves $code and its recovery information',
    async (failure) => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: `https://developer-api.amplitude.com/problems/${failure.code}`,
            title: 'Project API key request failed',
            status: failure.status,
            detail: 'The project API key could not be retrieved.',
            error_code: failure.code,
            retryable: failure.retryable,
          }),
          {
            status: failure.status,
            headers: { 'Content-Type': 'application/problem+json' },
          },
        ),
      );
      await run(['--raw']);
      expect(stdout).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(failure.exit);
      const error = JSON.parse(String(stderr.mock.calls[0][0])).error;
      expect(error).toMatchObject({
        error_code: failure.code,
        http_status: failure.status,
        retryable: failure.retryable,
        hint: expect.stringContaining(failure.hint),
      });
      if (failure.code === 'project_selection_required') {
        expect(error.hint).toContain('--project');
      }
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { message: 'example-project-api-key' },
    'example-project-api-key in a gateway error',
    { title: 'Gateway failure', detail: 'example-project-api-key' },
    {
      error_code: 'upstream_error',
      retryable: 'false',
      detail: 'example-project-api-key',
    },
    {
      type: 123,
      title: 'Gateway failure',
      status: 502,
      error_code: 'upstream_error',
      retryable: true,
      detail: 'example-project-api-key',
    },
    {
      type: 'not a URI',
      title: 'Gateway failure',
      status: 502,
      error_code: 'upstream_error',
      retryable: true,
      detail: 'example-project-api-key',
    },
    {
      type: 'https://developer-api.amplitude.com/problems/upstream-error',
      title: 'Gateway failure',
      status: 503,
      error_code: 'upstream_error',
      retryable: true,
      detail: 'example-project-api-key',
    },
    {
      type: 'https://developer-api.amplitude.com/problems/upstream-error',
      title: 'Gateway failure',
      status: 502,
      error_code: 'upstream_error',
      detail: 'example-project-api-key',
    },
  ])('sanitizes unexpected error bodies: %j', async (body) => {
    fetchMock.mockResolvedValueOnce(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: 502,
      }),
    );
    await run(['--raw']);
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(5);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(
      'example-project-api-key',
    );
    expect(JSON.parse(String(stderr.mock.calls[0][0])).error.http_status).toBe(
      502,
    );
  });
});
