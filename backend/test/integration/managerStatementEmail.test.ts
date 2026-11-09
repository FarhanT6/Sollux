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

const send = (method: string, path: string, body?: unknown) => fetch(`${api.url}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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

test('a choice made once fills the same line in next time, back months that were never recorded included', { skip }, async () => {
  const { intakeManagerStatement } = await import('../../src/services/managerStatementEmail');
  const { learnLineRules } = await import('../../src/services/managerStatementApply');
  const { db } = api;
  const profile = (await db.reconciliationProfile.findFirst({ where: { userId: ids.user } }))!;
  // The owner says what the unmatched lender line is, and that the owner's transfer came from their account.
  await learnLineRules(profile.id, [
    { description: 'Loan repayment - Unknown', kind: 'LOAN_PAYMENT', amount: 250, direction: 'OUT', loanId: ids.beta, include: true },
    { description: 'Transfer from Owner', kind: 'OWNER_PAYMENT', amount: 1600, direction: 'IN', bankAccountId: null, include: true },
  ]);
  const unknown = (m: string) => ({ date: `2026-${m}-20`, property: null, payee: 'Unknown Lender', description: 'Loan repayment - Unknown', kind: 'LOAN_PAYMENT', amount: 250, direction: 'OUT' });
  const owner = (m: string) => ({ date: `2026-${m}-07`, property: null, payee: null, description: 'Transfer from Owner', kind: 'OWNER_DRAW', amount: 1600, direction: 'IN' });
  const before = await db.loanPayment.count({ where: { loanId: ids.beta } });
  const r = await intakeManagerStatement(ids.user, Buffer.from('%PDF-1.4'), 'apr.pdf', 'manager@example.com', new Date('2026-05-01'), 'msg-3|apr.pdf', reader([...month('03'), unknown('02'), unknown('04'), owner('04'), ...month('04')]));
  // April's four lines, and the February and April "Unknown" lines now that it is known (February's was never recorded).
  assert.match(r.detail, /recorded 1 rent, 4 loan payments, 1 cost/);
  assert.equal(await db.loanPayment.count({ where: { loanId: ids.beta } }), before + 3);
  const st = await db.reconciliationStatement.findFirst({ where: { sourceRef: 'msg-3|apr.pdf' } });
  const ownerLine = (st!.lineItems as any[]).find(li => li.description === 'Transfer from Owner');
  assert.equal(ownerLine.targetLabel, 'OWNER_PAYMENT', 'the owner\'s transfer is kept as paid by the owner, not money sent to them');
});

test('redo: a lender letter from the manager is set aside and what it recorded removed; the real ones are recorded once', { skip }, async () => {
  const { db } = api;
  // A real PDF with text (pdf-lib), without the inbox agent (it opens queue connections).
  const textToPdf = async (text: string) => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    text.split('\n').forEach((line, i) => page.drawText(line, { x: 40, y: 750 - i * 13, size: 10, font }));
    return Buffer.from(await doc.save());
  };
  const { applyManagerStatement } = await import('../../src/services/managerStatementApply');
  const { redoManagerStatements, undoManagerStatement } = await import('../../src/services/managerStatementRedo');
  const profile = (await db.reconciliationProfile.findFirst({ where: { userId: ids.user } }))!;
  // A loan schedule the manager (also a lender) emailed, read as a statement before PDFs were checked.
  const bogus = await db.reconciliationStatement.create({ data: {
    userId: ids.user, profileId: profile.id, statementDate: new Date('2026-01-15'), source: 'email', sourceRef: 'msg-0|note.pdf', receivedAt: new Date('2026-01-15'),
    documentS3Key: 'bogus.pdf', netAmount: -75, draftJson: { lines: [], verified: false },
    lineItems: [{ type: 'EXPENSE', description: 'Late charge', amount: 75, direction: 'DEBIT', date: '2026-01-15', category: 'OTHER', propertyId: ids.property, include: true }],
  } });
  await applyManagerStatement(ids.user, bogus.id);
  const counts = async () => [await db.rentPayment.count({ where: { leaseId: ids.lease } }), await db.loanPayment.count({ where: { loan: { userId: ids.user } } }), await db.expense.count({ where: { userId: ids.user } })];
  const [rent0, loans0, exp0] = await counts();

  const letter = await textToPdf('Promissory Note - Payment Schedule\nBorrower: Sample Owner\nPrincipal $150,000.00\nInterest rate 10%\nMonthly interest payment $1,250.00 due on the 1st of each month.\nBalance after payment $150,000.00\n'.repeat(3));
  const r = await redoManagerStatements(ids.user, profile.id, { download: async () => letter });
  assert.equal(r.notStatements, 1);
  assert.equal((await db.reconciliationStatement.findUnique({ where: { id: bogus.id } }))!.status, 'NOT_A_STATEMENT');
  assert.deepEqual(await counts(), [rent0, loans0, exp0 - 1], 'only the letter\'s cost is gone; the statements recorded the same again');

  const apr = (await db.reconciliationStatement.findFirst({ where: { sourceRef: 'msg-3|apr.pdf' } }))!;
  await undoManagerStatement(ids.user, apr.id);
  assert.equal((await db.reconciliationStatement.findUnique({ where: { id: apr.id } }))!.status, 'UNDONE');
  assert.ok((await counts())[1] < loans0, 'its loan payments are removed');
});

test('one manager filed under two names is merged and each line counted once; a split line pays both loans', { skip }, async () => {
  const { db } = api;
  const { applyManagerStatement, learnLineRules } = await import('../../src/services/managerStatementApply');
  const { intakeManagerStatement } = await import('../../src/services/managerStatementEmail');
  const monty = (await db.reconciliationProfile.findFirst({ where: { userId: ids.user } }))!;
  // The same manager under the company name its statements are headed with, with a reviewed statement that repeats March's fee.
  const company = await db.reconciliationProfile.create({ data: { userId: ids.user, name: 'Sample Realty', loanIds: [] } });
  const dup = await db.reconciliationStatement.create({ data: {
    userId: ids.user, profileId: company.id, statementDate: new Date('2026-03-31'), netAmount: -100,
    lineItems: [{ type: 'EXPENSE', description: 'Property Management', amount: 100, direction: 'DEBIT', date: '2026-03-02', category: 'PROPERTY_MANAGEMENT', propertyId: ids.property, include: true }],
  } });
  await applyManagerStatement(ids.user, dup.id);
  const marchFees = () => db.expense.count({ where: { userId: ids.user, description: 'Property Management', date: new Date('2026-03-02T00:00:00Z') } });
  assert.equal(await marchFees(), 2, 'counted under both names');
  const r = await send('POST', `/reconciliation/profiles/${company.id}/merge`, { intoId: monty.id });
  assert.equal(r.status, 200);
  assert.equal(await marchFees(), 1, 'one manager: counted once');
  const merged = (await db.reconciliationProfile.findUnique({ where: { id: monty.id } }))!;
  assert.match(merged.name, /Sample Realty/);
  assert.equal(await db.reconciliationProfile.count({ where: { id: company.id } }), 0);

  // A lender's line that paid two loans at once, split once and remembered for that total.
  await learnLineRules(monty.id, [{ description: 'Loan repayment - Both', kind: 'LOAN_PAYMENT', amount: 1500, direction: 'OUT', loanId: ids.alpha, include: true,
    splits: [{ loanId: ids.alpha, amount: 1000 }, { loanId: ids.beta, amount: 500 }] }]);
  const before = await db.loanPayment.count({ where: { date: new Date('2026-05-02T00:00:00Z') } });
  await intakeManagerStatement(ids.user, Buffer.from('%PDF-1.4'), 'may.pdf', 'manager@example.com', new Date('2026-06-01'), 'msg-5|may.pdf',
    reader([{ date: '2026-05-02', property: null, payee: null, description: 'Loan repayment - Both', kind: 'LOAN_PAYMENT', amount: 1500, direction: 'OUT' }]));
  const may = await db.loanPayment.findMany({ where: { date: new Date('2026-05-02T00:00:00Z') }, orderBy: { amount: 'desc' } });
  assert.equal(may.length - before, 2);
  assert.deepEqual(may.map(p => [p.loanId, Number(p.amount)]), [[ids.alpha, 1000], [ids.beta, 500]]);
});

test('an undone statement is recorded again on its own, with what it recorded before', { skip }, async () => {
  const { db } = api;
  const st = (await db.reconciliationStatement.findFirst({ where: { userId: ids.user, status: 'APPLIED', source: 'email', NOT: { createdRecordIds: { equals: null as any } } }, orderBy: { receivedAt: 'asc' } }))!;
  const before = st.createdRecordIds as { rentPaymentIds?: string[]; loanPaymentIds?: string[]; expenseIds?: string[] };
  const count = (c: typeof before) => (c.rentPaymentIds?.length ?? 0) + (c.loanPaymentIds?.length ?? 0) + (c.expenseIds?.length ?? 0);
  assert.ok(count(before) > 0);
  assert.equal((await send('POST', `/reconciliation/statements/${st.id}/undo`)).status, 200);
  assert.equal((await db.reconciliationStatement.findUnique({ where: { id: st.id } }))!.status, 'UNDONE');
  const r = await send('POST', `/reconciliation/statements/${st.id}/record-again`);
  assert.equal(r.status, 200);
  const after = (await db.reconciliationStatement.findUnique({ where: { id: st.id } }))!;
  assert.equal(after.status, 'APPLIED');
  assert.equal(count(after.createdRecordIds as typeof before), count(before), 'the same records come back');
  // A letter set aside is not recorded.
  const letter = await db.reconciliationStatement.findFirst({ where: { userId: ids.user, status: 'NOT_A_STATEMENT' } });
  if (letter) assert.equal((await send('POST', `/reconciliation/statements/${letter.id}/record-again`)).status, 409);
});

test('a statement is deleted with what it recorded; start over deletes all of a manager\'s and fetches them again', { skip }, async () => {
  const { db } = api;
  const { startOverManager } = await import('../../src/services/managerStatementRedo');
  const monty = (await db.reconciliationProfile.findFirst({ where: { userId: ids.user } }))!;
  type Ids = { rentPaymentIds?: string[]; loanPaymentIds?: string[]; expenseIds?: string[] };
  const exists = async (c: Ids) => (await db.rentPayment.count({ where: { id: { in: c.rentPaymentIds ?? [] } } }))
    + (await db.loanPayment.count({ where: { id: { in: c.loanPaymentIds ?? [] } } })) + (await db.expense.count({ where: { id: { in: c.expenseIds ?? [] } } }));

  // An applied statement deletes (it used to be refused), taking what it recorded with it.
  const one = (await db.reconciliationStatement.findFirst({ where: { userId: ids.user, profileId: monty.id, status: 'APPLIED', source: 'email', NOT: { createdRecordIds: { equals: null as any } } }, orderBy: { receivedAt: 'desc' } }))!;
  const oneIds = one.createdRecordIds as Ids;
  assert.ok(await exists(oneIds) > 0, 'it recorded something');
  const r = await send('DELETE', `/reconciliation/statements/${one.id}`);
  assert.equal(r.status, 204);
  assert.equal(await db.reconciliationStatement.count({ where: { id: one.id } }), 0);
  assert.equal(await exists(oneIds), 0);

  // Start over: everything from the manager goes (letters set aside stay), then the email fetch runs far enough back.
  const all = await db.reconciliationStatement.findMany({ where: { userId: ids.user, profileId: monty.id } });
  const letters = all.filter(s => s.status === 'NOT_A_STATEMENT').length;
  const recorded = all.map(s => (s.createdRecordIds ?? {}) as Ids);
  let asked = 0;
  const out = await startOverManager(ids.user, monty.id, { fetch: async (_u, days) => { asked = days; return { mailboxes: 1, looked: 0, found: 0, recorded: 0, already: 0, details: [], errors: [] }; } });
  assert.equal(out.deleted, all.length - letters);
  assert.equal(await db.reconciliationStatement.count({ where: { userId: ids.user, profileId: monty.id, status: { not: 'NOT_A_STATEMENT' } } }), 0);
  assert.equal(await db.reconciliationStatement.count({ where: { userId: ids.user, profileId: monty.id, status: 'NOT_A_STATEMENT' } }), letters);
  for (const c of recorded) assert.equal(await exists(c), 0);
  assert.ok(asked >= 180, 'at least six months back');
  // The manager's remembered choices stay for the fresh read.
  assert.ok((await db.reconciliationProfile.findUnique({ where: { id: monty.id } }))!.lineRules);
});
