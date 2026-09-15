import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { getOrCreateDeviceId } from './client-identity';

interface IdentityWorker {
  ready: Promise<void>;
  result: Promise<string>;
}

function startIdentityWorker(
  path: string,
  barrierPath: string,
): IdentityWorker {
  const moduleUrl = pathToFileURL(
    join(process.cwd(), 'src/client-identity.ts'),
  ).href;
  const script = `
    import { existsSync } from 'node:fs';
    import { setTimeout } from 'node:timers/promises';

    const imported = await import(process.argv[1]);
    const { getOrCreateDeviceId } = imported.default ?? imported;
    process.stdout.write('ready\\n');
    while (!existsSync(process.argv[3])) {
      await setTimeout(1);
    }
    const result = getOrCreateDeviceId(process.argv[2]);
    process.stdout.write(
      result.kind === 'available' ? result.deviceId : 'unavailable',
    );
  `;
  const child = spawn(
    process.execPath,
    [
      '--import=tsx',
      '--input-type=module',
      '--eval',
      script,
      moduleUrl,
      path,
      barrierPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.startsWith('ready\n')) {
      markReady();
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(stdout.slice('ready\n'.length));
        return;
      }
      reject(new Error(`identity worker exited ${code}: ${stderr}`));
    });
  });
  return { ready, result };
}

describe('getOrCreateDeviceId', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories) {
      rmSync(directory, { force: true, recursive: true });
    }
    directories.length = 0;
  });

  it('persists one UUID for subsequent CLI invocations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'amp-client-identity-'));
    directories.push(directory);
    const path = join(directory, 'state.json');

    const first = getOrCreateDeviceId(path);
    const second = getOrCreateDeviceId(path);

    expect(first.kind).toBe('available');
    expect(second).toEqual(first);
    if (first.kind !== 'available') {
      return;
    }
    expect(first.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      device_id: first.deviceId,
    });
  });

  it('does not return an identity when it cannot persist the state file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'amp-client-identity-'));
    directories.push(directory);
    const blockingFile = join(directory, 'not-a-directory');
    writeFileSync(blockingFile, '');

    const result = getOrCreateDeviceId(join(blockingFile, 'state.json'));

    expect(result).toMatchObject({ kind: 'unavailable' });
  });

  it('returns one persisted identity to concurrent CLI processes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'amp-client-identity-'));
    directories.push(directory);
    const path = join(directory, 'state.json');
    const barrierPath = join(directory, 'start');
    const workers = Array.from({ length: 16 }, () =>
      startIdentityWorker(path, barrierPath),
    );
    await Promise.all(workers.map((worker) => worker.ready));

    writeFileSync(barrierPath, '');
    const deviceIds = await Promise.all(workers.map((worker) => worker.result));

    expect(deviceIds).not.toContain('unavailable');
    expect(new Set(deviceIds).size).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      device_id: deviceIds[0],
    });
  });
});
