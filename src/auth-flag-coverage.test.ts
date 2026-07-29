import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { globalOptionAliases } from './args';
import { buildCatalog } from './catalog';

/**
 * `auth-commands.ts`'s handlers dispatch outside `buildRequest`, so the only
 * thing standing between a typo'd flag and a silent no-op is
 * `assertKnownAuthFlags` in cli.ts rejecting anything not in
 * globals ∪ the catalog's hand-authored `AUTH_COMMANDS` flags. That reject is
 * only safe if every flag alias a handler actually reads is declared
 * somewhere in that allowed set — otherwise a legitimate flag a handler reads
 * could be falsely rejected before the handler ever sees it. `auth-commands.ts`
 * itself delegates its `env`/`region`/`base-url`/`token`/`profile` reads to
 * `resolveAuthFromFlags`/`selectProfileFromFlags` in `credential-resolver.ts`,
 * so this test scans BOTH files with the same extraction and asserts every
 * alias referenced in either is covered. The boundary this test enforces: it
 * covers exactly the flag reads reachable from an auth/logout handler today
 * (`auth-commands.ts` + `credential-resolver.ts`). If a handler is ever
 * changed to delegate flag-reading to some OTHER module, that module must be
 * added to `SCANNED_FILES` below, or its reads become invisible to this
 * guard.
 */

const SCANNED_FILES = ['auth-commands.ts', 'credential-resolver.ts'];

const SCANNED_SOURCE = SCANNED_FILES.map((file) =>
  readFileSync(join(__dirname, file), 'utf8'),
).join('\n');

/**
 * Every flag alias a scanned file reads off `flags`, via any of the
 * recognized read patterns:
 *   - `stringFlag(flags, [...])` / `flagValue(flags, [...])` / `hasFlag(flags, [...])`
 *   - `isFlagEnabled(flags['x'])` / `isFlagEnabled(flags.x)`
 *   - direct `flags['x']` / `flags.x` reads
 * Intentionally over-broad rather than under: a pattern matching more call
 * sites than strictly necessary only means more aliases must be covered,
 * which is the safe direction for a guard against false-positive rejects.
 */
function extractReferencedAliases(source: string): Set<string> {
  const aliases = new Set<string>();

  // stringFlag(flags, ['a', 'b']) / flagValue(flags, [...]) / hasFlag(flags, [...])
  const arrayCallPattern =
    /\b(?:stringFlag|flagValue|hasFlag)\(\s*flags\s*,\s*\[([^\]]*)\]/g;
  for (const match of source.matchAll(arrayCallPattern)) {
    for (const literal of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
      aliases.add(literal[1]);
    }
  }

  // flags['with-token'] / flags["with-token"]
  const bracketAccessPattern = /\bflags\[\s*['"]([^'"]+)['"]\s*\]/g;
  for (const match of source.matchAll(bracketAccessPattern)) {
    aliases.add(match[1]);
  }

  // flags.force / flags.json / flags.all / flags.yes
  const dotAccessPattern = /\bflags\.([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(dotAccessPattern)) {
    aliases.add(match[1]);
  }

  return aliases;
}

function allowedAuthFlagAliases(): Set<string> {
  const catalogAuthAliases = buildCatalog()
    .filter((entry) => entry.group === 'auth')
    .flatMap((entry) => entry.flags.flatMap((flag) => flag.aliases));
  return new Set([...globalOptionAliases(), ...catalogAuthAliases]);
}

describe('auth handler flag-read coverage', () => {
  it('extracts a non-empty, sane set of referenced aliases (sanity check on the extractor itself)', () => {
    const referenced = extractReferencedAliases(SCANNED_SOURCE);
    // Known reads as of writing — asserting a floor guards against the
    // extractor silently regressing to matching nothing.
    for (const expected of ['profile', 'region', 'with-token', 'all']) {
      expect(referenced.has(expected)).toBe(true);
    }
  });

  it('covers every flag alias the scanned files read with globals ∪ AUTH_COMMANDS catalog flags', () => {
    const referenced = extractReferencedAliases(SCANNED_SOURCE);
    const allowed = allowedAuthFlagAliases();

    const uncovered = [...referenced].filter((alias) => !allowed.has(alias));

    expect(
      uncovered,
      `${SCANNED_FILES.join(', ')} read flag alias(es) not covered by GLOBAL_OPTIONS or any AUTH_COMMANDS catalog entry: ${uncovered.join(', ')}. ` +
        'Declare the flag on the relevant AUTH_COMMANDS entry in catalog.ts (or, if it should apply to every command, add it to GLOBAL_OPTIONS in args.ts) — ' +
        'otherwise the misplaced-flag reject can falsely reject a legitimate auth flag.',
    ).toEqual([]);
  });
});
