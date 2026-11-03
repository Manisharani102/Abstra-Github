import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies GitHub's `X-Hub-Signature-256` header (HMAC-SHA256 of the exact raw request body).
 * Must run on the raw bytes: re-serialised JSON would not match.
 */
export function verifyGitHubSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  secret: string,
): boolean {
  if (!rawBody || !header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const received = Buffer.from(header);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
