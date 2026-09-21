import { describe, expect, it } from 'vitest';

import { parseArgs } from './args';
import { CliError } from './cli-error';
import { CLI_OPERATIONS, type CliOperation } from './generated/cli-manifest';
import { findOperation } from './help';
import {
  buildRequest,
  operationSupportsDryRun,
  parseResponseBody,
} from './request';

function operation(command: string[]): CliOperation {
  const found = findOperation(command);

  if (!found) {
    throw new Error(`Missing CLI operation ${command.join(' ')}.`);
  }

  return found;
}

function request(command: string[], argv: string[]) {
  const parsed = parseArgs([...command, ...argv]);
  return buildRequest(operation(command), parsed.flags);
}

describe('manifest invariants', () => {
  it('builds saved insight list/get requests and preserves project-level filtering', () => {
    const list = ['agent-analytics', 'insights', 'list'];
    expect(operation(list).requiredScopes).toEqual(['analytics:read']);
    expect(
      request(list, [
        '--project',
        '12345',
        '--agent-name',
        '',
        '--limit',
        '7',
        '--cursor',
        '',
      ]).path,
    ).toBe('/v1/projects/12345/agent-analytics/insights?limit=7&agent_name=');
    expect(request(list, ['--project', '12345']).path).toBe(
      '/v1/projects/12345/agent-analytics/insights',
    );
    expect(request(['projects', 'list'], ['--cursor', '']).path).toBe(
      '/v1/projects',
    );
    const id = 'a37cf684-96ca-48d8-86ca-9c6213b0ade5';
    expect(
      request(
        ['agent-analytics', 'insights', 'get'],
        ['--project', '12345', '--insight-id', id],
      ).path,
    ).toBe(`/v1/projects/12345/agent-analytics/insights/${id}`);
  });
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

  it('does not expose duplicate public commands', () => {
    const commands = CLI_OPERATIONS.map((cliOperation) =>
      cliOperation.command.join(' '),
    );

    expect(new Set(commands).size).toBe(commands.length);
  });

  it('excludes Auth-tagged operations from the generated manifest', () => {
    const authOps = CLI_OPERATIONS.filter((cliOperation) =>
      cliOperation.path.startsWith('/v1/auth/'),
    );
    expect(authOps).toEqual([]);
  });

  it('generates the ingestion check under its public command', () => {
    expect(CLI_OPERATIONS).toContainEqual(
      expect.objectContaining({
        command: ['events', 'check-ingestion'],
        operationId: 'checkRecentEventIngestion',
        path: '/v1/projects/{project_id}/events/check-recent-ingestion',
      }),
    );
  });

  it('generates the API-key ingestion check as an unauthenticated public command', () => {
    expect(CLI_OPERATIONS).toContainEqual(
      expect.objectContaining({
        authentication: 'none',
        body: [
          expect.objectContaining({
            aliases: ['api-key'],
            name: 'api_key',
            required: true,
          }),
          expect.objectContaining({
            aliases: ['timeout-seconds'],
            name: 'polling_timeout_seconds',
            required: false,
          }),
        ],
        command: ['events', 'check-ingestion-by-api-key'],
        operationId: 'checkRecentEventIngestionByApiKey',
        path: '/v1/events/check-recent-ingestion',
      }),
    );
  });
});

describe('buildRequest', () => {
  it('builds the filtered ingestion check without an idempotency key', () => {
    const checkOperation = operation(['events', 'check-ingestion']);
    const built = request(
      ['events', 'check-ingestion'],
      [
        '--project',
        '187520',
        '--event-type',
        'Checkout Completed',
        '--lookback-minutes',
        '30',
        '--timeout-seconds',
        '120',
      ],
    );

    expect(checkOperation.method).toBe('POST');
    expect(built).toEqual({
      body: {
        event_type: 'Checkout Completed',
        lookback_minutes: 30,
        polling_timeout_seconds: 120,
      },
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      path: '/v1/projects/187520/events/check-recent-ingestion',
    });
  });

  it('allows the ingestion check filters to be omitted', () => {
    const built = request(
      ['events', 'check-ingestion'],
      ['--project', '187520'],
    );

    expect(built.body).toEqual({});
    expect(built.headers).not.toHaveProperty('Idempotency-Key');
  });

  it.each([
    ['project', '187520'],
    ['event-type', 'Checkout Completed'],
    ['lookback-minutes', '30'],
    ['token', 'amp_test'],
    ['profile', 'default'],
  ])('rejects --%s for the API-key ingestion check', (flag, value) => {
    expect(() =>
      request(
        ['events', 'check-ingestion-by-api-key'],
        ['--api-key', 'project-api-key', `--${flag}`, value],
      ),
    ).toThrowError(
      `Unknown flag --${flag} for \`amp events check-ingestion-by-api-key\`.`,
    );
  });

  it('builds headers without an Authorization value — credentials are attached later, at fetch time', () => {
    const built = request(
      ['events', 'get'],
      ['--project', '187520', '--event', 'signup'],
    );

    expect(built.headers.Authorization).toBeUndefined();
    expect(built.headers.Accept).toBe('application/json');
  });

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
      buildRequest(operation(['events', 'create']), {
        project: '187520',
        'body-json': true,
      }),
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

  it('rejects malformed JSON as a usage error naming the flag, not a raw SyntaxError', () => {
    let caught: unknown;
    try {
      request(
        ['events', 'create'],
        ['--project', '187520', '--body-json={bad'],
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    if (!(caught instanceof CliError)) {
      throw new Error('Expected a CliError.');
    }
    expect(caught.errorCode).toBe('usage_error');
    expect(caught.exitCode).toBe(2);
    expect(caught.message).toBe('--body-json must be valid JSON.');
  });

  it('rejects malformed JSON in an object/array-typed body flag as a usage error', () => {
    expect(() =>
      request(
        ['flags', 'create'],
        [
          '--project',
          '187520',
          '--key',
          'k',
          '--name',
          'n',
          '--rollout-weights',
          '{bad',
        ],
      ),
    ).toThrowError('--rollout-weights must be valid JSON.');

    expect(() =>
      request(
        ['flags', 'create'],
        [
          '--project',
          '187520',
          '--key',
          'k',
          '--name',
          'n',
          '--target-segments',
          '[bad',
        ],
      ),
    ).toThrowError('--target-segments must be valid JSON.');
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

  it('throws a CliError with errorCode usage_error for a missing required flag', () => {
    let caught: unknown;
    try {
      request(['events', 'list'], ['--project=']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    if (!(caught instanceof CliError)) {
      throw new Error('Expected a CliError.');
    }
    expect(caught.errorCode).toBe('usage_error');
    expect(caught.exitCode).toBe(2);
    expect(caught.message).toBe('Missing --project <project_id>.');
  });
});

describe('assertKnownFlags (via buildRequest)', () => {
  it('rejects a flag that is valid for another command but not this one', () => {
    expect(() => request(['flags', 'list'], ['--key', 'foo'])).toThrowError(
      'Unknown flag --key for `amp flags list`.',
    );
  });

  it('throws a CliError with errorCode usage_error for a misplaced flag', () => {
    let caught: unknown;
    try {
      request(['flags', 'list'], ['--key', 'foo']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    if (!(caught instanceof CliError)) {
      throw new Error('Expected a CliError.');
    }
    expect(caught.errorCode).toBe('usage_error');
    expect(caught.exitCode).toBe(2);
  });

  it('suggests the nearest valid alias for a near-miss flag on this command', () => {
    expect(() => request(['flags', 'list'], ['--porject', '1'])).toThrowError(
      /Did you mean --project\?/,
    );
  });

  it('does not throw for flags valid on this command, including global flags', () => {
    expect(() =>
      request(
        ['flags', 'list'],
        ['--project', '187520', '--limit', '5', '--json'],
      ),
    ).not.toThrow();
  });

  it('allows a global flag even on a command with no operation-specific parameters', () => {
    expect(() => request(['context'], ['--json'])).not.toThrow();
  });

  it('allows --dry-run globally even on operations that do not declare dry_run', () => {
    expect(() => request(['context'], ['--dry-run'])).not.toThrow();
  });

  it('rejects auth-flow-only globals on an API command instead of silently dropping them', () => {
    const cases: Array<[string, string[]]> = [
      ['timeout', ['--timeout', '5']],
      ['with-token', ['--with-token']],
      ['flow', ['--flow', 'device']],
      ['scope', ['--scope', 'read']],
      ['force', ['--force']],
    ];
    for (const [flag, argv] of cases) {
      expect(
        () => request(['events', 'list'], ['--project', '187520', ...argv]),
        `--${flag} should be rejected on an API command`,
      ).toThrowError(`Unknown flag --${flag} for \`amp events list\`.`);
    }
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
