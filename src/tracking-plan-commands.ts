import { createWriteStream } from 'node:fs';
import type { PathLike } from 'node:fs';
import { readFile, rename, stat, unlink } from 'node:fs/promises';

import {
  REPEATABLE_OPTION_VALUE_DELIMITER,
  type FlagValue,
  isFlagEnabled,
  stringFlag,
} from './args';
import {
  CliError,
  cliErrorFromResponse,
  exitCodeForErrorCode,
  usageError,
} from './cli-error';
import { deviceIdHeader } from './client-identity';
import {
  authorizationHeaderForToken,
  resolveAuthWithRefresh,
} from './credential-resolver';
import { asProblem } from './errors';
import { formatJsonOutput, shouldUseJsonOutput } from './output';
import { assertFlagsAllowed, parseResponseBody } from './request';
import { refreshProfileTokenLocked } from './token-refresh';
import { cliUserAgent } from './user-agent';

export type TrackingPlanVerb = 'export' | 'import';

const TRACKING_PLAN_COMMON_FLAGS = [
  'json',
  'token',
  'profile',
  'region',
  'env',
  'base-url',
  'help',
  'h',
  'version',
  'v',
] as const;

const PROJECT_ALIASES = ['project', 'project-id', 'project_id'] as const;

const TRACKING_PLAN_EXPORT_FLAGS = [
  ...TRACKING_PLAN_COMMON_FLAGS,
  ...PROJECT_ALIASES,
  'branch-name',
  'event',
  'events-file',
  'type',
  'include-deleted',
  'out',
] as const;

const TRACKING_PLAN_IMPORT_FLAGS = [
  ...TRACKING_PLAN_COMMON_FLAGS,
  ...PROJECT_ALIASES,
  'file',
  'branch-name',
] as const;

const MAX_IMPORT_BODY_BYTES = 50 * 1024 * 1024;

type ImportBranchRef = {
  id: string;
  name: string;
};

type ImportCounters = {
  created: number;
  updated: number;
  thirdLabel: 'removed' | 'unmapped';
  thirdValue: number;
};

type ResolvedAuth = Awaited<ReturnType<typeof resolveAuthWithRefresh>>;

interface EventedWritable {
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  write(
    chunk: string | Uint8Array,
    callback?: (error?: Error | null) => void,
  ): boolean;
  end(callback?: (error?: Error | null) => void): void;
  destroy(error?: Error): void;
}

export interface TrackingPlanCommandDeps {
  fetchImpl?: typeof fetch;
  isTTY?: boolean;
  write?: (chunk: string) => void;
  writeErr?: (chunk: string) => void;
  stdoutStream?: EventedWritable;
  createWriteStreamImpl?: (path: string) => EventedWritable;
  readFileImpl?: (path: PathLike) => Promise<Buffer>;
  statImpl?: (path: PathLike) => Promise<{ size: number }>;
  renameImpl?: (from: PathLike, to: PathLike) => Promise<void>;
  unlinkImpl?: (path: PathLike) => Promise<void>;
}

function writeStdout(chunk: string): void {
  process.stdout.write(chunk);
}

function throwCsvWriteError(path: string, error: unknown): never {
  const reason = error instanceof Error ? error.message : String(error);
  throw new CliError({
    message: `Could not write CSV to ${path}: ${reason}`,
    errorCode: 'file_write_failed',
    exitCode: 1,
  });
}

function throwCsvReadError(path: string, error: unknown): never {
  const reason = error instanceof Error ? error.message : String(error);
  throw new CliError({
    message: `Could not read CSV file ${path}: ${reason}`,
    errorCode: 'file_read_failed',
    exitCode: 1,
  });
}

function parseExportType(
  raw: string | undefined,
): 'events' | 'user_properties' {
  if (raw === undefined || raw === '') {
    return 'events';
  }
  if (raw === 'events' || raw === 'user_properties') {
    return raw;
  }
  throw usageError(`Invalid --type ${raw}. Allowed: events, user_properties.`);
}

function parseExportError(
  response: Response,
  responseBody: unknown,
  projectId: string,
): CliError {
  if (response.status === 404) {
    const problem = asProblem(responseBody);
    const detail =
      problem?.detail ??
      `Project ${projectId} or the selected branch was not found.`;
    return new CliError({
      message: `Tracking-plan export not found: ${detail}`,
      errorCode: problem?.error_code ?? 'not_found',
      exitCode: 4,
      httpStatus: 404,
      detail,
      hint: 'Verify --project and --branch-name, then retry.',
    });
  }
  return cliErrorFromResponse(
    response.status,
    response.statusText,
    responseBody,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function streamEndedEarly(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const text = `${error.name}: ${error.message}`;
  return (
    text.includes('terminated') ||
    text.includes('aborted') ||
    text.includes('premature') ||
    text.includes('ERR_STREAM_PREMATURE_CLOSE')
  );
}

function isEpipe(error: unknown): boolean {
  return (
    error instanceof Error &&
    ('code' in error ? error.code === 'EPIPE' : error.message.includes('EPIPE'))
  );
}

function normalizeSentence(detail: string): string {
  return detail.trim().replace(/[.\s]+$/u, '');
}

function isConnectionSetupFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code =
    ('code' in error ? error.code : undefined) ??
    (error.cause instanceof Error && 'code' in error.cause
      ? error.cause.code
      : undefined);
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

function branchLabel(branch: ImportBranchRef): string {
  return `${branch.name} (${branch.id})`;
}

function tmpPathFor(out: string): string {
  return `${out}.tmp-${process.pid}-${Date.now()}`;
}

async function removeTempFile(
  tmpPath: string,
  unlinkImpl: (path: PathLike) => Promise<void>,
): Promise<void> {
  try {
    await unlinkImpl(tmpPath);
  } catch {
    // best-effort cleanup
  }
}

function importBranchFromBody(body: unknown): ImportBranchRef | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const details = body.details;
  if (!isRecord(details)) {
    return undefined;
  }
  const branch = details.branch;
  if (!isRecord(branch)) {
    return undefined;
  }
  const id = branch.id;
  const name = branch.name;
  if (typeof id !== 'string' || typeof name !== 'string') {
    return undefined;
  }
  return { id, name };
}

async function sendAuthenticatedRequest(options: {
  auth: ResolvedAuth;
  url: string;
  method: 'GET' | 'POST';
  accept: string;
  body?: string | Buffer;
  contentType?: string;
  fetchImpl: typeof fetch;
  importSafeRetryHint?: boolean;
}): Promise<Response> {
  const send = async (token: string): Promise<Response> => {
    let requestBody: BodyInit | undefined;
    if (options.body === undefined) {
      requestBody = undefined;
    } else if (typeof options.body === 'string') {
      requestBody = options.body;
    } else {
      requestBody = new Uint8Array(options.body);
    }

    try {
      return await options.fetchImpl(options.url, {
        method: options.method,
        headers: {
          Accept: options.accept,
          ...deviceIdHeader(),
          Authorization: authorizationHeaderForToken(token),
          'User-Agent': cliUserAgent(),
          ...(options.body === undefined
            ? {}
            : { 'Content-Type': options.contentType ?? 'text/csv' }),
        },
        body: requestBody,
      });
    } catch (error) {
      if (options.importSafeRetryHint) {
        if (isConnectionSetupFailure(error)) {
          throw new CliError({
            message: `Could not reach the API at ${options.auth.baseUrl}.`,
            errorCode: 'transport_error',
            exitCode: 5,
            hint: 'Check network connectivity and retry.',
          });
        }
        throw new CliError({
          message:
            'Tracking-plan import request did not complete. The import may have started.',
          errorCode: 'upstream_error',
          exitCode: 1,
          hint: 'Check the project branches for an existing import branch before retrying.',
          retryable: false,
        });
      }
      throw new CliError({
        message: `Could not reach the API at ${options.auth.baseUrl}.`,
        errorCode: 'transport_error',
        exitCode: 5,
        hint: 'Check network connectivity and retry.',
      });
    }
  };

  const firstResponse = await send(options.auth.token);
  if (
    firstResponse.status !== 401 ||
    !options.auth.refreshable ||
    options.auth.profile === undefined ||
    options.auth.refreshed
  ) {
    return firstResponse;
  }

  await firstResponse.body?.cancel();
  const refreshed = await refreshProfileTokenLocked({
    name: options.auth.profile,
    now: Date.now(),
    staleAccessToken: options.auth.token,
    expectedProfileBaseUrl: options.auth.profileBaseUrl,
  });
  return send(refreshed.credential.access_token);
}

async function streamExportToFile(options: {
  response: Response;
  out: string;
  createWriteStreamImpl: (path: string) => EventedWritable;
  renameImpl: (from: PathLike, to: PathLike) => Promise<void>;
  unlinkImpl: (path: PathLike) => Promise<void>;
}): Promise<void> {
  if (options.response.body === null) {
    throw new CliError({
      message: 'Export response did not include a CSV stream.',
      errorCode: 'unexpected_response',
      exitCode: 1,
    });
  }

  const tmpPath = tmpPathFor(options.out);
  const writer = options.createWriteStreamImpl(tmpPath);
  const reader = options.response.body.getReader();
  let writerError: unknown;
  const onWriterError = (error: unknown): void => {
    writerError = error;
  };
  writer.on('error', onWriterError);

  try {
    await new Promise<void>((resolve, reject) => {
      writer.once('open', () => resolve());
      writer.once('error', (error) => reject(error));
    });

    while (true) {
      if (writerError !== undefined) {
        throw writerError;
      }
      const next = await reader.read();
      if (next.done) {
        break;
      }
      await new Promise<void>((resolve, reject) => {
        writer.write(next.value, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    if (writerError !== undefined) {
      throw writerError;
    }

    // Wait for 'close', not just the end callback ('finish'): the file
    // descriptor is released after finish, and renaming an open file fails on
    // Windows.
    await new Promise<void>((resolve, reject) => {
      writer.once('close', () => resolve());
      writer.end((error: Error | null | undefined) => {
        if (error) {
          reject(error);
        }
      });
    });
    if (writerError !== undefined) {
      throw writerError;
    }
  } catch (error) {
    writer.destroy();
    reader.cancel().catch(() => undefined);
    await removeTempFile(tmpPath, options.unlinkImpl);
    if (streamEndedEarly(error)) {
      throw new CliError({
        message:
          'Tracking-plan export stream ended early; no file was written.',
        errorCode: 'transport_error',
        exitCode: 5,
      });
    }
    throwCsvWriteError(options.out, error);
  } finally {
    writer.off('error', onWriterError);
  }

  try {
    await options.renameImpl(tmpPath, options.out);
  } catch (error) {
    await removeTempFile(tmpPath, options.unlinkImpl);
    throwCsvWriteError(options.out, error);
  }
}

async function streamExportToStdout(options: {
  response: Response;
  stdoutStream: EventedWritable;
}): Promise<void> {
  if (options.response.body === null) {
    throw new CliError({
      message: 'Export response did not include a CSV stream.',
      errorCode: 'unexpected_response',
      exitCode: 1,
    });
  }

  const reader = options.response.body.getReader();
  let streamError: unknown;
  const onError = (error: unknown): void => {
    streamError = error;
  };
  options.stdoutStream.on('error', onError);

  try {
    while (true) {
      if (streamError !== undefined) {
        throw streamError;
      }

      const next = await reader.read();
      if (next.done) {
        break;
      }

      const canContinue = options.stdoutStream.write(Buffer.from(next.value));
      if (!canContinue) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = (): void => {
            options.stdoutStream.off('error', onDrainError);
            resolve();
          };
          const onDrainError = (error: unknown): void => {
            options.stdoutStream.off('drain', onDrain);
            reject(error);
          };
          options.stdoutStream.once('drain', onDrain);
          options.stdoutStream.once('error', onDrainError);
        });
      }
    }
    // The last write may still be buffered; wait for it to flush so a late
    // EPIPE is handled here instead of firing after the listener is removed.
    await new Promise<void>((resolve, reject) => {
      options.stdoutStream.write('', (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (streamError !== undefined) {
      throw streamError;
    }
  } catch (error) {
    if (isEpipe(error)) {
      reader.cancel().catch(() => undefined);
      return;
    }
    if (streamEndedEarly(error)) {
      throw new CliError({
        message: 'Tracking-plan export stream ended early.',
        errorCode: 'transport_error',
        exitCode: 5,
      });
    }
    throw error;
  } finally {
    options.stdoutStream.off('error', onError);
  }
}

export function assertTrackingPlanFlags(
  verb: TrackingPlanVerb,
  flags: Record<string, FlagValue>,
): void {
  const allowed = new Set<string>(
    verb === 'export' ? TRACKING_PLAN_EXPORT_FLAGS : TRACKING_PLAN_IMPORT_FLAGS,
  );
  assertFlagsAllowed(allowed, `amp tracking-plan ${verb}`, flags);
}

function parseEventNamesFlag(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') {
    return [];
  }
  return raw
    .split(REPEATABLE_OPTION_VALUE_DELIMITER)
    .filter((value) => value.length > 0);
}

async function readEventNamesFile(
  path: string | undefined,
  readFileImpl: (path: PathLike) => Promise<Buffer>,
): Promise<string[]> {
  if (path === undefined || path === '') {
    return [];
  }
  let contents: Buffer;
  try {
    contents = await readFileImpl(path);
  } catch (error) {
    throw new CliError({
      message: `Could not read events file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      errorCode: 'file_read_failed',
      exitCode: 1,
    });
  }
  const lines = contents.toString('utf8').split(/\r?\n/u);
  if (lines.length > 0 && lines[0]?.startsWith('\uFEFF')) {
    lines[0] = lines[0].slice(1);
  }
  return lines.filter((line) => line !== '');
}

function uniqueEventNames(names: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    unique.push(name);
  }
  return unique;
}

function parseUnmatchedEventNamesHeader(value: string | null): string[] {
  if (!value) {
    return [];
  }
  const names: string[] = [];
  for (const chunk of value.split(',')) {
    const trimmed = chunk.trim();
    if (trimmed === '') {
      continue;
    }
    try {
      names.push(decodeURIComponent(trimmed));
    } catch {
      names.push(trimmed);
    }
  }
  return names;
}

function parseUnmatchedEventNamesCountHeader(
  value: string | null,
): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

export async function runTrackingPlanExport(
  flags: Record<string, FlagValue>,
  deps: TrackingPlanCommandDeps = {},
): Promise<void> {
  const projectId = stringFlag(flags, [...PROJECT_ALIASES]);
  if (projectId === undefined || projectId === '') {
    throw usageError('Missing --project <project_id>.');
  }

  const out = stringFlag(flags, ['out']);
  if (out === undefined || out === '') {
    throw usageError(
      'Missing --out <path>. Pass --out - to print CSV to stdout.',
    );
  }
  if (out === '-' && isFlagEnabled(flags.json)) {
    throw usageError(
      '--out - cannot be combined with --json. Pass --out <path> to get a JSON summary.',
    );
  }

  const exportType = parseExportType(stringFlag(flags, ['type']));
  const branchName = stringFlag(flags, ['branch-name']);
  if (branchName === '') {
    throw usageError(
      '--branch-name cannot be empty. Omit it to export the default branch.',
    );
  }
  const includeDeleted = isFlagEnabled(flags['include-deleted']);
  const write = deps.write ?? writeStdout;
  const writeErr =
    deps.writeErr ?? ((chunk: string) => process.stderr.write(chunk));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const renameImpl = deps.renameImpl ?? rename;
  const unlinkImpl = deps.unlinkImpl ?? unlink;
  const readFileImpl =
    deps.readFileImpl ??
    (async (path: PathLike): Promise<Buffer> => readFile(path));
  const createWriteStreamImpl =
    deps.createWriteStreamImpl ??
    ((path: string): EventedWritable =>
      createWriteStream(path, { flags: 'wx' }));
  const stdoutStream = deps.stdoutStream ?? process.stdout;
  const rawEventFlag = stringFlag(flags, ['event']);
  const eventsFilePath = stringFlag(flags, ['events-file']);
  const eventNamesFromFlags = parseEventNamesFlag(rawEventFlag);
  const eventNamesFromFile = await readEventNamesFile(
    eventsFilePath,
    readFileImpl,
  );
  const eventNames = uniqueEventNames([
    ...eventNamesFromFlags,
    ...eventNamesFromFile,
  ]);
  if (
    (rawEventFlag !== undefined || eventsFilePath !== undefined) &&
    eventNames.length === 0
  ) {
    throw usageError(
      '--event/--events-file must include at least one non-empty event name.',
    );
  }
  if (exportType === 'user_properties' && eventNames.length > 0) {
    throw usageError(
      '--event and --events-file are only supported with --type events.',
    );
  }

  const auth = await resolveAuthWithRefresh(flags);
  const baseUrl = `${auth.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/tracking-plan/export`;
  const response =
    eventNames.length > 0
      ? await sendAuthenticatedRequest({
          auth,
          url: baseUrl,
          method: 'POST',
          accept: 'text/csv',
          body: JSON.stringify({
            type: exportType,
            branch_name: branchName,
            include_deleted: includeDeleted,
            event_names: eventNames,
            strict: false,
          }),
          contentType: 'application/json',
          fetchImpl,
        })
      : await sendAuthenticatedRequest({
          auth,
          url: `${baseUrl}?${new URLSearchParams({
            type: exportType,
            ...(branchName ? { branch_name: branchName } : {}),
            ...(includeDeleted ? { include_deleted: 'true' } : {}),
          }).toString()}`,
          method: 'GET',
          accept: 'text/csv',
          fetchImpl,
        });

  if (!response.ok) {
    const responseBody = parseResponseBody(await response.text());
    throw parseExportError(response, responseBody, projectId);
  }
  const unmatchedEventNames = parseUnmatchedEventNamesHeader(
    response.headers.get('x-unmatched-event-names'),
  );
  const unmatchedEventNameCount = parseUnmatchedEventNamesCountHeader(
    response.headers.get('x-unmatched-event-count'),
  );
  const unmatchedEventNamesTruncated =
    response.headers.get('x-unmatched-event-names-truncated') === 'true';
  if (unmatchedEventNames.length > 0) {
    writeErr(`Unmatched event names: ${unmatchedEventNames.join(', ')}\n`);
  } else if ((unmatchedEventNameCount ?? 0) > 0) {
    writeErr(
      `Unmatched event names: ${unmatchedEventNameCount} total (header list omitted)\n`,
    );
  }
  if (unmatchedEventNamesTruncated) {
    const total = unmatchedEventNameCount ?? unmatchedEventNames.length;
    writeErr(`Unmatched event names list truncated (${total} total).\n`);
  }

  if (out === '-') {
    await streamExportToStdout({ response, stdoutStream });
    return;
  }

  await streamExportToFile({
    response,
    out,
    createWriteStreamImpl,
    renameImpl,
    unlinkImpl,
  });

  const useJson = shouldUseJsonOutput({
    jsonFlag: isFlagEnabled(flags.json),
    isTTY,
  });
  if (useJson) {
    write(
      `${formatJsonOutput(
        {
          data: {
            project_id: projectId,
            type: exportType,
            branch_name: branchName,
            include_deleted: includeDeleted,
            out,
          },
        },
        isTTY,
      )}\n`,
    );
    return;
  }

  write(`Exported tracking-plan CSV to ${out}\n`);
}

function parseImportError(response: Response, responseBody: unknown): CliError {
  const problem = asProblem(responseBody);
  const branch = importBranchFromBody(responseBody);
  if (response.status === 409) {
    const detail =
      problem?.detail ??
      'The requested branch name already exists. Choose another --branch-name value.';
    const errorCode = problem?.error_code ?? 'conflict';
    return new CliError({
      message: `Import branch name conflict: ${detail}`,
      errorCode,
      exitCode: exitCodeForErrorCode(errorCode, 409),
      httpStatus: 409,
      detail,
      hint: 'Retry with a different --branch-name, or omit it to auto-generate one.',
      retryable: problem?.retryable,
    });
  }
  if (response.status === 413) {
    const serverDetail = problem?.detail ?? 'The CSV file is too large.';
    const errorCode = problem?.error_code ?? 'payload_too_large';
    return new CliError({
      message: `Tracking-plan import rejected: ${serverDetail} Maximum file size is 50 MB.`,
      errorCode,
      exitCode: exitCodeForErrorCode(errorCode, 413, problem?.retryable),
      httpStatus: 413,
      detail: `${serverDetail} Maximum file size is 50 MB.`,
      hint: 'Reduce the CSV size to 50 MB or less and retry.',
      retryable: false,
    });
  }

  const nonRetryableServerFailure =
    response.status === 504 ||
    (response.status >= 500 &&
      (problem?.retryable === false || branch !== undefined));
  if (nonRetryableServerFailure) {
    const errorCode = problem?.error_code ?? 'upstream_error';
    const rawDetail =
      problem?.detail ?? `Request failed with HTTP ${response.status}`;
    const detail = normalizeSentence(rawDetail);
    const branchMessage =
      branch === undefined ? '' : ` Import branch: ${branchLabel(branch)}.`;
    return new CliError({
      message: `Tracking-plan import did not complete cleanly: ${detail}.${branchMessage}`,
      errorCode,
      exitCode: 1,
      httpStatus: response.status,
      detail,
      hint: 'Check the project branches for an existing import branch before retrying. Do not immediately retry: a second run can create a duplicate branch.',
      retryable: false,
    });
  }

  const error = cliErrorFromResponse(
    response.status,
    response.statusText,
    responseBody,
  );
  if (branch !== undefined) {
    const label = branchLabel(branch);
    error.message = `${normalizeSentence(error.message)}. Import branch created: ${label}.`;
    error.hint = [
      error.hint,
      `Review or delete branch ${label} before retrying to avoid duplicates.`,
    ]
      .filter((value) => value !== undefined && value !== '')
      .join('\n\n');
  }
  return error;
}

function parseImportCounters(value: unknown): ImportCounters | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.created !== 'number' || typeof value.updated !== 'number') {
    return undefined;
  }
  if (typeof value.removed === 'number') {
    return {
      created: value.created,
      updated: value.updated,
      thirdLabel: 'removed',
      thirdValue: value.removed,
    };
  }
  if (typeof value.unmapped === 'number') {
    return {
      created: value.created,
      updated: value.updated,
      thirdLabel: 'unmapped',
      thirdValue: value.unmapped,
    };
  }
  return undefined;
}

function importResponseData(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new CliError({
      message: 'Unexpected tracking-plan import response format.',
      errorCode: 'unexpected_response',
      exitCode: 1,
    });
  }
  const data = body.data;
  if (!isRecord(data)) {
    throw new CliError({
      message: 'Unexpected tracking-plan import response format.',
      errorCode: 'unexpected_response',
      exitCode: 1,
    });
  }
  return data;
}

function importCountsByType(
  data: Record<string, unknown>,
): Array<[string, ImportCounters]> {
  const importType =
    data.import_type === 'user_properties' ? 'user_properties' : 'events';
  const labels: Array<[string, string]> =
    importType === 'user_properties'
      ? [['user_properties', 'User properties']]
      : [
          ['templates', 'Templates'],
          ['template_properties', 'Template properties'],
          ['events', 'Events'],
          ['event_properties', 'Event properties'],
        ];

  const breakdown = data.breakdown;
  const rows: Array<[string, ImportCounters]> = [];
  if (isRecord(breakdown)) {
    for (const [key, label] of labels) {
      const counters = parseImportCounters(breakdown[key]);
      if (counters !== undefined) {
        rows.push([label, counters]);
      }
    }
  }
  return rows;
}

function importTotalLines(data: Record<string, unknown>): string[] {
  const importType =
    data.import_type === 'user_properties' ? 'user_properties' : 'events';
  if (importType === 'user_properties') {
    const userTotal =
      typeof data.user_property_count === 'number'
        ? data.user_property_count
        : 0;
    return [`  User properties total: ${userTotal}`];
  }

  const eventTotal =
    typeof data.event_count === 'number' ? data.event_count : 0;
  const templateTotal =
    typeof data.template_count === 'number' ? data.template_count : 0;
  return [
    `  Events total: ${eventTotal}`,
    `  Templates total: ${templateTotal}`,
  ];
}

function importCreatedBranchLine(data: Record<string, unknown>): string {
  const branchName = data.branch_name;
  const branchId = data.branch_id;
  if (typeof branchId !== 'string' || branchId === '') {
    throw new CliError({
      message:
        'Unexpected tracking-plan import response: missing branch identifier.',
      errorCode: 'unexpected_response',
      exitCode: 1,
    });
  }
  if (typeof branchName === 'string' && branchName !== '') {
    return `Created branch: ${branchName} (${branchId})`;
  }
  return `Created branch: ${branchId}`;
}

export async function runTrackingPlanImport(
  flags: Record<string, FlagValue>,
  deps: TrackingPlanCommandDeps = {},
): Promise<void> {
  const projectId = stringFlag(flags, [...PROJECT_ALIASES]);
  if (projectId === undefined || projectId === '') {
    throw usageError('Missing --project <project_id>.');
  }
  const filePath = stringFlag(flags, ['file']);
  if (filePath === undefined || filePath === '') {
    throw usageError('Missing --file <path>.');
  }
  const branchName = stringFlag(flags, ['branch-name']);
  if (branchName === '') {
    throw usageError(
      '--branch-name cannot be empty. Omit it to auto-generate a branch name.',
    );
  }

  const readFileImpl =
    deps.readFileImpl ??
    (async (path: PathLike): Promise<Buffer> => readFile(path));
  const statImpl =
    deps.statImpl ??
    (async (path: PathLike): Promise<{ size: number }> => stat(path));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const write = deps.write ?? writeStdout;
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);

  let fileStats;
  try {
    fileStats = await statImpl(filePath);
  } catch (error) {
    throwCsvReadError(filePath, error);
  }
  if (fileStats.size === 0) {
    throw usageError('CSV file is empty. Pass a non-empty file.');
  }
  if (fileStats.size > MAX_IMPORT_BODY_BYTES) {
    throw usageError(
      'CSV file is larger than 50 MB. Reduce the file size before importing.',
    );
  }

  let csvBody: Buffer;
  try {
    csvBody = await readFileImpl(filePath);
  } catch (error) {
    throwCsvReadError(filePath, error);
  }

  const query = new URLSearchParams();
  if (branchName !== undefined) {
    query.set('branch_name', branchName);
  }
  const queryString = query.toString();
  const path = `/v1/projects/${encodeURIComponent(projectId)}/tracking-plan/import`;

  const auth = await resolveAuthWithRefresh(flags);
  const response = await sendAuthenticatedRequest({
    auth,
    url:
      queryString === ''
        ? `${auth.baseUrl}${path}`
        : `${auth.baseUrl}${path}?${queryString}`,
    method: 'POST',
    accept: 'application/json',
    body: csvBody,
    contentType: 'text/csv',
    fetchImpl,
    importSafeRetryHint: true,
  });

  const rawBody = await response.text();
  const responseBody = parseResponseBody(rawBody);
  if (!response.ok) {
    throw parseImportError(response, responseBody);
  }

  const useJson = shouldUseJsonOutput({
    jsonFlag: isFlagEnabled(flags.json),
    isTTY,
  });
  if (useJson) {
    write(`${formatJsonOutput(responseBody, isTTY)}\n`);
    return;
  }

  const data = importResponseData(responseBody);
  const rows = importCountsByType(data);
  const lines = [importCreatedBranchLine(data), 'Import counts:'];
  if (rows.length === 0) {
    lines.push(...importTotalLines(data));
  } else {
    for (const [label, counters] of rows) {
      lines.push(
        `  ${label}: created ${counters.created}, updated ${counters.updated}, ${counters.thirdLabel} ${counters.thirdValue}`,
      );
    }
  }
  lines.push(
    'Review and merge this branch in Amplitude Data (Branches) after validating the import.',
  );
  write(`${lines.join('\n')}\n`);
}
