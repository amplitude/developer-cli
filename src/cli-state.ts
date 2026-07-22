import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/**
 * On-disk install state for the `amp` CLI: a versioned, non-secret file holding
 * a stable per-installation device_id. Separate from credentials.json (the
 * secrets store): this is write-once and must never churn, and would have
 * nowhere to live once secrets move to an OS keychain.
 *
 * It mirrors the credential store's write mechanics (atomic temp-file + rename,
 * 0600/0700, forward-compat `.catchall`) but follows two rules the credential
 * store does not, because this is telemetry: it is entirely silent (never writes
 * to stderr) and it never throws — a read or write failure degrades to "no id
 * this run", never an error the user sees or that could break a command.
 */

const CURRENT_VERSION = 1;

const stateSchema = z
  .object({
    version: z.number().int(),
    device_id: z.string().min(1).optional(),
    created_at: z.string().min(1).optional(),
  })
  .catchall(z.unknown());

type CliState = z.infer<typeof stateSchema>;

function statePath(): string {
  return join(homedir(), '.amplitude', 'amp', 'state.json');
}

// The parsed state, or undefined when there is nothing usable to build on —
// missing, unreadable, corrupt, or schema-invalid all collapse to undefined,
// and the caller recreates the file. An unreadable/corrupt file holds no
// recoverable id, so recreating self-heals rather than getting stuck.
function readState(path: string): CliState | undefined {
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeState(state: CliState, path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tempPath = join(
    dir,
    `.state.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );

  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * The installation's stable device_id, minting and persisting one on first use
 * and returning it unchanged thereafter. A missing, corrupt, or unreadable file
 * is recreated (it holds no recoverable id, so this self-heals); a valid file
 * without an id is filled in, preserving its other keys. Never throws and never
 * writes to stderr: a telemetry helper must not break or bother the CLI, so a
 * failed persist just yields an ephemeral id for this run.
 */
export function getOrCreateDeviceId(path: string = statePath()): string {
  const existing = readState(path);
  if (existing?.device_id) {
    return existing.device_id;
  }

  const deviceId = randomUUID();
  try {
    writeState(
      {
        ...(existing ?? { version: CURRENT_VERSION }),
        device_id: deviceId,
        created_at: new Date().toISOString(),
      },
      path,
    );
  } catch {
    // Best-effort persist.
  }
  return deviceId;
}
