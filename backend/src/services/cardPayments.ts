/**
 * A card's payments and the statements that list them.
 *
 * A payment the owner logs ("Log payment") later shows up as a line on the
 * next statement. The two are one payment: the statement's line is matched to
 * the logged payment (same amount, the logged date up to 10 days before the
 * line's or 3 after) and the payment is marked as posted on that statement,
 * so it is not counted against the statement's balance a second time. A line
 * with no logged payment becomes one (method "On statement"), so the
 * Payments tab shows every payment, and logging it afterwards fills in that
 * one rather than adding a second.
 */
import { db } from '../config/db';

export const ON_STATEMENT = 'On statement';
const DAY = 86_400_000;

/** A statement's payment line: amount positive for a payment, negative for a payment reversed (returned check). */
export interface PayLine { date: Date; amount: number; reference?: string | null }
export interface LoggedPay { id: string; date: Date; amount: number; postedStatementId: string | null; method: string | null; confirmation?: string | null }

/** "P632139753156462" on the statement and "632139753156462" typed in are one confirmation. */
const refKey = (r: string | null | undefined) => (r ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const sameReference = (a: string | null | undefined, b: string | null | undefined) => {
  const x = refKey(a), y = refKey(b);
  if (x.length < 6 || y.length < 6) return false;
  return x === y || x.endsWith(y) || y.endsWith(x);
};

/** Each statement line's logged payment, or null. Pure; exported for tests. */
export function matchLines(lines: PayLine[], logged: LoggedPay[], statementId: string): (string | null)[] {
  const used = new Set<string>();
  const fits = (l: PayLine, p: LoggedPay) => Math.abs(p.amount - l.amount) < 0.005
    && (sameReference(l.reference, p.confirmation)
      ? Math.abs(p.date.getTime() - l.date.getTime()) <= 31 * DAY
      : p.date.getTime() >= l.date.getTime() - 10 * DAY && p.date.getTime() <= l.date.getTime() + 3 * DAY);
  return lines.map(l => {
    const cands = logged.filter(p => !used.has(p.id) && (p.postedStatementId == null || p.postedStatementId === statementId) && fits(l, p))
      // Already this statement's first, then the owner's own, then the nearest date.
      // The same confirmation number first, then already this statement's, then the owner's own, then the nearest date.
      .sort((a, b) => Number(sameReference(l.reference, b.confirmation)) - Number(sameReference(l.reference, a.confirmation))
        || Number(b.postedStatementId === statementId) - Number(a.postedStatementId === statementId)
        || Number(a.method === ON_STATEMENT) - Number(b.method === ON_STATEMENT)
        || Math.abs(a.date.getTime() - l.date.getTime()) - Math.abs(b.date.getTime() - l.date.getTime()));
    const hit = cands[0] ?? null;
    if (hit) used.add(hit.id);
    return hit?.id ?? null;
  });
}

/** Link a statement's payment lines to the card's payments; make the ones that are missing. */
export async function syncStatementPayments(statementId: string): Promise<{ linked: number; created: number }> {
  const st = await db.cardStatement.findUnique({ where: { id: statementId }, select: { id: true, cardId: true, closingDate: true } });
  if (!st) return { linked: 0, created: 0 };
  const rows = (await db.cardTransaction.findMany({ where: { statementId, kind: 'PAYMENT' }, orderBy: { date: 'asc' }, select: { date: true, amount: true, description: true, reference: true } }))
    .filter(r => Number(r.amount) !== 0);
  // A payment line takes the balance down (negative on the statement); a reversed one is a payment taken back.
  const lines = rows.map(r => ({ date: r.date, amount: -Number(r.amount), reference: r.reference }));
  const from = new Date(st.closingDate.getTime() - 75 * DAY), to = new Date(st.closingDate.getTime() + 10 * DAY);
  const logged = (await db.cardPayment.findMany({ where: { cardId: st.cardId, date: { gte: from, lte: to } }, select: { id: true, date: true, amount: true, postedStatementId: true, method: true, confirmation: true } }))
    .map(p => ({ ...p, amount: Number(p.amount) }));
  const hits = matchLines(lines, logged, st.id);
  let linked = 0, created = 0;
  const keep = new Set<string>();
  const closed = st.closingDate.toISOString().slice(0, 10);
  for (let i = 0; i < lines.length; i++) {
    const id = hits[i];
    if (id) {
      keep.add(id);
      const p = logged.find(x => x.id === id)!;
      // The statement's reference fills in a confirmation the owner didn't type.
      const confirmation = !p.confirmation && lines[i].reference ? { confirmation: lines[i].reference } : {};
      if (p.postedStatementId !== st.id || Object.keys(confirmation).length) {
        await db.cardPayment.update({ where: { id }, data: { postedStatementId: st.id, ...confirmation } });
        if (p.postedStatementId !== st.id) linked++;
      }
      continue;
    }
    // The statement before the payment is the one it pays.
    const pays = await db.cardStatement.findFirst({ where: { cardId: st.cardId, closingDate: { lt: lines[i].date } }, orderBy: { closingDate: 'desc' }, select: { id: true } });
    const made = await db.cardPayment.create({
      data: {
        cardId: st.cardId, date: lines[i].date, amount: lines[i].amount, method: ON_STATEMENT, confirmation: lines[i].reference ?? null,
        notes: `${lines[i].amount < 0 ? 'Payment reversed (returned): ' : ''}${rows[i].description} — on the ${closed} statement`, postedStatementId: st.id, statementId: pays?.id ?? null,
      },
    });
    keep.add(made.id);
    created++;
  }
  // A re-read statement whose lines changed: what it made and no longer lists goes; a payment the owner logged is only unlinked.
  const stale = await db.cardPayment.findMany({ where: { postedStatementId: st.id, id: { notIn: [...keep] } }, select: { id: true, method: true } });
  for (const p of stale) {
    if (p.method === ON_STATEMENT) await db.cardPayment.delete({ where: { id: p.id } });
    else await db.cardPayment.update({ where: { id: p.id }, data: { postedStatementId: null } });
  }
  return { linked, created };
}

/**
 * A payment the owner logs that a statement already listed: the statement's
 * one is filled in (bank account, confirmation) instead of a second added.
 */
export async function statementPaymentFor(cardId: string, date: Date, amount: number, confirmation?: string | null) {
  const near = await db.cardPayment.findMany({
    where: { cardId, method: ON_STATEMENT, amount, date: { gte: new Date(date.getTime() - 31 * DAY), lte: new Date(date.getTime() + 31 * DAY) } },
    orderBy: { date: 'asc' },
  });
  // The same confirmation number settles it; otherwise the statement's line from up to 3 days before to 10 after.
  return near.find(p => sameReference(p.confirmation, confirmation))
    ?? near.find(p => p.date.getTime() >= date.getTime() - 3 * DAY && p.date.getTime() <= date.getTime() + 10 * DAY) ?? null;
}

/** The card's cycle from its newest real statement (an email's date is not a closing date). */
export async function refreshCardCycle(cardId: string): Promise<void> {
  const newest = await db.cardStatement.findFirst({ where: { cardId, fromEmail: false }, orderBy: { closingDate: 'desc' }, select: { closingDate: true, dueDate: true } });
  if (!newest) return;
  await db.creditCard.update({
    where: { id: cardId },
    data: { statementClosingDay: newest.closingDate.getUTCDate(), ...(newest.dueDate ? { paymentDueDay: newest.dueDate.getUTCDate() } : {}) },
  });
}

/** Every card statement's payments linked, and every card's cycle from its newest statement. Idempotent; run at worker start. */
export async function backfillCardPayments(): Promise<void> {
  const sts = await db.cardStatement.findMany({ where: { transactions: { some: { kind: 'PAYMENT' } } }, select: { id: true } });
  for (const s of sts) { try { await syncStatementPayments(s.id); } catch (e) { console.warn('[cards] payment sync failed', s.id, e instanceof Error ? e.message : e); } }
  const cards = await db.creditCard.findMany({ where: { statements: { some: { fromEmail: false } } }, select: { id: true } });
  for (const c of cards) { try { await refreshCardCycle(c.id); } catch { /* next card */ } }
}
