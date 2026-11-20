/**
 * A premium finance loan entered apart from its insurance account (or left behind when the account
 * was added again) is linked to it, so the Bills page shows one row and costs count it once; a
 * mortgage is not moved onto a statement account of the same lender. Made-up names.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } as any });
  const prop = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const acct = (providerName: string, category: string, accountNumber: string) => db.utilityAccount.create({ data: { propertyId: prop.id, providerName, providerSlug: 'gmail-fallback', category, accountNumber } as any });
  ids.ins = (await acct('Example Premium Financing', 'INSURANCE', '00001234')).id;
  ids.bankAcct = (await acct('Example Bank', 'OTHER', '99995678')).id;
  const loan = (lender: string, loanType: string) => db.loan.create({ data: { userId: me.id, propertyId: prop.id, lender, loanType, originalAmount: 1000, monthlyPayment: 100 } as any });
  ids.pf = (await loan('Example Premium Financing, Inc.', 'OTHER')).id;
  ids.mortgage = (await loan('Example Bank', 'MORTGAGE')).id;
});
after(async () => { if (!skip) await api.stop(); });

test('the premium finance loan joins its insurance account; the mortgage stays a loan', { skip }, async () => {
  const res = await fetch(`${api.url}/api/loans/tracker?year=2026&today=2026-11-20`);
  assert.equal(res.status, 200);
  const year = await res.json() as { rows: { loanId: string; utilityAccountId: string | null }[] };
  assert.equal(year.rows.find(r => r.loanId === ids.pf)?.utilityAccountId, ids.ins);
  assert.equal(year.rows.find(r => r.loanId === ids.mortgage)?.utilityAccountId ?? null, null);
  assert.equal((await api.db.loan.findUniqueOrThrow({ where: { id: ids.pf } })).utilityAccountId, ids.ins);
});

test('names that only share a word are not the same company', async () => {
  const { sameCompany } = await import('../../src/services/billedLoans');
  assert.equal(sameCompany('Capital Premium Financing', 'Capital Premium Financing, Inc.'), true);
  assert.equal(sameCompany('Capital One', 'Capital Premium Financing'), false);
  assert.equal(sameCompany('IID', 'IID Electric'), false);
});
