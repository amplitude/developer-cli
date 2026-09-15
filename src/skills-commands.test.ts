import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_API_BASE_URL } from './config';
import {
  assertSkillsFlags,
  runSkillsGet,
  runSkillsList,
} from './skills-commands';

const EMPTY_STORE_PATH = '/nonexistent/amp-skills-credentials.json';

const INDEX = [
  { name: 'integrating-amplitude', description: 'Use when finding a skill.' },
];

describe('assertSkillsFlags', () => {
  it('accepts only output and standard flags on list', () => {
    expect(() =>
      assertSkillsFlags('list', {
        json: true,
        help: true,
        version: true,
      }),
    ).not.toThrow();
  });

  it.each(['profile', 'base-url'])('rejects --%s on list', (alias) => {
    expect(() => assertSkillsFlags('list', { [alias]: 'x' })).toThrowError(
      /unknown|unrecognized|not supported/i,
    );
  });

  it('accepts --env on list', () => {
    expect(() => assertSkillsFlags('list', { env: 'local' })).not.toThrow();
  });

  it('accepts undocumented --region on list', () => {
    expect(() => assertSkillsFlags('list', { region: 'us' })).not.toThrow();
  });

  it.each(['token', 'yes', 'dry-run', 'body-json', 'with-token', 'timeout'])(
    'rejects --%s, which this path ignores',
    (alias) => {
      expect(() => assertSkillsFlags('list', { [alias]: 'x' })).toThrowError(
        /unknown|unrecognized|not supported/i,
      );
    },
  );

  it('accepts output and endpoint flags on get', () => {
    expect(() =>
      assertSkillsFlags('get', {
        json: true,
        env: 'local',
        region: 'us',
        help: true,
        version: true,
      }),
    ).not.toThrow();
  });

  it('accepts --region on get', () => {
    expect(() => assertSkillsFlags('get', { region: 'us' })).not.toThrow();
  });

  it('accepts --env on get', () => {
    expect(() => assertSkillsFlags('get', { env: 'local' })).not.toThrow();
  });

  it.each(['profile', 'base-url'])('rejects --%s on get', (alias) => {
    expect(() => assertSkillsFlags('get', { [alias]: 'x' })).toThrowError(
      /unknown|unrecognized|not supported/i,
    );
  });
});

describe('runSkillsList', () => {
  it('fetches the US catalog when there is no default profile', async () => {
    const fetchIndex = vi.fn(async () => INDEX);

    await runSkillsList(
      {},
      {
        path: EMPTY_STORE_PATH,
        write: () => {},
        isTTY: false,
        fetchIndex,
      },
    );

    expect(fetchIndex).toHaveBeenCalledWith(DEFAULT_API_BASE_URL);
  });

  it('routes --region to its catalog endpoint', async () => {
    const fetchIndex = vi.fn(async () => INDEX);

    await runSkillsList(
      { region: 'eu' },
      {
        path: EMPTY_STORE_PATH,
        write: () => {},
        isTTY: false,
        fetchIndex,
      },
    );

    expect(fetchIndex).toHaveBeenCalledWith(
      'https://developer-api.eu.amplitude.com',
    );
  });

  it('emits the data envelope when piped', async () => {
    const chunks: string[] = [];
    await runSkillsList(
      {},
      {
        write: (chunk) => chunks.push(chunk),
        isTTY: false,
        fetchIndex: async () => INDEX,
      },
    );

    expect(JSON.parse(chunks.join(''))).toEqual({ data: INDEX });
  });

  it('emits readable skill blocks at a TTY', async () => {
    const chunks: string[] = [];
    await runSkillsList(
      {},
      {
        write: (chunk) => chunks.push(chunk),
        isTTY: true,
        fetchIndex: async () => [
          { name: 'first-event-android', description: 'Use when Android.' },
          { name: 'first-event-browser', description: 'Use when browser.' },
        ],
      },
    );

    expect(chunks.join('')).toBe(`Available skills (2):

\`first-event-android\`
Use when Android.

\`first-event-browser\`
Use when browser.

Run \`amp skills get <name>\` to print a skill. For example: \`amp skills get first-event-browser\`.
`);
  });

  it('uses integrating-amplitude as the example when it is available', async () => {
    const chunks: string[] = [];
    await runSkillsList(
      {},
      {
        write: (chunk) => chunks.push(chunk),
        isTTY: true,
        fetchIndex: async () => [
          {
            name: 'integrating-amplitude',
            description: 'Use when starting Amplitude work.',
          },
          { name: 'first-event-browser', description: 'Use when browser.' },
        ],
      },
    );

    expect(chunks.join('')).toContain(
      'For example: `amp skills get integrating-amplitude`.\n',
    );
  });

  it('explains an empty index at a TTY', async () => {
    const chunks: string[] = [];
    await runSkillsList(
      {},
      {
        write: (chunk) => chunks.push(chunk),
        isTTY: true,
        fetchIndex: async () => [],
      },
    );

    expect(chunks.join('')).toBe('No skills are currently available.\n');
  });

  it('keeps an empty piped result machine-readable', async () => {
    const chunks: string[] = [];
    await runSkillsList(
      {},
      {
        write: (chunk) => chunks.push(chunk),
        isTTY: false,
        fetchIndex: async () => [],
      },
    );

    expect(chunks.join('')).toBe('{"data":[]}\n');
  });

  it('prints complete descriptions so callers can choose a skill', async () => {
    const description =
      'Use when you need to work with Amplitude from a terminal — instrumenting an app, inspecting a tracking plan, or querying product data.';
    const chunks: string[] = [];
    await runSkillsList(
      {},
      {
        write: (chunk) => chunks.push(chunk),
        isTTY: true,
        fetchIndex: async () => [
          { name: 'integrating-amplitude', description },
        ],
      },
    );

    const output = chunks.join('');
    expect(output).toContain(description);
    expect(output).not.toContain('…');
  });

  it('never abridges the name, which has to be passable to `skills get`', async () => {
    const longName = `a-very-long-skill-name-${'x'.repeat(40)}`;
    const chunks: string[] = [];
    await runSkillsList(
      {},
      {
        write: (chunk) => chunks.push(chunk),
        isTTY: true,
        fetchIndex: async () => [
          { name: longName, description: 'Use when testing a long name.' },
        ],
      },
    );

    const output = chunks.join('');
    expect(output).toContain(`\`${longName}\``);
    expect(output).not.toContain('…');
  });

  it('propagates a transport failure', async () => {
    const fetchIndex = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(
      runSkillsList({}, { write: () => {}, isTTY: false, fetchIndex }),
    ).rejects.toThrow('boom');
  });
});

const DOCUMENT = `---
name: integrating-amplitude
description: Use when finding a skill.
version: 1
---

# Using Amplitude
`;

describe('runSkillsGet', () => {
  it('writes a compact JSON envelope when requested without a TTY', async () => {
    const chunks: string[] = [];
    await runSkillsGet(
      'integrating-amplitude',
      { region: 'us', json: true },
      {
        write: (chunk) => chunks.push(chunk),
        isTTY: false,
        fetchDocument: async () => DOCUMENT,
      },
    );

    expect(chunks.join('')).toBe(
      `${JSON.stringify({
        data: { name: 'integrating-amplitude', document: DOCUMENT },
      })}\n`,
    );
  });

  it('pretty-prints the same JSON envelope when requested at a TTY', async () => {
    const chunks: string[] = [];
    await runSkillsGet(
      'integrating-amplitude',
      { region: 'us', json: true },
      {
        write: (chunk) => chunks.push(chunk),
        isTTY: true,
        fetchDocument: async () => DOCUMENT,
      },
    );

    const output = chunks.join('');
    expect(output).toBe(
      `${JSON.stringify(
        { data: { name: 'integrating-amplitude', document: DOCUMENT } },
        null,
        2,
      )}\n`,
    );
    expect(JSON.parse(output)).toEqual({
      data: { name: 'integrating-amplitude', document: DOCUMENT },
    });
  });

  it.each([true, false])(
    'writes raw bytes with --json false when isTTY=%s',
    async (isTTY) => {
      const chunks: string[] = [];
      await runSkillsGet(
        'integrating-amplitude',
        { region: 'us', json: 'false' },
        {
          write: (chunk) => chunks.push(chunk),
          isTTY,
          fetchDocument: async () => DOCUMENT,
        },
      );

      expect(chunks.join('')).toBe(DOCUMENT);
    },
  );

  it('writes the document verbatim to stdout', async () => {
    const chunks: string[] = [];
    await runSkillsGet(
      'integrating-amplitude',
      { region: 'us' },
      {
        write: (chunk) => chunks.push(chunk),
        isTTY: false,
        fetchDocument: async () => DOCUMENT,
      },
    );

    expect(chunks.join('')).toBe(DOCUMENT);
  });

  it('writes the same bytes at a TTY', async () => {
    const chunks: string[] = [];
    await runSkillsGet(
      'integrating-amplitude',
      { region: 'us' },
      {
        write: (chunk) => chunks.push(chunk),
        isTTY: true,
        fetchDocument: async () => DOCUMENT,
      },
    );

    expect(chunks.join('')).toBe(DOCUMENT);
  });

  // Exercises the default stdout rather than an injected one: `console.log`
  // appends a newline to a document that already ends in one, so `amp skills get
  // X > f` would not be the bytes the server served.
  it('writes exactly the served bytes through the default stdout', async () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runSkillsGet(
        'integrating-amplitude',
        { region: 'us' },
        { fetchDocument: async () => DOCUMENT },
      );

      expect(write.mock.calls.map((call) => String(call[0])).join('')).toBe(
        DOCUMENT,
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      log.mockRestore();
    }
  });

  it('requires a skill name', async () => {
    await expect(
      runSkillsGet(
        undefined,
        {},
        {
          write: () => {},
          isTTY: false,
          fetchDocument: async () => DOCUMENT,
        },
      ),
    ).rejects.toMatchObject({ errorCode: 'usage_error', exitCode: 2 });
  });

  it('does not fetch when the name is missing', async () => {
    const fetchDocument = vi.fn(async () => DOCUMENT);

    await expect(
      runSkillsGet(
        undefined,
        {},
        {
          write: () => {},
          isTTY: false,
          fetchDocument,
        },
      ),
    ).rejects.toThrow();
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it('passes an explicit EU endpoint to the document fetcher', async () => {
    const fetchDocument = vi.fn(async () => DOCUMENT);

    await runSkillsGet(
      'integrating-amplitude',
      { region: 'eu' },
      { write: () => {}, fetchDocument },
    );

    expect(fetchDocument).toHaveBeenCalledWith(
      'https://developer-api.eu.amplitude.com',
      'integrating-amplitude',
    );
  });

  it('does not fetch without a default profile or --region', async () => {
    const fetchDocument = vi.fn(async () => DOCUMENT);

    await expect(
      runSkillsGet(
        'integrating-amplitude',
        {},
        {
          path: EMPTY_STORE_PATH,
          write: () => {},
          fetchDocument,
        },
      ),
    ).rejects.toMatchObject({ errorCode: 'usage_error', exitCode: 2 });
    expect(fetchDocument).not.toHaveBeenCalled();
  });
});
