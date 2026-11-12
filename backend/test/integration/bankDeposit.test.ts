/**
 * A bank deposit of several checks, read from the bank's page: each check matched to a tenant by the name
 * on it (or, with none, by what one tenant owes), split between rent and open utility invoices, recorded,
 * not twice, and undone. The read itself (the model) is stood in for. Made-up tenants and amounts.
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
  const me = await db.user.create({ data: { ...OWNER, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  ids.user = me.id;
  const p = await db.property.create({ data: { userId: me.id, address: '1200 Elm Grove Ln', city: 'Riverside', state: 'CA', zip: '92501', type: 'RESIDENTIAL_SINGLE' } });
  const lease = async (label: string, tenant: string, rent: number, invoice: number | null) => {
    const u = await db.unit.create({ data: { propertyId: p.id, unitLabel: label } });
    const l = await db.lease.create({ data: { unitId: u.id, rentAmount: rent, status: 'ACTIVE', leaseType: 'MONTH_TO_MONTH', startDate: new Date('2025-01-01'), arrearsBalance: 0 } as any });
    const t = await db.tenant.create({ data: { userId: me.id, fullName: tenant } });
    await db.leaseTenant.create({ data: { leaseId: l.id, tenantId: t.id } as any });
    if (invoice) {
      const r = await db.utilityReimbursement.create({ data: { leaseId: l.id, enabled: true, rulesJson: [] } });
      ids[`inv_${label}`] = (await db.reimbursementInvoice.create({ data: { reimbursementId: r.id, periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'), subtotal: invoice, total: invoice, status: 'SENT' } })).id;
    }
    return l.id;
  };
  ids.a = await lease('A', 'Jordan Sample', 1200, 110.79);
  ids.b = await lease('B', 'Riley Example', 629.1, null);
  ids.c = await lease('C', 'Casey Placeholder', 700, 33.68);
  ids.bank = (await db.bankAccount.create({ data: { userId: me.id, name: 'Business Checking', bank: 'Example Bank', last4: '9173', accountType: 'CHECKING' } as any })).id;
  // The bank's line for the deposit, left for review (it matched no one's rent).
  ids.line = (await db.incomingTransaction.create({ data: { userId: me.id, bankAccountId: ids.bank, plaidTransactionId: 'tx-deposit', amount: 2673.57, date: new Date('2026-11-10T00:00:00Z'), name: 'MOBILE DEPOSIT', channel: 'DEPOSIT', status: 'UNMATCHED' } as any })).id;
});
after(async () => { if (!skip) await api.stop(); });

const read = {
  bank: 'Example Bank', accountLast4: '9173', postDate: '2026-11-10', total: 2673.57, checkCount: 3,
  checks: [
    { index: 1, amount: 1310.79, payer: 'JORDAN SAMPLE', payTo: null, checkNumber: '1042', memo: 'November', checkDate: '2026-11-08' },
    { index: 2, amount: 629.1, payer: 'Riley Example', payTo: null, checkNumber: null, memo: null, checkDate: null },
    { index: 3, amount: 733.68, payer: null, payTo: null, checkNumber: '88', memo: null, checkDate: null },
  ],
};

test('each check matched to its tenant and split into rent and the open utility invoice', { skip }, async () => {
  const { draftDeposit } = await import('../../src/services/bankDeposit');
  const d = await draftDeposit(ids.user, read);
  assert.equal(d.bankAccountId, ids.bank);
  assert.deepEqual(d.problems, []);
  const [a, b, c] = d.checks;
  assert.deepEqual([a.leaseId, a.matchedBy, a.month, a.rent, a.utilities], [ids.a, 'name', '2026-11', 1200, 110.79]);
  assert.deepEqual([b.leaseId, b.rent, b.utilities], [ids.b, 629.1, 0]);
  // No name on it: the one tenant who owes exactly this (rent plus their open invoice).
  assert.deepEqual([c.leaseId, c.matchedBy, c.rent, c.utilities], [ids.c, 'amount', 700, 33.68]);
  assert.ok(d.checks.every(x => x.include));
});

test('recorded: rent as checks deposited into the account, utilities on the invoices, the bank\'s line marked; not twice; undone', { skip }, async () => {
  const { draftDeposit } = await import('../../src/services/bankDeposit');
  const d = await draftDeposit(ids.user, read);
  const send = (path: string, body: unknown) => fetch(`${api.url}/api/deposits${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const body = { bankAccountId: ids.bank, postDate: d.postDate, total: d.total, checks: d.checks.map(c => ({ leaseId: c.leaseId, amount: c.amount, month: c.month, rent: c.rent, utilities: c.utilities, payer: c.payer, checkNumber: c.checkNumber, memo: c.memo })) };
  const res = await send('/record', body);
  assert.equal(res.status, 200);
  const r = await res.json() as any;
  assert.deepEqual([r.rent, r.utilities, r.checks], [2529.1, 144.47, 3]);
  const { db } = api;
  const rents = await db.rentPayment.findMany({ where: { leaseId: { in: [ids.a, ids.b, ids.c] } }, orderBy: { amount: 'asc' } });
  assert.deepEqual(rents.map(p => Number(p.amount)), [629.1, 700, 1200]);
  assert.ok(rents.every(p => p.method === 'CHECK' && p.bankAccountId === ids.bank && p.depositedAt?.toISOString().startsWith('2026-11-10')));
  assert.match(rents[2].notes ?? '', /Check #1042 from JORDAN SAMPLE/);
  assert.equal(Number((await db.reimbursementInvoice.findUnique({ where: { id: ids.inv_A } }))!.paidAmount), 110.79);
  assert.equal(Number((await db.reimbursementInvoice.findUnique({ where: { id: ids.inv_C } }))!.paidAmount), 33.68);
  assert.equal((await db.incomingTransaction.findUnique({ where: { id: ids.line } }))!.status, 'APPLIED');
  // The same deposit again: refused; and the read says it is recorded.
  assert.equal((await send('/record', body)).status, 409);
  assert.ok((await draftDeposit(ids.user, read)).recorded);
  // Undone: payments gone, invoices open again, the bank's line back for review.
  const u = await send('/undo', { key: r.key });
  assert.equal(u.status, 200);
  assert.equal(await db.rentPayment.count({ where: { leaseId: { in: [ids.a, ids.b, ids.c] } } }), 0);
  assert.equal(Number((await db.reimbursementInvoice.findUnique({ where: { id: ids.inv_A } }))!.paidAmount), 0);
  assert.equal((await db.incomingTransaction.findUnique({ where: { id: ids.line } }))!.status, 'UNMATCHED');
  assert.equal((await draftDeposit(ids.user, read)).recorded, null);
});

test('another account\'s lease cannot be recorded to', { skip }, async () => {
  const res = await fetch(`${api.url}/api/deposits/record`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bankAccountId: ids.bank, postDate: '2026-11-11', total: 5, checks: [{ leaseId: 'not-mine', amount: 5, month: '2026-11', rent: 5, utilities: 0 }] }) });
  assert.equal(res.status, 404);
});
