import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const packageManifestSchema = z.object({
  engines: z.object({
    node: z.string(),
  }),
});

function packageManifest() {
  return packageManifestSchema.parse(
    JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')),
  );
}

describe('published package engine contract', () => {
  it('matches the supported runtime dependency ranges', () => {
    expect(packageManifest().engines.node).toBe('^22.13.0 || >=23.5.0');
  });
});
