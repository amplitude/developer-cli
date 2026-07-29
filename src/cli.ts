#!/usr/bin/env node
/* eslint-disable no-console */
import {
  type FlagValue,
  globalOptionAliases,
  isFlagEnabled,
  parseArgs,
} from './args';
import {
  runAuthList,
  runAuthLogin,
  runAuthLoginPoll,
  runAuthLoginStart,
  runAuthPat,
  runAuthStatus,
  runAuthToken,
  runAuthUse,
  runLogout,
} from './auth-commands';
import { buildCatalog } from './catalog';
import {
  CliError,
  formatErrorEnvelope,
  formatErrorText,
  usageError,
} from './cli-error';
import {
  findOperation,
  formatVersion,
  printCommandHelp,
  printGlobalHelp,
} from './help';
import { shouldUseJsonOutput } from './output';
import { assertFlagsAllowed } from './request';
import { runOperation } from './run';
import { terminal } from './terminal';

/**
 * Validates flags for a bespoke auth/logout command against globals ∪ that
 * command's catalog-declared flags. These commands dispatch directly in
 * `main()` rather than through `buildRequest`, so without this they'd skip
 * the same misplaced/unknown-flag check API operations get from
 * `assertKnownFlags` — a typo'd flag (e.g. `--toekn`) would silently drop
 * instead of erroring.
 *
 * `command` must be the catalog path (e.g. `['auth', 'use']`), not the raw
 * parsed command tokens — those may carry a trailing positional argument
 * (`auth use <name>`) that isn't part of the catalog key.
 */
function assertKnownAuthFlags(
  command: string[],
  flags: Record<string, FlagValue>,
): void {
  const entry = buildCatalog().find(
    (candidate) =>
      candidate.command.length === command.length &&
      candidate.command.every((part, index) => part === command[index]),
  );
  const catalogAliases = entry?.flags.flatMap((flag) => flag.aliases) ?? [];
  const allowed = new Set([...globalOptionAliases(), ...catalogAliases]);
  assertFlagsAllowed(allowed, `amp ${command.join(' ')}`, flags);
}

export function isHelpRequested(
  command: string[],
  flags: Record<string, FlagValue>,
): boolean {
  return (
    command[0] === 'help' || isFlagEnabled(flags.help) || isFlagEnabled(flags.h)
  );
}

export function isVersionRequested(
  command: string[],
  flags: Record<string, FlagValue>,
): boolean {
  return (
    command[0] === 'version' ||
    isFlagEnabled(flags.version) ||
    isFlagEnabled(flags.v)
  );
}

export async function main(): Promise<void> {
  const isTTY = Boolean(process.stdout.isTTY);
  let flags: Record<string, FlagValue> | undefined;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    flags = parsed.flags;
    const { command } = parsed;

    if (isVersionRequested(command, flags)) {
      console.log(formatVersion());
      return;
    }

    const wantsJson = shouldUseJsonOutput({
      jsonFlag: isFlagEnabled(flags.json),
      isTTY,
    });

    if (command.length === 0) {
      if (wantsJson) {
        printCommandHelp([], { json: true, isTTY });
      } else {
        printGlobalHelp();
      }
      return;
    }

    if (isHelpRequested(command, flags)) {
      const topic = command[0] === 'help' ? command.slice(1) : command;
      printCommandHelp(topic, { json: wantsJson, isTTY });
      return;
    }

    if (command[0] === 'auth') {
      if (
        command.length === 3 &&
        command[1] === 'login' &&
        command[2] === 'start'
      ) {
        assertKnownAuthFlags(['auth', 'login', 'start'], flags);
        await runAuthLoginStart(flags);
        return;
      }
      if (
        command.length === 3 &&
        command[1] === 'login' &&
        command[2] === 'poll'
      ) {
        assertKnownAuthFlags(['auth', 'login', 'poll'], flags);
        await runAuthLoginPoll(flags);
        return;
      }
      if (command.length === 2 && command[1] === 'login') {
        assertKnownAuthFlags(['auth', 'login'], flags);
        const isInteractive = Boolean(
          process.stdin.isTTY && process.stdout.isTTY,
        );
        if (!isInteractive) {
          await runAuthLoginStart(flags);
        } else {
          await runAuthLogin(flags);
        }
        return;
      }
      if (command.length === 2 && command[1] === 'pat') {
        assertKnownAuthFlags(['auth', 'pat'], flags);
        await runAuthPat(flags);
        return;
      }
      if (command.length === 2 && command[1] === 'list') {
        assertKnownAuthFlags(['auth', 'list'], flags);
        runAuthList(flags);
        return;
      }
      if (command[1] === 'use' && command.length <= 3) {
        assertKnownAuthFlags(['auth', 'use'], flags);
        runAuthUse(command[2]);
        return;
      }
      if (command.length === 2 && command[1] === 'status') {
        assertKnownAuthFlags(['auth', 'status'], flags);
        runAuthStatus(flags);
        return;
      }
      if (command.length === 2 && command[1] === 'token') {
        assertKnownAuthFlags(['auth', 'token'], flags);
        runAuthToken(flags);
        return;
      }

      throw usageError(
        `Unknown auth command: ${command.join(' ')}. Try: amp help auth`,
      );
    }

    if (command[0] === 'logout' && command.length === 1) {
      assertKnownAuthFlags(['logout'], flags);
      await runLogout(flags);
      return;
    }

    const operation = findOperation(command);
    if (!operation) {
      throw usageError(
        `Unknown command: ${command.join(' ')}. Run \`amp help\` to list commands.`,
      );
    }

    await runOperation(operation, flags);
  } catch (error) {
    // Prefer the parsed flag so the error envelope honors `--json false` the
    // same way the success path does; fall back to an argv scan only when
    // parseArgs itself threw and `flags` was never assigned.
    const wantsJson = flags
      ? shouldUseJsonOutput({ jsonFlag: isFlagEnabled(flags.json), isTTY })
      : process.argv.includes('--json') || !isTTY;
    const cliError =
      error instanceof CliError
        ? error
        : new CliError({
            message: error instanceof Error ? error.message : String(error),
            errorCode: 'error',
            exitCode: 1,
          });
    if (wantsJson) {
      console.error(formatErrorEnvelope(cliError, isTTY));
    } else {
      console.error(terminal.error(formatErrorText(cliError)));
    }
    process.exitCode = cliError.exitCode;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      terminal.error(error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  });
}
