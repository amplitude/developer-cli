import { z } from 'zod';

import type { FlagValue } from './args';
import type { CatalogFlag } from './catalog';
import { problemDetailsSchema } from './errors';
import { normalizeWhitespace } from './output';

export const PROJECT_API_KEY_OPERATION_ID = 'getProjectApiKey';

export const PROJECT_API_KEY_RAW_FLAG = {
  name: 'raw',
  aliases: ['raw'],
  type: 'boolean',
  required: false,
  description:
    'Print only the ingestion API key. Cannot be combined with --json.',
} satisfies CatalogFlag;

const projectIdSchema = z.string().regex(/^[1-9][0-9]*$/);
const booleanFlagSchema = z
  .union([z.boolean(), z.literal('true'), z.literal('false')])
  .optional();

const projectApiKeyResourceSchema = z.object({
  object: z.literal('project_api_key'),
  project_id: projectIdSchema,
  project_name: z.string().nullable(),
  api_key: z.string().min(1),
});
const projectApiKeyResponseSchema = z.object({
  data: projectApiKeyResourceSchema,
});

// This credential read accepts diagnostics only from a complete API problem.
const projectApiKeyProblemSchema = problemDetailsSchema.extend({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  error_code: z.string(),
  retryable: z.boolean(),
});

export function parseProjectApiKeyProblem(body: unknown) {
  return projectApiKeyProblemSchema.safeParse(body);
}

export type ProjectApiKeyResource = z.infer<typeof projectApiKeyResourceSchema>;

type InvalidOptions = {
  ok: false;
  issue: { kind: 'invalid_options'; message: string };
};

export function resolveProjectApiKeyOptions(
  flags: Record<string, FlagValue>,
): { ok: true; options: { raw: boolean } } | InvalidOptions {
  const projectId = flags.project ?? flags['project-id'] ?? flags.project_id;
  if (!projectIdSchema.optional().safeParse(projectId).success) {
    return {
      ok: false,
      issue: {
        kind: 'invalid_options',
        message: 'Expected --project to be a positive integer project ID.',
      },
    };
  }

  const parsedRaw = booleanFlagSchema.safeParse(flags.raw);
  if (!parsedRaw.success) {
    return {
      ok: false,
      issue: {
        kind: 'invalid_options',
        message: 'Expected --raw to be a boolean.',
      },
    };
  }
  const raw = parsedRaw.data === true || parsedRaw.data === 'true';
  if (raw && (flags.json === true || flags.json === 'true')) {
    return {
      ok: false,
      issue: {
        kind: 'invalid_options',
        message: '--raw cannot be combined with --json.',
      },
    };
  }
  return { ok: true, options: { raw } };
}

export function parseProjectApiKeyResponse(body: unknown):
  | { ok: true; resource: ProjectApiKeyResource }
  | {
      ok: false;
      issue: { kind: 'invalid_response'; message: string };
    } {
  const result = projectApiKeyResponseSchema.safeParse(body);
  return result.success
    ? { ok: true, resource: result.data.data }
    : {
        ok: false,
        issue: {
          kind: 'invalid_response',
          message: 'The API returned an invalid project API key response.',
        },
      };
}

export function formatProjectApiKeyOutput(
  resource: ProjectApiKeyResource,
): string {
  const name = resource.project_name
    ? normalizeWhitespace(resource.project_name)
    : '';
  const label = name ? `${name} (${resource.project_id})` : resource.project_id;
  return `Project: ${label}\nAPI key: ${resource.api_key}`;
}
