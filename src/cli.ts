#!/usr/bin/env node
/* eslint-disable no-console */
import { type FlagValue, isFlagEnabled, parseArgs } from './args';
import {
  runAuthList,
  runAuthLogin,
  runAuthPat,
  runAuthStatus,
  runAuthToken,
  runAuthUse,
  runLogout,
} from './auth-commands';
import { DEFAULT_API_BASE_URL } from './config';
import {
  findOperation,
  formatVersion,
  printCommandHelp,
  printGlobalHelp,
} from './help';
import { runOperation } from './run';
import { terminal } from './terminal';

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
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (isVersionRequested(command, flags)) {
    console.log(formatVersion());
    return;
  }

  if (command.length === 0) {
    printGlobalHelp(DEFAULT_API_BASE_URL);
    return;
  }

  if (isHelpRequested(command, flags)) {
    const topic = command[0] === 'help' ? command.slice(1) : command;
    printCommandHelp(topic, DEFAULT_API_BASE_URL);
    return;
  }

  if (command[0] === 'auth') {
    if (command.length === 2 && command[1] === 'login') {
      await runAuthLogin(flags);
      return;
    }
    if (command.length === 2 && command[1] === 'pat') {
      await runAuthPat(flags);
      return;
    }
    if (command.length === 2 && command[1] === 'list') {
      runAuthList();
      return;
    }
    if (command[1] === 'use' && command.length <= 3) {
      runAuthUse(command[2]);
      return;
    }
    if (command.length === 2 && command[1] === 'status') {
      runAuthStatus(flags);
      return;
    }
    if (command.length === 2 && command[1] === 'token') {
      runAuthToken(flags);
      return;
    }

    throw new Error(
      `Unknown auth command: ${command.join(' ')}. Try: amp help auth`,
    );
  }

  if (command[0] === 'logout' && command.length === 1) {
    runLogout(flags);
    return;
  }

  const operation = findOperation(command);
  if (!operation) {
    throw new Error(
      `Unknown command: ${command.join(' ')}. Run \`amp help ${command[0]}\` for related commands.`,
    );
  }

  await runOperation(operation, flags);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(terminal.error(message));
    process.exitCode = 1;
  });
}
