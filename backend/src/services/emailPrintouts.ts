/**
 * PDFs Sollux printed from the body of an email ("your bill is ready").
 *
 * Until email notices were kept as figures only, the printout of such an
 * email was saved as the statement's PDF, though it is not the statement.
 * Each printout starts with the stamp Sollux put on it ("From: … Subject: …
 * Received: …"), which is how they are recognised here: on bills already
 * filed (once, at worker start) and on review cards staged before the change.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { downloadDocument } from './s3Service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;

export async function isEmailPrintout(pdf: Buffer): Promise<boolean> {
  // The plain-text printout is marked in its metadata (and its text layer is
  // one pdf-parse cannot read).
  try {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
    if (doc.getSubject() === 'Sollux email printout') return true;
  } catch { /* not readable by pdf-lib; try the text */ }
  try {
    const head = (await pdfParse(pdf)).text.trim().slice(0, 600);
    return /^From:[^\n]*\n?[\s\S]{0,300}?Subject:[\s\S]{0,300}?Received:/i.test(head);
  } catch { return false; }
}

/** Takes the printout off bills filed from an email body; their figures stay. Runs once per bill. */
export async function detachEmailPrintouts(): Promise<{ checked: number; detached: number }> {
  const rows = await db.statement.findMany({
    where: { pdfS3Key: { not: null }, rawDataJson: { path: ['source'], equals: 'email' } },
    select: { id: true, pdfS3Key: true, rawDataJson: true },
    take: 2000,
  });
  let checked = 0, detached = 0;
  for (const s of rows) {
    const raw = (s.rawDataJson ?? {}) as Record<string, unknown>;
    if (raw.printoutChecked || raw.emailNotice) continue;
    checked++;
    let printout = false;
    try { printout = await isEmailPrintout(await downloadDocument(s.pdfS3Key!)); } catch { continue; }
    await db.statement.update({
      where: { id: s.id },
      data: printout
        ? { pdfS3Key: null, rawDataJson: { ...raw, emailNotice: true, printoutChecked: true } as Prisma.InputJsonValue }
        : { rawDataJson: { ...raw, printoutChecked: true } as Prisma.InputJsonValue },
    });
    if (printout) detached++;
  }
  return { checked, detached };
}
