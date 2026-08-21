import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY env var is required');

  // Buffer.from(x, 'hex') stops at the first character that isn't a hex digit
  // and returns what it decoded up to that point — no error. A key that is
  // the right length but carries a stray quote, space or base64 character
  // therefore produces a short buffer, and the only symptom is createCipheriv
  // reporting "Invalid key length" with nothing about the cause. Say it here
  // instead, without ever putting the key itself in a message.
  const buf = Buffer.from(key, 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must be 32 bytes of hex (64 hex characters); ` +
      `got ${key.length} character(s) decoding to ${buf.length} byte(s). ` +
      (/^[0-9a-fA-F]*$/.test(key)
        ? 'Generate one with: openssl rand -hex 32'
        : 'It contains non-hex characters — check for quotes, spaces, or a value that is base64 rather than hex.')
    );
  }
  return buf;
}

/**
 * Encrypt a plaintext string.
 * Returns base64-encoded: iv (16 bytes) + tag (16 bytes) + ciphertext
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a base64-encoded ciphertext produced by encrypt().
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const data = Buffer.from(ciphertext, 'base64');

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');
}

/** Encrypt only if value is truthy, otherwise return null */
export function encryptOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  return encrypt(value);
}

/** Decrypt only if value is truthy, otherwise return null */
export function decryptOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  return decrypt(value);
}
