import { randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { amplitudeDataFiles, amplitudeDataPath } from './amplitude-data-path';

const CURRENT_VERSION = 1;
export const AMP_DEVICE_ID_HEADER = 'Amp-Device-Id';

const clientIdentitySchema = z
  .object({
    version: z.number().int().positive(),
    device_id: z.uuid().optional(),
  })
  .catchall(z.unknown());

function clientIdentityPath(): string {
  return amplitudeDataPath(amplitudeDataFiles.clientIdentity);
}

function readDeviceId(path: string): string | undefined {
  try {
    const result = clientIdentitySchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    return result.success ? result.data.device_id : undefined;
  } catch {
    return undefined;
  }
}

export type ClientIdentityResult =
  | { kind: 'available'; deviceId: string }
  | { kind: 'unavailable'; error: unknown };

function writeDeviceId(path: string, deviceId: string): ClientIdentityResult {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.state.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: CURRENT_VERSION, device_id: deviceId })}\n`,
      { mode: 0o600 },
    );
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'EEXIST')
      ) {
        return { kind: 'unavailable', error };
      }

      const existing = readDeviceId(path);
      if (existing !== undefined) {
        return { kind: 'available', deviceId: existing };
      }

      // Repair an existing malformed state file atomically.
      renameSync(temporaryPath, path);
    }
    return { kind: 'available', deviceId };
  } catch (error) {
    return { kind: 'unavailable', error };
  } finally {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Cleanup is best-effort and must not replace the persistence result.
    }
  }
}

/** Returns the stable, non-secret identity for this CLI installation. */
export function getOrCreateDeviceId(
  path = clientIdentityPath(),
): ClientIdentityResult {
  const existing = readDeviceId(path);
  if (existing !== undefined) {
    return { kind: 'available', deviceId: existing };
  }

  const deviceId = randomUUID();
  return writeDeviceId(path, deviceId);
}

export function deviceIdHeader(): Record<string, string> {
  const result = getOrCreateDeviceId();
  if (result.kind === 'unavailable') {
    process.stderr.write(
      `amp: could not persist a stable client identity (${
        result.error instanceof Error
          ? result.error.message
          : String(result.error)
      }); requests will omit ${AMP_DEVICE_ID_HEADER}.\n`,
    );
    return {};
  }
  return { [AMP_DEVICE_ID_HEADER]: result.deviceId };
}
