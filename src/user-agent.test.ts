import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLI_VERSION } from './help';
import { cliUserAgent } from './user-agent';

describe('cliUserAgent', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('identifies the CLI and its version', () => {
    vi.stubEnv('AMP_CLIENT', undefined);

    expect(cliUserAgent()).toBe(`amp-cli/${CLI_VERSION}`);
  });

  it('appends the AMP_CLIENT tag', () => {
    vi.stubEnv('AMP_CLIENT', 'mcp');

    expect(cliUserAgent()).toBe(`amp-cli/${CLI_VERSION} (mcp)`);
  });

  it.each(['', '   ', 'MCP', 'mcp) (evil', 'a'.repeat(33)])(
    'drops the malformed tag %j',
    (tag) => {
      vi.stubEnv('AMP_CLIENT', tag);

      expect(cliUserAgent()).toBe(`amp-cli/${CLI_VERSION}`);
    },
  );
});
