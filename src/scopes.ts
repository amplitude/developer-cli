import { CLI_OPERATIONS } from './generated/cli-manifest';
// Legacy org-level scopes, generated from the central OAuth scope catalog.
// They map to the granular API read/write scopes server-side, but the
// device-flow client can grant them directly, so include them in the default
// request for full coverage. No CLI command declares them as required.
import { MCP_BASE_SCOPES } from './generated/scopes';

/**
 * Scopes declared in the OpenAPI manifest but not yet registered on the
 * device-flow OAuth client. Requesting these during login makes Hydra reject
 * the whole authorization. Remove entries here once MCP-396 registers them.
 */
const LOGIN_SCOPE_EXCLUSIONS = new Set(['read:analytics']);

/**
 * The scope set a login requests when no `--scope` is given. The granular
 * `read:`/`write:` scopes come from the generated manifest, so the default
 * tracks the command surface automatically; the MCP scopes are appended.
 * Sorted and de-duped for deterministic output.
 */
export const DEFAULT_SCOPES: string = [
  ...new Set([
    ...CLI_OPERATIONS.flatMap((operation) => operation.requiredScopes),
    ...MCP_BASE_SCOPES,
  ]),
]
  .filter((scope) => !LOGIN_SCOPE_EXCLUSIONS.has(scope))
  .sort()
  .join(' ');
