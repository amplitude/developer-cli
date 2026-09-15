import { describe, expect, it, vi } from 'vitest';

import { buildCatalog } from './catalog';
import { printCommandHelp, serializeCatalog } from './help';

const INDEX_ALLOWLIST = [
  'command',
  'group',
  'requiredScopes',
  'summary',
].sort();

// Tripwire: the fields below are the only ones a per-command detail object is
// allowed to serialize. `order` and `destructive` must never appear — the
// latter would be method-derived, not authoritative/sourced from the OpenAPI
// spec. Adding a new serialized field (the next `destructive`) fails this test,
// forcing a deliberate "is this field authoritative/sourced, not invented?"
// decision in review before it ships on the catalog's public JSON surface.
const DETAIL_ALLOWLIST = [
  'command',
  'description',
  'example',
  'flags',
  'group',
  'positional',
  'requiredScopes',
  'summary',
];

// Fields the catalog once carried and deliberately removed; they must never
// reappear on the serialized surface. `agentNote` was audience-targeting copy;
// `destructive`/`order` are non-authoritative/presentation-only.
const FORBIDDEN_DETAIL_FIELDS = ['agentNote', 'destructive', 'order'];

function captureJson(fn: () => void) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    fn();
    return JSON.parse(log.mock.calls.map((call) => String(call[0])).join(''));
  } finally {
    log.mockRestore();
  }
}

describe('catalog shape — serialized field allowlist', () => {
  it('every index entry exposes exactly command/group/requiredScopes/summary', () => {
    const dump = serializeCatalog();
    expect(dump.commands.length).toBeGreaterThan(0);

    for (const entry of dump.commands) {
      expect(
        Object.keys(entry).sort(),
        `index entry \`${entry.command}\` has unexpected keys`,
      ).toEqual(INDEX_ALLOWLIST);
    }
  });

  it('every command detail object carries only allowlisted fields', () => {
    for (const command of buildCatalog()) {
      const detail = captureJson(() =>
        printCommandHelp(command.command, { json: true, isTTY: false }),
      );
      const keys = Object.keys(detail);
      const label = command.command.join(' ');
      const unknownKeys = keys.filter((key) => !DETAIL_ALLOWLIST.includes(key));
      expect(unknownKeys, `\`${label}\` serializes unknown field(s)`).toEqual(
        [],
      );
      for (const forbidden of FORBIDDEN_DETAIL_FIELDS) {
        expect(
          keys,
          `\`${label}\` must not serialize ${forbidden}`,
        ).not.toContain(forbidden);
      }
    }
  });

  // A required argument is part of the input contract. `flags` already carries
  // `required`, so a command whose only input is positional would otherwise
  // serialize as taking no input at all — an agent would have to fail once, or
  // parse prose, to discover it.
  it('serializes a required positional argument for every command that takes one', () => {
    for (const command of buildCatalog()) {
      if (command.positional === undefined) {
        continue;
      }

      const detail = captureJson(() =>
        printCommandHelp(command.command, { json: true, isTTY: false }),
      );

      expect(
        detail.positional,
        `\`${command.command.join(' ')}\` hides its positional argument`,
      ).toEqual(command.positional);
    }
  });

  it('declares the positional on the two commands that take one', () => {
    const withPositional = buildCatalog()
      .filter((command) => command.positional !== undefined)
      .map((command) => command.command.join(' '))
      .sort();

    expect(withPositional).toEqual(['auth use', 'skills get']);
  });
});
