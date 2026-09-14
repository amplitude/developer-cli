import { type FlagValue, isFlagEnabled } from './args';
import { SKILLS_GLOBAL_FLAGS, type SkillsVerb } from './catalog';
import { usageError } from './cli-error';
import {
  formatJsonOutput,
  normalizeWhitespace,
  shouldUseJsonOutput,
} from './output';
import { assertFlagsAllowed } from './request';
import {
  type SkillIndexEntry,
  fetchSkillDocument,
  fetchSkillIndex,
  resolveSkillsGetBaseUrl,
  resolveSkillsListBaseUrl,
} from './skills-registry';

/**
 * Validates against the verb's public `SKILLS_GLOBAL_FLAGS` set — narrower than both
 * `globalOptionAliases()` (which admits auth-flow globals like --with-token and
 * --timeout) and `apiGlobalOptionAliases()` (which admits --token, --yes,
 * --dry-run, --body-json). These commands make one unauthenticated GET with no
 * body and no writes, so any of those would be accepted and silently dropped —
 * the caller would believe it took effect. Sharing that set with the catalog is
 * what keeps `--help` from advertising flags this rejects. `skills list` also
 * accepts the undocumented `--region` compatibility flag because agents may
 * infer it from `skills get`.
 */
export function assertSkillsFlags(
  verb: SkillsVerb,
  flags: Record<string, FlagValue>,
): void {
  const label = `amp skills ${verb}`;
  const allowed = new Set(SKILLS_GLOBAL_FLAGS[verb]);
  if (verb === 'list') allowed.add('region');
  assertFlagsAllowed(allowed, label, flags);
}

export interface SkillsCommandDeps {
  /** Raw stdout write — the caller supplies its own newlines. */
  write?: (chunk: string) => void;
  isTTY?: boolean;
  path?: string;
  fetchIndex?: (baseUrl: string) => Promise<SkillIndexEntry[]>;
  fetchDocument?: (baseUrl: string, name: string) => Promise<string>;
}

function writeStdout(chunk: string): void {
  process.stdout.write(chunk);
}

function resolveExampleSkillName(index: SkillIndexEntry[]): string | undefined {
  const example =
    index.find(
      (entry) => normalizeWhitespace(entry.name) === 'integrating-amplitude',
    ) ?? index.at(-1);
  return example === undefined ? undefined : normalizeWhitespace(example.name);
}

function formatIndexText(index: SkillIndexEntry[]): string {
  if (index.length === 0) {
    return 'No skills are currently available.';
  }

  const skills = index
    .map(
      (entry) =>
        `\`${normalizeWhitespace(entry.name)}\`\n${normalizeWhitespace(entry.description)}`,
    )
    .join('\n\n');
  const exampleName = resolveExampleSkillName(index);
  const example =
    exampleName === undefined
      ? ''
      : ` For example: \`amp skills get ${exampleName}\`.`;

  return `Available skills (${index.length}):\n\n${skills}\n\nRun \`amp skills get <name>\` to print a skill.${example}`;
}

export async function runSkillsList(
  flags: Record<string, FlagValue>,
  deps: SkillsCommandDeps = {},
): Promise<void> {
  const write = deps.write ?? writeStdout;
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const fetchIndex = deps.fetchIndex ?? fetchSkillIndex;
  const index = await fetchIndex(
    resolveSkillsListBaseUrl(flags, { path: deps.path }),
  );

  if (shouldUseJsonOutput({ jsonFlag: isFlagEnabled(flags.json), isTTY })) {
    write(`${formatJsonOutput({ data: index }, isTTY)}\n`);
    return;
  }

  write(`${formatIndexText(index)}\n`);
}

export async function runSkillsGet(
  name: string | undefined,
  flags: Record<string, FlagValue>,
  deps: SkillsCommandDeps = {},
): Promise<void> {
  if (name === undefined || name.length === 0) {
    throw usageError(
      'Pass the skill name: `amp skills get <name>`. Run `amp skills list` to see what is available.',
    );
  }

  const write = deps.write ?? writeStdout;
  const fetchDocument = deps.fetchDocument ?? fetchSkillDocument;
  const document = await fetchDocument(
    resolveSkillsGetBaseUrl(flags, { path: deps.path }),
    name,
  );
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);

  if (isFlagEnabled(flags.json)) {
    write(`${formatJsonOutput({ data: { name, document } }, isTTY)}\n`);
    return;
  }

  // Written raw, not via console.log: the document already ends in a newline, and
  // `amp skills get X > SKILL.md` has to be the bytes the server served.
  write(document);
}
