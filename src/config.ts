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

// Friendly `--region` names → the same Developer API base URLs as the
// internal prod/prod-eu envs. References ENV_BASE_URLS rather than
// hardcoding hosts a second time, so the two maps can't drift apart.
export const REGION_BASE_URLS: Record<string, string> = {
  us: ENV_BASE_URLS.prod,
  eu: ENV_BASE_URLS['prod-eu'],
};

export function resolveRegionBaseUrl(name: string): string {
  const url = REGION_BASE_URLS[name];
  if (!url) {
    throw new Error(
      `Unknown --region "${name}". Known: ${Object.keys(REGION_BASE_URLS).join(', ')}.`,
    );
  }
  return url;
}

// Callers must run this before any --base-url short-circuit, not just inside
// resolveNamedBaseUrl — otherwise a conflicting --region/--env pair silently
// passes through whenever --base-url also happens to be set.
export function assertRegionAndEnvNotBothSet(options: {
  envFlag?: string;
  regionFlag?: string;
}): void {
  if (options.regionFlag && options.envFlag) {
    throw new Error('Pass either --region or --env, not both.');
  }
}

// Centralizes the "--region xor --env" precedence shared by loginBaseUrl
// (auth-commands.ts) and baseUrlOverrideFromFlags (credential-resolver.ts) so
// both call sites agree on what each flag means and on the same
// mutual-exclusivity error.
export function resolveNamedBaseUrl(options: {
  envFlag?: string;
  regionFlag?: string;
}): string | undefined {
  assertRegionAndEnvNotBothSet(options);
  if (options.regionFlag) {
    return resolveRegionBaseUrl(options.regionFlag);
  }
  if (options.envFlag) {
    return resolveEnvBaseUrl(options.envFlag);
  }
  return undefined;
}

export function resolveBaseUrl(flags: Record<string, FlagValue>): string {
  return (
    stringFlag(flags, ['base-url']) ??
    apiBaseUrlFromEnv() ??
    DEFAULT_API_BASE_URL
  ).replace(/\/$/, '');
}
