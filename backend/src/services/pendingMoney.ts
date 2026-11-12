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
  const row = await addPendingDeposit(userId, p.bankAccountId, p.amount, when, `${p.method === 'MONEY_ORDER' ? 'Money order' : 'Check'} deposited${p.payer ? ` — from ${p.payer}` : ''}`, `rent:${p.id}`);
  // Logged after the bank already shows it: cleared in the background.
  if (row) void checkPendingWithBank(userId).catch(() => 0);
  return row;
}

const CHECKS = new Set(['CHECK', 'MONEY_ORDER', 'CASHIERS_CHECK']);

/**
 * A loan payment logged before it has come out of the account (a check in the mail, a payment
 * scheduled for later): pending on that account until the bank shows it — a check waits for it
 * to be cashed, anything else also clears a few days after its date (settlePending). The loan
 * shows the month paid at once. Removed with the payment.
 */
export async function pendingForLoanPayment(userId: string, bankAccountId: string, p: { id: string; amount: number; date: Date; method: string | null; confirmationNumber?: string | null }, lender: string) {
  if (!(await db.bankAccount.findFirst({ where: { id: bankAccountId, userId }, select: { id: true } }))) return null;
  if (await db.pendingOutflow.findFirst({ where: { userId, sourceRef: `loanpay:${p.id}` }, select: { id: true } })) return null;
  const check = !!p.method && CHECKS.has(p.method);
  const loan = await db.loanPayment.findUnique({ where: { id: p.id }, select: { loanId: true } });
  const row = await db.pendingOutflow.create({
    data: {
      userId, bankAccountId, amount: r2(p.amount), direction: 'OUT', kind: check ? 'CHECK' : 'SCHEDULED',
      description: `${check ? `Check${p.confirmationNumber ? ` #${p.confirmationNumber}` : ''} to ` : ''}${lender}`.slice(0, 300),
      expectedDate: p.date, loanId: loan?.loanId ?? null, sourceRef: `loanpay:${p.id}`,
    },
  });
  // Already out by the time it was logged: cleared from the bank's lines, in the background.
  void checkPendingWithBank(userId).catch(() => 0);
  return row;
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
  // clearedBy is "plaid:<id>", or "plaid:<id>+<id>…" when several of the bank's lines made up one item.
  if (tx.pendingOf) {
    const before = await db.pendingOutflow.findFirst({ where: { bankAccountId, clearedBy: { startsWith: 'plaid:', contains: tx.pendingOf } }, select: { id: true, clearedBy: true } });
    if (before) { await db.pendingOutflow.update({ where: { id: before.id }, data: { clearedBy: before.clearedBy!.replace(tx.pendingOf, tx.id) } }); return before.id; }
  }
  if (await db.pendingOutflow.findFirst({ where: { bankAccountId, clearedBy: { startsWith: 'plaid:', contains: tx.id } }, select: { id: true } })) return null;   // replayed
  const direction = tx.amount > 0 ? 'OUT' : 'IN';
  const amt = Math.abs(tx.amount);
  const day = new Date(`${tx.date.slice(0, 10)}T00:00:00.000Z`).getTime();
  const items = await db.pendingOutflow.findMany({
    where: { bankAccountId, cleared: false, direction, amount: { gte: amt - 0.005, lte: amt + 0.005 } },
    orderBy: { createdAt: 'asc' },
  });
  // Made before the bank saw it (three days' slack for a date entered late): when it was entered, or the
  // date it was sent or deposited if earlier — a payment logged days after the check went out.
  const made = (p: (typeof items)[number]) => Math.min(p.createdAt.getTime(), p.expectedDate ? p.expectedDate.getTime() : Infinity);
  const cands = items.filter(p => day >= made(p) - 3 * DAY);
  if (!cands.length) return null;
  const no = checkNo(tx.name);
  const pick = (no && cands.find(p => checkNo(p.description) === no || checkNo(p.notes) === no)) || cands[0];
  await db.pendingOutflow.update({ where: { id: pick.id }, data: { cleared: true, clearedAt: new Date(day), clearedBy: `plaid:${tx.id}` } });
  return pick.id;
}

/** The bank's transaction ids an item was cleared by ("plaid:a" or "plaid:a+b"). */
const clearedIds = (by: string | null) => (by?.startsWith('plaid:') ? by.slice(6).split('+').filter(Boolean) : []);

/** The checks on a deposit slip, by amount: "slip:r:<rent payment>,m:<movement>" (or "rent:<id>"). */
async function slipAmounts(sourceRef: string | null): Promise<number[]> {
  if (!sourceRef) return [];
  const tokens = sourceRef.startsWith('rent:') ? [`r:${sourceRef.slice(5)}`] : sourceRef.startsWith('slip:') ? sourceRef.slice(5).split(',') : [];
  const rentIds = tokens.filter(t => t.startsWith('r:')).map(t => t.slice(2));
  const moveIds = tokens.filter(t => t.startsWith('m:')).map(t => t.slice(2));
  const [rents, moves] = await Promise.all([
    rentIds.length ? db.rentPayment.findMany({ where: { id: { in: rentIds } }, select: { amount: true } }) : [],
    moveIds.length ? db.walletMovement.findMany({ where: { id: { in: moveIds } }, select: { amount: true } }) : [],
  ]);
  return [...rents.map(r => Math.abs(Number(r.amount))), ...moves.map(m => Math.abs(Number(m.amount)))];
}

type BankLine = { id: string; amount: number; date: string };   // Plaid: positive is money out

/**
 * Which of the bank's lines are this pending item: one line of its amount; for a deposit
 * of several checks, a line for each check, or any few credits that add up to it (a bank
 * may post each check of a deposit on its own).
 */
export function linesForItem(item: { amount: number; direction: string; made: number; checks: number[] }, lines: BankLine[]): BankLine[] | null {
  const cents = (n: number) => Math.round(n * 100);
  const want = cents(item.amount);
  const sameWay = lines
    .filter(l => (item.direction === 'IN' ? l.amount < 0 : l.amount > 0))
    .filter(l => new Date(`${l.date.slice(0, 10)}T00:00:00Z`).getTime() >= item.made - 3 * DAY)
    .sort((a, b) => a.date.localeCompare(b.date));
  const one = sameWay.find(l => cents(Math.abs(l.amount)) === want);
  if (one) return [one];
  if (item.direction !== 'IN') return null;
  // Each check of the slip as its own credit.
  if (item.checks.length > 1) {
    const left = [...sameWay];
    const found: BankLine[] = [];
    for (const c of item.checks) {
      const i = left.findIndex(l => cents(Math.abs(l.amount)) === cents(c));
      if (i < 0) { found.length = 0; break; }
      found.push(left.splice(i, 1)[0]);
    }
    if (found.length === item.checks.length) return found;
  }
  // Any few credits within ten days of the deposit that add up to it.
  const near = sameWay.filter(l => new Date(`${l.date.slice(0, 10)}T00:00:00Z`).getTime() <= item.made + 10 * DAY).slice(0, 14);
  for (let mask = 1; mask < 1 << near.length; mask++) {
    let sum = 0;
    const pick: BankLine[] = [];
    for (let i = 0; i < near.length; i++) if (mask & (1 << i)) { sum += cents(Math.abs(near[i].amount)); pick.push(near[i]); }
    if (pick.length > 1 && sum === want) return pick;
  }
  return null;
}

/**
 * Pending items checked against the bank's own lines for their account (Plaid
 * transactions/get), not only the new ones each sync brings: a deposit recorded
 * after the bank had already shown it, or one the bank posted check by check,
 * stayed pending although the balance already had it. Run after each bank sync
 * and when a pending item is added.
 */
export async function checkPendingWithBank(userId: string, now = new Date()): Promise<number> {
  const open = await db.pendingOutflow.findMany({
    where: { userId, cleared: false, bankAccount: { plaidAccountId: { not: null }, plaidItemId: { not: null } } },
    select: { id: true, amount: true, direction: true, expectedDate: true, createdAt: true, sourceRef: true, bankAccountId: true, bankAccount: { select: { plaidAccountId: true, plaidItemId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!open.length) return 0;
  const { plaidClient } = await import('../config/plaid');
  const { decrypt } = await import('../crypto/encrypt');
  const made = (p: (typeof open)[number]) => Math.min(p.createdAt.getTime(), p.expectedDate ? p.expectedDate.getTime() : Infinity);
  const byItem = new Map<string, typeof open>();
  for (const p of open) byItem.set(p.bankAccount.plaidItemId!, [...(byItem.get(p.bankAccount.plaidItemId!) ?? []), p]);
  let n = 0;
  for (const [itemId, items] of byItem) {
    const plaidItem = await db.plaidItem.findFirst({ where: { id: itemId, userId, isActive: true }, select: { accessTokenEnc: true } });
    if (!plaidItem) continue;
    const from = new Date(Math.max(Math.min(...items.map(made)) - 5 * DAY, now.getTime() - 90 * DAY));
    const accountIds = [...new Set(items.map(p => p.bankAccount.plaidAccountId!))];
    let lines: (BankLine & { account: string })[] = [];
    try {
      const resp = await plaidClient.transactionsGet({
        access_token: decrypt(plaidItem.accessTokenEnc),
        start_date: from.toISOString().slice(0, 10), end_date: now.toISOString().slice(0, 10),
        options: { account_ids: accountIds, count: 500 },
      });
      lines = resp.data.transactions.map(t => ({ id: t.transaction_id, amount: t.amount, date: t.date, account: t.account_id }));
    } catch (err) {
      console.warn('[Pending] bank lines:', err instanceof Error ? err.message : err);
      continue;
    }
    // Lines that already cleared an item are not used again.
    const used = new Set((await db.pendingOutflow.findMany({
      where: { bankAccountId: { in: items.map(p => p.bankAccountId) }, clearedBy: { startsWith: 'plaid:' } }, select: { clearedBy: true },
    })).flatMap(r => clearedIds(r.clearedBy)));
    for (const p of items) {
      const free = lines.filter(l => l.account === p.bankAccount.plaidAccountId && !used.has(l.id));
      const checks = p.direction === 'IN' ? await slipAmounts(p.sourceRef) : [];
      const hit = linesForItem({ amount: Number(p.amount), direction: p.direction, made: made(p), checks }, free);
      if (!hit) continue;
      hit.forEach(l => used.add(l.id));
      const last = hit.map(l => l.date).sort().pop()!;
      await db.pendingOutflow.update({ where: { id: p.id }, data: { cleared: true, clearedAt: new Date(`${last.slice(0, 10)}T00:00:00Z`), clearedBy: `plaid:${hit.map(l => l.id).join('+')}` } });
      n++;
    }
  }
  return n;
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
    select: { id: true, kind: true, direction: true, expectedDate: true, createdAt: true, loanId: true, sourceRef: true },
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
      // Not one made by logging the payment itself ("loanpay:<id>"): that one waits for the bank, or its date.
      if (p.loanId && !p.sourceRef?.startsWith('loanpay:') && age >= 0 && paid.some(lp => lp.loanId === p.loanId && (lp.periodDate
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
