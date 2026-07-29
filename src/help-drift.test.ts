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

  it('renders per-command help for every catalog command', () => {
    for (const entry of buildCatalog()) {
      const out = capture(() => printCommandHelp(entry.command));
      expect(out).toContain(entry.command.join(' '));
    }
  });
});
