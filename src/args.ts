import { Command, CommanderError, Option } from 'commander';

import { CLI_OPERATIONS } from './generated/cli-manifest';

export type FlagValue = boolean | string;

export interface ParsedArgs {
  command: string[];
  flags: Record<string, FlagValue>;
}

type ValueRequirement = 'optional' | 'required';

interface CliOptionDefinition {
  aliases: string[];
  valueRequirement: ValueRequirement;
}

const GLOBAL_OPTIONS: CliOptionDefinition[] = [
  { aliases: ['token'], valueRequirement: 'required' },
  { aliases: ['base-url'], valueRequirement: 'required' },
  { aliases: ['body-json'], valueRequirement: 'required' },
  { aliases: ['json'], valueRequirement: 'optional' },
  { aliases: ['yes'], valueRequirement: 'optional' },
  { aliases: ['open'], valueRequirement: 'optional' },
  { aliases: ['flow'], valueRequirement: 'required' },
  { aliases: ['scope'], valueRequirement: 'required' },
  { aliases: ['profile'], valueRequirement: 'required' },
  { aliases: ['env'], valueRequirement: 'required' },
  { aliases: ['with-token'], valueRequirement: 'optional' },
  { aliases: ['all'], valueRequirement: 'optional' },
  { aliases: ['help', 'h'], valueRequirement: 'optional' },
  { aliases: ['version', 'v'], valueRequirement: 'optional' },
];

function attributeName(alias: string): string {
  return alias.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function defineOption(
  program: Command,
  alias: string,
  valueRequirement: ValueRequirement,
): void {
  const valuePlaceholder =
    valueRequirement === 'optional' ? '[value]' : '<value>';
  const flags =
    alias.length === 1
      ? `-${alias}, --${alias} ${valuePlaceholder}`
      : `--${alias} ${valuePlaceholder}`;

  program.addOption(new Option(flags).hideHelp());
}

function optionDefinitions(): CliOptionDefinition[] {
  const byAlias = new Map<string, ValueRequirement>();

  for (const option of GLOBAL_OPTIONS) {
    for (const alias of option.aliases) {
      byAlias.set(alias, option.valueRequirement);
    }
  }

  for (const operation of CLI_OPERATIONS) {
    for (const option of [...operation.parameters, ...operation.body]) {
      const valueRequirement: ValueRequirement =
        option.type === 'boolean' ? 'optional' : 'required';
      for (const alias of option.aliases) {
        const previous = byAlias.get(alias);
        // If an alias is ever shared across commands with different shapes,
        // optional boolean parsing is the safer universal form: bare flags
        // still work, and explicit string values keep flowing to request
        // validation for command-specific errors.
        byAlias.set(
          alias,
          previous === 'optional' || valueRequirement === 'optional'
            ? 'optional'
            : 'required',
        );
      }
    }
  }

  return [...byAlias.entries()].map(([alias, valueRequirement]) => ({
    aliases: [alias],
    valueRequirement,
  }));
}

function createParser(): Command {
  const program = new Command('amp');
  program
    .exitOverride()
    .configureOutput({ writeErr: () => undefined })
    .helpOption(false)
    .allowExcessArguments(true)
    .argument('[command...]');

  for (const option of optionDefinitions()) {
    defineOption(program, option.aliases[0], option.valueRequirement);
  }

  return program;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const program = createParser();
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;

  try {
    program.parse(normalizedArgv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new Error(error.message.replace(/^error: /, ''));
    }
    throw error;
  }

  const opts = program.opts<Record<string, FlagValue>>();
  for (const option of optionDefinitions()) {
    const alias = option.aliases[0];
    const value = opts[attributeName(alias)];
    if (value !== undefined) {
      flags[alias] = value;
    }
  }

  const command = program.args.filter((arg) => arg !== '--');
  return { command, flags };
}

export function flagValue(
  flags: Record<string, FlagValue>,
  aliases: string[],
): FlagValue | undefined {
  for (const name of aliases) {
    const value = flags[name];
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

export function stringFlag(
  flags: Record<string, FlagValue>,
  aliases: string[],
): string | undefined {
  const value = flagValue(flags, aliases);
  if (value === true) {
    throw new Error(`Expected --${aliases[0]} to have a value.`);
  }
  return typeof value === 'string' ? value : undefined;
}

export function hasFlag(
  flags: Record<string, FlagValue>,
  aliases: string[],
): boolean {
  return aliases.some((name) => flags[name] !== undefined);
}

export function isFlagEnabled(value: FlagValue | undefined): boolean {
  return value === true || value === 'true';
}

export function isMissingRequiredValue(value: FlagValue | undefined): boolean {
  return value === undefined || value === '';
}
