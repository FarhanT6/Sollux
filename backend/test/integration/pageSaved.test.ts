/**
 * A portal's bill page saved in place of its PDF (made-up account): the schedule comes back for the
 * PDF, and the agent does not count the page as the statement on file.
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
});
after(async () => { if (!skip) await api.stop(); });

test('a saved page is marked, and the schedule comes back for the PDF', { skip }, async () => {
  const { markSavedPages } = await import('../../src/services/pageSaved');
  const marked = await markSavedPages({ infoOf: async key => key.includes('page') ? { Creator: 'Mozilla/5.0 HeadlessChrome/147.0', Producer: 'Skia/PDF m147' } : { Producer: 'Acrobat' } });
  assert.equal(marked, 1);
  const { nextBillExpected } = await import('../../src/services/nextFetch');
  const next = await nextBillExpected(ids.acct, 'MONTHLY');
  // Still due: expected on the page's own date, not a month later.
  assert.equal(next.on?.toISOString().slice(0, 10), daysAgo(3).toISOString().slice(0, 10));
});
