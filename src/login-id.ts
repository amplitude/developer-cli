import { z } from 'zod';

export const LOGIN_ID_FLAG = 'loginId';
export const AMP_LOGIN_ID_HEADER = 'Amp-Login-Id';

const loginIdHeaderSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .regex(/^[\x20-\x7e]+$/);

export function loginIdHeader(
  loginId: string | undefined,
): Record<string, string> {
  const parsed = loginIdHeaderSchema.safeParse(loginId);
  return parsed.success ? { [AMP_LOGIN_ID_HEADER]: parsed.data } : {};
}
