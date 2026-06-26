import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type AuthPatDeps, normalizePat, runAuthPat } from './auth-commands';
import { getProfile, loadStore } from './credential-store';

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

  function deps(path: string, out: string[], over: Partial<AuthPatDeps> = {}) {
    return {
      path,
      now: () => NOW,
      stdout: (line: string) => out.push(line),
      confirm: () => Promise.resolve(true),
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

  it('requires --profile', async () => {
    await expect(
      runAuthPat({ env: 'prod', 'with-token': true }, deps(tempPath(), [])),
    ).rejects.toThrow(/--profile/);
  });

  it('rejects the reserved name "default"', async () => {
    await expect(
      runAuthPat(
        { profile: 'default', env: 'prod', 'with-token': true },
        deps(tempPath(), []),
      ),
    ).rejects.toThrow(/reserved/);
  });

  it('rejects an invalid profile name', async () => {
    await expect(
      runAuthPat(
        { profile: 'bad/name', env: 'prod', 'with-token': true },
        deps(tempPath(), []),
      ),
    ).rejects.toThrow(/Invalid profile name/);
  });

  it('is force-explicit: creating without --env/--base-url errors', async () => {
    await expect(
      runAuthPat({ profile: 'ci', 'with-token': true }, deps(tempPath(), [])),
    ).rejects.toThrow(/requires --env|--base-url/);
  });

  it('rejects an empty supplied PAT', async () => {
    await expect(
      runAuthPat(
        { profile: 'ci', env: 'prod', 'with-token': true },
        deps(tempPath(), [], { readToken: () => Promise.resolve('   ') }),
      ),
    ).rejects.toThrow(/cannot be empty/);
  });

  it('aborts a re-pat to a different target when not confirmed', async () => {
    const path = tempPath();
    await runAuthPat(
      { profile: 'ci', env: 'prod', 'with-token': true },
      deps(path, []),
    );

    await expect(
      runAuthPat(
        { profile: 'ci', env: 'staging', 'with-token': true },
        deps(path, [], { confirm: () => Promise.resolve(false) }),
      ),
    ).rejects.toThrow(/Aborted/);
    expect(loadStore(path).profiles.ci?.base_url).toBe(
      'https://developer-api.amplitude.com',
    );
  });
});
