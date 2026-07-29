import { describe, expect, it, vi } from 'vitest';

import { buildCatalog } from './catalog';
import { hintForErrorCode } from './errors';
import { authHelpText, printGlobalHelp } from './help';

// Generalizes the single audience-targeting/prescriptive-copy guard that used
// to live only on the auth hint (errors.test.ts) to every piece of
// user-facing copy the CLI emits about commands. The principle: describe
// behavior semantically for both readers (humans and agents); prescriptive
// agent recipes don't belong in summaries/descriptions/hints/help.
const BANNED_PATTERNS: RegExp[] = [
  /\bAgents?\s*\/?\s*CI\b/i, // audience segmentation ("Agents/CI: ...")
  /\bInteractive:/, // audience segmentation ("Interactive: ...")
  /\bfor agents\b/i, // audience targeting
  /\bfor scripted\b/i, // audience targeting
  /agent-friendly path/i, // audience targeting
  /\(agent path\)/i, // audience targeting
  /then run .*(until|then)/i, // scripted recipe ("then run X until/then Y")
];

const KNOWN_ERROR_CODES = [
  'authentication_required',
  'invalid_token',
  'insufficient_scope',
  'validation_error',
  'not_found',
  'auth_unavailable',
  'upstream_error',
] as const;

interface CopySample {
  source: string;
  text: string;
}

function capture(fn: () => void): string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    fn();
    return log.mock.calls.map((call) => String(call[0])).join('\n');
  } finally {
    log.mockRestore();
  }
}

function collectCopy(): CopySample[] {
  const samples: CopySample[] = [];

  for (const command of buildCatalog()) {
    const label = command.command.join(' ');
    samples.push({
      source: `catalog[${label}].summary`,
      text: command.summary,
    });
    if (command.description) {
      samples.push({
        source: `catalog[${label}].description`,
        text: command.description,
      });
    }
    for (const flag of command.flags) {
      if (flag.description) {
        samples.push({
          source: `catalog[${label}].flags[${flag.name}].description`,
          text: flag.description,
        });
      }
    }
  }

  for (const code of KNOWN_ERROR_CODES) {
    const hint = hintForErrorCode(code);
    if (hint) {
      samples.push({ source: `hintForErrorCode(${code})`, text: hint });
    }
  }

  samples.push({
    source: 'printGlobalHelp()',
    text: capture(() => printGlobalHelp()),
  });
  samples.push({ source: 'authHelpText()', text: authHelpText() });

  return samples;
}

describe('semantic copy — no audience-targeting or prescriptive language', () => {
  const samples = collectCopy();

  it('collected copy from every catalog command, error hint, and help surface', () => {
    // Sanity floor so a refactor that empties `samples` can't silently make
    // every pattern check below vacuously pass.
    expect(samples.length).toBeGreaterThan(20);
  });

  for (const pattern of BANNED_PATTERNS) {
    it(`no collected copy matches ${pattern}`, () => {
      const offenders = samples
        .filter((sample) => pattern.test(sample.text))
        .map((sample) => `${sample.source}: ${JSON.stringify(sample.text)}`);
      expect(offenders).toEqual([]);
    });
  }
});
