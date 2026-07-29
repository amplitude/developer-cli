import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli';

/**
 * Unlike `cli.test.ts`, this file does NOT mock `./auth-commands` — it drives
 * `main()` end to end so a converted `usageError` really reaches the CliError
 * catch in `cli.ts`, not a mocked stand-in for the handler.
 */
describe('main() end to end — CliError conversions', () => {
  const originalArgv = process.argv;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stdoutIsTTY: PropertyDescriptor | undefined;

  function runWith(argv: string[]): Promise<void> {
    process.argv = ['node', 'amp', ...argv];
    return main();
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    if (stdoutIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
    }
    process.exitCode = undefined;
  });

  it('renders a usage_error (exit 2) for `auth pat` without --with-token', async () => {
    await runWith(['auth', 'pat']);

    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('usage_error');
    expect(parsed.message).toMatch(/requires --with-token/);
  });
});
