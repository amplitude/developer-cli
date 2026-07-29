import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type AuthPatDeps, normalizePat, runAuthPat } from './auth-commands';
import { CliError } from './cli-error';
import { getProfile, loadStore } from './credential-store';
import {
  getPending,
  loadPending,
  savePending,
  setPending,
} from './pending-store';

const NOW = Date.parse('2026-06-23T12:00:00.000Z');

describe('normalizePat', () => {
  it('strips Bearer and PAT= prefixes', () => {
    expect(normalizePat('Bearer PAT=amp_x')).toBe('amp_x');
    expect(normalizePat('PAT=amp_x')).toBe('amp_x');
    expect(normalizePat('  amp_x  ')).toBe('amp_x');
  });
});

describe('runAuthPat', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    dirs.length = 0;
  });

  function tempPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'amp-pat-'));
    dirs.push(dir);
    return join(dir, 'credentials.json');
  }

  function pendingPathFor(path: string): string {
    return join(dirname(path), 'pending.json');
  }

  function deps(path: string, out: string[], over: Partial<AuthPatDeps> = {}) {
    return {
      path,
      pendingPath: pendingPathFor(path),
      now: () => NOW,
      stdout: (line: string) => out.push(line),
      readToken: () => Promise.resolve('amp_pasted'),
      ...over,
    };
  }

  it('saves a pat credential and activates the profile', async () => {
    const path = tempPath();
    const out: string[] = [];

    await runAuthPat(
      { profile: 'ci', env: 'prod', 'with-token': true },
      deps(path, out),
    );

    const store = loadStore(path);
    expect(store.default).toBe('ci');
    expect(getProfile(store, 'ci')?.credential).toEqual({
      type: 'pat',
      pat: 'amp_pasted',
    });
    expect(getProfile(store, 'ci')?.base_url).toBe(
      'https://developer-api.amplitude.com',
    );
    expect(out.join('\n')).toMatch(/created and set as default/);
  });

  it('normalizes a prefixed token before saving', async () => {
    const path = tempPath();
    await runAuthPat(
      { profile: 'ci', env: 'prod', 'with-token': true },
      deps(path, [], { readToken: () => Promise.resolve('Bearer PAT=amp_x') }),
    );
    expect(getProfile(loadStore(path), 'ci')?.credential).toEqual({
      type: 'pat',
      pat: 'amp_x',
    });
  });

  it('errors and saves nothing without --with-token (bare verb reserved)', async () => {
    const path = tempPath();
    await expect(
      runAuthPat({ profile: 'ci', env: 'prod' }, deps(path, [])),
    ).rejects.toThrow(/requires --with-token/);
    expect(loadStore(path).profiles.ci).toBeUndefined();
  });

  it('creates the implicit "default" profile when --profile is omitted', async () => {
    const path = tempPath();
    const out: string[] = [];
    await runAuthPat({ env: 'prod', 'with-token': true }, deps(path, out));

    const store = loadStore(path);
    expect(store.default).toBe('default');
    expect(getProfile(store, 'default')?.credential).toEqual({
      type: 'pat',
      pat: 'amp_pasted',
    });
    expect(out.join('\n')).toMatch(/created and set as default/);
  });

  it('accepts an explicit --profile default', async () => {
    const path = tempPath();
    await runAuthPat(
      { profile: 'default', env: 'prod', 'with-token': true },
      deps(path, []),
    );
    expect(loadStore(path).default).toBe('default');
  });

  it('rejects an invalid profile name', async () => {
    await expect(
      runAuthPat(
        { profile: 'bad/name', env: 'prod', 'with-token': true },
        deps(tempPath(), []),
      ),
    ).rejects.toThrow(/Invalid profile name/);
  });

  it('is force-explicit: creating without --region errors', async () => {
    await expect(
      runAuthPat({ profile: 'ci', 'with-token': true }, deps(tempPath(), [])),
    ).rejects.toThrow(/requires --region/);
  });

  it('maps --region for a new PAT profile', async () => {
    const path = tempPath();
    await runAuthPat(
      { profile: 'ci', region: 'eu', 'with-token': true },
      deps(path, []),
    );
    expect(getProfile(loadStore(path), 'ci')?.base_url).toBe(
      'https://developer-api.eu.amplitude.com',
    );
  });

  it('announces the region when --region is used', async () => {
    const path = tempPath();
    const out: string[] = [];
    await runAuthPat(
      { profile: 'ci', region: 'eu', 'with-token': true },
      deps(path, out),
    );
    expect(out.join('\n')).toContain(
      'Authenticating to https://app.eu.amplitude.com/',
    );
  });

  it('does not announce a region when --base-url wins over --region', async () => {
    const path = tempPath();
    const out: string[] = [];
    await runAuthPat(
      {
        profile: 'ci',
        region: 'eu',
        'base-url': 'http://localhost:3036',
        'with-token': true,
      },
      deps(path, out),
    );
    expect(out.join('\n')).not.toContain('Authenticating to');
    expect(getProfile(loadStore(path), 'ci')?.base_url).toBe(
      'http://localhost:3036',
    );
  });

  it('errors asking for --region on a cold bare pat', async () => {
    await expect(
      runAuthPat({ 'with-token': true }, deps(tempPath(), [])),
    ).rejects.toThrow(/requires --region/);
  });

  it('rejects an empty supplied PAT', async () => {
    await expect(
      runAuthPat(
        { profile: 'ci', env: 'prod', 'with-token': true },
        deps(tempPath(), [], { readToken: () => Promise.resolve('   ') }),
      ),
    ).rejects.toThrow(/cannot be empty/);
  });

  it('refuses to silently retarget a profile without --force (non-interactive, no confirm)', async () => {
    const path = tempPath();
    await runAuthPat(
      { profile: 'ci', env: 'prod', 'with-token': true },
      deps(path, []),
    );

    let caught: unknown;
    try {
      await runAuthPat(
        { profile: 'ci', env: 'staging', 'with-token': true },
        deps(path, []),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.errorCode).toBe('usage_error');
      expect(caught.exitCode).toBe(2);
      expect(caught.message).toMatch(/refusing to silently retarget/);
    }
    expect(loadStore(path).profiles.ci?.base_url).toBe(
      'https://developer-api.amplitude.com',
    );
  });

  it('retargets a profile with --force (no confirm needed)', async () => {
    const path = tempPath();
    await runAuthPat(
      { profile: 'ci', env: 'prod', 'with-token': true },
      deps(path, []),
    );

    const out: string[] = [];
    await runAuthPat(
      { profile: 'ci', env: 'staging', 'with-token': true, force: true },
      deps(path, out),
    );

    expect(loadStore(path).profiles.ci?.base_url).not.toBe(
      'https://developer-api.amplitude.com',
    );
    expect(out.join('\n')).toMatch(/updated and set as default/);
  });

  it('clears a stranded login-start entry for the profile it authenticates', async () => {
    const path = tempPath();
    const pendingPath = pendingPathFor(path);
    savePending(
      setPending(loadPending(pendingPath), 'ci', {
        device_code: 'abandoned',
        code_verifier: 'cv',
        base_url: 'https://developer-api.amplitude.com',
        expires_at: new Date(NOW + 600_000).toISOString(),
        interval: 5,
        started_at: new Date(NOW).toISOString(),
      }),
      pendingPath,
    );

    await runAuthPat(
      { profile: 'ci', env: 'prod', 'with-token': true },
      deps(path, []),
    );

    expect(getPending(loadPending(pendingPath), 'ci')).toBeUndefined();
  });
});
