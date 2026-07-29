import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseArgs } from './args';
import * as authCommands from './auth-commands';
import { isHelpRequested, isVersionRequested, main } from './cli';
import * as credentialStore from './credential-store';
import { formatVersion } from './help';

vi.mock('./auth-commands', async () => {
  const actual =
    await vi.importActual<typeof import('./auth-commands')>('./auth-commands');
  return {
    ...actual,
    runAuthLoginStart: vi.fn(),
    runAuthLoginPoll: vi.fn(),
    runAuthLogin: vi.fn(),
    runAuthPat: vi.fn(),
  };
});

// `loadStore` reads real `~/.amplitude/amp/credentials.json` by default,
// which main-routing tests must not depend on. Give it a safe empty-store
// default here; the expired-token test below overrides it for that case only.
vi.mock('./credential-store', async () => {
  const actual =
    await vi.importActual<typeof import('./credential-store')>(
      './credential-store',
    );
  return {
    ...actual,
    loadStore: vi.fn(),
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
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stdoutIsTTY: PropertyDescriptor | undefined;

  function runWith(argv: string[]): Promise<void> {
    process.argv = ['node', 'amp', ...argv];
    return main();
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('fetch should not be called for these routes');
      }),
    );
    vi.mocked(authCommands.runAuthLoginStart).mockClear();
    vi.mocked(authCommands.runAuthLoginPoll).mockClear();
    vi.mocked(authCommands.runAuthLogin).mockClear();
    vi.mocked(authCommands.runAuthPat).mockClear();
    vi.mocked(credentialStore.loadStore).mockReturnValue(
      credentialStore.emptyStore(),
    );
  });

  afterEach(() => {
    process.argv = originalArgv;
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (stdoutIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
    }
    process.exitCode = undefined;
    vi.unstubAllGlobals();
  });

  it('prints the version for both `version` and --version', async () => {
    await runWith(['version']);
    await runWith(['--version']);
    expect(logSpy).toHaveBeenCalledWith(formatVersion());
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it('renders a helpful error for an unknown command as a JSON usage error on stderr', async () => {
    await runWith(['frobnicate']);

    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('usage_error');
    expect(parsed.message).toMatch(/Unknown command: frobnicate/);
  });

  it('renders a usage_error (exit 2) for an unknown --region on an API command', async () => {
    await runWith(['projects', 'list', '--region', 'bogus']);

    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('usage_error');
    expect(parsed.message).toMatch(/Unknown --region "bogus"/);
  });

  it('routes `amp help <unknown>` through the error envelope (stderr, exit 2), not stdout', async () => {
    await runWith(['help', 'frobnicate']);

    expect(process.exitCode).toBe(2);
    expect(logSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('usage_error');
    expect(parsed.message).toMatch(/Unknown command: frobnicate/);
  });

  it('renders a structured auth error (exit 3) for an unknown --profile on an API command', async () => {
    await runWith(['projects', 'list', '--profile', '__nope__']);

    expect(process.exitCode).toBe(3);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('authentication_required');
    expect(parsed.error.hint).toBeTruthy();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('renders a structured invalid_token error (exit 3) for an expired stored oauth credential', async () => {
    const expiredStore = credentialStore.setDefault(
      credentialStore.setProfile(credentialStore.emptyStore(), 'default', {
        base_url: 'https://prod',
        credential: {
          type: 'oauth',
          access_token: 'expired-access-token',
          token_type: 'Bearer',
          expires_at: '2000-01-01T00:00:00.000Z',
        },
        saved_at: '2000-01-01T00:00:00.000Z',
        store: 'file',
      }),
      'default',
    );
    vi.mocked(credentialStore.loadStore).mockReturnValue(expiredStore);

    await runWith(['projects', 'list']);

    expect(process.exitCode).toBe(3);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('invalid_token');
    expect(parsed.error.hint).toBeTruthy();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('renders a deterministic usage_error (exit 2) for a malformed command even with an unresolvable --profile, not an auth error', async () => {
    await runWith(['events', 'get', '--profile', '__nope__']);

    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('usage_error');
    expect(parsed.message).toMatch(/Missing --project <project_id>\./);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('renders a usage_error (exit 2) for a flag valid on another command but not this one', async () => {
    await runWith(['flags', 'list', '--key', 'foo']);

    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('usage_error');
    expect(parsed.message).toBe('Unknown flag --key for `amp flags list`.');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('validates flags before the delete-confirmation gate: an unknown flag on a DELETE with no --yes surfaces usage_error, not the "Pass --yes" gate error', async () => {
    await runWith([
      'events',
      'delete',
      '--project',
      '187520',
      '--totally-bogus',
      'x',
    ]);

    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('usage_error');
    expect(parsed.message).toMatch(/--totally-bogus/);
    expect(parsed.message).not.toMatch(/Pass --yes/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('renders a truly-unknown flag (no alias anywhere) as usage_error (exit 2) with a "Did you mean" suggestion', async () => {
    await runWith(['flags', 'list', '--porject', '1']);

    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('usage_error');
    expect(parsed.message).toMatch(/Did you mean --project/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('renders a structured authentication_required error (exit 3) for `auth status` piped with no credential, stdout empty', async () => {
    await runWith(['auth', 'status']);

    expect(process.exitCode).toBe(3);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.status).toBe('error');
    expect(parsed.error.error_code).toBe('authentication_required');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('renders a structured invalid_token error (exit 3) for `auth status` piped with an expired stored credential, stdout empty', async () => {
    const expiredStore = credentialStore.setDefault(
      credentialStore.setProfile(credentialStore.emptyStore(), 'default', {
        base_url: 'https://prod',
        credential: {
          type: 'oauth',
          access_token: 'expired-access-token',
          token_type: 'Bearer',
          expires_at: '2000-01-01T00:00:00.000Z',
        },
        saved_at: '2000-01-01T00:00:00.000Z',
        store: 'file',
      }),
      'default',
    );
    vi.mocked(credentialStore.loadStore).mockReturnValue(expiredStore);

    await runWith(['auth', 'status']);

    expect(process.exitCode).toBe(3);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('invalid_token');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('rejects `auth use` with an extra argument instead of ignoring it', async () => {
    await runWith(['auth', 'use', 'foo', 'bar']);

    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.error.error_code).toBe('usage_error');
    expect(parsed.message).toMatch(/Unknown auth command: auth use foo bar/);
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
    await runWith(['auth', 'login', 'start', 'default']);

    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.message).toMatch(
      /Unknown auth command: auth login start default/,
    );
    expect(authCommands.runAuthLoginStart).not.toHaveBeenCalled();
  });

  it('rejects `auth login poll` with a trailing argument instead of ignoring it', async () => {
    await runWith(['auth', 'login', 'poll', 'default']);

    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
    expect(parsed.message).toMatch(
      /Unknown auth command: auth login poll default/,
    );
    expect(authCommands.runAuthLoginPoll).not.toHaveBeenCalled();
  });

  describe('auth/logout input safety', () => {
    it('accepts legit flags on `auth login` without an "Unknown flag" error', async () => {
      await runWith([
        'auth',
        'login',
        '--region',
        'us',
        '--profile',
        'p',
        '--flow',
        'device',
      ]);

      expect(errSpy).not.toHaveBeenCalled();
      expect(authCommands.runAuthLoginStart).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us',
          profile: 'p',
          flow: 'device',
        }),
      );
    });

    it('accepts legit flags on `auth login start` without an "Unknown flag" error', async () => {
      await runWith(['auth', 'login', 'start', '--region', 'us', '--json']);

      expect(errSpy).not.toHaveBeenCalled();
      expect(authCommands.runAuthLoginStart).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'us', json: true }),
      );
    });

    it('accepts legit flags on `auth login poll` without an "Unknown flag" error', async () => {
      await runWith(['auth', 'login', 'poll', '--timeout', '0', '--json']);

      expect(errSpy).not.toHaveBeenCalled();
      expect(authCommands.runAuthLoginPoll).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: '0', json: true }),
      );
    });

    it('accepts legit flags on `auth pat` without an "Unknown flag" error', async () => {
      await runWith(['auth', 'pat', '--with-token', '--region', 'us']);

      expect(errSpy).not.toHaveBeenCalled();
      expect(authCommands.runAuthPat).toHaveBeenCalledWith(
        expect.objectContaining({ 'with-token': true, region: 'us' }),
      );
    });

    it('rejects an unknown flag on `auth pat` (exit 2, usage_error, names the flag)', async () => {
      await runWith(['auth', 'pat', '--key', 'foo']);

      expect(process.exitCode).toBe(2);
      const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
      expect(parsed.error.error_code).toBe('usage_error');
      expect(parsed.message).toBe('Unknown flag --key for `amp auth pat`.');
      expect(authCommands.runAuthPat).not.toHaveBeenCalled();
    });

    it('suggests the nearest known flag for a typo on `auth pat`', async () => {
      await runWith(['auth', 'pat', '--toekn', 'x']);

      expect(process.exitCode).toBe(2);
      const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
      expect(parsed.error.error_code).toBe('usage_error');
      expect(parsed.message).toMatch(/Did you mean --token\?/);
      expect(authCommands.runAuthPat).not.toHaveBeenCalled();
    });

    it('rejects an unknown flag on `logout` (exit 2, usage_error, names the flag)', async () => {
      await runWith(['logout', '--key', 'foo']);

      expect(process.exitCode).toBe(2);
      const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
      expect(parsed.error.error_code).toBe('usage_error');
      expect(parsed.message).toBe('Unknown flag --key for `amp logout`.');
    });
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

  describe('help JSON routing', () => {
    let stdoutIsTTY: PropertyDescriptor | undefined;

    beforeEach(() => {
      stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    });

    afterEach(() => {
      if (stdoutIsTTY) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
      }
    });

    function setTTY(value: boolean): void {
      Object.defineProperty(process.stdout, 'isTTY', {
        value,
        configurable: true,
      });
    }

    it('prints prose global help at a TTY with no command', async () => {
      setTTY(true);
      await runWith([]);

      const output = logSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('\n');
      expect(() => JSON.parse(output)).toThrow();
      expect(output).toContain('Usage:');
    });

    it('prints JSON for a bare command when not a TTY', async () => {
      setTTY(false);
      await runWith([]);

      const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
      expect(Array.isArray(parsed.commands)).toBe(true);
    });

    it('prints prose global help for bare `amp help` at a TTY, not an unknown-command error', async () => {
      setTTY(true);
      await runWith(['help']);

      const output = logSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('\n');
      expect(output).toContain('Usage:');
      expect(output).toContain('Product surfaces:');
      expect(errSpy).not.toHaveBeenCalled();
      expect(process.exitCode).not.toBeTruthy();
    });

    it('prints JSON for a bare command at a TTY when --json is passed', async () => {
      setTTY(true);
      await runWith(['--json']);

      expect(() => JSON.parse(String(logSpy.mock.calls[0]?.[0]))).not.toThrow();
    });

    it('prints JSON for `<cmd> --help` when not a TTY, including the command topic', async () => {
      setTTY(false);
      await runWith(['flags', 'list', '--help']);

      const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
      expect(parsed.command).toBe('flags list');
    });

    it('prints prose for `<cmd> --help` at a TTY', async () => {
      setTTY(true);
      await runWith(['flags', 'list', '--help']);

      const output = logSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('\n');
      expect(() => JSON.parse(output)).toThrow();
    });
  });

  describe('error rendering', () => {
    let stdoutIsTTY: PropertyDescriptor | undefined;

    beforeEach(() => {
      stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    });

    afterEach(() => {
      if (stdoutIsTTY) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
      }
    });

    function setTTY(value: boolean): void {
      Object.defineProperty(process.stdout, 'isTTY', {
        value,
        configurable: true,
      });
    }

    it('renders a usage error as a JSON envelope on stderr when not a TTY', async () => {
      setTTY(false);
      await runWith(['bogus']);

      expect(process.exitCode).toBe(2);
      const parsed = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
      expect(parsed.status).toBe('error');
      expect(parsed.error.error_code).toBe('usage_error');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('renders a usage error as prose with remediation guidance at a TTY', async () => {
      setTTY(true);
      await runWith(['bogus']);

      expect(process.exitCode).toBe(2);
      const output = String(errSpy.mock.calls[0]?.[0]);
      expect(() => JSON.parse(output)).toThrow();
      expect(output).toContain('Unknown command: bogus');
      expect(output).toContain('Run `amp help` to list commands.');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('honors --json false on the error path at a TTY (prose, not a JSON envelope)', async () => {
      setTTY(true);
      // argv carries a bare `--json` token, but the parsed flag is `false`; the
      // error envelope must follow the parsed flag like the success path does.
      await runWith(['bogus', '--json', 'false']);

      expect(process.exitCode).toBe(2);
      const output = String(errSpy.mock.calls[0]?.[0]);
      expect(() => JSON.parse(output)).toThrow();
      expect(output).toContain('Unknown command: bogus');
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
