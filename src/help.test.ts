import { describe, expect, it, vi } from 'vitest';

import {
  authHelpText,
  findOperation,
  listProductSurfaces,
  operationsMatchingPrefix,
  printGlobalHelp,
} from './help';

describe('help', () => {
  it('lists product surfaces for top-level help', () => {
    const surfaces = listProductSurfaces().map((surface) => surface.label);
    expect(surfaces).toEqual([
      'context',
      'projects',
      'events',
      'event-properties',
      'user-properties',
      'flags',
    ]);
  });

  it('finds an exact operation', () => {
    expect(findOperation(['flags', 'list'])?.operationId).toBe(
      'listFeatureFlags',
    );
  });

  it('finds operations under a command prefix', () => {
    const matches = operationsMatchingPrefix(['flags']);
    expect(matches.length).toBeGreaterThan(1);
    expect(matches.every((operation) => operation.command[0] === 'flags')).toBe(
      true,
    );
  });

  it('has auth-specific help outside the generated manifest', () => {
    const help = authHelpText();
    expect(help).toContain('amp auth login');
    expect(help).toContain('amp auth status');
    expect(help).toContain('--profile');
  });

  it('describes DELETE safety without overstating --dry-run support', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printGlobalHelp('https://developer-api.amplitude.com');
      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('Skip interactive confirmation for DELETE');
      expect(output).toContain('Preview supported DELETE commands');
      expect(output).not.toContain('unless --dry-run is set');
    } finally {
      log.mockRestore();
    }
  });
});
