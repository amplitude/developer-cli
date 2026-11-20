import { mkdtempSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertTrackingPlanFlags,
  runTrackingPlanExport,
  runTrackingPlanImport,
} from './tracking-plan-commands';

const resolveAuthWithRefreshMock = vi.fn();
const refreshProfileTokenLockedMock = vi.fn();
const deviceIdHeaderMock = vi.fn();

vi.mock('./credential-resolver', () => ({
  authorizationHeaderForToken: (token: string) => `Bearer ${token}`,
  resolveAuthWithRefresh: (...args: unknown[]) =>
    resolveAuthWithRefreshMock(...args),
}));

vi.mock('./token-refresh', () => ({
  refreshProfileTokenLocked: (...args: unknown[]) =>
    refreshProfileTokenLockedMock(...args),
}));

vi.mock('./client-identity', () => ({
  deviceIdHeader: (...args: unknown[]) => deviceIdHeaderMock(...args),
}));

function authFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    token: 'token-123',
    baseUrl: 'https://api.example.test',
    source: '--token',
    refreshable: false,
    ...overrides,
  };
}

describe('tracking-plan export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAuthWithRefreshMock.mockResolvedValue(authFixture());
    refreshProfileTokenLockedMock.mockResolvedValue({
      credential: { access_token: 'new-token-123' },
    });
    deviceIdHeaderMock.mockReturnValue({ 'X-Amp-Device-Id': 'device-1' });
  });

  it('writes CSV to disk atomically and requests expected URL/query params', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-export-'));
    const out = join(dir, 'plan.csv');
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(
        '/v1/projects/project%201/tracking-plan/export',
      );
      expect(url.searchParams.get('type')).toBe('user_properties');
      expect(url.searchParams.get('branch_name')).toBe('feat branch');
      expect(url.searchParams.get('include_deleted')).toBe('true');
      return new Response('a,b\n1,2\n', { status: 200 });
    });

    await runTrackingPlanExport(
      {
        project: 'project 1',
        'branch-name': 'feat branch',
        type: 'user_properties',
        'include-deleted': true,
        out,
      },
      {
        fetchImpl,
        isTTY: true,
        write: () => undefined,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readFile(out, 'utf8')).toBe('a,b\n1,2\n');
  });

  it('sends POST export with event_names when --event is provided', async () => {
    const fetchImpl = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/v1/projects/123/tracking-plan/export');
        expect(url.search).toBe('');
        expect(init?.method).toBe('POST');
        const headers = new Headers(init?.headers);
        expect(headers.get('Content-Type')).toBe('application/json');
        expect(headers.get('Accept')).toBe('text/csv');
        expect(String(init?.body)).toContain(
          '"event_names":["Signup Completed","Purchase Completed"]',
        );
        return new Response('a,b\n1,2\n', { status: 200 });
      },
    );

    const dir = mkdtempSync(join(tmpdir(), 'tp-export-events-'));
    const out = join(dir, 'plan.csv');

    await runTrackingPlanExport(
      {
        project: '123',
        event: 'Signup Completed\u0000Purchase Completed',
        out,
      },
      { fetchImpl, write: () => undefined },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readFile(out, 'utf8')).toBe('a,b\n1,2\n');
  });

  it('loads additional event names from --events-file and writes unmatched names to stderr', async () => {
    const writesErr: string[] = [];
    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(String(init?.body)).toContain(
          '"event_names":["Signup Completed","Missing Name"]',
        );
        return new Response('a,b\n1,2\n', {
          status: 200,
          headers: {
            'x-unmatched-event-names': 'Missing%20Name',
            'x-unmatched-event-count': '1',
          },
        });
      },
    );
    const dir = mkdtempSync(join(tmpdir(), 'tp-export-events-file-'));
    const out = join(dir, 'plan.csv');

    await runTrackingPlanExport(
      {
        project: '123',
        event: 'Signup Completed',
        'events-file': 'events.txt',
        out,
      },
      {
        fetchImpl,
        readFileImpl: vi.fn(async () => Buffer.from('Missing Name\n')),
        isTTY: true,
        write: () => undefined,
        writeErr: (chunk) => {
          writesErr.push(chunk);
        },
      },
    );

    expect(writesErr.join('')).toContain('Unmatched event names: Missing Name');
  });

  it('prints a truncation notice when unmatched-name headers are truncated', async () => {
    const writesErr: string[] = [];
    const fetchImpl = vi.fn(async () => {
      return new Response('a,b\n1,2\n', {
        status: 200,
        headers: {
          'x-unmatched-event-count': '45',
          'x-unmatched-event-names-truncated': 'true',
        },
      });
    });
    const dir = mkdtempSync(join(tmpdir(), 'tp-export-truncated-unmatched-'));
    const out = join(dir, 'plan.csv');

    await runTrackingPlanExport(
      {
        project: '123',
        event: 'Signup Completed',
        out,
      },
      {
        fetchImpl,
        isTTY: true,
        write: () => undefined,
        writeErr: (chunk) => {
          writesErr.push(chunk);
        },
      },
    );

    const rendered = writesErr.join('');
    expect(rendered).toContain(
      'Unmatched event names: 45 total (header list omitted)',
    );
    expect(rendered).toContain(
      'Unmatched event names list truncated (45 total).',
    );
  });

  it('reports unmatched event names in the JSON summary instead of stderr prose', async () => {
    const writes: string[] = [];
    const writesErr: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'tp-export-unmatched-json-'));
    const out = join(dir, 'plan.csv');

    await runTrackingPlanExport(
      { project: '123', event: 'Signup\u0000Missing, Name', out, json: true },
      {
        fetchImpl: vi.fn(
          async () =>
            new Response('a,b\n1,2\n', {
              status: 200,
              headers: {
                'x-unmatched-event-names': 'Missing%2C%20Name',
                'x-unmatched-event-count': '1',
              },
            }),
        ),
        isTTY: false,
        write: (chunk) => {
          writes.push(chunk);
        },
        writeErr: (chunk) => {
          writesErr.push(chunk);
        },
      },
    );

    expect(JSON.parse(writes.join(''))).toEqual({
      data: {
        project_id: '123',
        type: 'events',
        include_deleted: false,
        out,
        event_names: ['Signup', 'Missing, Name'],
        unmatched_event_names: ['Missing, Name'],
        unmatched_event_count: 1,
        unmatched_event_names_truncated: false,
      },
    });
    expect(writesErr).toEqual([]);
  });

  it('preserves commas inside a literal --event value', async () => {
    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(String(init?.body)).toContain(
          '"event_names":["Checkout, Step 2"]',
        );
        return new Response('a,b\n1,2\n', { status: 200 });
      },
    );
    const dir = mkdtempSync(join(tmpdir(), 'tp-export-event-comma-'));
    const out = join(dir, 'plan.csv');

    await runTrackingPlanExport(
      {
        project: '123',
        event: 'Checkout, Step 2',
        out,
      },
      { fetchImpl, write: () => undefined },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects --event/--events-file when exporting user_properties', async () => {
    await expect(
      runTrackingPlanExport(
        {
          project: '123',
          type: 'user_properties',
          event: 'Signup Completed',
          out: '/tmp/plan.csv',
        },
        { fetchImpl: vi.fn() },
      ),
    ).rejects.toMatchObject({
      errorCode: 'usage_error',
      message: expect.stringContaining('only supported with --type events'),
    });
  });

  it('rejects empty event filters from --event/--events-file', async () => {
    await expect(
      runTrackingPlanExport(
        {
          project: '123',
          event: '',
          out: '/tmp/plan.csv',
        },
        { fetchImpl: vi.fn() },
      ),
    ).rejects.toMatchObject({
      errorCode: 'usage_error',
      message: expect.stringContaining('must include at least one non-empty'),
    });

    await expect(
      runTrackingPlanExport(
        {
          project: '123',
          'events-file': 'events.txt',
          out: '/tmp/plan.csv',
        },
        {
          fetchImpl: vi.fn(),
          readFileImpl: vi.fn(async () => Buffer.from('\n\r\n')),
        },
      ),
    ).rejects.toMatchObject({
      errorCode: 'usage_error',
      message: expect.stringContaining('must include at least one non-empty'),
    });
  });

  it('maps --events-file read failures to file_read_failed', async () => {
    await expect(
      runTrackingPlanExport(
        {
          project: '123',
          'events-file': 'events.txt',
          out: '/tmp/plan.csv',
        },
        {
          fetchImpl: vi.fn(),
          readFileImpl: vi.fn(async () => {
            throw new Error('ENOENT');
          }),
        },
      ),
    ).rejects.toMatchObject({
      errorCode: 'file_read_failed',
    });
  });

  it('strips UTF-8 BOM in --events-file', async () => {
    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(String(init?.body)).toContain(
          '"event_names":["Signup Completed"]',
        );
        return new Response('a,b\n1,2\n', { status: 200 });
      },
    );
    await runTrackingPlanExport(
      {
        project: '123',
        'events-file': 'events.txt',
        out: '-',
      },
      {
        fetchImpl,
        readFileImpl: vi.fn(async () =>
          Buffer.from('\uFEFFSignup Completed\n'),
        ),
        stdoutStream: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        write: () => undefined,
      },
    );
  });

  it.each(['project-id', 'project_id'])(
    'accepts --%s as the project selector',
    async (alias) => {
      const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
        expect(new URL(String(input)).pathname).toBe(
          '/v1/projects/123/tracking-plan/export',
        );
        return new Response('a,b\n', { status: 200 });
      });

      await runTrackingPlanExport(
        { [alias]: '123', out: '-' },
        {
          fetchImpl,
          stdoutStream: new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
        },
      );

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an empty --branch-name before requesting the export', async () => {
    const fetchImpl = vi.fn();
    await expect(
      runTrackingPlanExport(
        { project: '123', out: '-', 'branch-name': '' },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      errorCode: 'usage_error',
      exitCode: 2,
      message:
        '--branch-name cannot be empty. Omit it to export the default branch.',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects --json with --out - before requesting the export', async () => {
    const fetchImpl = vi.fn();
    await expect(
      runTrackingPlanExport(
        { project: '123', out: '-', json: true },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      errorCode: 'usage_error',
      exitCode: 2,
      message:
        '--out - cannot be combined with --json. Pass --out <path> to get a JSON summary.',
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('prints CSV bytes to stdout when --out - is used', async () => {
    const chunks: Uint8Array[] = [];
    await runTrackingPlanExport(
      {
        project: '123',
        out: '-',
      },
      {
        fetchImpl: vi.fn(
          async () => new Response('x,y\n3,4\n', { status: 200 }),
        ),
        stdoutStream: new Writable({
          write(chunk, _encoding, callback) {
            const value =
              chunk instanceof Uint8Array
                ? chunk
                : new Uint8Array(Buffer.from(String(chunk), 'utf8'));
            chunks.push(value);
            callback();
          },
        }),
      },
    );

    const text = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
    ).toString('utf8');
    expect(text).toBe('x,y\n3,4\n');
  });

  it('handles EPIPE quietly on --out -', async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        const error = Object.assign(new Error('write EPIPE'), {
          code: 'EPIPE',
        });
        this.emit('error', error);
        callback(error);
      },
    });

    await expect(
      runTrackingPlanExport(
        { project: '123', out: '-' },
        {
          fetchImpl: vi.fn(
            async () => new Response('x,y\n3,4\n', { status: 200 }),
          ),
          stdoutStream: stream,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('handles a late EPIPE after the last chunk was accepted on --out -', async () => {
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        if (chunk.length === 0) {
          callback();
          return;
        }
        setImmediate(() => {
          const error = Object.assign(new Error('write EPIPE'), {
            code: 'EPIPE',
          });
          callback(error);
        });
      },
    });

    await expect(
      runTrackingPlanExport(
        { project: '123', out: '-' },
        {
          fetchImpl: vi.fn(
            async () => new Response('x,y\n3,4\n', { status: 200 }),
          ),
          stdoutStream: stream,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('returns a clear error for truncated streams and preserves existing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-export-trunc-'));
    const out = join(dir, 'plan.csv');
    await writeFile(out, 'good\n', 'utf8');

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('partial\n'));
        controller.error(new Error('terminated'));
      },
    });

    await expect(
      runTrackingPlanExport(
        { project: '123', out },
        {
          fetchImpl: vi.fn(
            async () =>
              new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/csv' },
              }),
          ),
        },
      ),
    ).rejects.toMatchObject({
      errorCode: 'transport_error',
      message: expect.stringContaining('ended early'),
    });

    expect(await readFile(out, 'utf8')).toBe('good\n');
  });

  it('returns file_write_failed when temp file cannot be opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-export-openfail-'));
    const out = join(dir, 'nested', 'plan.csv');

    await expect(
      runTrackingPlanExport(
        { project: '123', out },
        {
          fetchImpl: vi.fn(
            async () => new Response('a,b\n1,2\n', { status: 200 }),
          ),
        },
      ),
    ).rejects.toMatchObject({
      errorCode: 'file_write_failed',
      message: expect.stringContaining('Could not write CSV'),
    });
  });

  it('cleans up temp files after a write error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-export-writefail-'));
    const out = join(dir, 'plan.csv');

    const failingWriter = new Writable({
      write(_chunk, _encoding, callback) {
        const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        callback(error);
      },
    });

    await expect(
      runTrackingPlanExport(
        { project: '123', out },
        {
          fetchImpl: vi.fn(
            async () => new Response('a,b\n1,2\n', { status: 200 }),
          ),
          createWriteStreamImpl: () => {
            queueMicrotask(() => {
              failingWriter.emit('open');
            });
            return failingWriter;
          },
        },
      ),
    ).rejects.toMatchObject({
      errorCode: 'file_write_failed',
    });

    const files = await readdir(dir);
    expect(files.some((entry) => entry.includes('.tmp-'))).toBe(false);
  });

  it('renames the temp file only after the write stream has closed', async () => {
    let closed = false;
    const writer = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        callback();
        setImmediate(() => {
          closed = true;
        });
      },
      autoDestroy: false,
    });
    writer.once('finish', () => {
      setImmediate(() => {
        setImmediate(() => writer.emit('close'));
      });
    });
    const renameImpl = vi.fn(async () => {
      expect(closed).toBe(true);
    });

    await runTrackingPlanExport(
      { project: '123', out: '/tmp/plan.csv', json: true },
      {
        fetchImpl: vi.fn(
          async () => new Response('a,b\n1,2\n', { status: 200 }),
        ),
        createWriteStreamImpl: () => {
          queueMicrotask(() => writer.emit('open'));
          return writer;
        },
        renameImpl,
        write: () => undefined,
      },
    );

    expect(renameImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces 404 with explicit project/branch guidance', async () => {
    await expect(
      runTrackingPlanExport(
        {
          project: '123',
          'branch-name': 'missing',
          out: '/tmp/plan.csv',
        },
        {
          fetchImpl: vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  title: 'Not found',
                  detail: 'Branch not found.',
                  error_code: 'not_found',
                }),
                {
                  status: 404,
                  headers: { 'Content-Type': 'application/problem+json' },
                },
              ),
          ),
        },
      ),
    ).rejects.toMatchObject({
      errorCode: 'not_found',
      httpStatus: 404,
      message: expect.stringContaining('Tracking-plan export not found'),
    });
  });

  it('retries once on 401 with refreshed token and sends device-id header', async () => {
    resolveAuthWithRefreshMock.mockResolvedValue(
      authFixture({
        token: 'stale-token',
        refreshable: true,
        profile: 'default',
        profileBaseUrl: 'https://api.example.test',
        refreshed: false,
      }),
    );

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('a,b\n1,2\n', { status: 200 }));

    const dir = mkdtempSync(join(tmpdir(), 'tp-export-refresh-'));
    const out = join(dir, 'plan.csv');

    await runTrackingPlanExport(
      { project: '123', out },
      {
        fetchImpl,
        isTTY: true,
        write: () => undefined,
      },
    );

    expect(refreshProfileTokenLockedMock).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    const secondHeaders = new Headers(fetchImpl.mock.calls[1][1]?.headers);
    expect(firstHeaders.get('X-Amp-Device-Id')).toBe('device-1');
    expect(secondHeaders.get('X-Amp-Device-Id')).toBe('device-1');
  });
});

describe('tracking-plan import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAuthWithRefreshMock.mockResolvedValue(authFixture());
    refreshProfileTokenLockedMock.mockResolvedValue({
      credential: { access_token: 'new-token-123' },
    });
    deviceIdHeaderMock.mockReturnValue({ 'X-Amp-Device-Id': 'device-1' });
  });

  it('uploads raw CSV bytes and includes branch_name query param', async () => {
    const writes: string[] = [];
    const csvBytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);

    const fetchImpl = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/v1/projects/123/tracking-plan/import');
        expect(url.searchParams.get('branch_name')).toBe('import branch');
        const headers = new Headers(init?.headers);
        expect(headers.get('Content-Type')).toBe('text/csv');
        const body = init?.body;
        if (!(body instanceof Uint8Array)) {
          throw new Error('expected Uint8Array body');
        }
        expect(Buffer.from(body).equals(csvBytes)).toBe(true);

        return new Response(
          JSON.stringify({
            data: {
              branch_id: 'br-1',
              branch_name: 'import-1',
              import_type: 'events',
              event_count: 1,
              template_count: 0,
              user_property_count: 0,
              breakdown: {
                templates: { created: 0, updated: 0, removed: 0 },
                template_properties: { created: 1, updated: 2, unmapped: 3 },
                events: { created: 4, updated: 5, removed: 6 },
                event_properties: { created: 7, updated: 8, unmapped: 9 },
              },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    );

    await runTrackingPlanImport(
      {
        project: '123',
        file: 'plan.csv',
        'branch-name': 'import branch',
      },
      {
        fetchImpl,
        readFileImpl: vi.fn(async () => csvBytes),
        statImpl: vi.fn(async () => ({ size: csvBytes.length })),
        write: (chunk) => {
          writes.push(chunk);
        },
        isTTY: true,
      },
    );

    const rendered = writes.join('');
    expect(rendered).toContain('Created branch: import-1 (br-1)');
    expect(rendered).toContain(
      'Template properties: created 1, updated 2, unmapped 3',
    );
    expect(rendered).toContain('Review and merge this branch');
  });

  it('returns clear duplicate-branch guidance for 409 conflict', async () => {
    await expect(
      runTrackingPlanImport(
        {
          project: '123',
          file: 'plan.csv',
          'branch-name': 'import-1',
        },
        {
          readFileImpl: vi.fn(async () => Buffer.from('event_type\nSignup\n')),
          statImpl: vi.fn(async () => ({ size: 18 })),
          fetchImpl: vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  title: 'Conflict',
                  detail: 'A branch with this name already exists.',
                  error_code: 'conflict',
                }),
                {
                  status: 409,
                  headers: { 'Content-Type': 'application/problem+json' },
                },
              ),
          ),
        },
      ),
    ).rejects.toMatchObject({
      httpStatus: 409,
      errorCode: 'conflict',
      message: expect.stringContaining('Import branch name conflict'),
    });
  });

  it('returns 413 payload-too-large mapping', async () => {
    await expect(
      runTrackingPlanImport(
        { project: '123', file: 'plan.csv' },
        {
          readFileImpl: vi.fn(async () => Buffer.from('event_type\nSignup\n')),
          statImpl: vi.fn(async () => ({ size: 18 })),
          fetchImpl: vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  title: 'Payload Too Large',
                  detail: 'The CSV must be at most 52428800 bytes.',
                  error_code: 'payload_too_large',
                }),
                {
                  status: 413,
                  headers: { 'Content-Type': 'application/problem+json' },
                },
              ),
          ),
        },
      ),
    ).rejects.toMatchObject({
      httpStatus: 413,
      errorCode: 'payload_too_large',
    });
  });

  it('surfaces 422 partial-failure branch details', async () => {
    await expect(
      runTrackingPlanImport(
        { project: '123', file: 'plan.csv' },
        {
          readFileImpl: vi.fn(async () => Buffer.from('event_type\nSignup\n')),
          statImpl: vi.fn(async () => ({ size: 18 })),
          fetchImpl: vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  title: 'Unprocessable Entity',
                  detail: 'CSV has invalid rows.',
                  error_code: 'unprocessable_entity',
                  details: {
                    branch: {
                      id: 'br-123',
                      name: 'import-123',
                    },
                  },
                }),
                {
                  status: 422,
                  headers: { 'Content-Type': 'application/problem+json' },
                },
              ),
          ),
        },
      ),
    ).rejects.toMatchObject({
      httpStatus: 422,
      errorCode: 'unprocessable_entity',
      message: expect.stringContaining(
        'CSV has invalid rows. Import branch created: import-123 (br-123)',
      ),
    });
  });

  it('warns against retry for non-retryable 502 with branch details', async () => {
    await expect(
      runTrackingPlanImport(
        { project: '123', file: 'plan.csv' },
        {
          readFileImpl: vi.fn(async () => Buffer.from('event_type\nSignup\n')),
          statImpl: vi.fn(async () => ({ size: 18 })),
          fetchImpl: vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  title: 'Upstream error',
                  detail: 'Import failed after branch creation.',
                  error_code: 'upstream_error',
                  retryable: false,
                  details: {
                    branch: {
                      id: 'br-123',
                      name: 'import-123',
                    },
                  },
                }),
                {
                  status: 502,
                  headers: { 'Content-Type': 'application/problem+json' },
                },
              ),
          ),
        },
      ),
    ).rejects.toMatchObject({
      httpStatus: 502,
      errorCode: 'upstream_error',
      exitCode: 1,
      hint: expect.stringContaining('before retrying'),
    });
  });

  it('warns against retry for non-retryable 504', async () => {
    await expect(
      runTrackingPlanImport(
        { project: '123', file: 'plan.csv' },
        {
          readFileImpl: vi.fn(async () => Buffer.from('event_type\nSignup\n')),
          statImpl: vi.fn(async () => ({ size: 18 })),
          fetchImpl: vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  title: 'Gateway Timeout',
                  detail: 'Import timed out.',
                  error_code: 'upstream_timeout',
                  retryable: false,
                }),
                {
                  status: 504,
                  headers: { 'Content-Type': 'application/problem+json' },
                },
              ),
          ),
        },
      ),
    ).rejects.toMatchObject({
      httpStatus: 504,
      errorCode: 'upstream_timeout',
      exitCode: 1,
    });
  });

  it('treats connection-refused as transport_error retryable guidance', async () => {
    const connectError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    });

    await expect(
      runTrackingPlanImport(
        { project: '123', file: 'plan.csv' },
        {
          readFileImpl: vi.fn(async () => Buffer.from('event_type\nSignup\n')),
          statImpl: vi.fn(async () => ({ size: 18 })),
          fetchImpl: vi.fn(async () => {
            throw connectError;
          }),
        },
      ),
    ).rejects.toMatchObject({
      errorCode: 'transport_error',
      exitCode: 5,
      message: expect.stringContaining('Could not reach the API'),
    });
  });

  it('warns that drop after upload may have started import', async () => {
    await expect(
      runTrackingPlanImport(
        { project: '123', file: 'plan.csv' },
        {
          readFileImpl: vi.fn(async () => Buffer.from('event_type\nSignup\n')),
          statImpl: vi.fn(async () => ({ size: 18 })),
          fetchImpl: vi.fn(async () => {
            throw new Error('socket hang up');
          }),
        },
      ),
    ).rejects.toMatchObject({
      errorCode: 'upstream_error',
      exitCode: 1,
      hint: expect.stringContaining('before retrying'),
    });
  });

  it('does not invent created/updated/removed counts when breakdown is null', async () => {
    const writes: string[] = [];
    await runTrackingPlanImport(
      { project: '123', file: 'plan.csv' },
      {
        readFileImpl: vi.fn(async () => Buffer.from('event_type\nSignup\n')),
        statImpl: vi.fn(async () => ({ size: 18 })),
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: {
                  branch_id: 'br-1',
                  branch_name: 'import-1',
                  import_type: 'events',
                  event_count: 120,
                  template_count: 4,
                  user_property_count: 0,
                  breakdown: null,
                },
              }),
              { status: 201, headers: { 'Content-Type': 'application/json' } },
            ),
        ),
        write: (chunk) => {
          writes.push(chunk);
        },
        isTTY: true,
      },
    );

    const rendered = writes.join('');
    expect(rendered).toContain('Events total: 120');
    expect(rendered).toContain('Templates total: 4');
    expect(rendered).not.toContain('created 120');
  });

  it('rejects an empty --branch-name before reading or uploading the file', async () => {
    const fetchImpl = vi.fn();
    const statImpl = vi.fn();
    await expect(
      runTrackingPlanImport(
        { project: '123', file: 'plan.csv', 'branch-name': '' },
        { fetchImpl, statImpl },
      ),
    ).rejects.toMatchObject({
      errorCode: 'usage_error',
      exitCode: 2,
      message:
        '--branch-name cannot be empty. Omit it to auto-generate a branch name.',
    });
    expect(statImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails before upload when file size exceeds 50MB', async () => {
    const fetchImpl = vi.fn();
    await expect(
      runTrackingPlanImport(
        { project: '123', file: 'plan.csv' },
        {
          statImpl: vi.fn(async () => ({ size: 50 * 1024 * 1024 + 1 })),
          readFileImpl: vi.fn(async () => Buffer.from('x')),
          fetchImpl,
        },
      ),
    ).rejects.toMatchObject({ errorCode: 'usage_error', exitCode: 2 });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not refresh twice when auth was already proactively refreshed', async () => {
    resolveAuthWithRefreshMock.mockResolvedValue(
      authFixture({
        token: 'fresh-token',
        refreshable: true,
        profile: 'default',
        profileBaseUrl: 'https://api.example.test',
        refreshed: true,
      }),
    );

    await expect(
      runTrackingPlanImport(
        { project: '123', file: 'plan.csv' },
        {
          readFileImpl: vi.fn(async () => Buffer.from('event_type\nSignup\n')),
          statImpl: vi.fn(async () => ({ size: 18 })),
          fetchImpl: vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  title: 'Unauthorized',
                  detail: 'Token expired.',
                  error_code: 'invalid_token',
                }),
                {
                  status: 401,
                  headers: { 'Content-Type': 'application/problem+json' },
                },
              ),
          ),
        },
      ),
    ).rejects.toMatchObject({ errorCode: 'invalid_token', httpStatus: 401 });

    expect(refreshProfileTokenLockedMock).not.toHaveBeenCalled();
  });
});

describe('assertTrackingPlanFlags', () => {
  it('rejects unsupported flags for tracking-plan export', () => {
    expect(() =>
      assertTrackingPlanFlags('export', {
        project: '123',
        out: '/tmp/plan.csv',
        file: 'plan.csv',
      }),
    ).toThrow('Unknown flag --file for `amp tracking-plan export`.');
  });

  it('rejects unsupported flags for tracking-plan import', () => {
    expect(() =>
      assertTrackingPlanFlags('import', {
        project: '123',
        file: 'plan.csv',
        out: 'plan.csv',
      }),
    ).toThrow('Unknown flag --out for `amp tracking-plan import`.');
  });

  it('accepts a single spelling per flag', () => {
    expect(() =>
      assertTrackingPlanFlags('export', {
        project: '123',
        out: 'plan.csv',
        'branch-name': 'b',
        event: 'Signup Completed',
        'events-file': 'events.txt',
        type: 'events',
        'include-deleted': true,
      }),
    ).not.toThrow();
    expect(() => assertTrackingPlanFlags('export', { branch: 'b' })).toThrow(
      'Unknown flag --branch for `amp tracking-plan export`.',
    );
    expect(() =>
      assertTrackingPlanFlags('import', { branch_name: 'b' }),
    ).toThrow('Unknown flag --branch_name for `amp tracking-plan import`.');
  });
});
