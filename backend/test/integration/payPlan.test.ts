/**
 * The pay planner as Ask Sollux uses it: the owner's picks followed ("Sample Servicing and Example Wholesale from ··1111") and
 * the rest planned around them; only the payments asked about; cash, checks on hand and app balances
 * from Cash, checks & apps (a hand-entered cash balance from months ago left out) as money to deposit,
 * with where. Made-up lenders, accounts and amounts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const DAY = 86_400_000;

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * DAY) } });
  ids.user = me.id;
  const prop = (address: string) => db.property.create({ data: { userId: me.id, address, city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const dueDay = new Date(Date.now() + 3 * DAY).getUTCDate();
  const loan = async (lender: string, address: string, monthlyPayment: number) =>
    (await db.loan.create({ data: { userId: me.id, propertyId: (await prop(address)).id, lender, loanType: 'MORTGAGE', isActive: true, monthlyPayment, dueDay } as any })).id;
  ids.picked1 = await loan('Sample Servicing Co', '201 Example St', 5600);
  ids.picked2 = await loan('Example Wholesale Mortgage', '432 Sample St', 3900);
  ids.big = await loan('Placeholder Servicing', '1015 Example Hwy', 10250);
  const bank = async (name: string, last4: string, available: number, accountType = 'CHECKING', asOf = new Date()) => {
    const a = await db.bankAccount.create({ data: { userId: me.id, name, bank: 'Example Bank', last4, accountType } as any });
    await db.bankBalance.create({ data: { bankAccountId: a.id, balance: available, available, asOfDate: asOf, source: 'plaid' } as any });
    return a.id;
  };
  ids.a1111 = await bank('BUSINESS CHECKING ...1111', '1111', 9000);
  ids.a2222 = await bank('BUSINESS CHECKING ...2222', '2222', 12000);
  ids.a3333 = await bank('EVERYDAY CHECKING ...3333', '3333', 3000);
  // A cash balance typed in back in July, and the Cash wallet that keeps the real one.
  await bank('Cash on Hand', '', 500, 'CASH_POOL', new Date(Date.now() - 100 * DAY));
  const { ensureWallets } = await import('../../src/services/wallets');
  const wallets = await ensureWallets(me.id);
  await db.wallet.update({ where: { id: wallets.find(w => w.kind === 'CASH')!.id }, data: { openingBalance: 2000 } });
  // A rent check received this month, not deposited yet.
  const u = await db.unit.create({ data: { propertyId: (await prop('12 Sample Ct')).id, unitLabel: 'A' } });
  const lease = await db.lease.create({ data: { unitId: u.id, rentAmount: 1500, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2025-01-01') } as any });
  const first = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  await db.rentPayment.create({ data: { leaseId: lease.id, amount: 1500, periodDate: first, paidDate: new Date(Math.max(first.getTime(), Date.now() - DAY)), method: 'CHECK' } as any });
});
after(async () => { if (!skip) await api.stop(); });

test('the owner\'s picks are followed, the rest planned around them, and cash and checks become deposits', { skip }, async () => {
  const { buildPayPlan } = await import('../../src/lib/payPlan');
  const plan = await buildPayPlan(ids.user, {
    only: ['Sample Servicing', 'Example Wholesale', 'Placeholder Servicing'],
    choices: [{ payment: 'Sample Servicing', account: 'x1111' }, { payment: '432 Sample St', account: '201 Example St x1111' }],
  });
  assert.equal(plan.obligations.length, 3);
  const from = (loanId: string) => plan.obligations.find(o => o.id === loanId)!.payFrom.map(p => p.accountId);
  assert.deepEqual(from(ids.picked1), [ids.a1111]);
  assert.deepEqual(from(ids.picked2), [ids.a1111]);
  // The big one goes where there is room, not onto ··1111.
  assert.deepEqual(from(ids.big), [ids.a2222]);
  // Cash and app accounts are not drawn on; the July cash entry is left out for the Cash wallet's figure.
  assert.ok(!plan.accounts.some(a => a.accountType === 'CASH_POOL'));
  assert.deepEqual(plan.funds.map(f => [f.label, f.amount]).sort(), [['Cash', 2000], ['Checks on hand', 1500]]);
  assert.ok(plan.warnings.some(w => /Cash on Hand .* left out/.test(w)));
  // ··1111 is $500 short with both picks: the checks on hand go in first, and the rest of them too (it is left lowest).
  const into1111 = plan.deposits.filter(d => d.intoAccountId === ids.a1111);
  assert.equal(into1111[0].from, 'Checks on hand');
  assert.equal(into1111[0].amount, 500);
  assert.equal(Math.round(into1111.reduce((t, d) => t + d.amount, 0) * 100) / 100, 1500);
  assert.ok(!plan.deposits.some(d => d.from === 'Cash'), 'cash is only suggested where it is needed');
  assert.ok(plan.warnings.some(w => /1111 goes \$500 below/.test(w)));
});

test('nothing named: every payment due is planned, each from the account with the most room', { skip }, async () => {
  const { buildPayPlan } = await import('../../src/lib/payPlan');
  const plan = await buildPayPlan(ids.user, {});
  assert.equal(plan.obligations.filter(o => o.kind === 'LOAN').length, 3);
  // 24,000 across the three accounts, 19,750 due: covered without anything short.
  assert.equal(plan.totals.short, 0);
});

test('Ask Sollux sees each account\'s balance, what is planned from it and what is left', { skip }, async () => {
  const { runReadTool } = await import('../../src/ai/assistant');
  const r = await runReadTool(ids.user, 'pay_plan', { only: ['Sample Servicing'], choices: [{ payment: 'Sample Servicing', account: '1111' }] }, new Date().toISOString().slice(0, 10)) as any;
  const a = r.accounts.find((x: any) => /1111/.test(x.account));
  assert.equal(a.balance, 9000);
  assert.equal(a.plannedFromHere[0].amount, 5600);
  assert.equal(a.leftAfter, 3400);
});
