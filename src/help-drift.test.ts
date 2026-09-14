import { describe, expect, it, vi } from 'vitest';

import { buildCatalog } from './catalog';
import { listProductSurfaces, printCommandHelp } from './help';

function capture(fn: () => void): string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    fn();
    return log.mock.calls.map((c) => String(c[0])).join('\n');
  } finally {
    log.mockRestore();
  }
}

describe('help drift guard', () => {
  it('surfaces every non-auth catalog group as a product-surface row', () => {
    const rowLabels = new Set(listProductSurfaces().map((s) => s.label));
    const groups = new Set(buildCatalog().map((c) => c.group));
    for (const group of groups) {
      // auth has its own dedicated Usage section, not a product-surface row
      if (group === 'auth') continue;
      expect(rowLabels.has(group)).toBe(true);
    }
  });

  // `amp help <surface>` is advertised by global help and by the surface
  // overview, so every group has to answer to it — including the bespoke ones
  // (auth, skills) that have no generated manifest entry to list from.
  it('renders group help for every catalog group', () => {
    const groups = new Set(buildCatalog().map((c) => c.group));
    for (const group of groups) {
      const out = capture(() => printCommandHelp([group]));
      expect(out).toContain(group);
    }
  });

  // A footer naming a flag the command answers with `usage_error` sends an agent
  // straight into exit 2, so the advertised set has to be a subset of the
  // accepted one for every command, not just the generated ones.
  it('never advertises a global flag the command rejects', () => {
    for (const entry of buildCatalog()) {
      const footer = capture(() => printCommandHelp(entry.command))
        .split('\n')
        .find((line) => line.startsWith('Global flags:'));
      const advertised =
        footer === undefined
          ? []
          : footer
              .replace('Global flags:', '')
              .split(',')
              .map((flag) => flag.trim().replace(/^--/, ''));

      for (const flag of advertised) {
        expect(
          entry.globalFlags,
          `\`${entry.command.join(' ')}\` advertises --${flag}`,
        ).toContain(flag);
      }
    }
  });

  it('renders per-command help for every catalog command', () => {
    for (const entry of buildCatalog()) {
      const out = capture(() => printCommandHelp(entry.command));
      expect(out).toContain(entry.command.join(' '));
    }
  });
});
