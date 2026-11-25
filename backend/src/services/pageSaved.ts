/**
 * A portal's bill page saved as the statement (portalAgent save_page_as_statement) is a stand-in:
 * a portal that gives statement PDFs has one for that bill too, once it is out. Such a page is
 * marked (`rawDataJson.pageSaved`): the agent does not count it as the statement on file, the
 * fetch schedule comes back for the PDF the next nights (services/nextFetch.ts), and the PDF
 * replaces the page when it comes (services/documentIntake.ts).
 *
 * Pages saved before they were marked are known by the PDF itself: Chrome printed it
 * (Creator "HeadlessChrome", Producer "Skia/PDF"). Once, recent ones are marked.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { downloadDocument } from './s3Service';
import pdfParse from '../lib/pdfParse';

const DAY = 86_400_000;

export const printedByChrome = (info: unknown): boolean => {
  const i = (info ?? {}) as Record<string, unknown>;
  return /headlesschrome|chrome/i.test(String(i.Creator ?? '')) && /skia/i.test(String(i.Producer ?? ''));
};

export async function markSavedPages(opts: { days?: number; infoOf?: (key: string) => Promise<unknown> } = {}): Promise<number> {
  const rows = await db.statement.findMany({
    where: { pdfS3Key: { not: null }, isScheduled: false, createdAt: { gte: new Date(Date.now() - (opts.days ?? 30) * DAY) }, rawDataJson: { path: ['source'], equals: 'portal' } },
    select: { id: true, pdfS3Key: true, rawDataJson: true },
  });
  let marked = 0;
  for (const s of rows) {
    const raw = (s.rawDataJson ?? {}) as Record<string, unknown>;
    if (raw.pageSaved) continue;
    let info: unknown = null;
    try { info = opts.infoOf ? await opts.infoOf(s.pdfS3Key!) : (await pdfParse(await downloadDocument(s.pdfS3Key!), { max: 1 })).info; } catch { continue; }
    if (!printedByChrome(info)) continue;
    await db.statement.update({ where: { id: s.id }, data: { rawDataJson: { ...raw, pageSaved: true } as Prisma.InputJsonValue } });
    marked++;
  }
  return marked;
}
