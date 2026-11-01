import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** SHA-256 as lowercase hex. Used for high-entropy random tokens and device secrets, never for passwords. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A random URL-safe token of `bytes` random bytes. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
