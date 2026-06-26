import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isHelpRequested, isVersionRequested, main } from './cli';
import { formatVersion } from './help';

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
});
