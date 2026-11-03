import { createHmac } from 'node:crypto';
import { verifyGitHubSignature } from './signature';

describe('verifyGitHubSignature', () => {
  const secret = 'a-very-secret-webhook-secret';
  const body = Buffer.from('{"action":"opened"}');
  const sign = (b: Buffer, s = secret) => 'sha256=' + createHmac('sha256', s).update(b).digest('hex');

  it('accepts a correctly signed body', () => {
    expect(verifyGitHubSignature(body, sign(body), secret)).toBe(true);
  });

  it('rejects a body that was tampered with', () => {
    expect(verifyGitHubSignature(Buffer.from('{"action":"closed"}'), sign(body), secret)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyGitHubSignature(body, sign(body, 'some-other-secret-value'), secret)).toBe(false);
  });

  it('rejects missing or malformed headers', () => {
    expect(verifyGitHubSignature(body, undefined, secret)).toBe(false);
    expect(verifyGitHubSignature(body, 'sha1=abc', secret)).toBe(false);
    expect(verifyGitHubSignature(body, 'sha256=short', secret)).toBe(false);
    expect(verifyGitHubSignature(undefined, sign(body), secret)).toBe(false);
  });
});
