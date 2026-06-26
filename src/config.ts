import { type FlagValue, stringFlag } from './args';
import { apiBaseUrlFromEnv } from './env';

export const DEFAULT_API_BASE_URL = 'https://developer-api.amplitude.com';

// Friendly `--env` names → Developer API base URLs. `auth login` requires an
// explicit env (or --base-url) when creating a profile — no implicit default —
// so this map is the ergonomic primitive, not optional sugar.
//
// DRIFT RISK: these env→host mappings mirror the Developer API's per-env host
// config. This package ships standalone and cannot import that config, so the
// duplication is intentional but must be kept in sync by hand — a service-side
// host rename won't trip a test here.
export const ENV_BASE_URLS: Record<string, string> = {
  local: 'http://localhost:3036',
  dev: 'https://developer-api.dev.amplitude.com',
  staging: 'https://developer-api.stag2.amplitude.com',
  prod: 'https://developer-api.amplitude.com',
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
