import { z } from 'zod';

// The OAuth device-flow response shapes the CLI validates off the wire. These
// mirror the contract api-server projects from its own oauthResponseSchemas;
// the duplication is deliberate — developer-api ships as a standalone package
// and must not import from the server. Both sides encode the same RFC shapes,
// so they stay in lockstep by definition rather than by a shared import.

// RFC 8628 §3.2 — the device-authorization response.
export const deviceAuthorizationResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  verification_uri_complete: z.url().optional(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().optional(),
});
export type DeviceAuthorizationResponse = z.infer<
  typeof deviceAuthorizationResponseSchema
>;

// RFC 6749 §5.1 — the token response on a successful grant.
export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  id_token: z.string().min(1).optional(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
