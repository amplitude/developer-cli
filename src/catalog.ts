import { DEFAULT_POLL_TIMEOUT_SECONDS } from './config';
import type { CliOperation } from './generated/cli-manifest';
import { CLI_OPERATIONS } from './generated/cli-manifest';

export interface CatalogFlag {
  name: string;
  aliases: string[];
  type: string;
  required: boolean;
  enum?: string[];
  description?: string;
}

export interface CatalogCommand {
  command: string[];
  summary: string;
  description?: string;
  group: string;
  order?: number;
  flags: CatalogFlag[];
  example?: string;
  requiredScopes: string[];
}

// Curated presentation overlay. Generation fills the rest; curation wins where
// present (design rule: generation augments curation, never replaces it).
const GROUP_ORDER: Partial<Record<string, number>> = {
  context: 0,
  projects: 1,
  events: 2,
  'event-properties': 3,
  'user-properties': 4,
  flags: 5,
  charts: 6,
  auth: 20,
};

const GROUP_DESCRIPTIONS: Partial<Record<string, string>> = {
  context: 'Authenticated user and org context',
  projects: 'Projects in your organization',
  events: 'Event taxonomy',
  'event-properties': 'Properties on events',
  'user-properties': 'User properties',
  flags: 'Feature flags',
  charts: 'Saved and ad-hoc charts',
  auth: 'Authentication and credential profiles',
};

const EXAMPLES: Partial<Record<string, string>> = {
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

// Uncurated groups get a stable order *after* curated ones (alphabetical),
// so a new API surface still appears in help — just without a hand-picked slot.
const UNCURATED_ORDER_BASE = 100;

function flagsForOperation(operation: CliOperation): CatalogFlag[] {
  const fromParams = operation.parameters
    .filter((parameter) => parameter.in !== 'header')
    .map((parameter) => ({
      name: parameter.name,
      aliases: parameter.aliases,
      type: parameter.type,
      required: parameter.required,
    }));
  const fromBody = operation.body.map((property) => ({
    name: property.name,
    aliases: property.aliases,
    type: property.type,
    required: property.required,
    enum: property.enum,
  }));
  return [...fromParams, ...fromBody];
}

function apiCommands(): CatalogCommand[] {
  return CLI_OPERATIONS.map((operation) => {
    const group = operation.command[0];
    const key = operation.command.join(' ');
    return {
      command: operation.command,
      summary: operation.summary ?? 'Call the Developer API.',
      group,
      order: GROUP_ORDER[group],
      flags: flagsForOperation(operation),
      example: EXAMPLES[key],
      requiredScopes: operation.requiredScopes,
    };
  });
}

// Auth/meta commands are bespoke routing (excluded from the OpenAPI manifest by
// the generator's `Auth` tag filter), so they are hand-authored here in the same
// shape. Keep this in sync with the routing in cli.ts — catalog.test.ts's
// "covers every auth/meta command the CLI routes" test checks parity against a
// manually-maintained list, so update that list too. There is no automated
// routing-derived parity check.
//
// auth-flag-coverage.test.ts enforces that handlers only read declared/global
// flags, so the misplaced-flag reject can't false-positive.
const AUTH_COMMANDS: CatalogCommand[] = [
  {
    command: ['auth', 'login'],
    summary: 'Authenticate and save a profile (interactive device flow)',
    group: 'auth',
    order: GROUP_ORDER.auth,
    flags: [
      {
        name: 'region',
        aliases: ['region'],
        type: 'string',
        required: true,
        enum: ['us', 'eu'],
        description: 'Target region (us|eu); sets the base URL.',
      },
      {
        name: 'profile',
        aliases: ['profile'],
        type: 'string',
        required: false,
        description: 'Profile name; omit to use the implicit default profile.',
      },
      {
        name: 'force',
        aliases: ['force'],
        type: 'boolean',
        required: false,
        description:
          'Overwrite the profile when it already targets a different region/base URL, skipping the confirm prompt.',
      },
    ],
    example: 'amp auth login --region us',
    requiredScopes: [],
  },
  {
    command: ['auth', 'login', 'start'],
    summary: 'Begin the device flow (emits a JSON envelope)',
    group: 'auth',
    order: GROUP_ORDER.auth,
    description:
      'Begins OAuth device authorization: returns a verification URL, user code, and expiry, and records a pending authorization. The authorization is completed out of band by confirming the code; `amp auth login poll` returns the resulting credential.',
    flags: [
      {
        name: 'region',
        aliases: ['region'],
        type: 'string',
        required: true,
        enum: ['us', 'eu'],
        description: 'Target region (us|eu).',
      },
      {
        name: 'profile',
        aliases: ['profile'],
        type: 'string',
        required: false,
        description: 'Profile name; defaults to the implicit default profile.',
      },
      {
        name: 'force',
        aliases: ['force'],
        type: 'boolean',
        required: false,
        description:
          'Overwrite the profile when it already targets a different region/base URL (the retarget is refused without it).',
      },
    ],
    example: 'amp auth login start --region us --json',
    requiredScopes: [],
  },
  {
    command: ['auth', 'login', 'poll'],
    summary:
      'Complete the device flow started by `login start` (emits a JSON envelope)',
    group: 'auth',
    order: GROUP_ORDER.auth,
    description: `Completes the device authorization started by \`amp auth login start\`: returns the credential once the code is confirmed, or reports that authorization is still pending or the code has expired. Each call blocks up to ~${DEFAULT_POLL_TIMEOUT_SECONDS}s (\`--timeout <seconds>\`, or \`--timeout 0\` for a single check).`,
    flags: [
      {
        name: 'profile',
        aliases: ['profile'],
        type: 'string',
        required: false,
        description:
          'Profile being authorized; defaults to the implicit default.',
      },
      {
        name: 'timeout',
        aliases: ['timeout'],
        type: 'integer',
        required: false,
        description:
          'Max seconds to block this call. 0 = one check and return.',
      },
    ],
    example: 'amp auth login poll --json',
    requiredScopes: [],
  },
  {
    command: ['auth', 'pat'],
    summary: 'Save a supplied Personal Access Token as a profile',
    group: 'auth',
    order: GROUP_ORDER.auth,
    flags: [
      {
        name: 'with-token',
        aliases: ['with-token'],
        type: 'boolean',
        required: true,
        description:
          'Read the PAT from stdin (piped) or a masked prompt (TTY).',
      },
      {
        name: 'region',
        aliases: ['region'],
        type: 'string',
        required: true,
        enum: ['us', 'eu'],
        description: 'Target region (us|eu).',
      },
      {
        name: 'profile',
        aliases: ['profile'],
        type: 'string',
        required: false,
        description: 'Profile name; defaults to the implicit default profile.',
      },
      {
        name: 'force',
        aliases: ['force'],
        type: 'boolean',
        required: false,
        description:
          'Overwrite the profile when it already targets a different region/base URL (the retarget is refused without it).',
      },
    ],
    example: 'echo "$PAT" | amp auth pat --with-token --region us',
    requiredScopes: [],
  },
  {
    command: ['auth', 'use'],
    summary: 'Switch the active profile (no re-auth)',
    group: 'auth',
    order: GROUP_ORDER.auth,
    flags: [],
    example: 'amp auth use eu',
    requiredScopes: [],
  },
  {
    command: ['auth', 'list'],
    summary: 'List profiles (* marks the active one)',
    group: 'auth',
    order: GROUP_ORDER.auth,
    flags: [],
    example: 'amp auth list',
    requiredScopes: [],
  },
  {
    command: ['auth', 'status'],
    summary: 'Show the active credential, base URL, and expiry',
    group: 'auth',
    order: GROUP_ORDER.auth,
    flags: [],
    example: 'amp auth status',
    requiredScopes: [],
  },
  {
    command: ['auth', 'token'],
    summary: 'Print the active access token to stdout',
    group: 'auth',
    order: GROUP_ORDER.auth,
    flags: [],
    example: 'TOKEN=$(amp auth token)',
    requiredScopes: [],
  },
  {
    command: ['logout'],
    summary: 'Remove a profile (or all with --all)',
    group: 'auth',
    order: GROUP_ORDER.auth,
    flags: [
      {
        name: 'profile',
        aliases: ['profile'],
        type: 'string',
        required: false,
        description: 'Profile to remove; defaults to the active one.',
      },
      {
        name: 'all',
        aliases: ['all'],
        type: 'boolean',
        required: false,
        description: 'Remove every stored profile.',
      },
    ],
    example: 'amp logout --profile eu',
    requiredScopes: [],
  },
];

export function buildCatalog(): CatalogCommand[] {
  return [...apiCommands(), ...AUTH_COMMANDS];
}

export function catalogGroups(): {
  group: string;
  description: string;
  order: number;
}[] {
  const seen = new Map<string, number>();
  for (const entry of buildCatalog()) {
    if (!seen.has(entry.group)) {
      seen.set(entry.group, entry.order ?? UNCURATED_ORDER_BASE);
    }
  }
  return [...seen.entries()]
    .map(([group, order]) => ({
      group,
      order,
      description: GROUP_DESCRIPTIONS[group] ?? 'Developer API commands',
    }))
    .sort((a, b) => a.order - b.order || a.group.localeCompare(b.group));
}
