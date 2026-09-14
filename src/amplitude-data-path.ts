import { homedir } from 'node:os';
import { join } from 'node:path';

export const amplitudeDataFiles = Object.freeze({
  clientIdentity: 'state.json',
  credentials: 'credentials.json',
  pendingLogins: 'pending-logins.json',
});

export type AmplitudeDataFile =
  (typeof amplitudeDataFiles)[keyof typeof amplitudeDataFiles];

export function amplitudeDataPath(
  fileName: AmplitudeDataFile,
  override?: string,
): string {
  return override ?? join(homedir(), '.amplitude', 'amp', fileName);
}
