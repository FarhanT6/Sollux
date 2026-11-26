/**
 * A portal's bill page saved as the statement (portalAgent save_page_as_statement) is a stand-in:
 * a portal that gives statement PDFs has one for that bill too, once it is out. Such a page is
 * marked (`rawDataJson.pageSaved`): the agent does not count it as the statement on file, the
 * fetch schedule comes back for the PDF the next nights (services/nextFetch.ts), and the PDF
 * replaces the page when it comes (services/documentIntake.ts).
 *
 * Pages saved before they were marked are known by the PDF itself: Chrome printed it (Creator
 * "HeadlessChrome", Producer "Skia/PDF"), or — when the fetch ran in the owner's own Chrome through
 * the connector, which cannot print to PDF — Sollux made it from a screenshot (pdf-lib, and since
 * then "Sollux saved page"). The first marking knew only Chrome's, so a screenshot saved from City
 * of El Centro's Tyler portal passed for the portal's own PDF; from then on its bill pages were
 * refused ("this portal gives PDFs") and its new bills were never recorded.
 *
 * A saved page is a stand-in only where the portal gives PDFs (`pdfToCome`): elsewhere (Tyler Munis
 * self service, premium financing) the page is the statement and nothing more is coming.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { downloadDocument } from './s3Service';
import pdfParse from '../lib/pdfParse';

const DAY = 86_400_000;

export const SAVED_PAGE_PRODUCER = 'Sollux saved page';

/** A PDF Sollux made from a portal's page: Chrome printed it, or Sollux built it from a screenshot. */
export const printedByChrome = (info: unknown): boolean => {
  const i = (info ?? {}) as Record<string, unknown>;
  const creator = String(i.Creator ?? ''), producer = String(i.Producer ?? '');
  return (/headlesschrome|chrome/i.test(creator) && /skia/i.test(producer))
    || /pdf-lib|sollux saved page/i.test(producer) || /pdf-lib|sollux saved page/i.test(creator);
};

/** Portals that show bills as pages and never give a statement PDF. */
export const NO_PDF_PORTALS = /munisselfservice\.com/i;

/** Whether an account's portal gives statement PDFs: one fetched from it in the last year that is not a page Sollux saved. */
export async function accountGivesPdfs(accountIds: string[], host?: string | null): Promise<boolean> {
  if (!accountIds.length || (host && NO_PDF_PORTALS.test(host))) return false;
  const rows = await db.statement.findMany({
    where: { utilityAccountId: { in: accountIds }, pdfS3Key: { not: null }, isScheduled: false, statementDate: { gte: new Date(Date.now() - 365 * DAY) }, rawDataJson: { path: ['source'], equals: 'portal' } },
    select: { rawDataJson: true }, take: 12,
  });
  return rows.some(r => !(r.rawDataJson as Record<string, unknown> | null)?.pageSaved);
}

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

/**
 * Each saved page says whether a PDF is still to come: only where the account's portal gives PDFs.
 * Pages already saying so are left. Returns how many were set.
 */
export async function settlePdfToCome(opts: { days?: number } = {}): Promise<number> {
  const rows = await db.statement.findMany({
    where: { isScheduled: false, createdAt: { gte: new Date(Date.now() - (opts.days ?? 400) * DAY) }, rawDataJson: { path: ['pageSaved'], equals: true } },
    select: { id: true, rawDataJson: true, utilityAccountId: true, utilityAccount: { select: { loginUrl: true } } },
  });
  const gives = new Map<string, boolean>();
  let set = 0;
  for (const s of rows) {
    const raw = (s.rawDataJson ?? {}) as Record<string, unknown>;
    if (typeof raw.pdfToCome === 'boolean') continue;
    let host: string | null = null;
    try { host = s.utilityAccount.loginUrl ? new URL(s.utilityAccount.loginUrl).hostname : null; } catch { /* not a URL */ }
    if (!gives.has(s.utilityAccountId)) gives.set(s.utilityAccountId, await accountGivesPdfs([s.utilityAccountId], host));
    await db.statement.update({ where: { id: s.id }, data: { rawDataJson: { ...raw, pdfToCome: gives.get(s.utilityAccountId)! } as Prisma.InputJsonValue } });
    set++;
  }
  return set;
}
