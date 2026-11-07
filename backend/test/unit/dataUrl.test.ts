import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripDataUrls, repairDataUrlFile } from '../../src/lib/dataUrl';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

test('a data URL sent as the file is reduced to the file', () => {
  const body: any = { fileData: `data:application/pdf;base64,${pdf.toString('base64')}`, items: [{ fileData: `data:image/jpeg;base64,${'/9j/4AAQ'.repeat(20)}` }], notes: 'data: nothing to strip here' };
  stripDataUrls(body);
  assert.equal(body.fileData, pdf.toString('base64'));
  assert.ok(body.items[0].fileData.startsWith('/9j/'));
  assert.equal(body.notes, 'data: nothing to strip here');
});

test('a file stored with the label decoded into it comes back as it was', () => {
  const stored = Buffer.from(`data:application/pdf;base64,${pdf.toString('base64')}`, 'base64');
  assert.notEqual(stored.subarray(0, 4).toString('latin1'), '%PDF');
  assert.deepEqual(repairDataUrlFile(stored), pdf);
});

test('a good file is left alone', () => {
  assert.equal(repairDataUrlFile(pdf), null);
  assert.equal(repairDataUrlFile(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)])), null);
});
