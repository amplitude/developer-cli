import { Command, CommanderError, Option } from 'commander';
import { distance } from 'fastest-levenshtein';

import { usageError } from './cli-error';
import { CLI_OPERATIONS, type CliOperation } from './generated/cli-manifest';

export type FlagValue = boolean | string;

export interface ParsedArgs {
  command: string[];
  flags: Record<string, FlagValue>;
}

type ValueRequirement = 'optional' | 'required';
const BARE_BOOLEAN_SENTINEL = '\u0000amp-bare-boolean';

interface ParseableOption {
  aliases: string[];
  valueRequirement: ValueRequirement;
}

interface CliOptionDefinition extends ParseableOption {
  // Whether this global is meaningful on generated API commands. Auth-flow-only
  // flags (--flow, --scope, --with-token, --timeout, --all, --force, --open)
  // must stay globally *parseable* so the bespoke auth/logout handlers can read
  // them, but they are not honored by the API request path — accepting them
  // there would silently drop the flag and mislead the caller. See
  // apiGlobalOptionAliases().
  onApiCommands: boolean;
  requiresAuthentication?: true;
  visible: boolean;
}

function defineGlobalOptions<
  const Options extends readonly CliOptionDefinition[],
>(options: Options): Options {
  return options;
}

const GLOBAL_OPTIONS = defineGlobalOptions([
  {
    aliases: ['token'],
    valueRequirement: 'required',
    onApiCommands: true,
    requiresAuthentication: true,
    visible: true,
  },
  {
    aliases: ['base-url'],
    valueRequirement: 'required',
    onApiCommands: true,
    visible: false,
  },
  {
    aliases: ['body-json'],
    valueRequirement: 'required',
    onApiCommands: true,
    visible: true,
  },
  {
    aliases: ['json'],
    valueRequirement: 'optional',
    onApiCommands: true,
    visible: true,
  },
  {
    aliases: ['yes'],
    valueRequirement: 'optional',
    onApiCommands: true,
    visible: true,
  },
  {
    aliases: ['open'],
    valueRequirement: 'optional',
    onApiCommands: false,
    visible: true,
  },
  {
    aliases: ['flow'],
    valueRequirement: 'required',
    onApiCommands: false,
    visible: true,
  },
  {
    aliases: ['scope'],
    valueRequirement: 'required',
    onApiCommands: false,
    visible: true,
  },
  {
    aliases: ['profile'],
    valueRequirement: 'required',
    onApiCommands: true,
    requiresAuthentication: true,
    visible: true,
  },
  {
    aliases: ['env'],
    valueRequirement: 'required',
    onApiCommands: true,
    visible: false,
  },
  {
    aliases: ['region'],
    valueRequirement: 'required',
    onApiCommands: true,
    visible: true,
  },
  {
    aliases: ['timeout'],
    valueRequirement: 'required',
    onApiCommands: false,
    visible: true,
  },
  {
    aliases: ['with-token'],
    valueRequirement: 'optional',
    onApiCommands: false,
    visible: true,
  },
  {
    aliases: ['all'],
    valueRequirement: 'optional',
    onApiCommands: false,
    visible: true,
  },
  {
    aliases: ['force'],
    valueRequirement: 'optional',
    onApiCommands: false,
    visible: true,
  },
  {
    aliases: ['dry-run'],
    valueRequirement: 'optional',
    onApiCommands: true,
    visible: true,
  },
  {
    aliases: ['help', 'h'],
    valueRequirement: 'optional',
    onApiCommands: true,
    visible: true,
  },
  {
    aliases: ['version', 'v'],
    valueRequirement: 'optional',
    onApiCommands: true,
    visible: true,
  },
]);

/** Every alias any global flag answers to. */
export type GlobalOptionAlias =
  (typeof GLOBAL_OPTIONS)[number]['aliases'][number];

// `--dry-run` is defined per-operation in the manifest (only DELETE
// operations declare a `dry_run` parameter), but `run.ts`'s delete gate reads
// it unconditionally on every DELETE command — including ones that don't
// support it, to produce a specific "does not support --dry-run" error. It
// must stay globally parseable so that check can run before flag validation.

/** Every flag alias accepted on any command, regardless of the resolved operation. */
export function globalOptionAliases(): GlobalOptionAlias[] {
  return [...new Set(GLOBAL_OPTIONS.flatMap((option) => option.aliases))];
}

/**
 * Global aliases meaningful on generated API commands. Excludes the
 * auth-flow-only globals, so `amp projects list --timeout 5` is rejected as an
 * unknown flag instead of silently accepted-and-dropped.
 */
export function apiGlobalOptionAliases(
  authentication?: CliOperation['authentication'],
): GlobalOptionAlias[] {
  return [
    ...new Set(
      GLOBAL_OPTIONS.filter(
        (option) =>
          option.onApiCommands &&
          (authentication !== 'none' || !('requiresAuthentication' in option)),
      ).flatMap((option) => option.aliases),
    ),
  ];
}

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

function optionDefinitions(): ParseableOption[] {
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
        // still work, and explicit `--flag=<value>` strings keep flowing to
        // request validation for command-specific errors.
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

function normalizeOptionalValues(argv: string[]): string[] {
  const optionalAliases = new Set(
    optionDefinitions()
      .filter((option) => option.valueRequirement === 'optional')
      .map((option) => option.aliases[0]),
  );
  const normalized: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      normalized.push(...argv.slice(index));
      break;
    }

    const alias = token.startsWith('--')
      ? token.slice(2)
      : token.startsWith('-') && token.length === 2
        ? token.slice(1)
        : undefined;
    if (alias === undefined || !optionalAliases.has(alias)) {
      normalized.push(token);
      continue;
    }

    const next = argv[index + 1];
    if (next === 'true' || next === 'false') {
      normalized.push(`--${alias}=${next}`);
      index += 1;
    } else {
      normalized.push(`--${alias}=${BARE_BOOLEAN_SENTINEL}`);
    }
  }

  return normalized;
}

// Relative similarity (not a raw edit-distance cutoff) so short aliases like
// --yes or --all don't become coincidental "did you mean" matches for an
// unrelated short flag — mirrors commander's own suggestSimilar heuristic.
const MIN_SUGGESTION_SIMILARITY = 0.4;

/** Closest candidate to `flag` by relative similarity, for "did you mean" hints. */
export function nearestAlias(
  flag: string,
  candidates: Iterable<string>,
): string | undefined {
  let best: string | undefined;
  let bestSimilarity = MIN_SUGGESTION_SIMILARITY;

  for (const candidate of candidates) {
    if (candidate.length <= 1) {
      continue;
    }

    const dist = distance(flag, candidate);
    const length = Math.max(flag.length, candidate.length);
    const similarity = (length - dist) / length;
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      best = candidate;
    }
  }

  return best;
}

function operationFromCommandArgs(
  commandArgs: string[],
): CliOperation | undefined {
  return CLI_OPERATIONS.find((operation) =>
    operation.command.every(
      (commandPart, commandIndex) => commandArgs[commandIndex] === commandPart,
    ),
  );
}

function suggestionAliases(commandArgs: string[]): string[] {
  const operation = operationFromCommandArgs(commandArgs);
  if (operation) {
    return [
      ...apiGlobalOptionAliases(operation.authentication),
      ...operation.parameters.flatMap((parameter) => parameter.aliases),
      ...operation.body.flatMap((property) => property.aliases),
    ];
  }

  if (commandArgs[0]?.startsWith('-')) {
    return [];
  }

  return optionDefinitions().map((option) => option.aliases[0]);
}

function withUnknownOptionSuggestion(
  error: CommanderError,
  commandArgs: string[],
): string {
  const message = error.message.replace(/^error: /, '');
  const match =
    error.code === 'commander.unknownOption'
      ? /^unknown option '(-[^']+)'/.exec(message)
      : null;

  if (!match) {
    return message;
  }

  const hiddenAliases = new Set<string>(
    GLOBAL_OPTIONS.filter((option) => !option.visible).flatMap(
      (option) => option.aliases,
    ),
  );
  const knownAliases = suggestionAliases(commandArgs).filter(
    (alias) => !hiddenAliases.has(alias),
  );
  const suggestion = nearestAlias(match[1].replace(/^--?/, ''), knownAliases);
  return suggestion ? `${message} Did you mean --${suggestion}?` : message;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const program = createParser();
  const withoutRunScriptSeparator = argv[0] === '--' ? argv.slice(1) : argv;
  const normalizedArgv = normalizeOptionalValues(withoutRunScriptSeparator);

  try {
    program.parse(normalizedArgv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw usageError(withUnknownOptionSuggestion(error, program.args));
    }
    throw error;
  }

  const opts = program.opts<Record<string, FlagValue>>();
  for (const option of optionDefinitions()) {
    const alias = option.aliases[0];
    const value = opts[attributeName(alias)];
    if (value !== undefined) {
      flags[alias] = value === BARE_BOOLEAN_SENTINEL ? true : value;
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
    throw usageError(`Expected --${aliases[0]} to have a value.`);
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
