import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  emptyPending,
  gcExpiredPending,
  getPending,
  isPendingExpired,
  loadPending,
  removePending,
  savePending,
  setPending,
} from './pending-store';

const entry = {
  device_code: 'dc',
  base_url: 'https://developer-api.amplitude.com',
  expires_at: '2026-07-15T00:10:00.000Z',
  interval: 5,
  started_at: '2026-07-15T00:00:00.000Z',
};

function tmpFile() {
  return join(
    mkdtempSync(join(tmpdir(), 'amp-pending-')),
    'pending-logins.json',
  );
}

function writeRaw(path: string, contents: string) {
  writeFileSync(path, contents);
}

describe('pending-store', () => {
  it('round-trips an entry and writes 0600', () => {
    const path = tmpFile();
    savePending(setPending(emptyPending(), 'default', entry), path);
    expect(getPending(loadPending(path), 'default')).toEqual(entry);
    // eslint-disable-next-line no-bitwise -- masking permission bits off st_mode
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('loads a legacy entry containing code_verifier', () => {
    const path = tmpFile();
    const legacyEntry = { ...entry, code_verifier: 'legacy-verifier' };
    writeRaw(
      path,
      JSON.stringify({ version: 1, pending: { legacy: legacyEntry } }),
    );

    expect(getPending(loadPending(path), 'legacy')).toEqual(legacyEntry);
  });

  it('removePending drops the entry', () => {
    const path = tmpFile();
    savePending(setPending(emptyPending(), 'default', entry), path);
    savePending(removePending(loadPending(path), 'default'), path);
    expect(getPending(loadPending(path), 'default')).toBeUndefined();
  });

  it('treats missing/corrupt/mismatched files as empty', () => {
    const path = tmpFile();
    expect(loadPending(path)).toEqual(emptyPending()); // ENOENT
    savePending(emptyPending(), path);
    writeRaw(path, '{ not json');
    expect(loadPending(path)).toEqual(emptyPending());
    writeRaw(
      path,
      JSON.stringify({ version: 1, pending: { x: { device_code: 'd' } } }),
    );
    expect(loadPending(path)).toEqual(emptyPending()); // bad entry schema
  });

  it('isPendingExpired compares against expires_at', () => {
    const at = Date.parse(entry.expires_at);
    expect(isPendingExpired(entry, at - 1)).toBe(false);
    expect(isPendingExpired(entry, at)).toBe(true);
  });

  it('gcExpiredPending drops expired entries and keeps live ones', () => {
    const store = setPending(
      setPending(emptyPending(), 'live', {
        ...entry,
        expires_at: '2026-07-15T00:10:00.000Z',
      }),
      'dead',
      { ...entry, expires_at: '2026-07-15T00:00:00.000Z' },
    );
    const gced = gcExpiredPending(
      store,
      Date.parse('2026-07-15T00:05:00.000Z'),
    );
    expect(Object.keys(gced.pending)).toEqual(['live']);
  });
});
