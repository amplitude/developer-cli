import { describe, expect, it, vi } from 'vitest';

import { catalogGroups } from './catalog';
import { CliError } from './cli-error';
import {
  authHelpText,
  findOperation,
  listProductSurfaces,
  operationsMatchingPrefix,
  printCommandHelp,
  printGlobalHelp,
  serializeCatalog,
} from './help';
import { normalizeWhitespace } from './output';

describe('help', () => {
  it('lists all catalog groups for top-level help, including charts', () => {
    const surfaces = listProductSurfaces().map((surface) => surface.label);
    expect(surfaces).toContain('charts');
    expect(surfaces.slice(0, 6)).toEqual([
      'context',
      'projects',
      'events',
      'event-properties',
      'user-properties',
      'flags',
    ]);
  });

  it('excludes auth from product surfaces since it has its own help section', () => {
    const surfaces = listProductSurfaces().map((surface) => surface.label);
    expect(surfaces).not.toContain('auth');
    expect(surfaces).toContain('charts');
  });

  it('shows per-flag descriptions in per-command help for auth commands', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printCommandHelp(['auth', 'login', 'start']);
      const output = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toMatch(/Target region/);
    } finally {
      log.mockRestore();
    }
  });

  it('renders the semantic description as prose, with no "Agents:" heading', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printCommandHelp(['auth', 'login', 'start']);
      const output = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toMatch(/device authorization/);
      expect(output).not.toMatch(/Agents:/);
    } finally {
      log.mockRestore();
    }
  });

  it('finds an exact operation', () => {
    expect(findOperation(['flags', 'list'])?.operationId).toBe(
      'listFeatureFlags',
    );
  });

  it('finds operations under a command prefix', () => {
    const matches = operationsMatchingPrefix(['flags']);
    expect(matches.length).toBeGreaterThan(1);
    expect(matches.every((operation) => operation.command[0] === 'flags')).toBe(
      true,
    );
  });

  it('has auth-specific help outside the generated manifest', () => {
    const help = authHelpText();
    expect(help).toContain('amp auth login');
    expect(help).toContain('amp auth status');
    expect(help).toContain('--profile');
    expect(help).toContain('--region');
    expect(help).not.toContain('--env');
    expect(help).not.toContain('--base-url');
  });

  it('mentions the scripting-friendly login start/poll verbs', () => {
    const help = authHelpText();
    expect(help).toMatch(/login start/);
    expect(help).toMatch(/login poll/);
  });

  it('describes --profile as optional, defaulting to the implicit "default" profile', () => {
    const help = authHelpText();
    expect(help).toMatch(/implicit `default` profile/);
    expect(help).not.toMatch(/needs both --profile/);
  });

  it('describes DELETE safety without overstating --dry-run support', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printGlobalHelp();
      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('Skip interactive confirmation for DELETE');
      expect(output).toContain('Preview supported DELETE commands');
      expect(output).not.toContain('unless --dry-run is set');
    } finally {
      log.mockRestore();
    }
  });

  it('documents --region and not --env/--base-url in global help', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printGlobalHelp();
      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('--region <us|eu>');
      expect(output).not.toContain('--env');
      expect(output).not.toContain('--base-url');
    } finally {
      log.mockRestore();
    }
  });

  it('collapses embedded newlines and extra whitespace', () => {
    expect(normalizeWhitespace('a\n\n  b')).toBe('a b');
  });

  it('orders curated groups before auth', () => {
    const groups = catalogGroups().map((group) => group.group);
    const curated = groups.filter((group) => group !== 'auth');
    expect(curated).toEqual([
      'context',
      'projects',
      'events',
      'event-properties',
      'user-properties',
      'flags',
      'charts',
    ]);
    expect(groups.indexOf('auth')).toBeGreaterThan(groups.indexOf('charts'));
  });

  it('describes the JSON output surface behaviorally in prose global help', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printGlobalHelp();
      const out = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toMatch(/--json/);
      expect(out).toMatch(/JSON/);
      expect(out).not.toMatch(/agents/i);
    } finally {
      log.mockRestore();
    }
  });

  it('documents the exit-code / JSON-on-stderr error contract in global help', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printGlobalHelp();
      const out = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toMatch(/exit/);
      expect(out).toMatch(/JSON/);
      expect(out).toMatch(/stderr/);
    } finally {
      log.mockRestore();
    }
  });
});

describe('help JSON', () => {
  const capture = (fn: () => void): string => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      fn();
      return log.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      log.mockRestore();
    }
  };

  it('serializeCatalog dumps cli, spec, a drilldown hint, and a compact index of every catalog command', () => {
    const dump = serializeCatalog();
    expect(typeof dump.cli).toBe('string');
    expect(typeof dump.spec).toBe('string');
    expect(typeof dump.detail).toBe('string');
    const paths = dump.commands.map((c) => c.command);
    expect(paths).toContain('charts list');
    expect(paths).toContain('auth login start');
  });

  it('empty topic + json → compact index, not full detail', () => {
    const parsed = JSON.parse(
      capture(() => printCommandHelp([], { json: true, isTTY: false })),
    );
    expect(Array.isArray(parsed.commands)).toBe(true);
    expect(typeof parsed.detail).toBe('string');
    for (const entry of parsed.commands) {
      expect(Object.keys(entry).sort()).toEqual(
        ['command', 'group', 'requiredScopes', 'summary'].sort(),
      );
      expect(entry).not.toHaveProperty('flags');
      expect(entry).not.toHaveProperty('agentNote');
      expect(entry).not.toHaveProperty('order');
      expect(entry).not.toHaveProperty('destructive');
    }
  });

  it('the compact index is far smaller than a full per-command dump would be', () => {
    const out = capture(() =>
      printCommandHelp([], { json: true, isTTY: false }),
    );
    // Old behavior dumped every flag/enum/description for all ~34 commands (~19KB).
    // The compact index should stay well under half that.
    expect(out.length).toBeLessThan(8000);
  });

  it('exact command + json → full detail, with flags, and no order', () => {
    const parsed = JSON.parse(
      capture(() =>
        printCommandHelp(['auth', 'login', 'start'], {
          json: true,
          isTTY: false,
        }),
      ),
    );
    expect(parsed.command).toBe('auth login start');
    expect(parsed.description).toMatch(/device authorization/);
    expect(parsed.description).toMatch(/poll/);
    expect(parsed).not.toHaveProperty('agentNote');
    expect(parsed).not.toHaveProperty('order');
    expect(parsed).not.toHaveProperty('destructive');
  });

  it('exact command + json → flags array with a required flag, no order', () => {
    const parsed = JSON.parse(
      capture(() =>
        printCommandHelp(['flags', 'create'], { json: true, isTTY: false }),
      ),
    );
    expect(parsed.command).toBe('flags create');
    expect(Array.isArray(parsed.flags)).toBe(true);
    expect(parsed.flags.some((f: { required: boolean }) => f.required)).toBe(
      true,
    );
    expect(parsed).not.toHaveProperty('order');
  });

  it('surface + json → compact index entries for that group only', () => {
    const parsed = JSON.parse(
      capture(() => printCommandHelp(['flags'], { json: true, isTTY: false })),
    );
    expect(parsed.command).toBe('flags');
    expect(typeof parsed.detail).toBe('string');
    expect(
      parsed.commands.every((c: { group: string }) => c.group === 'flags'),
    ).toBe(true);
    for (const entry of parsed.commands) {
      expect(entry).not.toHaveProperty('flags');
      expect(entry).not.toHaveProperty('order');
    }
  });

  it('exact command wins over group filter for `context` (both a command and a group)', () => {
    const parsed = JSON.parse(
      capture(() =>
        printCommandHelp(['context'], { json: true, isTTY: false }),
      ),
    );
    expect(parsed.command).toBe('context');
    expect(parsed.commands).toBeUndefined();
  });

  it('unknown topic + json → throws a usage error instead of returning a bespoke error shape', () => {
    expect(() =>
      printCommandHelp(['nope', 'x'], { json: true, isTTY: false }),
    ).toThrow(/Unknown command: nope x/);
  });

  it('unknown topic + prose → throws a usage error instead of printing global help', () => {
    expect(() => printCommandHelp(['nope', 'x'])).toThrow(
      /Unknown command: nope x/,
    );
  });

  it('unknown topic throws a structured CliError (usage_error, exit 2)', () => {
    try {
      printCommandHelp(['nope', 'x'], { json: true, isTTY: false });
      expect.unreachable('printCommandHelp should have thrown');
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      expect(error.errorCode).toBe('usage_error');
      expect(error.exitCode).toBe(2);
    }
  });

  it('json:false keeps prose (contains Usage:)', () => {
    const out = capture(() =>
      printCommandHelp(['flags', 'list'], { json: false }),
    );
    expect(out).toContain('Usage:');
  });
});
