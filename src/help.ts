import packageJson from '../package.json';
import type { CliOperation } from './generated/cli-manifest';
import { API_SPEC_VERSION, CLI_OPERATIONS } from './generated/cli-manifest';

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

const COMMAND_EXAMPLES: Record<string, string> = {
  context: 'amp context',
  'projects list': 'amp projects list --limit 10',
  'events list': 'amp events list --project <project_id> --limit 5',
  'events create':
    'amp events create --project <project_id> --event-type my_event',
  'events get': 'amp events get --project <project_id> --event <event_type>',
  'flags list': 'amp flags list --project <project_id> --limit 5',
  'flags create':
    'amp flags create --project <project_id> --key my-flag --name "My Flag"',
  'flags get': 'amp flags get --project <project_id> --flag <flag_id>',
  'flags archive':
    'amp flags archive --project <project_id> --flag <flag_id> --dry-run',
};

function commandKey(command: string[]): string {
  return command.join(' ');
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

function operationUsage(operation: CliOperation): string {
  const flags = [
    ...operation.parameters
      .filter((parameter) => parameter.in !== 'header')
      .map((parameter) =>
        parameter.required
          ? `--${parameter.aliases[0]} <${parameter.name}>`
          : `[--${parameter.aliases[0]} <${parameter.name}>]`,
      ),
    ...operation.body.map((property) =>
      property.required
        ? `--${property.aliases[0]} <${property.name}>`
        : `[--${property.aliases[0]} <${property.name}>]`,
    ),
  ];

  return `  amp ${operation.command.join(' ')} ${flags.join(' ')}`.trimEnd();
}

function exampleFor(operation: CliOperation): string | undefined {
  return COMMAND_EXAMPLES[commandKey(operation.command)];
}

const SURFACE_DESCRIPTIONS: Record<string, string> = {
  context: 'Authenticated user and org context',
  projects: 'Projects in your organization',
  events: 'Event taxonomy',
  'event-properties': 'Properties on events',
  'user-properties': 'User properties',
  flags: 'Feature flags',
};

const SURFACE_ORDER = [
  'context',
  'projects',
  'events',
  'event-properties',
  'user-properties',
  'flags',
] as const;

export interface ProductSurface {
  command: string[];
  description: string;
  label: string;
}

export function listProductSurfaces(): ProductSurface[] {
  const byLabel = new Map<string, ProductSurface>();

  for (const operation of CLI_OPERATIONS) {
    const label = operation.command[0];
    if (byLabel.has(label)) {
      continue;
    }

    byLabel.set(label, {
      label,
      command: operation.command.length === 1 ? operation.command : [label],
      description:
        SURFACE_DESCRIPTIONS[label] ??
        operation.summary ??
        'Developer API commands',
    });
  }

  // A SURFACE_ORDER label may legitimately be absent when the manifest does
  // not include that surface, so skip missing entries instead of asserting.
  return SURFACE_ORDER.flatMap((label) => {
    const surface = byLabel.get(label);
    return surface ? [surface] : [];
  });
}

function printSurfaceOverview(): string {
  const lines = ['Product surfaces:'];

  for (const surface of listProductSurfaces()) {
    const padding = ' '.repeat(Math.max(1, 22 - surface.label.length));
    lines.push(`  ${surface.label}${padding}${surface.description}`);
  }

  return lines.join('\n');
}

export function printGlobalHelp(defaultApiBaseUrl: string): void {
  console.log(`amp ${CLI_VERSION} — Amplitude Developer API CLI

Usage:
  amp auth login --profile <name> --env <env>   Authenticate and save a profile
  amp auth <status|list|use|token>              Inspect, switch, or print credentials
  amp logout [--profile <name>|--all]           Remove a profile (or all)
  amp version                                   Print CLI version
  amp help [surface...]                         Explore commands for a product surface

${printSurfaceOverview()}

Explore commands:
  amp help <surface>             List commands for a surface (e.g. amp help flags)
  amp <surface> <cmd> --help     Flags and examples for one command

Global flags:
  --base-url <url>     API base URL, defaults to ${defaultApiBaseUrl}
  --env <env>          Target env (local|dev|staging|prod|prod-eu); sets the base URL
  --profile <name>     Use a stored profile for this command
  --token <token>      Raw PAT, PAT=<token>, or bearer-compatible token
  --json               Print raw JSON (default when piped)
  --yes                Skip interactive confirmation for DELETE commands
  --dry-run            Preview supported DELETE commands without applying changes
  --body-json '{...}'  Merge raw JSON into request bodies for fields not yet modeled as flags

Environment:
  AMP_TOKEN          Raw token (amp_... → PAT, else bearer); overrides stored profiles
  AMP_PROFILE        Stored profile to select by name
  AMP_API_BASE_URL   API base URL
  ~/.amplitude/amp/credentials.json  Saved profiles from \`amp auth login\``);
}

export function authHelpText(): string {
  return [
    'amp auth',
    '',
    'Authenticate and manage saved credential profiles.',
    '',
    'Usage:',
    '  amp auth login --profile <name> --env <env>   Device flow → save + activate a profile',
    '  amp auth login                                Re-authenticate the active profile',
    '  amp auth pat --with-token --profile <name> --env <env>  Save a supplied PAT (stdin/prompt)',
    '  amp auth use <name>                           Switch the active profile (no re-auth)',
    '  amp auth list                                 List profiles (* marks the active one)',
    '  amp auth status                               Show the active credential and expiry',
    '  amp auth token                                Print the active access token to stdout',
    '  amp logout [--profile <name>|--all]           Remove a profile (or all)',
    '',
    'Examples:',
    '  amp auth login --profile prod --env prod',
    '  amp auth login --profile staging --env staging',
    '  amp auth use prod',
    '  TOKEN=$(amp auth token)',
    '',
    'Creating a profile is force-explicit: a new profile needs both --profile',
    '<name> and --env <env> (or --base-url <url>). Re-authenticating an existing',
    'profile reuses the env recorded on it, so a bare `amp auth login` refreshes',
    'the active profile in place. Login activates the profile it mints and prints',
    'the switch; the active identity never changes without a command.',
    '',
    'A login requests every scope the CLI can use by default, so all commands',
    'work immediately.',
    '',
    'Environment:',
    '  AMP_TOKEN          Raw token (amp_... → PAT, else bearer); overrides stored profiles',
    '  AMP_PROFILE        Stored profile to select by name',
    '  AMP_API_BASE_URL   API base URL',
  ].join('\n');
}

export function printCommandHelp(
  command: string[],
  defaultApiBaseUrl: string,
): void {
  if (command.length === 1 && command[0] === 'auth') {
    console.log(authHelpText());
    return;
  }

  const exact = findOperation(command);
  if (exact) {
    printOperationHelp(exact);
    return;
  }

  const matches = operationsMatchingPrefix(command);
  if (matches.length > 0 && matches.length < CLI_OPERATIONS.length) {
    printGroupHelp(command, matches);
    return;
  }

  printGlobalHelp(defaultApiBaseUrl);
}

function printOperationHelp(operation: CliOperation): void {
  const lines = [
    `amp ${operation.command.join(' ')}`,
    '',
    operation.summary ?? 'Call the Developer API.',
    '',
    'Usage:',
    operationUsage(operation),
  ];

  const example = exampleFor(operation);
  if (example) {
    lines.push('', 'Example:', `  ${example}`);
  }

  if (operation.requiredScopes.length > 0) {
    lines.push(
      '',
      'Required scopes:',
      `  ${operation.requiredScopes.join(', ')}`,
    );
  }

  lines.push(
    '',
    'Global flags: --base-url, --token, --json, --yes, --body-json',
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
    const example = exampleFor(operation);
    if (example) {
      console.log(`    e.g. ${example}`);
    }
    console.log('');
  }
  console.log('Run `amp help <surface>` to explore another product surface.');
}
