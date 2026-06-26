import { CLI_OPERATIONS } from './generated/cli-manifest';

// Legacy org-level scopes. They map to the granular API read/write scopes
// server-side, but the device-flow client can grant them directly, so include
// them in the default request for full coverage. Added explicitly because no
// CLI command declares them as required.
const MCP_SCOPES = ['mcp:read', 'mcp:write'];

/**
 * The scope set a login requests when no `--scope` is given. The granular
 * `read:`/`write:` scopes come from the generated manifest, so the default
 * tracks the command surface automatically; the MCP scopes are appended.
 * Sorted and de-duped for deterministic output.
 */
export const DEFAULT_SCOPES: string = [
  ...new Set([
    ...CLI_OPERATIONS.flatMap((operation) => operation.requiredScopes),
    ...MCP_SCOPES,
  ]),
]
  .sort()
  .join(' ');
