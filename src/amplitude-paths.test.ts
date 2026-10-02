import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  amplitudeDataFiles,
  amplitudeDataPath,
  materializedSkillsRoot,
} from './amplitude-paths';

describe('amplitudeDataPath', () => {
  it('locates CLI state files in the shared Amplitude data directory', () => {
    expect(amplitudeDataPath(amplitudeDataFiles.clientIdentity)).toBe(
      join(homedir(), '.amplitude', 'amp', 'state.json'),
    );
  });

  it('preserves an explicit state-file override', () => {
    expect(
      amplitudeDataPath(
        amplitudeDataFiles.clientIdentity,
        '/tmp/amp-state.json',
      ),
    ).toBe('/tmp/amp-state.json');
  });
});

const envPathsCalls = vi.hoisted((): string[] => []);

vi.mock('env-paths', () => ({
  default: (name: string) => {
    envPathsCalls.push(name);
    return { cache: '/user-cache/amp-cli-nodejs' };
  },
}));

it('places materialized skills in the CLI cache directory', () => {
  expect(envPathsCalls).toEqual(['amp-cli']);
  expect(materializedSkillsRoot()).toBe(
    join('/user-cache/amp-cli-nodejs', 'skills'),
  );
});
