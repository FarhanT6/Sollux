/**
 * pdf-parse, given each PDF as bytes of its own.
 *
 * Node keeps small Buffers (under 4 KB) as slices of one shared 8 KB block.
 * pdf-parse's pdf.js copies a Buffer it is given with `new Buffer(...)` — back
 * into that shared block — and reads the PDF's compressed parts from the start
 * of the block rather than the slice: a small PDF read as "Invalid PDF
 * structure" (or as no text) depending on where it happened to sit. A lender's
 * one-page letter was taken for a scanned statement. A plain Uint8Array is
 * copied into memory of its own, so every PDF goes in as one.
 */
const parse = require('pdf-parse') as (data: Uint8Array, opts?: Record<string, unknown>) => Promise<{ text: string; numpages: number; info?: unknown }>;

/** The PDF's bytes in memory of their own (a plain Uint8Array, never a slice of Node's shared block). */
export const ownBytes = (buf: Buffer | Uint8Array): Uint8Array => new Uint8Array(buf);

export default function pdfParse(buf: Buffer | Uint8Array, opts?: { pagerender?: (page: any) => Promise<string>; max?: number }) {
  return parse(ownBytes(buf), opts);
}
