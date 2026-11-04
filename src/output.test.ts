import { describe, expect, it } from 'vitest';

import type { CliOperation } from './generated/cli-manifest';
import {
  formatJsonOutput,
  formatNoContentSuccess,
  formatSuccessOutput,
  isNoContentSuccess,
  shouldUseJsonOutput,
} from './output';

const listProjects: CliOperation = {
  command: ['projects', 'list'],
  method: 'GET',
  operationId: 'listProjects',
  path: '/v1/projects',
  requiredScopes: ['read:projects'],
  parameters: [],
  body: [],
};

const listEvents: CliOperation = {
  command: ['events', 'list'],
  method: 'GET',
  operationId: 'listEvents',
  path: '/v1/projects/{project_id}/events',
  requiredScopes: ['read:taxonomy'],
  parameters: [],
  body: [],
};

const listScheduledEventActions: CliOperation = {
  command: ['events', 'scheduled-actions', 'list'],
  method: 'GET',
  operationId: 'listScheduledEventActions',
  path: '/v1/projects/{project_id}/scheduled-event-actions',
  requiredScopes: ['read:taxonomy'],
  parameters: [],
  body: [],
};

const getContext: CliOperation = {
  command: ['context'],
  method: 'GET',
  operationId: 'getContext',
  path: '/v1/context',
  requiredScopes: ['read:projects'],
  parameters: [],
  body: [],
};

const deleteEvent: CliOperation = {
  command: ['events', 'delete'],
  method: 'DELETE',
  operationId: 'deleteEvent',
  path: '/v1/projects/{project_id}/events/{event_id}',
  requiredScopes: ['write:taxonomy'],
  successStatus: 204,
  parameters: [],
  body: [],
};

const archiveFlag: CliOperation = {
  command: ['flags', 'archive'],
  method: 'DELETE',
  operationId: 'archiveFeatureFlag',
  path: '/v1/projects/{project_id}/flags/{flag_id}',
  requiredScopes: ['write:flags'],
  successStatus: 204,
  parameters: [],
  body: [],
};

describe('output formatting', () => {
  it('detects empty 204 success responses', () => {
    expect(isNoContentSuccess(204, null)).toBe(true);
    expect(isNoContentSuccess(200, null)).toBe(false);
    expect(isNoContentSuccess(204, { data: {} })).toBe(false);
  });

  it('formats no-content success for humans', () => {
    expect(formatNoContentSuccess(deleteEvent)).toBe('Deleted.');
    expect(formatNoContentSuccess(archiveFlag)).toBe('Archived.');
  });
  it('uses JSON when stdout is not a TTY unless --json is forced', () => {
    expect(shouldUseJsonOutput({ isTTY: false })).toBe(true);
    expect(shouldUseJsonOutput({ isTTY: true })).toBe(false);
    expect(shouldUseJsonOutput({ isTTY: true, jsonFlag: true })).toBe(true);
  });

  it('formats list responses as a table', () => {
    const output = formatSuccessOutput(
      {
        data: [
          { id: '1', name: 'Alpha' },
          { id: '2', name: 'Beta' },
        ],
        pagination: { has_more: true, next_cursor: '2' },
      },
      listProjects,
    );

    expect(output).toContain('ID');
    expect(output).toContain('Alpha');
    expect(output).toContain('--cursor 2');
  });

  it('truncates and normalizes long table cells', () => {
    const longDescription =
      'First line with a lot of detail.\nSecond line with even more detail that should not make the table unreadably wide.';
    const output = formatSuccessOutput(
      {
        data: [
          {
            id: '1',
            name: 'A project with an intentionally long name that needs truncation',
            description: longDescription,
          },
        ],
      },
      listProjects,
    );

    expect(output).toContain('…');
    expect(output).not.toContain('\nSecond line');
    expect(output).not.toContain(longDescription);
  });

  it('collapses columns that repeat the same value across rows', () => {
    const output = formatSuccessOutput(
      {
        data: [
          {
            id: 'delete-roles',
            object: 'event',
            event_type: 'delete-roles',
            display_name: 'delete-roles',
            description: null,
            is_active: false,
          },
          {
            id: 'Cookie Preferences Updated',
            object: 'event',
            event_type: 'Cookie Preferences Updated',
            display_name: 'Cookie Preferences Updated',
            description: 'Fired when a visitor saves cookie settings.',
            is_active: true,
          },
        ],
      },
      listEvents,
    );

    const header = output.split('\n')[0];
    expect(header).toContain('ID');
    expect(header).toContain('IS_ACTIVE');
    expect(header).toContain('DESCRIPTION');
    // event_type and display_name duplicate id on every row, so they collapse.
    expect(header).not.toContain('EVENT_TYPE');
    expect(header).not.toContain('DISPLAY_NAME');
  });

  it('shows action on scheduled event action lists', () => {
    const output = formatSuccessOutput(
      {
        data: [
          {
            id: 'action-1',
            object: 'scheduled_event_action',
            event_type: 'A Brand New Event',
            display_name: 'A Brand New Event',
            action: 'delete',
            status: 'pending',
            target_date: '2026-09-28T00:00:00.000Z',
          },
          {
            id: 'action-2',
            object: 'scheduled_event_action',
            event_type: 'Test_Event_2',
            display_name: 'Test_Event_2',
            action: 'block',
            status: 'pending',
            target_date: '2026-09-24T00:00:00.000Z',
          },
        ],
      },
      listScheduledEventActions,
    );

    const header = output.split('\n')[0];
    expect(header).toContain('ID');
    expect(header).toContain('ACTION');
    expect(output).toContain('delete');
    expect(output).toContain('block');
  });

  it('emits no trailing whitespace on any table row', () => {
    const output = formatSuccessOutput(
      {
        data: [
          { id: '1', name: 'Alpha' },
          { id: '2', name: 'Beta' },
        ],
      },
      listProjects,
    );

    for (const line of output.split('\n')) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('formats context as a short summary', () => {
    const output = formatSuccessOutput(
      {
        data: {
          principal: {
            login_id: 'user@example.com',
            auth_type: 'pat',
            scopes: ['read:projects'],
          },
          org: { id: '1', name: 'Acme' },
        },
      },
      getContext,
    );

    expect(output).toContain('user@example.com');
    expect(output).toContain('Acme');
    expect(output).toContain('read:projects');
  });

  it('renders control characters in table cells as visible text', () => {
    const output = formatSuccessOutput(
      {
        data: [{ id: '1', name: 'ok\u001b[31mred\u001b[0m\u0007' }],
        pagination: { has_more: true, next_cursor: 'next\u001b]0;title\u0007' },
      },
      listProjects,
    );

    expect(output).toContain('ok^[[31mred^[[0m^G');
    expect(output).toContain('--cursor next^[]0;title^G');
    expect(output.includes('\u001b')).toBe(false);
    expect(output.includes('\u0007')).toBe(false);
  });

  it('keeps collapsing whitespace in table cells that also contain escapes', () => {
    const output = formatSuccessOutput(
      {
        data: [{ id: '1', name: 'first\nsecond\u001b[0m' }],
      },
      listProjects,
    );

    expect(output).toContain('first second^[[0m');
    expect(output).not.toContain('\nsecond');
  });

  it('renders control characters in the context summary as visible text', () => {
    const output = formatSuccessOutput(
      {
        data: {
          principal: {
            login_id: 'user\u001b[2J@evil.test',
            auth_type: 'pat\u000d',
            scopes: ['read\u001b[0m:projects'],
          },
          org: { id: '1\u009b31m', name: 'Acme\r\u001b[1AHacked' },
        },
      },
      getContext,
    );

    expect(output).toContain('User: user^[[2J@evil.test');
    expect(output).toContain('Org:  Acme^M^[[1AHacked (1\\u009b31m)');
    expect(output).toContain('Auth: pat^M');
    expect(output).toContain('Scopes: read^[[0m:projects');
    expect(output.includes('\u001b')).toBe(false);
    expect(output.includes('\u000d')).toBe(false);
    expect(output.includes('\u009b')).toBe(false);
  });

  it('leaves control characters inside JSON serialization', () => {
    const payload = { data: [{ name: 'a\u001b[31mb' }] };

    expect(formatJsonOutput(payload, false)).toBe(JSON.stringify(payload));
    expect(JSON.parse(formatJsonOutput(payload, false))).toEqual(payload);
    expect(formatJsonOutput(payload, false)).not.toContain('\u001b');
  });
});
