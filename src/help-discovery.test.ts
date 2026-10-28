import { describe, expect, it, vi } from 'vitest';

import { buildCatalog, findCatalogCommand } from './catalog';
import { CLI_OPERATIONS } from './generated/cli-manifest';
import { printCommandHelp } from './help';
import { assertKnownFlags, buildRequest } from './request';

describe('write discovery', () => {
  it('accepts every advertised API flag name', () => {
    for (const operation of CLI_OPERATIONS) {
      const entry = findCatalogCommand(operation.command)!;
      for (const flag of entry.flags) {
        expect(
          () => assertKnownFlags(operation, { [flag.name]: 'value' }),
          `${entry.command.join(' ')} --${flag.name}`,
        ).not.toThrow();
      }
    }
  });

  it('builds a request using canonical names and JSON object-array flags', () => {
    const operation = CLI_OPERATIONS.find(
      (op) => op.command.join(' ') === 'agent-analytics evaluators create',
    )!;
    const tags = [
      { id: 'true', label: 'True', description: 'Helpful' },
      { id: 'false', label: 'False', description: 'Not helpful' },
    ];
    const request = buildRequest(operation, {
      project_id: '12345',
      topic: 'Helpfulness',
      output_type: 'binary',
      description: 'Rate helpfulness',
      tags: JSON.stringify(tags),
      'idempotency-key': 'test-key-12345',
    });
    expect(request.path).toContain('/projects/12345/');
    expect(request.body?.tags).toEqual(tags);
    expect(request.headers['Idempotency-Key']).toBe('test-key-12345');
  });

  it('exposes tag item schema, array encoding, idempotency and DELETE confirmation', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printCommandHelp(['agent-analytics', 'evaluators', 'create'], {
        json: true,
      });
      const detail = JSON.parse(String(log.mock.calls[0][0]));
      const tags = detail.flags.find(
        (f: { name: string }) => f.name === 'tags',
      );
      expect(tags.items).toMatchObject({
        type: 'object',
        required: ['id', 'label', 'description'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
        },
      });
      expect(tags.description).toContain('JSON array');
      expect(
        detail.flags.find(
          (f: { name: string }) => f.name === 'idempotency-key',
        ),
      ).toMatchObject({
        required: false,
        description: expect.stringContaining(
          'does not guarantee retry deduplication',
        ),
      });
      const remove = buildCatalog().find(
        (c) =>
          c.command.join(' ') === 'agent-analytics datasets remove-sessions',
      );
      expect(remove?.description).toContain('--yes');
      expect(remove?.description).toContain('--dry-run');
    } finally {
      log.mockRestore();
    }
  });
});
