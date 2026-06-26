import { z } from 'zod';

/**
 * A plain JSON object: rejects arrays, null, and primitives. Shared by the
 * output formatter (guarding untrusted API payloads) and the CLI (validating
 * user-supplied --body-json).
 */
export const jsonRecordSchema = z.record(z.string(), z.unknown());

// RFC 8628 device-code grant type. The URN, not the bare `device_code` — the
// Developer API's token endpoint expects the URN form.
export const DEVICE_CODE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:device_code';
