import { describe, expect, it } from 'vitest';

import { buildCatalog } from './catalog';

describe('buildCatalog — API operations', () => {
  it('includes the charts surface (regression: charts was hidden from help)', () => {
    const groups = new Set(buildCatalog().map((c) => c.group));
    expect(groups.has('charts')).toBe(true);
  });

  it('maps flags with type and required but no description (API commands are undescribed in this PR)', () => {
    const list = buildCatalog().find(
      (c) => c.command.join(' ') === 'projects list',
    );
    const limit = list?.flags.find((f) => f.name === 'limit');
    expect(limit?.type).toBe('integer');
    expect(limit?.required).toBe(false);
    expect(limit?.description).toBeUndefined();
  });

  it('carries an enum through from a body property to the catalog flag', () => {
    const create = buildCatalog().find(
      (c) => c.command.join(' ') === 'event-properties create',
    );
    const dataType = create?.flags.find((f) => f.name === 'data_type');
    expect(dataType?.enum).toEqual([
      'string',
      'number',
      'boolean',
      'object',
      'enum',
      'any',
    ]);
  });
});

describe('buildCatalog — auth/meta commands', () => {
  it('describes auth login start behaviorally, with no agentNote field', () => {
    const start = buildCatalog().find(
      (c) => c.command.join(' ') === 'auth login start',
    );
    expect(start?.group).toBe('auth');
    expect(start?.description).toMatch(/device authorization/);
    expect(start?.description).toMatch(/poll/);
    for (const entry of buildCatalog()) {
      expect(entry).not.toHaveProperty('agentNote');
    }
  });

  it('carries the hand-authored description for an auth flag', () => {
    const start = buildCatalog().find(
      (c) => c.command.join(' ') === 'auth login start',
    );
    const region = start?.flags.find((f) => f.name === 'region');
    expect(region?.description).toBeDefined();
    expect(region?.description).toMatch(/region/);
  });

  it('covers every auth/meta command the CLI routes', () => {
    // `version` and `help` are also routed by cli.ts but are intentionally NOT
    // catalog entries — they're documented in the global-help header instead,
    // so this parity list is deliberately auth/meta-command-scoped.
    const commands = new Set(buildCatalog().map((c) => c.command.join(' ')));
    for (const routed of [
      'auth login',
      'auth login start',
      'auth login poll',
      'auth pat',
      'auth use',
      'auth list',
      'auth status',
      'auth token',
      'logout',
    ]) {
      expect(commands.has(routed)).toBe(true);
    }
  });
});
