import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { windowsReservedNameRegex } from 'filename-reserved-regex';

import { materializedSkillsRoot } from './amplitude-paths';
import { CliError, transportError } from './cli-error';

const portableSkillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const versionDirectoryPattern =
  /^\d{8}T\d{6}Z-([a-f0-9]{12})(?:[a-f0-9]{4}){0,13}$/;
const windowsReservedName = windowsReservedNameRegex();

export interface MaterializedSkill {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  lines: number;
  instruction: string;
}

export interface SkillMaterializerDeps {
  rootDirectory?: string;
  now?: () => Date;
}

interface SkillDirectoryIdentity {
  directoryName: string;
  includesNameInInstruction: boolean;
}

function cacheError(action: string, error: unknown): CliError {
  const reason = error instanceof Error ? error.message : 'an unknown error';
  return transportError(
    `Could not ${action}: ${reason}.`,
    'Check permissions for the skill cache and available disk space, then retry.',
  );
}

function skillDirectoryIdentity(name: string): SkillDirectoryIdentity {
  if (
    name.length <= 64 &&
    portableSkillName.test(name) &&
    !windowsReservedName.test(name)
  ) {
    return { directoryName: name, includesNameInInstruction: true };
  }
  return {
    directoryName: `_sha256-${createHash('sha256').update(name, 'utf8').digest('hex')}`,
    includesNameInInstruction: false,
  };
}

function lineCount(document: string): number {
  if (document.length === 0) {
    return 0;
  }
  const endings = document.match(/\r\n|\r|\n/g)?.length ?? 0;
  const endsWithLineEnding = /(?:\r\n|\r|\n)$/.test(document);
  return endings + 1 - (endsWithLineEnding ? 1 : 0);
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '').slice(0, 15).concat('Z');
}

function candidateDirectory(
  skillDirectory: string,
  publishedAt: string,
  sha256: string,
  prefixLength: number,
): string {
  return join(
    skillDirectory,
    `${publishedAt}-${sha256.slice(0, prefixLength)}`,
  );
}

function candidateBytes(path: string): Buffer | undefined {
  try {
    if (!lstatSync(path).isFile()) {
      return undefined;
    }
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

function findExistingArtifact(
  skillDirectory: string,
  sha256: string,
  canonicalBytes: Buffer,
): string | undefined {
  const candidates = readdirSync(skillDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((entry) => versionDirectoryPattern.test(entry))
    .sort();

  for (const candidate of candidates) {
    const separator = candidate.indexOf('-');
    const hashPrefix = candidate.slice(separator + 1);
    if (!sha256.startsWith(hashPrefix)) {
      continue;
    }

    const path = join(skillDirectory, candidate, 'SKILL.md');
    if (candidateBytes(path)?.equals(canonicalBytes)) {
      return path;
    }
  }

  return undefined;
}

function removeStagingDirectory(path: string | undefined): void {
  if (path !== undefined) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Cleanup must not replace the original publication error.
    }
  }
}

function ensureDirectories(
  rootDirectory: string,
  skillDirectory: string,
): void {
  mkdirSync(rootDirectory, { mode: 0o700, recursive: true });
  mkdirSync(skillDirectory, { mode: 0o700, recursive: true });
}

export function materializeSkill(
  name: string,
  document: string,
  deps: SkillMaterializerDeps = {},
): MaterializedSkill {
  const documentBytes = Buffer.from(document);
  const sha256 = createHash('sha256').update(documentBytes).digest('hex');
  const rootDirectory = deps.rootDirectory ?? materializedSkillsRoot();
  const directoryIdentity = skillDirectoryIdentity(name);
  const skillDirectory = join(rootDirectory, directoryIdentity.directoryName);
  const publishedAt = timestamp((deps.now ?? (() => new Date()))());

  try {
    ensureDirectories(rootDirectory, skillDirectory);

    const existingPath = findExistingArtifact(
      skillDirectory,
      sha256,
      documentBytes,
    );
    if (existingPath !== undefined) {
      return materializedSkill(
        name,
        existingPath,
        sha256,
        document,
        directoryIdentity.includesNameInInstruction,
      );
    }

    for (let prefixLength = 12; prefixLength <= 64; prefixLength += 4) {
      const directory = candidateDirectory(
        skillDirectory,
        publishedAt,
        sha256,
        prefixLength,
      );
      const path = join(directory, 'SKILL.md');
      const existing = candidateBytes(path);

      if (existing?.equals(documentBytes)) {
        return materializedSkill(
          name,
          path,
          sha256,
          document,
          directoryIdentity.includesNameInInstruction,
        );
      }
      if (existsSync(directory)) {
        continue;
      }

      let stagingDirectory: string | undefined;
      try {
        stagingDirectory = mkdtempSync(join(skillDirectory, '.staging-'));
        writeFileSync(join(stagingDirectory, 'SKILL.md'), document, 'utf8');
        renameSync(stagingDirectory, directory);
        stagingDirectory = undefined;
        return materializedSkill(
          name,
          path,
          sha256,
          document,
          directoryIdentity.includesNameInInstruction,
        );
      } catch (error) {
        removeStagingDirectory(stagingDirectory);

        if (!existsSync(directory)) {
          throw error;
        }

        const racedBytes = candidateBytes(path);
        if (racedBytes?.equals(documentBytes)) {
          return materializedSkill(
            name,
            path,
            sha256,
            document,
            directoryIdentity.includesNameInInstruction,
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw cacheError(`save skill "${name}"`, error);
  }

  throw transportError(
    `Could not save skill "${name}" because every SHA-256 path is already occupied by different content.`,
    'Remove conflicting cache entries, then retry.',
  );
}

function materializedSkill(
  name: string,
  path: string,
  sha256: string,
  document: string,
  includesNameInInstruction: boolean,
): MaterializedSkill {
  return {
    name,
    path,
    sha256,
    bytes: Buffer.byteLength(document),
    lines: lineCount(document),
    instruction: includesNameInInstruction
      ? `Read and follow the complete \`${name}\` skill at \`${path}\` for the current task.`
      : `Read and follow the complete skill at \`${path}\` for the current task.`,
  };
}
