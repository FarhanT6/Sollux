/**
 * The paid rule (frontend lib/paidState.ts, shared by the account page and the Bills grid), made-up
 * figures: a bill page saved from a portal that lists bills one by one shows that bill's balance
 * alone, so a newer page whose balance is its own charge does not prove the older bills paid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeResolvedByFutureCheckpoint, computePaidMap } from '../../../frontend/src/lib/paidState';

const bill = (id: string, d: string, raw: Record<string, unknown>) => ({ id, statementDate: d, dueDate: d, amountDue: 3.5, balance: 3.5, pastDueCarried: null, rawDataJson: raw });
const status = (statements: any[], payments: any[] = []) =>
  Object.fromEntries(computePaidMap(statements, payments, computeResolvedByFutureCheckpoint(statements)));

test("a saved bill page does not mark the bills before it paid", () => {
  const pages = ['2026-11-25', '2026-10-25', '2026-09-25'].map((d, i) => bill(['dec', 'nov', 'oct'][i], d, { pageSaved: true, pdfToCome: false }));
  const paid = status(pages, [{ id: 'p', statementId: 'oct', amount: 3.5, paymentDate: '2026-10-10', status: 'PAID' }]);
  assert.deepEqual(paid, { oct: true, nov: false, dec: false });
});

test('a statement whose balance is its own charge still settles the bills before it', () => {
  const statements = ['2026-11-25', '2026-10-25', '2026-09-25'].map((d, i) => bill(['dec', 'nov', 'oct'][i], d, { source: 'pdf_import' }));
  assert.deepEqual(status(statements), { oct: true, nov: true, dec: false });
});

test('the Bills grid passes the flag on its own', () => {
  const rows = [{ ...bill('dec', '2026-11-25', {}), rawDataJson: undefined, pageSaved: true }, { ...bill('nov', '2026-10-25', {}), rawDataJson: undefined, pageSaved: true }];
  assert.deepEqual(status(rows), { nov: false, dec: false });
});

test("Owed now counts an older bill still open that the newest page does not carry", async () => {
  const { olderOpenBills, accountView } = await import('../../../frontend/src/lib/paidState');
  const pages = ['2026-11-25', '2026-10-25', '2026-09-25'].map((d, i) => bill(['dec', 'nov', 'oct'][i], d, { pageSaved: true, pdfToCome: false }));
  const pays = [{ id: 'p', statementId: 'oct', amount: 3.5, paymentDate: '2026-10-10', status: 'PAID' }];
  const paidMap = computePaidMap(pages, pays, computeResolvedByFutureCheckpoint(pages));
  assert.deepEqual(olderOpenBills(pages, pays, paidMap), { total: 3.5, count: 1 });
  assert.equal(accountView(pages, pays).owed, 7);
  // A newest bill that carries the older one's balance already holds it: not counted twice.
  const carried = [{ ...bill('dec', '2026-11-25', {}), pastDueCarried: 3.5, balance: 7 }, bill('nov', '2026-10-25', {})];
  assert.equal(olderOpenBills(carried, [], computePaidMap(carried, [], computeResolvedByFutureCheckpoint(carried))).total, 0);
  assert.equal(accountView(carried, []).owed, 7);
});
