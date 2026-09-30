import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliError } from './cli-error';
import { materializeSkill } from './skill-materializer';

type RenameAction = (() => void) | undefined;

const filesystemControl = vi.hoisted(
  (): {
    failRename: boolean;
    failCleanup: boolean;
    onRename: RenameAction;
  } => ({
    failRename: false,
    failCleanup: false,
    onRename: undefined,
  }),
);

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    rmSync: (...args: Parameters<typeof original.rmSync>) => {
      if (filesystemControl.failCleanup) {
        throw new Error('simulated cleanup failure');
      }
      return original.rmSync(...args);
    },
    renameSync: (...args: Parameters<typeof original.renameSync>) => {
      const onRename = filesystemControl.onRename;
      if (onRename !== undefined) {
        filesystemControl.onRename = undefined;
        onRename();
        throw new Error('simulated rename race');
      }
      if (filesystemControl.failRename) {
        throw new Error('simulated rename failure');
      }
      return original.renameSync(...args);
    },
  };
});

const temporaryDirectories: string[] = [];
const fixedNow = new Date('2026-09-18T12:34:56.789Z');
const laterNow = new Date('2026-09-19T12:34:56.789Z');
const latestNow = new Date('2026-09-20T12:34:56.789Z');
const name = 'first-event-node';
const document = `---\r\nname: ${name}\r\ndescription: Test skill\r\n---\r\n\r\n# Test skill\r\n`;
const canonicalDocument = document;

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'amp-skill-materializer-'));
  temporaryDirectories.push(directory);
  return directory;
}

function materialize(
  rootDirectory = temporaryRoot(),
  sourceDocument = document,
  now = fixedNow,
) {
  return materializeSkill(name, sourceDocument, {
    rootDirectory,
    now: () => now,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function versionDirectory(
  rootDirectory: string,
  digest: string,
  now = fixedNow,
  prefixLength = 12,
): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:.]/g, '')
    .slice(0, 15)
    .concat('Z');
  return join(
    rootDirectory,
    name,
    `${timestamp}-${digest.slice(0, prefixLength)}`,
  );
}

function versionDirectories(rootDirectory: string): string[] {
  return readdirSync(join(rootDirectory, name)).filter((entry) =>
    /^\d{8}T\d{6}Z-[a-f0-9]{12}(?:[a-f0-9]{4})*$/.test(entry),
  );
}

function stagingDirectories(rootDirectory: string): string[] {
  const skillDirectory = join(rootDirectory, name);
  try {
    return readdirSync(skillDirectory).filter((entry) =>
      entry.startsWith('.staging-'),
    );
  } catch {
    return [];
  }
}

function materializerUrl(): string {
  return pathToFileURL(join(process.cwd(), 'src/skill-materializer.ts')).href;
}

// Namespace import on purpose. How tsx exposes the module depends on the
// nearest package.json: with no "type" field the file loads as CommonJS and
// Node's interop puts module.exports on `default` with no named exports; with
// "type": "commonjs" it loads as ESM with the named export and no `default`.
// Reading whichever is present keeps the subprocess working under both.
function materializeInSubprocess(rootDirectory: string) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import * as loaded from ${JSON.stringify(materializerUrl())}; const materializer = loaded.materializeSkill ? loaded : loaded.default; if (process.platform !== 'win32') process.umask(0); materializer.materializeSkill(${JSON.stringify(name)}, ${JSON.stringify(document)}, { rootDirectory: ${JSON.stringify(rootDirectory)}, now: () => new Date(${JSON.stringify(fixedNow.toISOString())}) });`,
    ],
    { encoding: 'utf8' },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('materializeSkill', () => {
  it('preserves CR-only document bytes', () => {
    const rootDirectory = temporaryRoot();
    const crOnlyDocument = document.replace(/\r\n/g, '\r');

    const result = materializeSkill(name, crOnlyDocument, {
      rootDirectory,
      now: () => fixedNow,
    });

    expect(readFileSync(result.path, 'utf8')).toBe(crOnlyDocument);
  });

  it('preserves trailing whitespace-only lines', () => {
    const rootDirectory = temporaryRoot();
    const documentWithTrailingBlankLines = `${document}\t \r\n  \r\n`;

    const result = materializeSkill(name, documentWithTrailingBlankLines, {
      rootDirectory,
      now: () => fixedNow,
    });

    expect(readFileSync(result.path, 'utf8')).toBe(
      documentWithTrailingBlankLines,
    );
  });

  it('publishes fetched skill bytes in an immutable version directory', () => {
    const rootDirectory = temporaryRoot();

    const result = materialize(rootDirectory);
    const digest = sha256(canonicalDocument);
    const expectedPath = join(
      versionDirectory(rootDirectory, digest),
      'SKILL.md',
    );

    expect(result).toEqual({
      name,
      path: expectedPath,
      sha256: digest,
      bytes: Buffer.byteLength(canonicalDocument),
      lines: 6,
      instruction: `Read and follow the complete \`${name}\` skill at \`${expectedPath}\` for the current task.`,
    });
    expect(readFileSync(result.path, 'utf8')).toBe(canonicalDocument);
    expect(stagingDirectories(rootDirectory)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'creates new root and skill directories with private POSIX modes',
    () => {
      const rootDirectory = join(temporaryRoot(), 'materialized-skills');
      const result = materializeInSubprocess(rootDirectory);

      expect(result.status).toBe(0);

      expect(statSync(rootDirectory).mode.toString(8).slice(-3)).toBe('700');
      expect(
        statSync(join(rootDirectory, name)).mode.toString(8).slice(-3),
      ).toBe('700');
    },
  );

  it('allows a later same-user process to read a materialized skill', () => {
    const rootDirectory = join(temporaryRoot(), 'materialized-skills');
    const path = join(
      versionDirectory(rootDirectory, sha256(canonicalDocument)),
      'SKILL.md',
    );
    const creator = materializeInSubprocess(rootDirectory);
    const reader = spawnSync(process.execPath, [
      '--eval',
      `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(path)}));`,
    ]);

    expect(creator.status).toBe(0);
    expect(reader.stderr.toString()).toBe('');
    expect(reader.status).toBe(0);
    expect(reader.stdout).toEqual(Buffer.from(canonicalDocument));
  });

  it.skipIf(process.platform === 'win32')(
    'does not reuse an exact-content symlink artifact',
    () => {
      const rootDirectory = temporaryRoot();
      const digest = sha256(canonicalDocument);
      const symlinkDirectory = versionDirectory(rootDirectory, digest);
      const sourcePath = join(rootDirectory, 'source.md');
      const symlinkPath = join(symlinkDirectory, 'SKILL.md');
      writeFileSync(sourcePath, canonicalDocument);
      mkdirSync(symlinkDirectory, { recursive: true });
      symlinkSync(sourcePath, symlinkPath);

      const result = materialize(rootDirectory, document, laterNow);

      expect(result.path).toBe(
        join(versionDirectory(rootDirectory, digest, laterNow), 'SKILL.md'),
      );
      expect(readFileSync(result.path, 'utf8')).toBe(canonicalDocument);
    },
  );

  it('publishes a fresh artifact when a candidate SKILL.md is non-regular', () => {
    const rootDirectory = temporaryRoot();
    const digest = sha256(canonicalDocument);
    const malformedDirectory = versionDirectory(rootDirectory, digest);
    mkdirSync(join(malformedDirectory, 'SKILL.md'), { recursive: true });

    const result = materialize(rootDirectory, document, laterNow);

    expect(result.path).toBe(
      join(versionDirectory(rootDirectory, digest, laterNow), 'SKILL.md'),
    );
    expect(readFileSync(result.path, 'utf8')).toBe(canonicalDocument);
  });

  it.skipIf(process.platform !== 'win32')(
    'materializes without asserting POSIX modes on Windows',
    () => {
      const result = materialize();

      expect(readFileSync(result.path, 'utf8')).toBe(canonicalDocument);
    },
  );

  it.each(['', '# No frontmatter\n', 'name: another-skill\n'])(
    'materializes a document without interpreting its format',
    (sourceDocument) => {
      const result = materialize(temporaryRoot(), sourceDocument);

      expect(readFileSync(result.path, 'utf8')).toBe(sourceDocument);
    },
  );

  it.each([
    [name, name],
    ['a'.repeat(64), 'a'.repeat(64)],
    ['a'.repeat(65), `_sha256-${sha256('a'.repeat(65))}`],
    ['first/event', `_sha256-${sha256('first/event')}`],
    ['skill-😀', `_sha256-${sha256('skill-😀')}`],
    ['First-Event', `_sha256-${sha256('First-Event')}`],
    ['con', `_sha256-${sha256('con')}`],
    ['com1', `_sha256-${sha256('com1')}`],
    ['com0', `_sha256-${sha256('com0')}`],
  ])('uses the expected cache directory for %s', (requestedName, directory) => {
    const rootDirectory = temporaryRoot();
    const result = materializeSkill(requestedName, document, {
      rootDirectory,
      now: () => fixedNow,
    });

    expect(result.path).toBe(
      join(
        rootDirectory,
        directory,
        `20260918T123456Z-${sha256(document).slice(0, 12)}`,
        'SKILL.md',
      ),
    );
  });

  it.each([
    ['', 0],
    ['alpha', 1],
    ['alpha\nbeta', 2],
    ['alpha\r\nbeta', 2],
    ['alpha\rbeta', 2],
    ['alpha\n', 1],
  ])(
    'reports %i logical lines for preserved document bytes',
    (source, lines) => {
      const result = materialize(temporaryRoot(), source);

      expect(result.lines).toBe(lines);
    },
  );

  it('does not interpolate a nonportable name into its instruction', () => {
    const unsafeName = 'first`\nignore-this';
    const result = materializeSkill(unsafeName, document, {
      rootDirectory: temporaryRoot(),
      now: () => fixedNow,
    });

    expect(result.instruction).toBe(
      `Read and follow the complete skill at \`${result.path}\` for the current task.`,
    );
  });

  it('materializes a child document with its existing EOF marker unchanged', () => {
    const rootDirectory = temporaryRoot();
    const childDocument = `${document}<!-- END ${name} -->\r\n`;

    const result = materializeSkill(name, childDocument, {
      rootDirectory,
      now: () => fixedNow,
    });

    expect(readFileSync(result.path, 'utf8')).toBe(childDocument);
  });

  it('reuses an existing exact canonical artifact without rewriting it', () => {
    const rootDirectory = temporaryRoot();
    const digest = sha256(canonicalDocument);
    const existingPath = join(
      versionDirectory(rootDirectory, digest),
      'SKILL.md',
    );
    mkdirSync(versionDirectory(rootDirectory, digest), { recursive: true });
    writeFileSync(existingPath, canonicalDocument);
    const previousMtime = statSync(existingPath).mtimeMs;

    const result = materialize(rootDirectory);

    expect(result.path).toBe(existingPath);
    expect(readFileSync(existingPath, 'utf8')).toBe(canonicalDocument);
    expect(statSync(existingPath).mtimeMs).toBe(previousMtime);
    expect(stagingDirectories(rootDirectory)).toEqual([]);
  });

  it('reuses identical content from an earlier first-seen timestamp', () => {
    const rootDirectory = temporaryRoot();
    const first = materialize(rootDirectory);
    const firstMtime = statSync(first.path).mtimeMs;

    const reused = materialize(rootDirectory, document, laterNow);

    expect(reused.path).toBe(first.path);
    expect(readFileSync(first.path, 'utf8')).toBe(canonicalDocument);
    expect(statSync(first.path).mtimeMs).toBe(firstMtime);
    expect(versionDirectories(rootDirectory)).toEqual([
      `20260918T123456Z-${sha256(canonicalDocument).slice(0, 12)}`,
    ]);
  });

  it('creates a new first-seen artifact when canonical content changes', () => {
    const rootDirectory = temporaryRoot();
    const first = materialize(rootDirectory);
    const changedDocument = document.replace('# Test skill', '# Changed skill');
    const canonicalChangedDocument = canonicalDocument.replace(
      '# Test skill',
      '# Changed skill',
    );

    const changed = materialize(rootDirectory, changedDocument, laterNow);

    expect(readFileSync(first.path, 'utf8')).toBe(canonicalDocument);
    expect(changed.path).toBe(
      join(
        versionDirectory(
          rootDirectory,
          sha256(canonicalChangedDocument),
          laterNow,
        ),
        'SKILL.md',
      ),
    );
    expect(readFileSync(changed.path, 'utf8')).toBe(canonicalChangedDocument);
  });

  it('reuses the original artifact after content changes and returns', () => {
    const rootDirectory = temporaryRoot();
    const first = materialize(rootDirectory);
    const changedDocument = document.replace('# Test skill', '# Changed skill');

    materialize(rootDirectory, changedDocument, laterNow);
    const reused = materialize(rootDirectory, document, latestNow);

    expect(reused.path).toBe(first.path);
    expect(versionDirectories(rootDirectory)).toHaveLength(2);
  });

  it('uses candidate filenames only as a shortlist for byte comparison', () => {
    const rootDirectory = temporaryRoot();
    const digest = sha256(canonicalDocument);
    const misleadingDirectory = versionDirectory(rootDirectory, digest);
    const misleadingPath = join(misleadingDirectory, 'SKILL.md');
    mkdirSync(misleadingDirectory, { recursive: true });
    writeFileSync(misleadingPath, 'different bytes\n');

    const result = materialize(rootDirectory, document, laterNow);

    expect(result.path).toBe(
      join(versionDirectory(rootDirectory, digest, laterNow), 'SKILL.md'),
    );
    expect(readFileSync(misleadingPath, 'utf8')).toBe('different bytes\n');
  });

  it('reuses an exact artifact with an extended hash prefix', () => {
    const rootDirectory = temporaryRoot();
    const digest = sha256(canonicalDocument);
    const extendedDirectory = versionDirectory(
      rootDirectory,
      digest,
      fixedNow,
      16,
    );
    const extendedPath = join(extendedDirectory, 'SKILL.md');
    mkdirSync(extendedDirectory, { recursive: true });
    writeFileSync(extendedPath, canonicalDocument);

    const result = materialize(rootDirectory, document, laterNow);

    expect(result.path).toBe(extendedPath);
  });

  it('reuses the earliest exact artifact when legacy duplicates exist', () => {
    const rootDirectory = temporaryRoot();
    const digest = sha256(canonicalDocument);
    const earliestDirectory = versionDirectory(rootDirectory, digest);
    const laterDirectory = versionDirectory(rootDirectory, digest, laterNow);
    const earliestPath = join(earliestDirectory, 'SKILL.md');
    mkdirSync(earliestDirectory, { recursive: true });
    mkdirSync(laterDirectory, { recursive: true });
    writeFileSync(earliestPath, canonicalDocument);
    writeFileSync(join(laterDirectory, 'SKILL.md'), canonicalDocument);

    const result = materialize(rootDirectory, document, latestNow);

    expect(result.path).toBe(earliestPath);
  });

  it('extends the digest prefix when its candidate contains different bytes', () => {
    const rootDirectory = temporaryRoot();
    const digest = sha256(canonicalDocument);
    const collisionDirectory = versionDirectory(rootDirectory, digest);
    const collisionPath = join(collisionDirectory, 'SKILL.md');
    mkdirSync(collisionDirectory, { recursive: true });
    writeFileSync(collisionPath, 'different bytes\n');

    const result = materialize(rootDirectory);

    expect(readFileSync(collisionPath, 'utf8')).toBe('different bytes\n');
    expect(result.path).toBe(
      join(
        rootDirectory,
        name,
        `20260918T123456Z-${digest.slice(0, 16)}`,
        'SKILL.md',
      ),
    );
    expect(readFileSync(result.path, 'utf8')).toBe(canonicalDocument);
    expect(stagingDirectories(rootDirectory)).toEqual([]);
  });

  it('does not reuse a differently encoded artifact with the same UTF-8 text', () => {
    const rootDirectory = temporaryRoot();
    const documentWithReplacement = document.replace(
      '# Test skill',
      '# Test skill \uFFFD',
    );
    const canonicalWithReplacement = canonicalDocument.replace(
      '# Test skill',
      '# Test skill \uFFFD',
    );
    const digest = sha256(canonicalWithReplacement);
    const collisionDirectory = versionDirectory(rootDirectory, digest);
    const collisionPath = join(collisionDirectory, 'SKILL.md');
    const canonicalBytes = Buffer.from(canonicalWithReplacement);
    const replacementCharacter = Buffer.from('\uFFFD');
    const replacementOffset = canonicalBytes.indexOf(replacementCharacter);
    const invalidUtf8Bytes = Buffer.concat([
      canonicalBytes.subarray(0, replacementOffset),
      Buffer.from([0xff]),
      canonicalBytes.subarray(replacementOffset + replacementCharacter.length),
    ]);
    mkdirSync(collisionDirectory, { recursive: true });
    writeFileSync(collisionPath, invalidUtf8Bytes);

    const result = materializeSkill(name, documentWithReplacement, {
      rootDirectory,
      now: () => fixedNow,
    });

    expect(readFileSync(collisionPath)).toEqual(invalidUtf8Bytes);
    expect(result.path).toBe(
      join(
        rootDirectory,
        name,
        `20260918T123456Z-${digest.slice(0, 16)}`,
        'SKILL.md',
      ),
    );
    expect(stagingDirectories(rootDirectory)).toEqual([]);
  });

  it('removes its staging directory when publication fails', () => {
    const rootDirectory = temporaryRoot();
    filesystemControl.failRename = true;
    let caught: unknown;

    try {
      materialize(rootDirectory);
    } catch (error) {
      caught = error;
    } finally {
      filesystemControl.failRename = false;
    }

    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.errorCode).toBe('transport_error');
      expect(caught.hint).toContain('permissions for the skill cache');
      expect(caught.hint).not.toContain('temporary directory');
    }
    expect(stagingDirectories(rootDirectory)).toEqual([]);
  });

  it('preserves the publication error when staging cleanup also fails', () => {
    const rootDirectory = temporaryRoot();
    filesystemControl.failRename = true;
    filesystemControl.failCleanup = true;
    try {
      expect(() => materialize(rootDirectory)).toThrow(
        'simulated rename failure',
      );
    } finally {
      filesystemControl.failRename = false;
      filesystemControl.failCleanup = false;
    }
  });

  it('reuses an artifact published by a rename race when its bytes match', () => {
    const rootDirectory = temporaryRoot();
    const digest = sha256(canonicalDocument);
    const racedDirectory = versionDirectory(rootDirectory, digest);
    const racedPath = join(racedDirectory, 'SKILL.md');
    filesystemControl.onRename = () => {
      mkdirSync(racedDirectory, { recursive: true });
      writeFileSync(racedPath, canonicalDocument);
    };

    const result = materialize(rootDirectory);

    expect(result.path).toBe(racedPath);
    expect(readFileSync(racedPath, 'utf8')).toBe(canonicalDocument);
    expect(stagingDirectories(rootDirectory)).toEqual([]);
  });

  it('extends the digest prefix after a rename race publishes different bytes', () => {
    const rootDirectory = temporaryRoot();
    const digest = sha256(canonicalDocument);
    const racedDirectory = versionDirectory(rootDirectory, digest);
    const racedPath = join(racedDirectory, 'SKILL.md');
    filesystemControl.onRename = () => {
      mkdirSync(racedDirectory, { recursive: true });
      writeFileSync(racedPath, 'raced bytes\n');
    };

    const result = materialize(rootDirectory);

    expect(readFileSync(racedPath, 'utf8')).toBe('raced bytes\n');
    expect(result.path).toBe(
      join(
        rootDirectory,
        name,
        `20260918T123456Z-${digest.slice(0, 16)}`,
        'SKILL.md',
      ),
    );
    expect(readFileSync(result.path, 'utf8')).toBe(canonicalDocument);
    expect(stagingDirectories(rootDirectory)).toEqual([]);
  });

  it('fails without altering artifacts when all digest prefixes are occupied', () => {
    const rootDirectory = temporaryRoot();
    const digest = sha256(canonicalDocument);
    const paths: string[] = [];
    for (let prefixLength = 12; prefixLength <= 64; prefixLength += 4) {
      const directory = join(
        rootDirectory,
        name,
        `20260918T123456Z-${digest.slice(0, prefixLength)}`,
      );
      const path = join(directory, 'SKILL.md');
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, `occupied ${prefixLength}\n`);
      paths.push(path);
    }

    let caught: unknown;
    try {
      materialize(rootDirectory);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.errorCode).toBe('transport_error');
      expect(caught.hint).toContain('conflicting cache entries');
      expect(caught.hint).not.toContain('temporary root');
    }
    for (const path of paths) {
      expect(readFileSync(path, 'utf8')).toMatch(/^occupied /);
    }
    expect(stagingDirectories(rootDirectory)).toEqual([]);
  });
});
