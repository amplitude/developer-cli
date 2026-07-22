import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseArgs } from './args';
import * as authCommands from './auth-commands';
import { isHelpRequested, isVersionRequested, main } from './cli';
import { formatVersion } from './help';

vi.mock('./auth-commands', async () => {
  const actual =
    await vi.importActual<typeof import('./auth-commands')>('./auth-commands');
  return {
    ...actual,
    runAuthLoginStart: vi.fn(),
    runAuthLoginPoll: vi.fn(),
    runAuthLogin: vi.fn(),
  };
});

describe('isHelpRequested', () => {
  it('recognizes the help command and --help/-h in every form', () => {
    expect(isHelpRequested(['help', 'flags'], {})).toBe(true);
    expect(isHelpRequested(['flags', 'list'], { help: true })).toBe(true);
    expect(isHelpRequested(['flags', 'list'], { help: 'true' })).toBe(true);
    expect(isHelpRequested(['flags', 'list'], { h: true })).toBe(true);
  });

  it('does not treat --help=false as a help request', () => {
    expect(isHelpRequested(['flags', 'list'], { help: 'false' })).toBe(false);
    expect(isHelpRequested(['flags', 'list'], {})).toBe(false);
  });
});

describe('isVersionRequested', () => {
  it('recognizes the version command and --version/-v', () => {
    expect(isVersionRequested(['version'], {})).toBe(true);
    expect(isVersionRequested([], { version: true })).toBe(true);
    expect(isVersionRequested([], { v: true })).toBe(true);
  });

  it('does not treat --version=false as a version request', () => {
    expect(isVersionRequested([], { version: 'false' })).toBe(false);
    expect(isVersionRequested([], {})).toBe(false);
  });
});

describe('main routing', () => {
  const originalArgv = process.argv;
  let logSpy: ReturnType<typeof vi.spyOn>;

  function runWith(argv: string[]): Promise<void> {
    process.argv = ['node', 'amp', ...argv];
    return main();
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('fetch should not be called for these routes');
      }),
    );
    vi.mocked(authCommands.runAuthLoginStart).mockClear();
    vi.mocked(authCommands.runAuthLoginPoll).mockClear();
    vi.mocked(authCommands.runAuthLogin).mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    logSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('prints the version for both `version` and --version', async () => {
    await runWith(['version']);
    await runWith(['--version']);
    expect(logSpy).toHaveBeenCalledWith(formatVersion());
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it('prints global help when no command is given', async () => {
    await runWith([]);
    const output = logSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
    expect(output).toContain('amp');
  });

  it('throws a helpful error for an unknown command', async () => {
    await expect(runWith(['frobnicate'])).rejects.toThrow(
      /Unknown command: frobnicate/,
    );
  });

  it('rejects `auth use` with an extra argument instead of ignoring it', async () => {
    await expect(runWith(['auth', 'use', 'foo', 'bar'])).rejects.toThrow(
      /Unknown auth command: auth use foo bar/,
    );
  });

  it('dispatches `auth login start` to runAuthLoginStart, not runAuthLoginPoll', async () => {
    await runWith(['auth', 'login', 'start', '--region', 'us']);

    expect(authCommands.runAuthLoginStart).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us' }),
    );
    expect(authCommands.runAuthLoginPoll).not.toHaveBeenCalled();
  });

  it('dispatches `auth login poll` to runAuthLoginPoll, not runAuthLoginStart', async () => {
    await runWith(['auth', 'login', 'poll', '--profile', 'default']);

    expect(authCommands.runAuthLoginPoll).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'default' }),
    );
    expect(authCommands.runAuthLoginStart).not.toHaveBeenCalled();
  });

  it('rejects `auth login start` with a trailing argument instead of ignoring it', async () => {
    await expect(
      runWith(['auth', 'login', 'start', 'default']),
    ).rejects.toThrow(/Unknown auth command: auth login start default/);
    expect(authCommands.runAuthLoginStart).not.toHaveBeenCalled();
  });

  it('rejects `auth login poll` with a trailing argument instead of ignoring it', async () => {
    await expect(runWith(['auth', 'login', 'poll', 'default'])).rejects.toThrow(
      /Unknown auth command: auth login poll default/,
    );
    expect(authCommands.runAuthLoginPoll).not.toHaveBeenCalled();
  });

  describe('bare `auth login` TTY dispatch', () => {
    let stdinIsTTY: PropertyDescriptor | undefined;
    let stdoutIsTTY: PropertyDescriptor | undefined;

    beforeEach(() => {
      stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    });

    afterEach(() => {
      if (stdinIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
      }
      if (stdoutIsTTY) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
      }
    });

    it('dispatches to runAuthLoginStart when not an interactive terminal', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });

      await runWith(['auth', 'login']);

      expect(authCommands.runAuthLoginStart).toHaveBeenCalled();
      expect(authCommands.runAuthLogin).not.toHaveBeenCalled();
    });

    it('dispatches to runAuthLogin when at an interactive terminal', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });

      await runWith(['auth', 'login']);

      expect(authCommands.runAuthLogin).toHaveBeenCalled();
      expect(authCommands.runAuthLoginStart).not.toHaveBeenCalled();
    });
  });
});

describe('cli routing', () => {
  it('keeps --timeout as a value flag', () => {
    expect(
      parseArgs(['auth', 'login', 'poll', '--timeout', '25']).flags.timeout,
    ).toBe('25');
  });
  it('parses the login start/poll command path', () => {
    expect(
      parseArgs(['auth', 'login', 'start', '--region', 'us']).command,
    ).toEqual(['auth', 'login', 'start']);
  });
});
