import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Tripwire: user-facing failures in this CLI must throw a structured
 * `CliError` (`usageError`/`authError`/`transportError`), never a bare
 * `Error` — a plain `Error` reaching `main()`'s catch renders as the
 * generic `error_code:"error"` / exit 1, which breaks the differentiated
 * exit-code contract (`error-contract.test.ts`).
 *
 * This scans every non-test source file for `throw new Error(` and requires
 * a `// plain-error-ok: <reason>` marker on the same line for the rare
 * genuine exception (e.g. a TTY-only cancellation that can't reach an agent
 * non-interactively). Anything unannotated fails, naming file:line, so a new
 * bare `throw new Error(...)` can't sneak back in unnoticed.
 *
 * Limitation: this is a textual match on the literal `throw new Error(`.
 * Aliasing it away (`const e = new Error('x'); throw e;`, or a factory that
 * returns/throws a plain `Error`) evades the scan. The convention is to
 * annotate the flagged line, not to alias around the guard.
 */

const SRC_DIR = join(__dirname);

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(fullPath);
    }
    if (
      extname(entry.name) === '.ts' &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      return [fullPath];
    }
    return [];
  });
}

function unannotatedThrowSites(): string[] {
  const offenders: string[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/\bthrow new Error\(/.test(line)) {
        return;
      }
      if (/\/\/\s*plain-error-ok:/.test(line)) {
        return;
      }
      offenders.push(`${relative(SRC_DIR, file)}:${index + 1}`);
    });
  }
  return offenders;
}

describe('CliError usage guard', () => {
  it('every `throw new Error(` is either converted to CliError or explicitly sanctioned', () => {
    const offenders = unannotatedThrowSites();
    expect(
      offenders,
      offenders.length
        ? [
            'user-facing failures must throw CliError (usageError/authError/transportError);',
            'if a bare Error is genuinely correct, annotate with `// plain-error-ok: <reason>`.',
            'Offending site(s):',
            ...offenders.map((site) => `  - ${site}`),
          ].join('\n')
        : undefined,
    ).toEqual([]);
  });
});
