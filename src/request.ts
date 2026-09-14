import { randomUUID } from 'node:crypto';

import {
  type FlagValue,
  apiGlobalOptionAliases,
  flagValue,
  hasFlag,
  isMissingRequiredValue,
  nearestAlias,
  stringFlag,
} from './args';
import { usageError } from './cli-error';
import type { CliBodyProperty, CliOperation } from './generated/cli-manifest';
import { jsonRecordSchema } from './schemas';

export type QueryValue = boolean | number | string | null | undefined;

export interface BuiltRequest {
  body?: Record<string, unknown>;
  headers: Record<string, string>;
  path: string;
}

export function operationSupportsDryRun(operation: CliOperation): boolean {
  return operation.parameters.some((parameter) => parameter.name === 'dry_run');
}

export function parseResponseBody(responseBody: string): unknown {
  if (!responseBody) {
    return null;
  }

  try {
    return JSON.parse(responseBody) as unknown;
  } catch {
    return responseBody;
  }
}

function parseScalar(
  value: FlagValue,
  type: string,
  nullable: boolean,
): QueryValue {
  if (nullable && value === 'null') {
    return null;
  }

  if (type === 'boolean') {
    if (typeof value === 'boolean') {
      return value;
    }
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    throw usageError(`Expected boolean value, got ${value}.`);
  }

  if (typeof value === 'boolean') {
    throw usageError(`Expected ${type} value, got ${value}.`);
  }

  if (type === 'integer' || type === 'number') {
    const parsed = Number(value);
    if (
      !Number.isFinite(parsed) ||
      (type === 'integer' && !Number.isInteger(parsed))
    ) {
      throw usageError(`Expected ${type} value, got ${value}.`);
    }
    return parsed;
  }

  return value;
}

// A raw JSON.parse throws a SyntaxError, which escapes as a generic error/exit
// 1; a malformed inline JSON value is a local input mistake, so classify it as
// a usage error (exit 2) that names the flag it came from.
function parseJsonFlag(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw usageError(`${label} must be valid JSON.`);
  }
}

function parseBodyValue(
  property: CliBodyProperty,
  value: FlagValue,
): QueryValue | QueryValue[] | Record<string, unknown> {
  if (property.nullable && value === 'null') {
    return null;
  }

  if (typeof value === 'boolean') {
    return parseScalar(value, property.type, property.nullable);
  }

  if (property.enum && !property.enum.includes(value)) {
    throw usageError(
      `Invalid --${property.aliases[0]} ${value}. Allowed: ${property.enum.join(', ')}.`,
    );
  }

  if (property.type === 'array') {
    if (value.startsWith('[')) {
      return parseJsonFlag(value, `--${property.aliases[0]}`) as QueryValue[];
    }
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (property.type === 'object') {
    return parseJsonFlag(value, `--${property.aliases[0]}`) as Record<
      string,
      unknown
    >;
  }

  return parseScalar(value, property.type, property.nullable);
}

function parseBodyJson(
  flags: Record<string, FlagValue>,
): Record<string, unknown> {
  const raw = stringFlag(flags, ['body-json']);
  if (raw === undefined) {
    return {};
  }
  if (raw.trim() === '') {
    throw usageError('--body-json must be a JSON object.');
  }

  const result = jsonRecordSchema.safeParse(parseJsonFlag(raw, '--body-json'));
  if (!result.success) {
    throw usageError('--body-json must be a JSON object.');
  }

  return result.data;
}

function withQuery(path: string, query: Record<string, QueryValue>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  const queryString = params.toString();

  return queryString ? `${path}?${queryString}` : path;
}

function allowedAliases(operation: CliOperation): Set<string> {
  const aliases = new Set<string>(
    apiGlobalOptionAliases(operation.authentication),
  );
  for (const parameter of operation.parameters) {
    for (const alias of parameter.aliases) {
      aliases.add(alias);
    }
  }
  for (const property of operation.body) {
    for (const alias of property.aliases) {
      aliases.add(alias);
    }
  }
  return aliases;
}

/**
 * Flags parse successfully against the global commander option set even when
 * they belong to a different command (all flags are defined globally, see
 * args.ts). Left unchecked, a flag meant for another command — e.g. --key on
 * `flags list` — parses fine and is then silently dropped by the loop below,
 * which only reads this operation's own parameters/body. Reject anything not
 * valid for the resolved command before that can happen.
 *
 * Shared by both dispatch paths: API operations (via {@link assertKnownFlags},
 * allowed = globals ∪ the operation's manifest-declared flags) and the
 * bespoke auth/logout commands in cli.ts (allowed = globals ∪ that command's
 * catalog-declared flags), so both reject a misplaced/unknown flag the same
 * way instead of the auth/logout path silently dropping it.
 */
export function assertFlagsAllowed(
  allowed: Set<string>,
  commandLabel: string,
  flags: Record<string, FlagValue>,
): void {
  for (const key of Object.keys(flags)) {
    if (allowed.has(key)) {
      continue;
    }

    const suggestion = nearestAlias(key, allowed);
    const hint = suggestion ? ` Did you mean --${suggestion}?` : '';
    throw usageError(`Unknown flag --${key} for \`${commandLabel}\`.${hint}`);
  }
}

export function assertKnownFlags(
  operation: CliOperation,
  flags: Record<string, FlagValue>,
): void {
  assertFlagsAllowed(
    allowedAliases(operation),
    `amp ${operation.command.join(' ')}`,
    flags,
  );
}

export function buildRequest(
  operation: CliOperation,
  flags: Record<string, FlagValue>,
): BuiltRequest {
  assertKnownFlags(operation, flags);

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const query: Record<string, QueryValue> = {};
  let path = operation.path;

  for (const parameter of operation.parameters) {
    const raw = flagValue(flags, parameter.aliases);
    if (
      parameter.required &&
      isMissingRequiredValue(raw) &&
      parameter.in !== 'header'
    ) {
      throw usageError(
        `Missing --${parameter.aliases[0]} <${parameter.name}>.`,
      );
    }

    if (parameter.in === 'path') {
      if (typeof raw === 'boolean') {
        throw usageError(`Expected --${parameter.aliases[0]} to have a value.`);
      }
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(raw ?? ''));
    } else if (parameter.in === 'query' && raw !== undefined) {
      query[parameter.name] = parseScalar(raw, parameter.type, true);
    } else if (parameter.in === 'header') {
      if (parameter.name === 'Idempotency-Key') {
        headers[parameter.name] =
          typeof raw === 'string'
            ? raw
            : `api-cli-${operation.operationId}-${randomUUID()}`;
      } else if (typeof raw === 'string') {
        headers[parameter.name] = raw;
      } else if (raw !== undefined) {
        throw usageError(`Expected --${parameter.aliases[0]} to have a value.`);
      }
    }
  }

  const body = parseBodyJson(flags);
  if (operation.body.length === 0 && Object.keys(body).length > 0) {
    throw usageError(
      `\`amp ${operation.command.join(' ')}\` does not accept a request body.`,
    );
  }

  for (const property of operation.body) {
    const raw = flagValue(flags, property.aliases);
    if (property.required && raw === '') {
      throw usageError(`Missing --${property.aliases[0]} <${property.name}>.`);
    }
    if (
      property.required &&
      raw === undefined &&
      !hasFlag(flags, ['body-json'])
    ) {
      throw usageError(`Missing --${property.aliases[0]} <${property.name}>.`);
    }

    if (raw !== undefined) {
      body[property.name] = parseBodyValue(property, raw);
    }
  }

  if (operation.body.length > 0) {
    headers['Content-Type'] = 'application/json';
  }

  return {
    body:
      operation.body.length > 0 || Object.keys(body).length > 0
        ? body
        : undefined,
    headers,
    path: withQuery(path, query),
  };
}
