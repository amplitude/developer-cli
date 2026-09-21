import { describe, expect, it } from 'vitest';

import { buildCatalog } from './catalog';

describe('buildCatalog — API operations', () => {
  it('exposes the curated ingestion check command instead of the raw operation name', () => {
    const commands = buildCatalog();
    const check = commands.find(
      (command) => command.command.join(' ') === 'events check-ingestion',
    );

    expect(check).toMatchObject({
      example:
        'amp events check-ingestion --project <project_id> --event-type <event_type>',
      requiredScopes: ['analytics:read'],
    });
    expect(check?.flags).toEqual([
      {
        name: 'project_id',
        aliases: ['project', 'project-id'],
        type: 'string',
        required: true,
      },
      {
        name: 'event_type',
        aliases: ['event-type', 'type'],
        type: 'string',
        required: false,
        enum: undefined,
      },
      {
        name: 'lookback_minutes',
        aliases: ['lookback-minutes'],
        type: 'integer',
        required: false,
        enum: undefined,
      },
      {
        name: 'polling_timeout_seconds',
        aliases: ['timeout-seconds'],
        type: 'integer',
        required: false,
        enum: undefined,
      },
    ]);
    expect(
      commands.some(
        (command) =>
          command.command.join(' ') === 'events check-recent-event-ingestion',
      ),
    ).toBe(false);
  });

  it('describes the API-key ingestion check without OAuth credential flags', () => {
    const check = buildCatalog().find(
      (command) =>
        command.command.join(' ') === 'events check-ingestion-by-api-key',
    );

    expect(check).toMatchObject({
      description: expect.stringContaining('requires --region <us|eu>'),
      example:
        'amp events check-ingestion-by-api-key --api-key <api_key> --region <us|eu>',
      requiredScopes: [],
      summary: 'Check recent event ingestion with an ingestion API key',
    });
    expect(check?.flags).toEqual([
      {
        name: 'api_key',
        aliases: ['api-key'],
        type: 'string',
        required: true,
        enum: undefined,
      },
      {
        name: 'polling_timeout_seconds',
        aliases: ['timeout-seconds'],
        type: 'integer',
        required: false,
        enum: undefined,
      },
    ]);
    expect(check?.globalFlags).not.toContain('token');
    expect(check?.globalFlags).not.toContain('profile');
  });

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
      'skills list',
      'skills get',
    ]) {
      expect(commands.has(routed)).toBe(true);
    }
  });

  it('assigns distinct endpoint flags to the two skills verbs', () => {
    const list = buildCatalog().find(
      (command) => command.command.join(' ') === 'skills list',
    );
    const get = buildCatalog().find(
      (command) => command.command.join(' ') === 'skills get',
    );

    expect(list?.globalFlags).toEqual([
      'json',
      'env',
      'help',
      'h',
      'version',
      'v',
    ]);
    expect(get?.globalFlags).toEqual([
      'json',
      'env',
      'region',
      'help',
      'h',
      'version',
      'v',
    ]);
  });
});
