/**
 * A portal's bill page saved in place of its PDF (made-up accounts): the schedule comes back for the
 * PDF, and the agent does not count the page as the statement on file. A page saved from a screenshot
 * (a fetch in the owner's own Chrome) is a saved page too, and a portal that gives no PDFs — a Tyler
 * site, or one whose every "PDF" was a saved page — is not chased for one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const daysAgo = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - n));

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const a = await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample Gas Co', providerSlug: 'gmail-fallback', category: 'GAS' } });
  await db.statement.create({ data: { utilityAccountId: a.id, statementDate: daysAgo(34), amountDue: 5, pdfS3Key: 'gas/oct.pdf', rawDataJson: { source: 'portal' } } });
  await db.statement.create({ data: { utilityAccountId: a.id, statementDate: daysAgo(3), amountDue: 5, pdfS3Key: 'gas/nov-page.pdf', rawDataJson: { source: 'portal' } } });
  ids.acct = a.id;
  // A water account on a Tyler portal: its "PDF" from September was a screenshot Sollux made.
  const w = await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample City Water', providerSlug: 'gmail-fallback', category: 'WATER', loginUrl: 'https://cityofsample.munisselfservice.com/css/citizens/Default.aspx' } });
  await db.statement.create({ data: { utilityAccountId: w.id, statementDate: daysAgo(62), amountDue: 3.5, pdfS3Key: 'water/sep-shot.pdf', rawDataJson: { source: 'portal' } } });
  await db.statement.create({ data: { utilityAccountId: w.id, statementDate: daysAgo(2), amountDue: 3.5, pdfS3Key: 'water/nov-shot.pdf', rawDataJson: { source: 'portal', pageSaved: true } } });
  ids.water = w.id;
});
after(async () => { if (!skip) await api.stop(); });

test('a saved page is marked, and the schedule comes back for the PDF', { skip }, async () => {
  const { markSavedPages } = await import('../../src/services/pageSaved');
  const marked = await markSavedPages({ infoOf: async key => key.includes('page') ? { Creator: 'Mozilla/5.0 HeadlessChrome/147.0', Producer: 'Skia/PDF m147' }
    : key.includes('shot') ? { Creator: 'pdf-lib (https://github.com/Hopding/pdf-lib)', Producer: 'pdf-lib (https://github.com/Hopding/pdf-lib)' } : { Producer: 'Acrobat' } });
  // The Chrome-printed page, and the screenshot (its newer twin was already marked).
  assert.equal(marked, 2);
  const { nextBillExpected } = await import('../../src/services/nextFetch');
  const next = await nextBillExpected(ids.acct, 'MONTHLY');
  // Still due: expected on the page's own date, not a month later.
  assert.equal(next.on?.toISOString().slice(0, 10), daysAgo(3).toISOString().slice(0, 10));
});

test("a portal that gives no PDFs is not chased for one, and its pages say so", { skip }, async () => {
  const { accountGivesPdfs, settlePdfToCome } = await import('../../src/services/pageSaved');
  assert.equal(await accountGivesPdfs([ids.water]), false, 'its only "PDF" was a screenshot');
  assert.equal(await accountGivesPdfs([ids.acct]), true);
  assert.equal(await accountGivesPdfs([ids.acct], 'cityofsample.munisselfservice.com'), false, 'a Tyler site gives none');
  assert.ok(await settlePdfToCome() >= 2);
  const pages = await api.db.statement.findMany({ where: { utilityAccountId: ids.water }, select: { rawDataJson: true } });
  assert.ok(pages.every(p => (p.rawDataJson as any).pageSaved === true && (p.rawDataJson as any).pdfToCome === false), JSON.stringify(pages));
  const { nextBillExpected } = await import('../../src/services/nextFetch');
  const next = await nextBillExpected(ids.water, 'MONTHLY');
  // Not the page's own date (no PDF is coming): the next bill, about a month on.
  assert.ok(next.on && next.on.getTime() > Date.now() + 15 * 86_400_000, String(next.on));
});
