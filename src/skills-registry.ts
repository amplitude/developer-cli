import { z } from 'zod';

import { type FlagValue, stringFlag } from './args';
import {
  CliError,
  exitCodeForErrorCode,
  transportError,
  usageError,
} from './cli-error';
import { deviceIdHeader } from './client-identity';
import { DEFAULT_API_BASE_URL, resolveNamedBaseUrl } from './config';
import { loadStore } from './credential-store';
import { asProblem } from './errors';
import { CLI_VERSION } from './help';

export interface SkillIndexEntry {
  name: string;
  description: string;
}

const skillIndexResponseSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    }),
  ),
});
const SKILLS_LIST_TRANSPORT_HINT =
  'Check network connectivity and retry. Inspect the active profile endpoint with `amp auth status` or switch profiles with `amp auth use <profile>`.';
const SKILLS_GET_TRANSPORT_HINT =
  'Check network connectivity and retry. If the endpoint is wrong, pass --region <us|eu>.';
const SKILLS_INDEX_NOT_FOUND_HINT =
  'Inspect the active profile endpoint with `amp auth status` or switch profiles with `amp auth use <profile>`.';

export interface RegistryDeps {
  path?: string;
}

function defaultProfileBaseUrl(path: string | undefined): string | undefined {
  const store = loadStore(path);
  return store.default === undefined
    ? undefined
    : store.profiles[store.default]?.base_url;
}

function stripTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

export function resolveSkillsListBaseUrl(
  flags: Record<string, FlagValue>,
  deps: RegistryDeps = {},
): string {
  const explicit = resolveNamedBaseUrl({
    envFlag: stringFlag(flags, ['env']),
    regionFlag: stringFlag(flags, ['region']),
  });
  return stripTrailingSlash(
    explicit ?? defaultProfileBaseUrl(deps.path) ?? DEFAULT_API_BASE_URL,
  );
}

export function resolveSkillsGetBaseUrl(
  flags: Record<string, FlagValue>,
  deps: RegistryDeps = {},
): string {
  const explicit = resolveNamedBaseUrl({
    envFlag: stringFlag(flags, ['env']),
    regionFlag: stringFlag(flags, ['region']),
  });
  const resolved = explicit ?? defaultProfileBaseUrl(deps.path);

  if (resolved === undefined) {
    throw usageError(
      'No default profile is configured. Pass --region <us|eu>.',
    );
  }

  return stripTrailingSlash(resolved);
}

async function get(url: string, hint: string): Promise<Response> {
  try {
    // `parseApiClient` on the server reads the leading `product/version` token
    // into analytics dimensions, so this is what makes retrievals attributable
    // to a CLI version. Matches the header authToken.ts already sends.
    return await fetch(url, {
      headers: {
        Accept: '*/*',
        'User-Agent': `amp-cli/${CLI_VERSION}`,
        ...deviceIdHeader(),
      },
    });
  } catch {
    throw transportError(
      `Could not reach the skills registry at ${url}.`,
      hint,
    );
  }
}

type RegistryRequest =
  | { kind: 'index'; url: string }
  | { kind: 'document'; name: string };

function errorFromResponse(
  status: number,
  body: string,
  request: RegistryRequest,
): CliError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const problem = asProblem(parsed);

  if (status === 404 && request.kind === 'document') {
    return new CliError({
      message: problem?.detail ?? `No skill named "${request.name}".`,
      errorCode: 'not_found',
      exitCode: exitCodeForErrorCode('not_found', status),
      httpStatus: status,
      hint: 'Run `amp skills list` to see what is available.',
    });
  }

  if (status === 404 && request.kind === 'index') {
    return new CliError({
      message: `The skills registry index at ${request.url} returned HTTP 404.`,
      errorCode: 'upstream_error',
      exitCode: exitCodeForErrorCode('upstream_error'),
      httpStatus: status,
      hint: SKILLS_INDEX_NOT_FOUND_HINT,
    });
  }

  return new CliError({
    message: problem?.detail ?? `The skills registry returned HTTP ${status}.`,
    errorCode: 'upstream_error',
    exitCode: exitCodeForErrorCode('upstream_error', status),
    httpStatus: status,
  });
}

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export async function fetchSkillIndex(
  baseUrl: string,
): Promise<SkillIndexEntry[]> {
  const url = `${baseUrl}/v1/skills`;
  const response = await get(url, SKILLS_LIST_TRANSPORT_HINT);
  const body = await response.text();

  if (!response.ok) {
    throw errorFromResponse(response.status, body, { kind: 'index', url });
  }

  const parsed = skillIndexResponseSchema.safeParse(tryParseJson(body));
  if (!parsed.success) {
    throw new CliError({
      message: `The skills registry at ${url} returned an unexpected response.`,
      errorCode: 'upstream_error',
      exitCode: exitCodeForErrorCode('upstream_error'),
    });
  }

  return parsed.data.data;
}

function isMarkdown(contentType: string | null): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'text/markdown';
}

export async function fetchSkillDocument(
  baseUrl: string,
  name: string,
): Promise<string> {
  const url = `${baseUrl}/v1/skills/${encodeURIComponent(name)}`;
  const response = await get(url, SKILLS_GET_TRANSPORT_HINT);
  const body = await response.text();

  if (!response.ok) {
    throw errorFromResponse(response.status, body, {
      kind: 'document',
      name,
    });
  }

  // `amp skills get X > SKILL.md` writes whatever arrives, and an agent then
  // follows it as a procedure. A captive portal or proxy interstitial answers
  // 200 with an HTML login page, so the media type is the only thing separating
  // a skill from someone else's document.
  if (!isMarkdown(response.headers.get('content-type'))) {
    throw new CliError({
      message: `The skills registry at ${url} returned ${response.headers.get('content-type') ?? 'no content type'} instead of text/markdown.`,
      errorCode: 'upstream_error',
      exitCode: exitCodeForErrorCode('upstream_error'),
    });
  }

  return body;
}
