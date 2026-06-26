import { z } from 'zod';

/**
 * RFC 6749 §5.2 OAuth error, plus the OAuth server's `error_hint` extension.
 * The CLI parses upstream error bodies through this strict schema so debug-only
 * fields (`error_debug`, `status_code`) are dropped and only the actionable
 * message survives. Duplicated here so this package stays standalone for
 * distribution.
 */
export const oauthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  error_hint: z.string().optional(),
  error_uri: z.string().optional(),
});

export type OAuthErrorBody = z.infer<typeof oauthErrorSchema>;

/** Fallback when an upstream response is not RFC-shaped (no `error` field). */
export function serverError(): OAuthErrorBody {
  return {
    error: 'server_error',
    error_description:
      'The authorization server returned an unexpected response.',
  };
}

/**
 * Convert an arbitrary upstream error body into the client-facing OAuth error
 * shape. A body that isn't RFC-shaped degrades to a generic `server_error`.
 */
export function toOAuthError(body: unknown): OAuthErrorBody {
  const parsed = oauthErrorSchema.safeParse(body);

  return parsed.success ? parsed.data : serverError();
}
