/**
 * Money on its way in or out of a bank account that the bank's balance does
 * not show yet (pending_outflows, both directions):
 *
 * - out: a check written and mailed (it can take weeks to be cashed), a
 *   payment scheduled on a lender's site — entered on Settings → Banking;
 * - in: checks deposited — made here when rent paid by check is logged as
 *   deposited, or checks on hand are deposited from Cash, checks & apps.
 *
 * What's really there is the bank's balance less what is going out plus what
 * is coming in. Each item clears itself when the bank shows a transaction of
 * the same amount and direction on that account (clearPendingByTransaction,
 * from the bank sync); the owner can mark one cleared by hand too.
 */
import { db } from '../config/db';

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Checks logged as deposited more than this long ago have reached the bank: no pending item. */
export const PENDING_DEPOSIT_DAYS = 10;

/** Checks taken to the bank: money on its way into the account until the bank posts it. */
export async function addPendingDeposit(userId: string, bankAccountId: string, amount: number, date: Date, description: string, sourceRef: string) {
  if (!(amount > 0.005)) return null;
  return db.pendingOutflow.create({
    data: { userId, bankAccountId, amount: r2(amount), description: description.slice(0, 300), kind: 'CHECK', direction: 'IN', expectedDate: date, sourceRef },
  });
}

/** A rent check logged as deposited (recently): a pending deposit of its own. */
export async function pendingForRentCheck(userId: string, p: { id: string; method: string; bankAccountId: string | null; paidDate: Date; depositedAt?: Date | null; amount: number; payer?: string | null }) {
  if (!['CHECK', 'MONEY_ORDER'].includes(p.method) || !p.bankAccountId) return null;
  const when = p.depositedAt ?? p.paidDate;
  if (Date.now() - when.getTime() > PENDING_DEPOSIT_DAYS * DAY) return null;
  if (await db.pendingOutflow.findFirst({ where: { userId, sourceRef: `rent:${p.id}` }, select: { id: true } })) return null;
  return addPendingDeposit(userId, p.bankAccountId, p.amount, when, `${p.method === 'MONEY_ORDER' ? 'Money order' : 'Check'} deposited${p.payer ? ` — from ${p.payer}` : ''}`, `rent:${p.id}`);
}

/**
 * One check taken back out of what is pending: its own deposit ("rent:<id>") goes, and on a deposit
 * of several ("slip:r:<id>,m:<id>") its amount comes off. token is "r:<rentPaymentId>" or "m:<movementId>".
 */
export async function dropFromPendingDeposit(userId: string, token: string, amount: number) {
  if (token.startsWith('r:')) await db.pendingOutflow.deleteMany({ where: { userId, cleared: false, sourceRef: `rent:${token.slice(2)}` } });
  const slips = await db.pendingOutflow.findMany({ where: { userId, cleared: false, direction: 'IN', sourceRef: { startsWith: 'slip:', contains: token } } });
  for (const s of slips) {
    const parts = s.sourceRef!.slice(5).split(',').filter(t => t && t !== token);
    const left = r2(Number(s.amount) - amount);
    if (!parts.length || left <= 0.005) await db.pendingOutflow.delete({ where: { id: s.id } });
    else await db.pendingOutflow.update({ where: { id: s.id }, data: { amount: left, sourceRef: `slip:${parts.join(',')}`, description: `${parts.length} check${parts.length === 1 ? '' : 's'} deposited` } });
  }
}

/** A check number in a description or a bank line: "Check #1205 to …", "CHECK 1205". */
const checkNo = (s: string | null | undefined) => String(s ?? '').match(/(?:check|chk|ck)\s*#?\s*(\d{3,7})\b|#\s*(\d{3,7})\b/i)?.slice(1).find(Boolean) ?? null;

/**
 * A transaction the bank shows (posted, or pending — the bank's balance has it either way): the oldest
 * uncleared pending item on that account of the same amount and direction, made before it, is cleared.
 * A check number on both picks the right one of two equal amounts. Plaid: a positive amount is money out.
 */
export async function clearPendingByTransaction(bankAccountId: string, tx: { id: string; amount: number; date: string; name: string; pendingOf?: string | null }) {
  // The posted copy of a transaction already seen while pending: the item it cleared then is the one (not a second of the same amount).
  if (tx.pendingOf) {
    const before = await db.pendingOutflow.findFirst({ where: { bankAccountId, clearedBy: `plaid:${tx.pendingOf}` }, select: { id: true } });
    if (before) { await db.pendingOutflow.update({ where: { id: before.id }, data: { clearedBy: `plaid:${tx.id}` } }); return before.id; }
  }
  if (await db.pendingOutflow.findFirst({ where: { bankAccountId, clearedBy: `plaid:${tx.id}` }, select: { id: true } })) return null;   // replayed
  const direction = tx.amount > 0 ? 'OUT' : 'IN';
  const amt = Math.abs(tx.amount);
  const day = new Date(`${tx.date.slice(0, 10)}T00:00:00.000Z`).getTime();
  const items = await db.pendingOutflow.findMany({
    where: { bankAccountId, cleared: false, direction, amount: { gte: amt - 0.005, lte: amt + 0.005 } },
    orderBy: { createdAt: 'asc' },
  });
  // Made before the bank saw it (three days' slack for a date entered late).
  const made = (p: (typeof items)[number]) => Math.min(p.createdAt.getTime(), p.expectedDate && direction === 'IN' ? p.expectedDate.getTime() : Infinity);
  const cands = items.filter(p => day >= made(p) - 3 * DAY);
  if (!cands.length) return null;
  const no = checkNo(tx.name);
  const pick = (no && cands.find(p => checkNo(p.description) === no || checkNo(p.notes) === no)) || cands[0];
  await db.pendingOutflow.update({ where: { id: pick.id }, data: { cleared: true, clearedAt: new Date(day), clearedBy: `plaid:${tx.id}` } });
  return pick.id;
}

/**
 * Days after its date by which the bank has surely taken money that is not a
 * check: a payment scheduled on a lender's site, a transfer or a card payment
 * goes out on its date. A check can sit uncashed for weeks, so it waits for
 * the bank's line or the owner.
 */
const SETTLED_AFTER_DAYS: Record<string, number> = { SCHEDULED: 5, TRANSFER: 5, CARD: 5, OTHER: 14 };

/**
 * Pending items the bank has surely taken by now, cleared — the bank's own line
 * cannot always clear them: a payment the planner split across accounts posts
 * as one debit, and anything that posted before the bank sync matched pending
 * items (or while an account was not synced) is never seen again. So:
 * - a payment toward a loan (not a check) clears once its date has come and a
 *   payment for that month is on the loan ("auto:loan");
 * - a payment, transfer or card payment clears SETTLED_AFTER_DAYS after its
 *   date, and a deposit PENDING_DEPOSIT_DAYS after it ("auto:date");
 * - a check written waits: for the bank's line, or Mark cleared;
 * - one the owner put back as still pending (clearedBy "kept") waits too.
 * Run before pending items are shown or counted.
 */
export async function settlePending(userId: string, now = new Date()): Promise<number> {
  const open = await db.pendingOutflow.findMany({
    // "kept": the owner put it back as still pending — only the bank or the owner clears it now.
    where: { userId, cleared: false, OR: [{ clearedBy: null }, { clearedBy: { not: 'kept' } }] },
    select: { id: true, kind: true, direction: true, expectedDate: true, createdAt: true, loanId: true },
  });
  if (!open.length) return 0;
  const loanIds = [...new Set(open.filter(p => p.loanId && p.kind !== 'CHECK' && p.direction !== 'IN').map(p => p.loanId!))];
  const paid = loanIds.length ? await db.loanPayment.findMany({
    where: { loanId: { in: loanIds }, status: { not: 'UNPAID' }, OR: [{ date: { gte: new Date(now.getTime() - 400 * DAY) } }, { periodDate: { gte: new Date(now.getTime() - 400 * DAY) } }] },
    select: { loanId: true, date: true, periodDate: true },
  }) : [];
  const monthOf = (d: Date) => d.toISOString().slice(0, 7);
  let n = 0;
  for (const p of open) {
    const when = p.expectedDate ?? p.createdAt;
    const age = (now.getTime() - when.getTime()) / DAY;
    let by: string | null = null, at = now;
    if (p.direction === 'IN') {
      if (age > PENDING_DEPOSIT_DAYS) { by = 'auto:date'; at = new Date(when.getTime() + PENDING_DEPOSIT_DAYS * DAY); }
    } else if (p.kind !== 'CHECK') {
      // The payment for the month it was sent toward: by the month it says it pays, else paid within days of it.
      if (p.loanId && age >= 0 && paid.some(lp => lp.loanId === p.loanId && (lp.periodDate
        ? monthOf(lp.periodDate) === monthOf(when)
        : lp.date.getTime() >= when.getTime() - 10 * DAY && lp.date.getTime() <= when.getTime() + 20 * DAY))) by = 'auto:loan';
      else {
        const days = SETTLED_AFTER_DAYS[p.kind] ?? 14;
        if (age > days) { by = 'auto:date'; at = new Date(when.getTime() + days * DAY); }
      }
    }
    if (!by) continue;
    await db.pendingOutflow.update({ where: { id: p.id }, data: { cleared: true, clearedAt: at, clearedBy: by } });
    n++;
  }
  return n;
}

/** Each account's pending money: out, in, and what the balance is once they clear. */
export async function pendingByAccount(userId: string) {
  const rows = await db.pendingOutflow.findMany({ where: { userId, cleared: false }, select: { bankAccountId: true, amount: true, direction: true } });
  const by = new Map<string, { out: number; in: number }>();
  for (const r of rows) {
    const x = by.get(r.bankAccountId) ?? { out: 0, in: 0 };
    if (r.direction === 'IN') x.in += Number(r.amount); else x.out += Number(r.amount);
    by.set(r.bankAccountId, x);
  }
  return by;
}
