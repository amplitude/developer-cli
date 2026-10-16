import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('amp launcher', () => {
  let directory: string;
  let launcher: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'amp-launcher-'));
    mkdirSync(join(directory, 'bin'));
    launcher = join(directory, 'bin/amp.cjs');
    copyFileSync(resolve('bin/amp.cjs'), launcher);
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('explains how to build when installed before compilation', () => {
    const result = spawnSync(process.execPath, [launcher, '--version'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Run pnpm build');
  });

  it('preserves arguments and exit status when invoking the built CLI', () => {
    mkdirSync(join(directory, 'dist'));
    writeFileSync(
      join(directory, 'dist/cli.js'),
      `
      exports.main = async () => {
        console.log(JSON.stringify(process.argv.slice(2)));
        process.exitCode = 2;
      };
    `,
    );
    const result = spawnSync(
      process.execPath,
      [launcher, 'projects', '--help'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual(['projects', '--help']);
    expect(result.stderr).toBe('');
  });

  it('does not misreport a missing runtime dependency as an unbuilt CLI', () => {
    mkdirSync(join(directory, 'dist'));
    writeFileSync(
      join(directory, 'dist/cli.js'),
      "require('./missing-dependency');",
    );
    const result = spawnSync(process.execPath, [launcher], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing-dependency');
    expect(result.stderr).not.toContain('has not been built');
  });
});
