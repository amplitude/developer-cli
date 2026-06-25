import { randomUUID } from 'node:crypto';

import {
  type FlagValue,
  flagValue,
  hasFlag,
  isMissingRequiredValue,
  stringFlag,
} from './args';
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
    throw new Error(`Expected boolean value, got ${value}.`);
  }

  if (typeof value === 'boolean') {
    throw new Error(`Expected ${type} value, got ${value}.`);
  }

  if (type === 'integer' || type === 'number') {
    const parsed = Number(value);
    if (
      !Number.isFinite(parsed) ||
      (type === 'integer' && !Number.isInteger(parsed))
    ) {
      throw new Error(`Expected ${type} value, got ${value}.`);
    }
    return parsed;
  }

  return value;
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
    throw new Error(
      `Invalid --${property.aliases[0]} ${value}. Allowed: ${property.enum.join(', ')}.`,
    );
  }

  if (property.type === 'array') {
    if (value.startsWith('[')) {
      return JSON.parse(value) as QueryValue[];
    }
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (property.type === 'object') {
    return JSON.parse(value) as Record<string, unknown>;
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
    throw new Error('--body-json must be a JSON object.');
  }

  const result = jsonRecordSchema.safeParse(JSON.parse(raw));
  if (!result.success) {
    throw new Error('--body-json must be a JSON object.');
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

export function buildRequest(
  operation: CliOperation,
  flags: Record<string, FlagValue>,
  authorizationHeader: string,
): BuiltRequest {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: authorizationHeader,
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
      throw new Error(`Missing --${parameter.aliases[0]} <${parameter.name}>.`);
    }

    if (parameter.in === 'path') {
      if (typeof raw === 'boolean') {
        throw new Error(`Expected --${parameter.aliases[0]} to have a value.`);
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
        throw new Error(`Expected --${parameter.aliases[0]} to have a value.`);
      }
    }
  }

  const body = parseBodyJson(flags);
  if (operation.body.length === 0 && Object.keys(body).length > 0) {
    throw new Error(
      `\`amp ${operation.command.join(' ')}\` does not accept a request body.`,
    );
  }

  for (const property of operation.body) {
    const raw = flagValue(flags, property.aliases);
    if (property.required && raw === '') {
      throw new Error(`Missing --${property.aliases[0]} <${property.name}>.`);
    }
    if (
      property.required &&
      raw === undefined &&
      !hasFlag(flags, ['body-json'])
    ) {
      throw new Error(`Missing --${property.aliases[0]} <${property.name}>.`);
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
