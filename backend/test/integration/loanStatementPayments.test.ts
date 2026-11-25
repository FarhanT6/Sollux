/**
 * Loan statements onto the loan (services/loanStatements.ts), made-up lenders and figures: a
 * mortgage statement filed to an account finds the mortgage already on the Loans tab (by its last
 * 4) instead of making a second, and puts each payment's principal, interest and escrow on the
 * matching payment; a loan billed through an account shows its statements' payments, once each.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00Z`);

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'PRIMARY' } });
  const mortgage = await db.loan.create({ data: { userId: me.id, propertyId: p.id, lender: 'Sample Home Lending', loanType: 'MORTGAGE', monthlyPayment: 2_000, accountLast4: '4321' } });
  await db.loanPayment.create({ data: { loanId: mortgage.id, date: d('2026-10-01'), amount: 2_000 } });
  await db.loanPayment.create({ data: { loanId: mortgage.id, date: d('2026-09-01'), amount: 2_000 } });
  const servicer = await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample Mortgage Servicing', providerSlug: 'gmail-fallback', category: 'LOAN', accountNumber: '0099994321' } });
  const cuAcct = await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample Credit Union', providerSlug: 'gmail-fallback', category: 'LOAN' } });
  const billed = await db.loan.create({ data: { userId: me.id, propertyId: p.id, utilityAccountId: cuAcct.id, lender: 'Sample Credit Union', loanType: 'AUTO', monthlyPayment: 400 } });
  const ls = (payments: unknown[], ytdInterest: number) => ({ loanStatement: { endingBalance: 8_000, regularPayment: 400, apr: 5.5, ytdInterest, payments } });
  await db.statement.create({ data: { utilityAccountId: cuAcct.id, statementDate: d('2026-09-30'), amountDue: 400, rawDataJson: ls([{ date: '2026-09-15', amount: 400, principal: 360, interest: 40, fees: 0, balance: 8_360 }], 150) } });
  await db.statement.create({ data: { utilityAccountId: cuAcct.id, statementDate: d('2026-10-31'), amountDue: 400, rawDataJson: ls([{ date: '2026-09-15', amount: 400, principal: 360, interest: 40, fees: 0, balance: 8_360 }, { date: '2026-10-15', amount: 400, principal: 362, interest: 38, fees: 0, balance: 7_998 }], 188) } });
  Object.assign(ids, { me: me.id, mortgage: mortgage.id, servicer: servicer.id, billed: billed.id });
});
after(async () => { if (!skip) await api.stop(); });

test('a mortgage statement updates the mortgage already on file and splits its payment', { skip }, async () => {
  const { syncLoanFromStatement } = await import('../../src/services/loanStatements');
  const r = await syncLoanFromStatement(ids.servicer, {
    statementDate: '2026-10-15', accountNumber: '0099994321',
    loanStatement: { description: 'Home loan', beginningBalance: 300_400, endingBalance: 300_000, regularPayment: 2_000, pastDue: 0, totalDue: 2_000, dueDate: '2026-11-01', apr: 6.5, ytdInterest: null,
      payments: [{ date: '2026-10-02', amount: 2_000, principal: 400, interest: 1_100, escrow: 500, fees: 0, balance: 300_000 }] },
  } as any);
  assert.equal(r, 'updated');
  assert.equal(await api.db.loan.count({ where: { userId: ids.me, loanType: 'MORTGAGE' } }), 1, 'no second mortgage');
  const m = await api.db.loan.findUniqueOrThrow({ where: { id: ids.mortgage } });
  assert.equal(Number(m.currentBalance), 300_000);
  assert.equal(Number(m.interestRate), 6.5);
  assert.equal(Number(m.escrowAmount), 500);
  assert.equal(m.utilityAccountId, null, 'left on the Loans tab');
  const oct = await api.db.loanPayment.findFirstOrThrow({ where: { loanId: ids.mortgage, date: d('2026-10-01') } });
  assert.deepEqual([Number(oct.principal), Number(oct.interest), Number(oct.escrow), Number(oct.balanceAfter)], [400, 1_100, 500, 300_000]);
  const sep = await api.db.loanPayment.findFirstOrThrow({ where: { loanId: ids.mortgage, date: d('2026-09-01') } });
  assert.equal(sep.principal, null, 'a payment the statement does not list is left');
});

test("a loan billed through an account shows its statements' payments once each", { skip }, async () => {
  const res = await fetch(`${api.url}/api/loans/${ids.billed}`);
  assert.equal(res.status, 200);
  const body = await res.json() as { statementPayments?: { payments: { date: string; principal: number; balance: number }[]; ytdInterest: number; ytdAsOf: string } };
  assert.ok(body.statementPayments, JSON.stringify(body));
  assert.deepEqual(body.statementPayments.payments.map(p => [p.date, p.principal, p.balance]), [['2026-10-15', 362, 7_998], ['2026-09-15', 360, 8_360]]);
  assert.equal(body.statementPayments.ytdInterest, 188);
  assert.equal(body.statementPayments.ytdAsOf, '2026-10-31');
});
