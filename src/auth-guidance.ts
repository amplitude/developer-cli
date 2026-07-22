import { apiBaseUrlFromEnv } from './env';

export const DEFAULT_APP_ORIGIN = 'https://app.amplitude.com';
export const EU_APP_ORIGIN = 'https://app.eu.amplitude.com';
export const DEFAULT_ORG_URL = 'amplitude';

const PAT_SETTINGS_SUFFIX = '/settings/profile/personal-access-tokens';

export function resolveAppOrigin(options?: { apiBaseUrl?: string }): string {
  const explicit = process.env.AMP_APP_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }

  const apiBase = options?.apiBaseUrl ?? apiBaseUrlFromEnv() ?? '';
  if (apiBase.includes('eu.amplitude.com')) {
    return EU_APP_ORIGIN;
  }

  return DEFAULT_APP_ORIGIN;
}

export function resolveOrgUrl(): string {
  const orgUrl = process.env.AMP_ORG_URL?.trim();
  return orgUrl || DEFAULT_ORG_URL;
}

export function personalAccessTokenSetupUrl(options?: {
  apiBaseUrl?: string;
  appOrigin?: string;
  orgUrl?: string;
}): string {
  const appOrigin = (
    options?.appOrigin ?? resolveAppOrigin({ apiBaseUrl: options?.apiBaseUrl })
  ).replace(/\/$/, '');
  const orgUrl = options?.orgUrl ?? resolveOrgUrl();

  return `${appOrigin}/analytics/${encodeURIComponent(orgUrl)}${PAT_SETTINGS_SUFFIX}`;
}

export function credentialsFileHint(path: string): string {
  return `Saved credentials to ${path}`;
}

export function missingTokenMessage(options?: { apiBaseUrl?: string }): string {
  const setupUrl = personalAccessTokenSetupUrl({
    apiBaseUrl: options?.apiBaseUrl,
  });

  return [
    'Missing token.',
    '',
    `Run: amp auth pat --with-token`,
    `Or create a token manually: ${setupUrl}`,
    '',
    'You can also set AMP_TOKEN or pass --token for a single command.',
  ].join('\n');
}

export function authSetupInstructions(options?: {
  apiBaseUrl?: string;
}): string {
  const setupUrl = personalAccessTokenSetupUrl({
    apiBaseUrl: options?.apiBaseUrl,
  });

  return [
    'Authenticate amp with a Personal Access Token (PAT).',
    '',
    'Recommended:',
    '  amp auth pat --with-token --region <us|eu>',
    '',
    'That prints the PAT settings page and reads the token from stdin (or a',
    'masked prompt at a terminal), saving it as the "default" profile (pass',
    '--profile <name> to use a different one) for future commands.',
    '',
    'Manual setup:',
    `  ${setupUrl}`,
    '',
    'Create a token with read access (and write access if you need',
    'create/update/delete commands), then run `amp auth pat --with-token`.',
    '',
    'Verify:',
    '  amp context',
    '',
    'Optional:',
    '  AMP_ORG_URL=<org-url-slug>  PAT settings org slug (default: amplitude)',
    '  AMP_APP_URL=<app-origin>    Override app host (default: app.amplitude.com)',
  ].join('\n');
}
