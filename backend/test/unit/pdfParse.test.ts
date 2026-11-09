/** A small PDF in a slice of Node's shared Buffer block is read as itself, not as the whole block. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import pdfParse, { ownBytes } from '../../src/lib/pdfParse';

test('a PDF that is a slice of a larger block reads the same as one on its own', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Promissory Note - Payment Schedule', { x: 40, y: 750, size: 10, font });
  const raw = await doc.save();
  // The PDF 300 bytes into a larger block, as a small Buffer from Node's pool is.
  const block = Buffer.alloc(raw.length + 600, 113);
  block.set(raw, 300);
  const slice = block.subarray(300, 300 + raw.length);
  assert.notEqual(slice.byteOffset, 0);
  const own = ownBytes(slice);
  assert.equal(own.byteOffset, 0);
  assert.equal(own.buffer.byteLength, raw.length);
  assert.equal(own.constructor, Uint8Array);
  assert.match((await pdfParse(slice)).text, /Promissory Note/);
  // A small Buffer straight from Node's pool, as an emailed or downloaded file is.
  for (let i = 0; i < 5; i++) {
    Buffer.from(new Uint8Array(100 + i * 37));
    assert.match((await pdfParse(Buffer.from(raw))).text, /Promissory Note/);
  }
});
