import { describe, expect, it, vi } from 'vitest';

import { buildCatalog } from './catalog';
import { printCommandHelp } from './help';

describe('help JSON drift', () => {
  it('the rendered JSON help contains every catalog command', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let out = '';
    try {
      printCommandHelp([], { json: true, isTTY: false });
      out = log.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      log.mockRestore();
    }
    const dumped = new Set(
      JSON.parse(out).commands.map((c: { command: string }) => c.command),
    );
    for (const entry of buildCatalog()) {
      expect(dumped.has(entry.command.join(' '))).toBe(true);
    }
  });
});
