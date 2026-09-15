import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { amplitudeDataFiles, amplitudeDataPath } from './amplitude-data-path';

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
