/**
 * The vault's cryptography, all in the browser (Web Crypto). Nothing here
 * leaves the page unencrypted.
 *
 *  passphrase ──PBKDF2-SHA256 (600k)──▶ passphrase key ─┐
 *  recovery key ─PBKDF2-SHA256 (600k)─▶ recovery key  ──┼─ each wraps ▶ data key (random AES-256)
 *                                                       │
 *  every record ──AES-256-GCM (data key, fresh IV)──▶ "iv:ciphertext"
 *
 * The data key lives only in memory while the vault is open. Changing the
 * passphrase re-wraps the data key; the records are not touched.
 */
export const VAULT_ITERATIONS = 600_000;

const enc = { encode: (s: string): Uint8Array<ArrayBuffer> => { const b = new TextEncoder().encode(s); const out = new Uint8Array(new ArrayBuffer(b.length)); out.set(b); return out; } };
const dec = new TextDecoder();
export const toB64 = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));

/** A key from a passphrase or recovery key. */
export async function deriveKey(secret: string, saltB64: string, iterations = VAULT_ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromB64(saltB64), iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function sealBytes(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return `${toB64(iv)}:${toB64(ct)}`;
}
async function openBytes(key: CryptoKey, sealed: string): Promise<Uint8Array<ArrayBuffer>> {
  const [iv, ct] = sealed.split(':');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv!) }, key, fromB64(ct!)));
}

export const newDataKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
export async function wrapDataKey(dataKey: CryptoKey, with_: CryptoKey): Promise<string> {
  return sealBytes(with_, new Uint8Array(await crypto.subtle.exportKey('raw', dataKey)));
}
/** Throws when the key is wrong — AES-GCM authenticates, so a wrong passphrase cannot open anything. */
export async function unwrapDataKey(wrapped: string, with_: CryptoKey): Promise<CryptoKey> {
  const raw = await openBytes(with_, wrapped);
  try { return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']); }
  finally { raw.fill(0); }
}

export async function sealRecord(dataKey: CryptoKey, record: unknown): Promise<string> {
  return sealBytes(dataKey, enc.encode(JSON.stringify(record)));
}
export async function openRecord<T = Record<string, string>>(dataKey: CryptoKey, sealed: string): Promise<T> {
  return JSON.parse(dec.decode(await openBytes(dataKey, sealed))) as T;
}

/** A recovery key: 25 random characters in five groups, no look-alike letters. */
export function newRecoveryKey(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(25);
  const chars = Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{5}/g)!.join('-');
}
export const normalizeRecoveryKey = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]/g, '').match(/.{1,5}/g)?.join('-') ?? '';

/** Rough strength: length and variety. A vault passphrase needs 12+ characters. */
export function passphraseProblem(p: string): string | null {
  if (p.length < 12) return 'Use at least 12 characters — a few unrelated words works well.';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(p)).length;
  if (p.length < 16 && kinds < 3) return 'Mix upper and lower case, numbers or symbols — or make it longer.';
  return null;
}
