import { describe, expect, it } from 'vitest';

import { DEFAULT_SCOPES } from './scopes';

describe('DEFAULT_SCOPES', () => {
  it('is the canonical manifest scope union plus the legacy mcp scopes, sorted', () => {
    expect(DEFAULT_SCOPES).toBe(
      'analytics:read destinations:read destinations:write flags:read flags:write mcp:read mcp:write offline_access openid projects:read taxonomy:read taxonomy:write',
    );
  });

  it('includes the legacy mcp org scopes', () => {
    const scopes = DEFAULT_SCOPES.split(' ');
    expect(scopes).toContain('mcp:read');
    expect(scopes).toContain('mcp:write');
  });

  it('requests only the scopes commands declare — no unused write scope', () => {
    const scopes = DEFAULT_SCOPES.split(' ');
    expect(scopes).toContain('analytics:read'); // chart read operations
    // No command writes analytics, so login must not ask consent for it.
    expect(scopes).not.toContain('analytics:write');
  });

  it('requests the offline_access and openid meta-scopes', () => {
    const scopes = DEFAULT_SCOPES.split(' ');
    expect(scopes).toContain('offline_access'); // refresh token
    expect(scopes).toContain('openid'); // id_token (auth_time anchor)
  });
});
