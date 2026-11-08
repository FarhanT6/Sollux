/**
 * A manager's statement fetched from email records itself: rent for the month each
 * line shows, each loan line as that month's payment, fees as costs — skipping a loan
 * month already paid, the lines an earlier year-to-date statement had, and an email
 * read before. The read itself (an AI call) is replaced by the lines it would return.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};

before(async () => {
  if (skip) return;
  api = await startApi();
  // The services run in this process, on the test database.
  process.env.DATABASE_URL = TEST_DB;
  const { db } = api;
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  ids.user = me.id;
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'COMMERCIAL' as any } });
  const u = await db.unit.create({ data: { propertyId: p.id, unitLabel: 'Suite 1' } });
  const t = await db.tenant.create({ data: { userId: me.id, fullName: 'Acme Clinic' } as any });
  const lease = await db.lease.create({ data: { unitId: u.id, rentAmount: 5000, status: 'ACTIVE', leaseType: 'FIXED_TERM', startDate: new Date('2025-01-01'), leaseTenants: { create: { tenantId: t.id } } } as any });
  const a = await db.loan.create({ data: { userId: me.id, propertyId: p.id, lender: 'Lender Alpha', loanType: 'MORTGAGE', isActive: true } as any });
  const b = await db.loan.create({ data: { userId: me.id, propertyId: p.id, lender: 'Lender Beta', loanType: 'MORTGAGE', isActive: true } as any });
  // January's Alpha payment is already on record (marked paid to date).
  await db.loanPayment.create({ data: { loanId: a.id, date: new Date('2026-01-02'), amount: 1000, status: 'PAID' } });
  Object.assign(ids, { property: p.id, lease: lease.id, alpha: a.id, beta: b.id });
});
after(async () => { if (!skip) await api.stop(); });

const month = (m: string) => [
  { date: `2026-${m}-02`, property: '1200 Elm Grove Ln', payee: 'Acme Clinic', description: 'Rent Received', kind: 'RENT', amount: 5000, direction: 'IN' },
  { date: `2026-${m}-02`, property: '1200 Elm Grove Ln', payee: null, description: 'Property Management', kind: 'MANAGEMENT_FEE', amount: 100, direction: 'OUT' },
  { date: `2026-${m}-02`, property: '1200 Elm Grove Ln', payee: 'Lender Alpha', description: 'Loan repayment - Alpha', kind: 'LOAN_PAYMENT', amount: 1000, direction: 'OUT' },
  { date: `2026-${m}-02`, property: '1200 Elm Grove Ln', payee: 'Lender Beta', description: 'Loan interest - Beta', kind: 'LOAN_PAYMENT', amount: 500, direction: 'OUT' },
];
const reader = (lines: any[]) => ({
  read: async (userId: string) => {
    const { matchManagerStatement } = await import('../../src/services/managerStatement');
    return matchManagerStatement(userId, { manager: 'Sample Manager', statementDate: '2026-02-28', lines });
  },
  upload: async () => {},
});

test('an emailed statement records itself, once, and the next year-to-date one only adds the new month', { skip }, async () => {
  const { intakeManagerStatement } = await import('../../src/services/managerStatementEmail');
  const { db } = api;
  const pdf = Buffer.from('%PDF-1.4 test');
  const first = await intakeManagerStatement(ids.user, pdf, 'feb.pdf', 'Sample Manager <manager@example.com>', new Date('2026-03-01'), 'msg-1|feb.pdf',
    reader([...month('01'), ...month('02'), { date: '2026-02-20', property: null, payee: 'Unknown Lender', description: 'Loan repayment - Unknown', kind: 'LOAN_PAYMENT', amount: 250, direction: 'OUT' }]));
  assert.match(first.detail, /recorded 2 rent, 3 loan payments, 2 costs/);
  assert.match(first.detail, /1 line to review/);

  const rent = await db.rentPayment.findMany({ where: { leaseId: ids.lease }, orderBy: { periodDate: 'asc' } });
  assert.deepEqual(rent.map(r => r.periodDate.toISOString().slice(0, 10)), ['2026-01-01', '2026-02-01']);
  const alpha = await db.loanPayment.findMany({ where: { loanId: ids.alpha }, orderBy: { date: 'asc' } });
  assert.equal(alpha.length, 2, "January's was on record already; February's is added");
  assert.equal(alpha[1].periodDate?.toISOString().slice(0, 10), '2026-02-01');
  assert.equal(alpha[1].method, 'DEDUCTED');
  const profile = await db.reconciliationProfile.findFirst({ where: { userId: ids.user } });
  assert.equal(profile?.emailFrom, 'manager@example.com');

  // The same email again: nothing new.
  const again = await intakeManagerStatement(ids.user, pdf, 'feb.pdf', 'manager@example.com', null, 'msg-1|feb.pdf', reader(month('01')));
  assert.match(again.detail, /already fetched/);

  // March's year-to-date statement repeats January and February.
  const next = await intakeManagerStatement(ids.user, pdf, 'mar.pdf', 'manager@example.com', new Date('2026-04-01'), 'msg-2|mar.pdf', reader([...month('01'), ...month('02'), ...month('03')]));
  assert.match(next.detail, /recorded 1 rent, 2 loan payments, 1 cost/);
  assert.equal(await db.rentPayment.count({ where: { leaseId: ids.lease } }), 3);
  assert.equal(await db.loanPayment.count({ where: { loanId: ids.beta } }), 3);
});
