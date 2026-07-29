import type { CliOperation } from './generated/cli-manifest';
import { jsonRecordSchema } from './schemas';

type Row = Record<string, string>;

const DEFAULT_CELL_WIDTH = 40;
const COLUMN_WIDTHS: Record<string, number> = {
  description: 80,
  display_name: 40,
  event_type: 40,
  name: 40,
};

function isListOperation(operation: CliOperation): boolean {
  return operation.operationId.startsWith('list');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  const result = jsonRecordSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function cellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeCell(value: string): string {
  return normalizeWhitespace(value);
}

function maxWidth(column: string): number {
  return COLUMN_WIDTHS[column] ?? DEFAULT_CELL_WIDTH;
}

function truncateCell(value: string, column: string): string {
  const normalized = normalizeCell(value);
  const width = maxWidth(column);
  if (normalized.length <= width) {
    return normalized;
  }

  return `${normalized.slice(0, width - 1)}…`;
}

function dropDuplicateColumns(rows: Row[], columns: string[]): string[] {
  const kept: string[] = [];
  for (const column of columns) {
    const duplicatesKept = kept.some((keptColumn) =>
      rows.every((row) => (row[keptColumn] ?? '') === (row[column] ?? '')),
    );
    if (!duplicatesKept) {
      kept.push(column);
    }
  }

  return kept;
}

function pickColumns(rows: Row[]): string[] {
  const preferred = [
    'id',
    'key',
    'name',
    'display_name',
    'event_type',
    'enabled',
    'archived',
    'is_active',
    'description',
  ];

  const available = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      available.add(key);
    }
  }

  // Taxonomy rows routinely repeat one value across id / event_type /
  // display_name (and key / name); collapse those so neither humans nor agents
  // pay to read the same string two or three times.
  const columns = preferred.filter((column) => available.has(column));
  if (columns.length > 0) {
    return dropDuplicateColumns(rows, columns).slice(0, 5);
  }

  return dropDuplicateColumns(rows, Array.from(available)).slice(0, 4);
}

function formatTable(rows: Row[], columns: string[]): string {
  const displayRows = rows.map((row) =>
    Object.fromEntries(
      columns.map((column) => [
        column,
        truncateCell(row[column] ?? '', column),
      ]),
    ),
  );
  const widths = columns.map((column) =>
    Math.max(
      column.length,
      ...displayRows.map((row) => (row[column] ?? '').length),
    ),
  );

  const header = columns
    .map((column, index) => column.toUpperCase().padEnd(widths[index] ?? 0))
    .join('  ')
    .trimEnd();

  const body = displayRows
    .map((row) =>
      columns
        .map((column, index) => (row[column] ?? '').padEnd(widths[index] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');

  return `${header}\n${body}`;
}

function formatContextSummary(body: Record<string, unknown>): string {
  const data = asRecord(body.data);
  const principal = data ? asRecord(data.principal) : undefined;
  const org = data ? asRecord(data.org) : undefined;
  const scopes = Array.isArray(principal?.scopes)
    ? principal.scopes.map(String)
    : [];

  const lines = ['Authenticated context:'];
  if (principal?.login_id) {
    lines.push(`  User: ${principal.login_id}`);
  }
  if (org?.name || org?.id) {
    const orgLabel = org.name ?? org.id;
    const orgId = org.id ? ` (${org.id})` : '';
    lines.push(`  Org:  ${orgLabel}${orgId}`);
  }
  if (principal?.auth_type) {
    lines.push(`  Auth: ${principal.auth_type}`);
  }
  if (scopes.length > 0) {
    lines.push(`  Scopes: ${scopes.join(', ')}`);
  }

  return lines.join('\n');
}

function formatListTable(
  body: Record<string, unknown>,
  pagination?: Record<string, unknown>,
): string {
  const items = Array.isArray(body.data) ? body.data : [];
  const rows = items
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((item) =>
      Object.fromEntries(
        Object.entries(item).map(([key, value]) => [key, cellValue(value)]),
      ),
    );

  if (rows.length === 0) {
    return 'No results.';
  }

  const columns = pickColumns(rows);
  const lines = [formatTable(rows, columns)];

  if (pagination?.has_more === true) {
    const cursor =
      typeof pagination.next_cursor === 'string'
        ? pagination.next_cursor
        : undefined;
    lines.push('');
    lines.push(
      cursor
        ? `More results available. Use --cursor ${cursor}`
        : 'More results available. Use --cursor to continue.',
    );
  }

  return lines.join('\n');
}

export function shouldUseJsonOutput(options: {
  jsonFlag?: boolean;
  isTTY: boolean;
}): boolean {
  if (options.jsonFlag === true) {
    return true;
  }

  return !options.isTTY;
}

export function isNoContentSuccess(status: number, parsed: unknown): boolean {
  return parsed === null && status === 204;
}

export function formatNoContentSuccess(operation: CliOperation): string {
  const verb = operation.command.at(-1);
  if (verb === 'archive') {
    return 'Archived.';
  }

  return 'Deleted.';
}

export function formatJsonOutput(payload: unknown, isTTY: boolean): string {
  return isTTY ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

export function formatSuccessOutput(
  body: unknown,
  operation: CliOperation,
): string {
  const record = asRecord(body);
  if (!record) {
    return JSON.stringify(body, null, 2);
  }

  if (operation.command.length === 1 && operation.command[0] === 'context') {
    return formatContextSummary(record);
  }

  if (isListOperation(operation) && Array.isArray(record.data)) {
    const pagination = asRecord(record.pagination);
    return formatListTable(record, pagination);
  }

  return JSON.stringify(body, null, 2);
}
