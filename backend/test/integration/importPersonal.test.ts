/**
 * Add → It's personal (made-up company, numbers and people): a bill filed as a new personal account
 * for a household member, kept with a property but personal; a second account from a company the
 * property already has is a new account, not the first one's bills; a personal invoice is that
 * person's expense.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};

before(async () => {
  if (skip) return;
  api = await startApi();
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const home = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'PRIMARY' } });
  const first = await db.utilityAccount.create({ data: { propertyId: home.id, providerName: 'Sample Credit Union', providerSlug: 'gmail-fallback', category: 'LOAN', accountNumber: '****0414' } });
  const parent = await db.householdMember.create({ data: { userId: me.id, name: 'Sample Parent' } });
  Object.assign(ids, { me: me.id, home: home.id, first: first.id, parent: parent.id });
});
after(async () => { if (!skip) await api.stop(); });

const confirm = (items: unknown[]) => fetch(`${api.url}/api/import/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) });

test("a personal bill is a new personal account for that person, not the first account's bills", { skip }, async () => {
  const r = await confirm([{
    filename: 'statement.pdf', fileData: '', ownerChose: true,
    extracted: { providerName: 'Sample Credit Union', accountNumber: '555512345678', statementDate: '2026-09-30', dueDate: '2026-10-30', amountDue: 600, currentCharges: 600, documentKind: 'bill', alerts: [], chargeBreakdown: null },
    match: { confidence: 'low', method: 'none', utilityAccountId: null },
    utilityAccountId: null, propertyId: ids.home,
    newAccount: { providerName: 'Sample Credit Union', providerSlug: 'sample-credit-union', category: 'LOAN', accountNumber: '555512345678' },
    personal: { memberId: ids.parent },
  }]);
  assert.equal(r.status, 200, await r.text());
  const accts = await api.db.utilityAccount.findMany({ where: { propertyId: ids.home }, orderBy: { createdAt: 'asc' } });
  assert.equal(accts.length, 2);
  const made = accts.find(a => a.id !== ids.first)!;
  assert.equal(made.isPersonal, true);
  assert.equal(made.memberId, ids.parent);
  assert.equal(await api.db.statement.count({ where: { utilityAccountId: made.id } }), 1);
  assert.equal(await api.db.statement.count({ where: { utilityAccountId: ids.first } }), 0);
});

test("a personal one-time invoice is that person's expense", { skip }, async () => {
  const r = await confirm([{
    filename: 'invoice.pdf', fileData: '',
    extracted: { providerName: 'Sample Plumbing', accountNumber: 'INV-1001', statementDate: '2026-10-05', statedTotalDue: 120, amountDue: 120, documentKind: 'service_invoice', alerts: [] },
    match: { confidence: 'low', method: 'none', utilityAccountId: null },
    utilityAccountId: null, expensePropertyId: null, expenseCategory: 'OTHER',
    personal: { memberId: ids.parent },
  }]);
  assert.equal(r.status, 200, await r.text());
  const e = await api.db.expense.findFirstOrThrow({ where: { userId: ids.me, amount: 120 } });
  assert.equal(e.isPersonal, true);
  assert.equal(e.propertyId, null);
  assert.equal(e.memberId, ids.parent);
});
