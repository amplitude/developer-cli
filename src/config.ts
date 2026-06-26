import { type FlagValue, stringFlag } from './args';
import { apiBaseUrlFromEnv } from './env';

export const DEFAULT_API_BASE_URL = 'https://developer-api.amplitude.com';

// Friendly `--env` names → developer-api base URLs. `auth login` requires an
// explicit env (or --base-url) when creating a profile — no implicit default —
// so this map is the ergonomic primitive, not optional sugar.
//
// DRIFT RISK: these env→host mappings mirror the server's per-env Hydra/host
// config (api-server `oauthConfig.ts`). This package is vended standalone, so it
// cannot import that config — the duplication is intentional but must be kept in
// sync by hand. (`staging` = stag2, matching the server; a server-side host
// rename won't trip a test here.)
export const ENV_BASE_URLS: Record<string, string> = {
  local: 'http://localhost:3036',
  // TODO(BA-367): verify the dev developer-api hostname.
  dev: 'https://developer-api.dev.amplitude.com',
  staging: 'https://developer-api.stag2.amplitude.com',
  prod: 'https://developer-api.amplitude.com',
  // TODO(BA-367): verify the prod-eu developer-api hostname.
  'prod-eu': 'https://developer-api.eu.amplitude.com',
};

export function resolveEnvBaseUrl(name: string): string {
  const url = ENV_BASE_URLS[name];
  if (!url) {
    throw new Error(
      `Unknown --env "${name}". Known: ${Object.keys(ENV_BASE_URLS).join(', ')}.`,
    );
  }
  return url;
}

export function resolveBaseUrl(flags: Record<string, FlagValue>): string {
  return (
    stringFlag(flags, ['base-url']) ??
    apiBaseUrlFromEnv() ??
    DEFAULT_API_BASE_URL
  ).replace(/\/$/, '');
}
