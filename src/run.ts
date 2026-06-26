/* eslint-disable no-console */
import { type FlagValue, isFlagEnabled } from './args';
import {
  authorizationHeaderForToken,
  resolveAuthFromFlags,
} from './credential-resolver';
import { formatApiError } from './errors';
import type { CliOperation } from './generated/cli-manifest';
import {
  formatJsonOutput,
  formatNoContentSuccess,
  formatSuccessOutput,
  isNoContentSuccess,
  shouldUseJsonOutput,
} from './output';
import { confirm } from './prompt';
import {
  buildRequest,
  operationSupportsDryRun,
  parseResponseBody,
} from './request';

export type DeleteGateDecision = 'block' | 'confirm' | 'proceed';

/**
 * Decides whether a destructive (DELETE) command may run. A `--dry-run` only
 * bypasses confirmation when the operation actually supports it server-side;
 * otherwise we confirm (interactive) or block (non-interactive) so `--dry-run`
 * can never silently perform a real delete.
 */
export function deleteGateDecision(options: {
  dryRunRequested: boolean;
  dryRunSupported: boolean;
  isDelete: boolean;
  isTTY: boolean;
  yes: boolean;
}): DeleteGateDecision {
  if (!options.isDelete) {
    return 'proceed';
  }
  if (options.dryRunRequested && options.dryRunSupported) {
    return 'proceed';
  }
  if (options.yes) {
    return 'proceed';
  }
  return options.isTTY ? 'confirm' : 'block';
}

const SYNTHETIC_OK = { data: { ok: true } };

async function ensureDeleteAllowed(
  operation: CliOperation,
  flags: Record<string, FlagValue>,
): Promise<void> {
  const dryRunRequested = isFlagEnabled(flags['dry-run']);
  const dryRunSupported = operationSupportsDryRun(operation);
  const decision = deleteGateDecision({
    dryRunRequested,
    dryRunSupported,
    isDelete: operation.method === 'DELETE',
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    yes: isFlagEnabled(flags.yes),
  });

  if (decision === 'proceed') {
    return;
  }

  if (decision === 'block') {
    if (dryRunRequested && !dryRunSupported) {
      throw new Error(
        `\`amp ${operation.command.join(' ')}\` does not support --dry-run. Pass --yes to confirm, or run it in an interactive terminal.`,
      );
    }
    throw new Error(
      'Pass --yes to run a DELETE command, or use --dry-run if the command supports it.',
    );
  }

  const approved = await confirm(
    `This runs DELETE \`amp ${operation.command.join(' ')}\`. Continue?`,
  );
  if (!approved) {
    throw new Error('Aborted.');
  }
}

export async function runOperation(
  operation: CliOperation,
  flags: Record<string, FlagValue>,
): Promise<void> {
  await ensureDeleteAllowed(operation, flags);

  const auth = resolveAuthFromFlags(flags);
  const request = buildRequest(
    operation,
    flags,
    authorizationHeaderForToken(auth.token),
  );
  const response = await fetch(`${auth.baseUrl}${request.path}`, {
    method: operation.method,
    headers: request.headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  const parsed = parseResponseBody(await response.text());

  if (!response.ok) {
    throw new Error(
      formatApiError(response.status, response.statusText, parsed),
    );
  }

  const isTTY = Boolean(process.stdout.isTTY);
  const useJson = shouldUseJsonOutput({
    jsonFlag: isFlagEnabled(flags.json),
    isTTY,
  });

  if (isNoContentSuccess(response.status, parsed)) {
    const output = useJson
      ? formatJsonOutput(null, isTTY)
      : formatNoContentSuccess(operation);
    console.log(output);
    return;
  }

  const payload = parsed ?? SYNTHETIC_OK;

  // When piped or non-interactive (the path agents and scripts take), emit
  // compact JSON to avoid spending tokens on indentation. Pretty-print only
  // when a human asked for JSON at a real terminal.
  const output = useJson
    ? formatJsonOutput(payload, isTTY)
    : formatSuccessOutput(payload, operation);

  console.log(output);
}
