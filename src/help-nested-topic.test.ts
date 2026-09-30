import { describe, expect, it, vi } from 'vitest';

import type { CatalogCommand } from './catalog';
import { printCommandHelp } from './help';

// A synthetic three-level command family, added on top of the real catalog so
// multi-token help stays covered regardless of which command families the
// current spec happens to expose.
const NESTED_FAMILY: CatalogCommand[] = ['list', 'get', 'create'].map(
  (verb) => ({
    command: ['widgets', 'schedules', verb],
    summary: `${verb} widget schedules`,
    group: 'widgets',
    flags: [],
    globalFlags: [],
    requiredScopes: ['widgets:read'],
  }),
);

vi.mock('./catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./catalog')>();
  return {
    ...actual,
    buildCatalog: () => [...actual.buildCatalog(), ...NESTED_FAMILY],
  };
});

function capture(fn: () => void): string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    fn();
    return log.mock.calls.map((call) => String(call[0])).join('\n');
  } finally {
    log.mockRestore();
  }
}

describe('help for a multi-token command prefix', () => {
  it('json → compact index of the commands under the prefix, and only those', () => {
    const parsed = JSON.parse(
      capture(() =>
        printCommandHelp(['widgets', 'schedules'], {
          json: true,
          isTTY: false,
        }),
      ),
    );
    expect(parsed.command).toBe('widgets schedules');
    expect(typeof parsed.detail).toBe('string');
    expect(
      parsed.commands.map((c: { command: string }) => c.command).sort(),
    ).toEqual([
      'widgets schedules create',
      'widgets schedules get',
      'widgets schedules list',
    ]);
    for (const entry of parsed.commands) {
      expect(entry).not.toHaveProperty('flags');
    }
  });

  it('json → the one-token group still expands to every command beneath it', () => {
    const parsed = JSON.parse(
      capture(() =>
        printCommandHelp(['widgets'], { json: true, isTTY: false }),
      ),
    );
    expect(parsed.command).toBe('widgets');
    expect(parsed.commands).toHaveLength(NESTED_FAMILY.length);
  });

  it('prose → lists the commands under the prefix', () => {
    const output = capture(() => printCommandHelp(['widgets', 'schedules']));
    expect(output).toContain('amp widgets schedules — available commands:');
    expect(output).toContain('widgets schedules list');
    expect(output).toContain('widgets schedules create');
  });

  it('an unknown nested prefix still throws a usage error', () => {
    expect(() =>
      printCommandHelp(['widgets', 'nope'], { json: true, isTTY: false }),
    ).toThrow(/Unknown command: widgets nope/);
  });
});
