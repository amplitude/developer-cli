import { describe, expect, it } from 'vitest';

import { DEFAULT_SCOPES } from './scopes';

describe('DEFAULT_SCOPES', () => {
  it('is the manifest scope union plus the legacy mcp scopes, sorted', () => {
    expect(DEFAULT_SCOPES).toBe(
      'mcp:read mcp:write read:flags read:projects read:taxonomy write:flags write:taxonomy',
    );
  });

  it('includes the legacy mcp org scopes', () => {
    const scopes = DEFAULT_SCOPES.split(' ');
    expect(scopes).toContain('mcp:read');
    expect(scopes).toContain('mcp:write');
  });

  it('excludes read:analytics until the OAuth client registers it', () => {
    expect(DEFAULT_SCOPES.split(' ')).not.toContain('read:analytics');
  });
});
