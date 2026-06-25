import { describe, expect, it } from 'vitest';

import { parseArgs } from './args';
import { CLI_OPERATIONS, type CliOperation } from './generated/cli-manifest';
import {
  buildRequest,
  operationSupportsDryRun,
  parseResponseBody,
} from './request';

const AUTH = 'Bearer test';

function operation(command: string[]): CliOperation {
  const found = CLI_OPERATIONS.find(
    (candidate) =>
      candidate.command.length === command.length &&
      candidate.command.every((part, index) => part === command[index]),
  );

  if (!found) {
    throw new Error(`Missing CLI operation ${command.join(' ')}.`);
  }

  return found;
}

function request(command: string[], argv: string[]) {
  const parsed = parseArgs([...command, ...argv]);
  return buildRequest(operation(command), parsed.flags, AUTH);
}

describe('manifest invariants', () => {
  it('does not generate duplicate aliases within a command', () => {
    for (const cliOperation of CLI_OPERATIONS) {
      const aliases = new Map<string, string>();
      for (const item of [...cliOperation.parameters, ...cliOperation.body]) {
        for (const alias of item.aliases) {
          expect(
            aliases.get(alias),
            `${cliOperation.command.join(' ')} duplicates --${alias}`,
          ).toBeUndefined();
          aliases.set(alias, item.name);
        }
      }
    }
  });

  it('excludes Auth-tagged operations from the generated manifest', () => {
    const authOps = CLI_OPERATIONS.filter((cliOperation) =>
      cliOperation.path.startsWith('/v1/auth/'),
    );
    expect(authOps).toEqual([]);
  });
});

describe('buildRequest', () => {
  it('sends bare dry-run flags as query parameters', () => {
    const built = request(
      ['events', 'delete'],
      ['--project', '187520', '--event', 'signup', '--dry-run'],
    );

    expect(built.path).toBe('/v1/projects/187520/events/signup?dry_run=true');
  });

  it('sends bare boolean body flags', () => {
    const built = request(
      ['event-properties', 'create'],
      [
        '--project',
        '187520',
        '--event',
        'signup',
        '--property',
        'plan',
        '--data-type',
        'string',
        '--is-hidden',
        '--is-array',
      ],
    );

    expect(built.body).toMatchObject({
      data_type: 'string',
      is_array_type: true,
      is_hidden: true,
    });
  });

  it('parses referenced object and array body schemas as JSON', () => {
    const built = request(
      ['flags', 'create'],
      [
        '--project',
        '187520',
        '--key',
        'rollout-test',
        '--name',
        'Rollout Test',
        '--rollout-weights',
        '{"on":1,"off":0}',
        '--target-segments',
        '[{"conditions":[],"percentage":100,"rollout_weights":{"on":1}}]',
      ],
    );

    expect(built.body).toMatchObject({
      rollout_weights: { on: 1, off: 0 },
      target_segments: [
        {
          conditions: [],
          percentage: 100,
          rollout_weights: { on: 1 },
        },
      ],
    });
  });

  it('rejects string-valued flags passed without a value', () => {
    expect(() =>
      buildRequest(
        operation(['events', 'create']),
        {
          project: '187520',
          'body-json': true,
        },
        AUTH,
      ),
    ).toThrowError('Expected --body-json to have a value.');
  });

  it('accepts a JSON object for --body-json and merges it', () => {
    const built = request(
      ['events', 'create'],
      ['--project', '187520', '--body-json', '{"event_type":"signup"}'],
    );

    expect(built.body).toMatchObject({ event_type: 'signup' });
  });

  it('rejects --body-json for operations without request bodies', () => {
    expect(() =>
      request(['context'], ['--body-json', '{"unexpected":true}']),
    ).toThrowError('`amp context` does not accept a request body.');
  });

  it('rejects non-object --body-json values', () => {
    expect(() =>
      request(
        ['events', 'create'],
        ['--project', '187520', '--body-json=[1,2]'],
      ),
    ).toThrowError('--body-json must be a JSON object.');

    expect(() =>
      request(
        ['events', 'create'],
        ['--project', '187520', '--body-json=null'],
      ),
    ).toThrowError('--body-json must be a JSON object.');

    expect(() =>
      request(['events', 'create'], ['--project', '187520', '--body-json=42']),
    ).toThrowError('--body-json must be a JSON object.');

    expect(() =>
      request(['events', 'create'], ['--project', '187520', '--body-json=']),
    ).toThrowError('--body-json must be a JSON object.');
  });

  it('rejects empty required path and body flags', () => {
    expect(() => request(['events', 'list'], ['--project='])).toThrowError(
      'Missing --project <project_id>.',
    );

    expect(() =>
      request(
        ['events', 'create'],
        ['--project', '187520', '--event-type', ''],
      ),
    ).toThrowError('Missing --event-type <event_type>.');
  });
});

describe('operationSupportsDryRun', () => {
  it('detects the dry_run parameter', () => {
    expect(operationSupportsDryRun(operation(['events', 'delete']))).toBe(true);
    expect(operationSupportsDryRun(operation(['events', 'get']))).toBe(false);
  });
});

describe('parseResponseBody', () => {
  it('parses JSON, keeps non-JSON text, and maps empty to null', () => {
    expect(parseResponseBody('{"ok":true}')).toEqual({ ok: true });
    expect(parseResponseBody('<html>bad gateway</html>')).toBe(
      '<html>bad gateway</html>',
    );
    expect(parseResponseBody('')).toBeNull();
  });
});
