import packageJson from '../package.json';
import { buildCatalog, catalogGroups } from './catalog';
import type { CatalogCommand } from './catalog';
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

export type CatalogDetail = Omit<CatalogCommand, 'order' | 'command'> & {
  command: string;
};

const JSON_DRILLDOWN_HINT =
  "Run `amp <command> --help --json` for a command's flags and parameters.";

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
  const { order, ...rest } = c;
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
  Human-readable at a terminal; JSON when piped or with --json.
  amp help --json                 Full command catalog (compact index)
  amp <command> --help --json     One command's parameters
  Errors: non-zero exit + JSON {"status":"error","error":{"error_code",…}} on stderr

Global flags:
  --region <us|eu>     Target region (us|eu); sets the base URL
  --profile <name>     Use a stored profile for this command
  --token <token>      Raw PAT, PAT=<token>, or bearer-compatible token
  --json               Print raw JSON (default when piped)
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
    printGroupHelp(command, matches);
    return;
  }

  throw usageError(
    `Unknown command: ${command.join(' ')}. Run \`amp help\` to list commands.`,
  );
}

function findCatalogCommand(command: string[]): CatalogCommand | undefined {
  return buildCatalog().find(
    (c) =>
      c.command.length === command.length &&
      c.command.every((part, i) => part === command[i]),
  );
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
  lines.push(
    `  amp ${entry.command.join(' ')} ${usageFlags.join(' ')}`.trimEnd(),
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
  lines.push(
    '',
    'Global flags: --token, --json, --yes, --body-json',
    'Run `amp help` for product surfaces.',
  );
  console.log(lines.join('\n'));
}

function printGroupHelp(command: string[], operations: CliOperation[]): void {
  const label = command.join(' ');
  console.log(`amp ${label} — available commands:\n`);
  for (const operation of operations) {
    const summary = operation.summary ?? '';
    console.log(`  ${operation.command.join(' ')}`);
    if (summary) {
      console.log(`    ${summary}`);
    }
    const example = findCatalogCommand(operation.command)?.example;
    if (example) {
      console.log(`    e.g. ${example}`);
    }
    console.log('');
  }
  console.log('Run `amp help <surface>` to explore another product surface.');
}
