import { describe, expect, it } from 'vitest';

import { DEFAULT_SCOPES } from './scopes';

describe('DEFAULT_SCOPES', () => {
  it('is the canonical manifest scope union plus the legacy mcp scopes, sorted', () => {
    expect(DEFAULT_SCOPES).toBe(
      'analytics:read analytics:write destinations:read destinations:write flags:read flags:write guides:read guides:write mcp:read mcp:write offline_access openid projects:read surveys:read surveys:write taxonomy:read taxonomy:write',
    );
  });

  it('includes the legacy mcp org scopes', () => {
    const scopes = DEFAULT_SCOPES.split(' ');
    expect(scopes).toContain('mcp:read');
    expect(scopes).toContain('mcp:write');
  });

  it('requests only the scopes commands declare', () => {
    const scopes = DEFAULT_SCOPES.split(' ');
    expect(scopes).toContain('analytics:read'); // chart read operations
    // analytics:write arrived with the Agent Analytics write commands
    // (AA-152500). Until those existed no command declared it, and login must
    // not ask consent for a scope nothing uses — so this asserts presence
    // rather than absence only because the commands are now real.
    expect(scopes).toContain('analytics:write');
    // Nothing declares experiments:write, so it must stay out.
    expect(scopes).not.toContain('experiments:write');
  });

  it('requests the offline_access and openid meta-scopes', () => {
    const scopes = DEFAULT_SCOPES.split(' ');
    expect(scopes).toContain('offline_access'); // refresh token
    expect(scopes).toContain('openid'); // id_token (auth_time anchor)
  });
});
