/**
 * Bills already on file put right by the free text readers (made-up companies and figures):
 * an HOA ledger bill stored with its reprinted eCheck as a late fee, a loan bill stored as its
 * total plus the past due again (its loan learns its balance and rate), and an email bill saved as
 * its whole total split into what was carried and its own charge.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00Z`);

const LEDGER = (asOf: string, billing: string, total: string, lines: string[]) => [
  'Account NumberBilling Date', 'Amount Due', 'DATEDESCRIPTIONCHARGESCREDITSBALANCE', 'Property AddressAs of Date',
  '1200 ELM GROVE LN# 4', asOf, `123456654321${billing}${total}`, 'MAKECHECKPAYABLETO:', ...lines,
].join('\n');
const TEXTS: Record<string, string> = {
  'hoa/aug.pdf': LEDGER('August19, 2026', 'Sep 1, 2026', '$3,000.00', [
    '07/01/2026BALANCEFORWARD$2,200.00', '07/15/2026eCheck($1,200.00)$1,000.00', '08/01/2026MonthlyAssessment$1,000.00$2,000.00',
    '08/16/2026eCheck($1,000.00)$1,000.00', '09/01/2026MonthlyAssessment$1,000.00$2,000.00', '09/02/2026MonthlyAssessment-B$1,000.00$3,000.00',
  ]),
  'hoa/sep.pdf': LEDGER('September20, 2026', 'Oct 1, 2026', '$2,800.00', [
    '08/01/2026BALANCEFORWARD$1,000.00', '09/01/2026MonthlyAssessment$1,000.00$2,000.00', '09/02/2026MonthlyAssessment-B$1,000.00$3,000.00',
    '09/14/2026eCheck($1,200.00)$1,800.00', '10/01/2026MonthlyAssessment$1,000.00$2,800.00',
  ]),
  'loan/jun.pdf': [
    'Loan - 12: 2019 Sample Sedan', 'Beginning', 'Balance', 'Ending', 'Balance', 'Payment', 'Amount', 'Past Due', 'Amount', 'Total Amount', 'Due',
    'Payment Due', 'Date', 'Annual', 'Percentage Rate', 'Daily', 'Periodic Rate', 'Year-To-Date', 'Interest Charge',
    '$9,000.00$8,650.00$400.00$400.00$800.0007/30/20265.500%0.015068%$210.00',
  ].join('\n'),
};

before(async () => {
  if (skip) return;
  api = await startApi();
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'PRIMARY' } });
  const hoa = await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample HOA Management', providerSlug: 'gmail-fallback', category: 'HOA' } });
  const loanAcct = await db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample Credit Union', providerSlug: 'gmail-fallback', category: 'OTHER' } });
  const loan = await db.loan.create({ data: { userId: me.id, propertyId: p.id, utilityAccountId: loanAcct.id, lender: 'Sample Credit Union', loanType: 'AUTO', monthlyPayment: 400 } });
  // August's bill as the old reading left it: its $1,000 charge plus the reprinted $1,200 eCheck as a late fee.
  const aug = await db.statement.create({ data: {
    utilityAccountId: hoa.id, statementDate: d('2026-08-19'), dueDate: d('2026-09-01'), amountDue: 3_200, pastDueCarried: 1_000, penaltiesFees: 1_200, carriedFee: 1_200, pdfS3Key: 'hoa/aug.pdf',
    rawDataJson: { source: 'pdf_import', statedTotalDue: 3_000, previousBalance: 1_000, paymentsReceived: 2_200, chargeBreakdown: { 'Monthly Assessment': 2_000, 'Late fee (added to the next bill)': 1_200 } },
  } });
  await db.statement.create({ data: {
    utilityAccountId: hoa.id, statementDate: d('2026-09-20'), dueDate: d('2026-10-01'), amountDue: 1_000, pastDueCarried: 1_800, pdfS3Key: 'hoa/sep.pdf',
    rawDataJson: { source: 'pdf_import', statedTotalDue: 2_800, previousBalance: 1_800, paymentsReceived: 2_200 },
  } });
  // October's bill known only from its email, saved as the whole $2,500 asked.
  const oct = await db.statement.create({ data: {
    utilityAccountId: hoa.id, statementDate: d('2026-10-21'), dueDate: d('2026-11-01'), amountDue: 2_500,
    rawDataJson: { source: 'email', emailNotice: true, statedTotalDue: null },
  } });
  await db.payment.create({ data: { utilityAccountId: hoa.id, amount: 1_300, paymentDate: d('2026-10-15'), status: 'PAID' } });
  // The loan bill read as its $800 total with the $400 past due added again.
  const jun = await db.statement.create({ data: {
    utilityAccountId: loanAcct.id, statementDate: d('2026-06-30'), dueDate: d('2026-07-30'), amountDue: 800, pastDueCarried: 400, pdfS3Key: 'loan/jun.pdf',
    rawDataJson: { source: 'pdf_import', statedTotalDue: 800 },
  } });
  Object.assign(ids, { hoa: hoa.id, aug: aug.id, oct: oct.id, jun: jun.id, loan: loan.id });
});
after(async () => { if (!skip) await api.stop(); });

test('the free readers put the stored bills right, and the loan learns its balance and rate', { skip }, async () => {
  const { recheckStoredStatements } = await import('../../src/services/textRecheck');
  const r = await recheckStoredStatements({ textOf: async key => TEXTS[key] ?? '' });
  assert.ok(r.fixed >= 2, JSON.stringify(r));
  const aug = await api.db.statement.findUniqueOrThrow({ where: { id: ids.aug } });
  // The reprinted eCheck is no fee: August is its own $2,000 again (two assessments in its month).
  assert.equal(Number(aug.amountDue), 2_000);
  assert.equal(aug.carriedFee, null);
  const jun = await api.db.statement.findUniqueOrThrow({ where: { id: ids.jun } });
  assert.equal(Number(jun.amountDue), 400);
  assert.equal(Number(jun.pastDueCarried), 400);
  const loan = await api.db.loan.findUniqueOrThrow({ where: { id: ids.loan } });
  assert.equal(Number(loan.currentBalance), 8_650);
  assert.equal(Number(loan.interestRate), 5.5);
  assert.equal(loan.dueDay, 30);
});

test("an email bill saved as its whole total: the bill before's balance less what was paid is carried", { skip }, async () => {
  const { repairEmailTotals } = await import('../../src/services/emailTotals');
  assert.equal(await repairEmailTotals(), 1);
  const oct = await api.db.statement.findUniqueOrThrow({ where: { id: ids.oct } });
  // September asked $2,800; $1,300 was paid since; $1,500 carried, so October's own charge is $1,000.
  assert.equal(Number(oct.pastDueCarried), 1_500);
  assert.equal(Number(oct.amountDue), 1_000);
});

test('an account checked by hand: a bill edited by hand is reported and left, then put right when asked', { skip }, async () => {
  const { recheckAccount } = await import('../../src/services/accountRecheck');
  const me = await api.db.user.findFirstOrThrow({ where: { email: OWNER.email } });
  const p = await api.db.property.findFirstOrThrow({ where: { userId: me.id } });
  const acct = await api.db.utilityAccount.create({ data: { propertyId: p.id, providerName: 'Sample Lender Two', providerSlug: 'gmail-fallback', category: 'LOAN' } });
  const st = await api.db.statement.create({ data: {
    utilityAccountId: acct.id, statementDate: d('2026-06-30'), amountDue: 800, pastDueCarried: 400, pdfS3Key: 'loan/jun.pdf',
    rawDataJson: { source: 'pdf_import', statedTotalDue: 800, ownerEditedAt: '2026-07-02T00:00:00.000Z' },
  } });
  const textOf = async (key: string) => TEXTS[key] ?? '';
  const first = await recheckAccount(me.id, acct.id, { textOf });
  assert.equal(first?.ownerEdited, 1);
  assert.equal(Number((await api.db.statement.findUniqueOrThrow({ where: { id: st.id } })).amountDue), 800);
  const second = await recheckAccount(me.id, acct.id, { textOf, includeOwnerEdited: true });
  assert.equal(second?.fixed, 1);
  assert.equal(Number((await api.db.statement.findUniqueOrThrow({ where: { id: st.id } })).amountDue), 400);
  // A LOAN account with no loan gets one from its statement.
  assert.ok(second?.loan && !('none' in second.loan) && second.loan.balance === 8_650, JSON.stringify(second?.loan));
});
