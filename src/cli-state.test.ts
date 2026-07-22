import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getOrCreateDeviceId } from './cli-state';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('getOrCreateDeviceId', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    dirs.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'amp-state-'));
    dirs.push(dir);
    return dir;
  }

  function tempPath(): string {
    return join(tempDir(), 'state.json');
  }

  it('mints and persists a device_id with a created_at on first use', () => {
    const path = tempPath();
    const id = getOrCreateDeviceId(path);

    expect(id).toMatch(UUID_RE);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.device_id).toBe(id);
    expect(Number.isNaN(Date.parse(written.created_at))).toBe(false);
  });

  it('returns the same device_id on subsequent calls (stable)', () => {
    const path = tempPath();
    expect(getOrCreateDeviceId(path)).toBe(getOrCreateDeviceId(path));
  });

  it('returns an existing device_id from a valid file', () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ version: 1, device_id: 'kept-id' }));
    expect(getOrCreateDeviceId(path)).toBe('kept-id');
  });

  it('mints into a valid file that has no device_id, preserving other keys', () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ version: 1, future_flag: true }));
    const id = getOrCreateDeviceId(path);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.device_id).toBe(id);
    expect(written.future_flag).toBe(true);
  });

  it('recreates a corrupt file (self-heal) without any stderr output', () => {
    const path = tempPath();
    writeFileSync(path, '{ not json');
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const id = getOrCreateDeviceId(path);
    expect(id).toMatch(UUID_RE);
    // Corrupt content held no recoverable id, so it's replaced with a valid file.
    expect(JSON.parse(readFileSync(path, 'utf8')).device_id).toBe(id);
    // Telemetry is silent — no user-facing output.
    expect(stderr).not.toHaveBeenCalled();
  });

  it('never throws when the state cannot be written', () => {
    // Read-only dir: the file is absent (read → mint path), but the write fails.
    // The failure must be swallowed and the (ephemeral) id still returned.
    const dir = tempDir();
    chmodSync(dir, 0o500);
    let id: string | undefined;
    try {
      id = getOrCreateDeviceId(join(dir, 'state.json'));
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(id).toMatch(UUID_RE);
  });

  it('leaves no temp file behind after a write', () => {
    const path = tempPath();
    getOrCreateDeviceId(path);
    const leftovers = readdirSync(dirname(path)).filter((f) =>
      f.includes('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });
});
