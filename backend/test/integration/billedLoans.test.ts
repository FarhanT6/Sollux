/**
 * A premium finance loan entered apart from its insurance account (or left behind when the account
 * was added again) is linked to it — or, when the account has its own loan for the same debt, set
 * aside — so the Bills page shows one row and costs count it once; a mortgage is not moved onto a
 * statement account of the same lender. Made-up names.
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
  const prop = (address: string) => db.property.create({ data: { userId: me.id, address, city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const p1 = await prop('1200 Elm Grove Ln'), p2 = await prop('1300 Elm Grove Ln');
  const acct = (propertyId: string, providerName: string, category: string, accountNumber: string) => db.utilityAccount.create({ data: { propertyId, providerName, providerSlug: 'gmail-fallback', category, accountNumber } as any });
  const loan = (propertyId: string, lender: string, loanType: string, extra: Record<string, unknown> = {}) => db.loan.create({ data: { userId: me.id, propertyId, lender, loanType, originalAmount: 1000, monthlyPayment: 100, ...extra } as any });
  // 1. No loan on the account; the loan's own number differs from the account's.
  ids.ins = (await acct(p1.id, 'Example Premium Financing', 'INSURANCE', '00001234')).id;
  ids.pf = (await loan(p1.id, 'Example Premium Finance, Inc.', 'OTHER', { accountLast4: '9876' })).id;
  ids.bankAcct = (await acct(p1.id, 'Example Bank', 'OTHER', '99995678')).id;
  ids.mortgage = (await loan(p1.id, 'Example Bank', 'MORTGAGE')).id;
  // 2. The account has the importer's loan already; the same debt was entered again, with a payment.
  ids.ins2 = (await acct(p2.id, 'Example Premium Financing', 'INSURANCE', '00005555')).id;
  ids.linked = (await loan(p2.id, 'Example Premium Financing', 'INSTALLMENT_PLAN', { utilityAccountId: ids.ins2, monthlyPayment: 615.02 })).id;
  ids.dup = (await loan(p2.id, 'Example Premium Financing', 'OTHER', { monthlyPayment: 615.02 })).id;
  await db.loanPayment.create({ data: { loanId: ids.dup, date: new Date('2026-10-01T00:00:00Z'), amount: 615.02, status: 'PAID' } as any });
});
after(async () => { if (!skip) await api.stop(); });

test('linked to its insurance account; the same debt entered again set aside; the mortgage stays a loan', { skip }, async () => {
  const res = await fetch(`${api.url}/api/loans/tracker?year=2026&today=2026-11-20`);
  assert.equal(res.status, 200);
  const year = await res.json() as { rows: { loanId: string; utilityAccountId: string | null }[] };
  assert.equal(year.rows.find(r => r.loanId === ids.pf)?.utilityAccountId, ids.ins);
  assert.equal(year.rows.find(r => r.loanId === ids.mortgage)?.utilityAccountId ?? null, null);
  // The duplicate is no longer a row; its payment is on the account's loan.
  assert.equal(year.rows.some(r => r.loanId === ids.dup), false);
  const dup = await api.db.loan.findUniqueOrThrow({ where: { id: ids.dup } });
  assert.equal(dup.isActive, false);
  assert.match(dup.notes ?? '', /Set aside by Sollux/);
  assert.equal(await api.db.loanPayment.count({ where: { loanId: ids.linked } }), 1);
  assert.equal(await api.db.loanPayment.count({ where: { loanId: ids.dup } }), 0);
});

test('names that only share a word are not the same company', async () => {
  const { sameCompany } = await import('../../src/services/billedLoans');
  assert.equal(sameCompany('Capital Premium Financing', 'Capital Premium Financing, Inc.'), true);
  assert.equal(sameCompany('Capital Premium Finance', 'Capital Premium Financing'), true);
  assert.equal(sameCompany('Capital One', 'Capital Premium Financing'), false);
  assert.equal(sameCompany('IID', 'IID Electric'), false);
});
