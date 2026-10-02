import { homedir } from 'node:os';
import { join } from 'node:path';

import envPaths from 'env-paths';

const amplitudeCliPaths = envPaths('amp-cli');

export const amplitudeDataFiles = Object.freeze({
  clientIdentity: 'state.json',
  credentials: 'credentials.json',
  pendingLogins: 'pending-logins.json',
});

export const amplitudeCacheDirectories = Object.freeze({
  skills: 'skills',
});

export type AmplitudeDataFile =
  (typeof amplitudeDataFiles)[keyof typeof amplitudeDataFiles];

export function amplitudeDataPath(
  fileName: AmplitudeDataFile,
  override?: string,
): string {
  return override ?? join(homedir(), '.amplitude', 'amp', fileName);
}

export function materializedSkillsRoot(): string {
  return join(amplitudeCliPaths.cache, amplitudeCacheDirectories.skills);
}
