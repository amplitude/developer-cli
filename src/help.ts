import packageJson from '../package.json';
import type { GlobalOptionAlias } from './args';
import { buildCatalog, catalogGroups, findCatalogCommand } from './catalog';
import type { CatalogCommand, CatalogPositional } from './catalog';
import { usageError } from './cli-error';
import type { CliOperation } from './generated/cli-manifest';
import { API_SPEC_VERSION, CLI_OPERATIONS } from './generated/cli-manifest';
import { formatJsonOutput, normalizeWhitespace } from './output';

export const CLI_VERSION = packageJson.version;

export { API_SPEC_VERSION };

/**
 * One-line version string for `amp version` / `--version`. Pairs the CLI's npm
 * version with the bundled Developer API spec version so a single line is both
 * human-readable and greppable by agents.
 */
export function formatVersion(): string {
  return `amp/${CLI_VERSION} (Developer API spec ${API_SPEC_VERSION})`;
}

// Compact per-command entry for the index tiers (global + surface). Deliberately
// omits flags/description/example/order — drilling into a single
// command via `--help --json` gets the full CatalogCommand instead.
//
// `command` is serialized as a single invocation string (the tokens typed
// after `amp`), not an array — that's the stable agent-facing identity for a
// command. The resource namespace is carried separately by `group`.
export interface CatalogIndexEntry {
  command: string;
  summary: string;
  group: string;
  requiredScopes: string[];
}

// `order` is presentation-only and `globalFlags` is validation-only, so neither
// is serialized. `positional` is — a required argument is part of a command's
// input contract, and `flags` already carries `required`, so omitting it would
// report a command that takes an argument as taking no input at all.
// See catalog-shape.test.ts.
export type CatalogDetail = Omit<
  CatalogCommand,
  'order' | 'command' | 'globalFlags' | 'requiredUsageGlobalFlags'
> & {
  command: string;
};

const JSON_DRILLDOWN_HINT =
  "Run `amp <command> --help --json` for a command's flags and parameters.";

// The globals worth naming in a per-command footer, in display order. Each is
// printed only when the command's own `globalFlags` set accepts it — a footer
// that names a flag the command answers with `usage_error` is worse than no
// footer, and the full accepted set (--region, --profile, …) belongs in
// `amp help`, not repeated under every command.
const ADVERTISED_GLOBAL_FLAGS: readonly GlobalOptionAlias[] = [
  'token',
  'json',
  'yes',
  'body-json',
];

export interface CatalogDump {
  cli: string;
  spec: string;
  detail: string;
  commands: CatalogIndexEntry[];
}

function toIndexEntry(c: CatalogCommand): CatalogIndexEntry {
  return {
    command: c.command.join(' '),
    summary: c.summary,
    group: c.group,
    requiredScopes: c.requiredScopes,
  };
}

function toDetail(c: CatalogCommand): CatalogDetail {
  const { order, globalFlags, requiredUsageGlobalFlags, ...rest } = c;
  return { ...rest, command: c.command.join(' ') };
}

export function serializeCatalog(): CatalogDump {
  return {
    cli: CLI_VERSION,
    spec: API_SPEC_VERSION,
    detail: JSON_DRILLDOWN_HINT,
    commands: buildCatalog().map(toIndexEntry),
  };
}

function helpAsJson(command: string[], isTTY: boolean): string {
  if (command.length === 0) {
    return formatJsonOutput(serializeCatalog(), isTTY);
  }
  const entry = findCatalogCommand(command);
  if (entry) {
    return formatJsonOutput(toDetail(entry), isTTY);
  }
  if (command.length === 1) {
    const commands = buildCatalog().filter((c) => c.group === command[0]);
    if (commands.length > 0) {
      return formatJsonOutput(
        {
          command: command.join(' '),
          detail: JSON_DRILLDOWN_HINT,
          commands: commands.map(toIndexEntry),
        },
        isTTY,
      );
    }
  }
  throw usageError(
    `Unknown command: ${command.join(' ')}. Run \`amp help\` to list commands.`,
  );
}

export function operationsMatchingPrefix(command: string[]): CliOperation[] {
  return CLI_OPERATIONS.filter(
    (operation) =>
      operation.command.length >= command.length &&
      command.every((part, index) => operation.command[index] === part),
  );
}

export function findOperation(command: string[]): CliOperation | undefined {
  return CLI_OPERATIONS.find(
    (operation) =>
      operation.command.length === command.length &&
      operation.command.every((part, index) => part === command[index]),
  );
}

export interface ProductSurface {
  command: string[];
  description: string;
  label: string;
}

export function listProductSurfaces(): ProductSurface[] {
  return catalogGroups()
    .filter((group) => group.group !== 'auth')
    .map((group) => ({
      label: group.group,
      command: [group.group],
      description: group.description,
    }));
}

function printSurfaceOverview(): string {
  const lines = ['Product surfaces:'];

  for (const surface of listProductSurfaces()) {
    const padding = ' '.repeat(Math.max(1, 22 - surface.label.length));
    lines.push(`  ${surface.label}${padding}${surface.description}`);
  }

  return lines.join('\n');
}

export function printGlobalHelp(): void {
  console.log(`amp ${CLI_VERSION} — Amplitude Developer API CLI

Usage:
  amp auth login --region <us|eu>      Authenticate and save a profile
  amp auth <status|list|use|token>     Inspect, switch, or print credentials
  amp logout [--profile <name>|--all]  Remove a profile (or all)
  amp version                          Print CLI version
  amp help [surface...]                Explore commands for a product surface

${printSurfaceOverview()}

Explore commands:
  amp help <surface>             List commands for a surface (e.g. amp help flags)
  amp <surface> <cmd> --help     Flags and examples for one command

Output:
  Human-readable at a terminal. Most commands use JSON when piped or with --json.
  amp skills get remains raw when piped unless --json is passed.
  amp help --json                 Full command catalog (compact index)
  amp <command> --help --json     One command's parameters
  Errors: non-zero exit + JSON {"status":"error","error":{"error_code",…}} on stderr

Global flags:
  --region <us|eu>     Target region (us|eu); sets the base URL
  --profile <name>     Use a stored profile for this command
  --token <token>      Raw PAT, PAT=<token>, or bearer-compatible token
  --json               Print raw JSON (most commands default when piped)
  --yes                Skip interactive confirmation for DELETE commands
  --dry-run            Preview supported DELETE commands without applying changes
  --body-json '{...}'  Merge raw JSON into request bodies for fields not yet modeled as flags

Environment:
  AMP_TOKEN          Raw token (amp_... → PAT, else bearer); overrides stored profiles
  AMP_PROFILE        Stored profile to select by name
  ~/.amplitude/amp/credentials.json  Saved profiles from \`amp auth login\``);
}

export function authHelpText(): string {
  return [
    'amp auth',
    '',
    'Authenticate and manage saved credential profiles.',
    '',
    'Usage:',
    '  amp auth login --region <us|eu>             Device flow → save + activate a profile',
    '  amp auth login                              Re-authenticate the active profile',
    '  amp auth pat --with-token --region <us|eu>  Save a supplied PAT (stdin/prompt)',
    '  amp auth use <name>                         Switch the active profile (no re-auth)',
    '  amp auth list                               List profiles (* marks the active one)',
    '  amp auth status                             Show the active credential and expiry',
    '  amp auth token                              Print the active access token to stdout',
    '  amp logout [--profile <name>|--all]         Remove a profile (or all)',
    '',
    'Examples:',
    '  amp auth login --region us',
    '  amp auth login --profile eu --region eu',
    '  amp auth use prod',
    '  TOKEN=$(amp auth token)',
    '',
    'Creating a profile is force-explicit: --region <us|eu> is required;',
    '--profile <name> is optional — omit it and the CLI targets the',
    'implicit `default` profile, created on first use.',
    'Re-authenticating an existing profile reuses the target recorded on it, so a',
    'bare `amp auth login` refreshes the active profile in place. Login activates',
    'the profile it mints and prints the switch; the active identity never changes',
    'without a command.',
    '',
    'A login requests every scope the CLI can use by default, so all commands',
    'work immediately.',
    '',
    'JSON output:',
    '  amp auth login start --region <us|eu> --json  Begin the device flow',
    '  amp auth login poll --json                    Complete it (add --timeout <seconds>)',
    '  Both always emit a JSON envelope, never prose.',
    '',
    'Environment:',
    '  AMP_TOKEN          Raw token (amp_... → PAT, else bearer); overrides stored profiles',
    '  AMP_PROFILE        Stored profile to select by name',
  ].join('\n');
}

export function printCommandHelp(
  command: string[],
  options: { json?: boolean; isTTY?: boolean } = {},
): void {
  if (options.json) {
    console.log(
      helpAsJson(command, options.isTTY ?? Boolean(process.stdout.isTTY)),
    );
    return;
  }
  if (command.length === 0) {
    printGlobalHelp();
    return;
  }
  if (command.length === 1 && command[0] === 'auth') {
    console.log(authHelpText());
    return;
  }

  const entry = findCatalogCommand(command);
  if (entry) {
    printCatalogCommandHelp(entry);
    return;
  }

  const matches = operationsMatchingPrefix(command);
  if (matches.length > 0 && matches.length < CLI_OPERATIONS.length) {
    printGroupHelp(command, operationGroupRows(matches));
    return;
  }

  // Bespoke groups (auth, skills) are excluded from the generated manifest by
  // tag, so `operationsMatchingPrefix` finds nothing for them. The catalog knows
  // every group, generated or not — so fall back to it rather than teaching this
  // function each bespoke group by name.
  if (command.length === 1) {
    const grouped = buildCatalog().filter((c) => c.group === command[0]);
    if (grouped.length > 0) {
      printGroupHelp(command, catalogGroupRows(grouped));
      return;
    }
  }

  throw usageError(
    `Unknown command: ${command.join(' ')}. Run \`amp help\` to list commands.`,
  );
}

function usagePositional(positional: CatalogPositional | undefined): string[] {
  if (positional === undefined) {
    return [];
  }

  return positional.required
    ? [`<${positional.name}>`]
    : [`[<${positional.name}>]`];
}

function printCatalogCommandHelp(entry: CatalogCommand): void {
  const lines = [`amp ${entry.command.join(' ')}`, '', entry.summary];
  if (entry.description) {
    lines.push('', normalizeWhitespace(entry.description));
  }
  lines.push('', 'Usage:');
  const usageFlags = entry.flags.map((f) =>
    f.required
      ? `--${f.aliases[0]} <${f.name}>`
      : `[--${f.aliases[0]} <${f.name}>]`,
  );
  const requiredUsageFlags = (entry.requiredUsageGlobalFlags ?? []).map(
    (flag) => `--${flag.alias} <${flag.valueName}>`,
  );
  const usageArgs = [
    ...usagePositional(entry.positional),
    ...requiredUsageFlags,
    ...usageFlags,
  ];
  lines.push(
    `  amp ${entry.command.join(' ')} ${usageArgs.join(' ')}`.trimEnd(),
  );

  const described = entry.flags.filter((f) => f.description);
  if (described.length > 0) {
    lines.push('', 'Flags:');
    for (const f of described) {
      const description = f.description
        ? normalizeWhitespace(f.description)
        : '';
      lines.push(`  --${f.aliases[0]}  ${description}`.trimEnd());
    }
  }
  if (entry.example) {
    lines.push('', 'Example:', `  ${entry.example}`);
  }
  if (entry.requiredScopes.length > 0) {
    lines.push('', 'Required scopes:', `  ${entry.requiredScopes.join(', ')}`);
  }
  lines.push('');
  const advertised = ADVERTISED_GLOBAL_FLAGS.filter((flag) =>
    entry.globalFlags.includes(flag),
  );
  if (advertised.length > 0) {
    lines.push(
      `Global flags: ${advertised.map((flag) => `--${flag}`).join(', ')}`,
    );
  }
  lines.push('Run `amp help` for product surfaces.');
  console.log(lines.join('\n'));
}

interface GroupHelpRow {
  command: string[];
  summary: string;
  example?: string;
}

function printGroupHelp(command: string[], rows: GroupHelpRow[]): void {
  const label = command.join(' ');
  console.log(`amp ${label} — available commands:\n`);
  for (const row of rows) {
    console.log(`  ${row.command.join(' ')}`);
    if (row.summary) {
      console.log(`    ${row.summary}`);
    }
    if (row.example) {
      console.log(`    e.g. ${row.example}`);
    }
    console.log('');
  }
  console.log('Run `amp help <surface>` to explore another product surface.');
}

function operationGroupRows(operations: CliOperation[]): GroupHelpRow[] {
  return operations.map((operation) => ({
    command: operation.command,
    summary: operation.summary ?? '',
    example: findCatalogCommand(operation.command)?.example,
  }));
}

function catalogGroupRows(commands: CatalogCommand[]): GroupHelpRow[] {
  return commands.map((c) => ({
    command: c.command,
    summary: c.summary,
    example: c.example,
  }));
}
