/**
 * Secret redaction — the single source of truth shared by every service that
 * logs or surfaces an error which might embed the AI Hub API key (BE-5 / Task 8
 * security). Keeping ONE implementation means a fix to the redaction rule can
 * never leave a second copy leaking the key.
 *
 * Redacts every occurrence of `apiKey` from `message`. A no-op when no key is
 * configured (empty string), so a missing key never blanks unrelated text.
 */
export function sanitize(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join('***');
}
