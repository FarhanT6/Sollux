/**
 * Uploads come in as base64 in a JSON body. A browser's FileReader gives a
 * data URL ("data:application/pdf;base64,JVBER…"); a screen that sent it
 * whole had the label decoded as part of the file, so the stored PDF began
 * with junk bytes and would not open (a new lease's attached documents).
 * stripDataUrls takes the label off every string that carries one, so each
 * route's Buffer.from(…, 'base64') gets only the file.
 */
const DATA_URL = /^data:[a-z0-9.+/-]+(?:;[a-z0-9=.+-]+)*;base64,/i;

export function stripDataUrls(body: unknown, depth = 0): void {
  if (depth > 4 || !body || typeof body !== 'object') return;
  const obj = body as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') { if (v.length > 64 && v.startsWith('data:')) { const m = DATA_URL.exec(v.slice(0, 200)); if (m) obj[k] = v.slice(m[0].length); } }
    else if (v && typeof v === 'object') stripDataUrls(v, depth + 1);
  }
}

/**
 * A file stored before that, with the label decoded into its first bytes,
 * restored. The junk decodes back to the label's own letters
 * ("dataapplication/pdfbase64"), so the stored bytes are encoded again, the
 * label taken off, and the rest decoded: a PDF comes back byte for byte (an
 * image at worst loses its very last byte). Null when the file is not one.
 */
export function repairDataUrlFile(buf: Buffer): Buffer | null {
  if (buf.length < 20 || buf.subarray(0, 5).toString('latin1') === '%PDF-') return null;
  const b64 = buf.subarray(0, 64).toString('base64');
  const m = /^data(?:application|image|text)[a-z0-9.+/-]*?base64/i.exec(b64);
  if (!m) return null;
  const fixed = Buffer.from(buf.toString('base64').slice(m[0].length), 'base64');
  const head = fixed.subarray(0, 4);
  const known = head.toString('latin1') === '%PDF' || (head[0] === 0xff && head[1] === 0xd8) || head.toString('latin1') === '\x89PNG'
    || head.toString('latin1').startsWith('GIF8') || head.toString('latin1') === 'RIFF';
  return known ? fixed : null;
}
