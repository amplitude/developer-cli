import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { amplitudeDataFiles, amplitudeDataPath } from './amplitude-data-path';

export const CURRENT_PENDING_VERSION = 1;

const pendingEntrySchema = z
  .object({
    device_code: z.string().min(1),
    base_url: z.string().min(1),
    expires_at: z.string().min(1),
    interval: z.number().int().positive(),
    started_at: z.string().min(1),
  })
  .catchall(z.unknown());

const pendingStoreSchema = z
  .object({
    version: z.number().int(),
    pending: z.record(z.string(), pendingEntrySchema),
  })
  .catchall(z.unknown());

export type PendingEntry = z.infer<typeof pendingEntrySchema>;
export type PendingStore = z.infer<typeof pendingStoreSchema>;

export function pendingPath(override?: string): string {
  return amplitudeDataPath(amplitudeDataFiles.pendingLogins, override);
}

export function emptyPending(): PendingStore {
  return { version: CURRENT_PENDING_VERSION, pending: {} };
}

// Pending entries are disposable: any unreadable / unparseable / schema-mismatched
// file is treated as "nothing in flight" rather than surfaced as an error.
export function loadPending(path: string = pendingPath()): PendingStore {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return emptyPending();
  }
  try {
    const parsed = pendingStoreSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyPending();
  } catch {
    return emptyPending();
  }
}

export function savePending(
  store: PendingStore,
  path: string = pendingPath(),
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = join(
    dir,
    `.pending-logins.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function getPending(
  store: PendingStore,
  name: string,
): PendingEntry | undefined {
  return store.pending[name];
}

export function setPending(
  store: PendingStore,
  name: string,
  entry: PendingEntry,
): PendingStore {
  return { ...store, pending: { ...store.pending, [name]: entry } };
}

export function removePending(store: PendingStore, name: string): PendingStore {
  const pending = { ...store.pending };
  delete pending[name];
  return { ...store, pending };
}

export function isPendingExpired(entry: PendingEntry, now: number): boolean {
  const at = Date.parse(entry.expires_at);
  return Number.isNaN(at) ? true : at <= now;
}

/** Returns a copy of the store with expired entries dropped (opportunistic GC). */
export function gcExpiredPending(
  store: PendingStore,
  now: number,
): PendingStore {
  const pending: Record<string, PendingEntry> = {};
  for (const [name, entry] of Object.entries(store.pending)) {
    if (!isPendingExpired(entry, now)) {
      pending[name] = entry;
    }
  }
  return { ...store, pending };
}
