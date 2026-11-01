import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const VERSION = 'v1';

/** AES-256-GCM over text. Each call uses a fresh random IV; `context` is bound in so a value moved to another row fails. */
export interface Cipher {
  encrypt(plain: string, context: string): string;
  decrypt(token: string, context: string): string;
}

/**
 * Builds the column cipher from a base64 256-bit key. The stored form is `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 * Throws at once for a key of the wrong size, so the API cannot start with a key that would encrypt weakly or not at all.
 */
export function createCipher(keyBase64: string | undefined): Cipher {
  const key = Buffer.from(keyBase64 ?? '', 'base64');
  if (key.length !== 32) throw new Error('BUNDLE_ENCRYPTION_KEY must be 32 random bytes encoded as base64');
  return {
    encrypt(plain, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context));
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
    },
    decrypt(token, context) {
      const [version, iv, tag, body] = token.split('.');
      if (version !== VERSION || !iv || !tag || body === undefined) throw new Error('stored value is not encrypted data');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}
