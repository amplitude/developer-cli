/**
 * Reads the API base URL from the environment via the canonical
 * AMP_API_BASE_URL. Returns undefined when it is unset (or blank) so callers
 * can apply their own default.
 *
 * Centralized here so the CLI request host (cli.ts) and the PAT settings app
 * origin (auth-guidance.ts) cannot drift apart. The legacy AMP_API alias was
 * dropped in M1 (BA-367) — AMP_API_BASE_URL is the only supported name.
 */
export function apiBaseUrlFromEnv(): string | undefined {
  return process.env.AMP_API_BASE_URL?.trim() || undefined;
}
