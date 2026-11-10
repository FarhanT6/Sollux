/**
 * Cash, check and payment-app balances (Finances -> Income -> Cash, checks & apps).
 *
 * One wallet per kind — Cash, Venmo, Cash App, PayPal, Apple Cash, and Checks
 * (checks and money orders received and not yet deposited: each rent check is
 * on hand until it is deposited into a bank account, one or several at a time
 * — depositChecks). Its balance
 * is its opening balance, plus rent received by that method on or after its
 * start date, plus or minus its movements: a transfer to a bank (read from the
 * app's "transferred to your bank" email, or entered), cash deposited or spent,
 * money moved to another wallet, a correction. A wallet is made the first time
 * the owner opens the page, starting on the first of that month, so rent logged
 * by that method this month counts in.
 */
import { db } from '../config/db';
import { addPendingDeposit, dropFromPendingDeposit } from './pendingMoney';
import { walletCategory, fits, INCOME_CATEGORIES, SPEND_CATEGORIES } from '../lib/walletCategories';

export const WALLET_KINDS = ['CASH', 'CHECK', 'VENMO', 'CASH_APP', 'PAYPAL', 'APPLE_CASH'] as const;
export type WalletKind = typeof WALLET_KINDS[number];
export const WALLET_LABEL: Record<WalletKind, string> = { CASH: 'Cash', CHECK: 'Checks', VENMO: 'Venmo', CASH_APP: 'Cash App', PAYPAL: 'PayPal', APPLE_CASH: 'Apple Cash' };
/** The rent payment methods each wallet holds: a money order is kept with the checks. */
const METHODS: Record<WalletKind, string[]> = { CASH: ['CASH'], CHECK: ['CHECK', 'MONEY_ORDER'], VENMO: ['VENMO'], CASH_APP: ['CASH_APP'], PAYPAL: ['PAYPAL'], APPLE_CASH: ['APPLE_CASH'] };
/** The check or money order number: as Log rent payment notes it ("Ref 1234 · …"), or as typed ("Check #2210", "check 2210"). */
export const checkNumber = (notes: string | null | undefined) => {
  const t = String(notes ?? '');
  return t.match(/\bRef\s+([\w-]+)/i)?.[1] ?? t.match(/#\s*(\d{2,10})\b/)?.[1] ?? t.match(/\b(?:check|chk|ck|money order)\s+(\d{3,10})\b/i)?.[1] ?? null;
};
export const MOVEMENT_TYPES = ['TO_BANK', 'SPENT', 'TO_WALLET', 'FROM_WALLET', 'ADJUSTMENT', 'OTHER_IN'] as const;

const r2 = (n: number) => Math.round(n * 100) / 100;
const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

/** The owner's wallets, made on first use (starting the first of this month). */
export async function ensureWallets(userId: string) {
  const have = await db.wallet.findMany({ where: { userId } });
  const missing = WALLET_KINDS.filter(k => !have.some(w => w.kind === k));
  if (missing.length) {
    await db.wallet.createMany({ data: missing.map(kind => ({ userId, kind, startedAt: monthStart() })), skipDuplicates: true });
    return db.wallet.findMany({ where: { userId } });
  }
  return have;
}

export interface WalletEntry {
  id: string; date: string; amount: number; kind: 'RENT' | string; description: string;
  bankAccountId?: string | null; bankAccountName?: string | null; source?: string | null; movementId?: string | null;
  /** A rent check: its payment, number, and whether (and when, where) it was deposited. */
  rentPaymentId?: string | null; checkNumber?: string | null; method?: string | null;
  deposited?: { date: string; bankAccountName: string | null } | null;
  /** What money in or spending was for, and the property spending was for. */
  category?: string | null; categoryLabel?: string | null; propertyId?: string | null; propertyName?: string | null;
}

/** Each wallet's balance and what went in and out of it. */
export async function walletReport(userId: string) {
  const wallets = await ensureWallets(userId);
  const [movements, banks, properties] = await Promise.all([
    db.walletMovement.findMany({ where: { walletId: { in: wallets.map(w => w.id) } }, orderBy: { date: 'desc' } }),
    db.bankAccount.findMany({ where: { userId }, select: { id: true, name: true, bank: true, last4: true } }),
    db.property.findMany({ where: { userId }, select: { id: true, nickname: true, address: true } }),
  ]);
  const propertyName = (id: string | null) => { const p = properties.find(x => x.id === id); return p ? p.nickname || p.address : null; };
  const bankName = (id: string | null) => {
    const b = banks.find(x => x.id === id);
    return b ? `${b.name}${b.last4 ? ` ••${b.last4}` : ''}` : null;
  };
  const out = [];
  for (const w of WALLET_KINDS.map(k => wallets.find(x => x.kind === k)!).filter(Boolean)) {
    const isCheck = w.kind === 'CHECK';
    const rent = await db.rentPayment.findMany({
      where: { method: { in: METHODS[w.kind as WalletKind] as any[] }, status: 'RECEIVED', paidDate: { gte: w.startedAt }, lease: { unit: { property: { userId } } } },
      select: { id: true, paidDate: true, amount: true, method: true, notes: true, bankAccountId: true, depositedAt: true, lease: { select: { unit: { select: { unitLabel: true, property: { select: { nickname: true, address: true } } } }, leaseTenants: { select: { tenant: { select: { fullName: true } } }, take: 1 } } } },
      orderBy: [{ paidDate: 'desc' }, { createdAt: 'desc' }],
    });
    // A check with a bank account went in: on the day recorded, else the day it was received.
    const depositOf = (r: (typeof rent)[number]) => (isCheck && r.bankAccountId ? (r.depositedAt ?? r.paidDate) : null);
    const mine = movements.filter(m => m.walletId === w.id);
    const what = (r: (typeof rent)[number]) => `${r.method === 'MONEY_ORDER' ? 'Money order' : isCheck ? 'Check' : 'Rent'} from ${r.lease.leaseTenants[0]?.tenant.fullName ?? 'a tenant'} · ${r.lease.unit.property.nickname || r.lease.unit.property.address}${r.lease.unit.unitLabel ? ` ${r.lease.unit.unitLabel}` : ''}`;
    const entries: WalletEntry[] = [
      ...rent.map(r => {
        const dep = depositOf(r);
        return {
          id: `rent-${r.id}`, date: r.paidDate.toISOString().slice(0, 10), amount: Number(r.amount), kind: 'RENT', description: what(r),
          rentPaymentId: r.id, method: r.method, checkNumber: isCheck ? checkNumber(r.notes) : null,
          deposited: dep ? { date: dep.toISOString().slice(0, 10), bankAccountName: bankName(r.bankAccountId) } : null,
        };
      }),
      // Each deposit takes its check out of what is on hand.
      ...rent.filter(r => depositOf(r)).map(r => ({
        id: `dep-${r.id}`, date: depositOf(r)!.toISOString().slice(0, 10), amount: -Number(r.amount), kind: 'CHECK_DEPOSIT',
        description: `${checkNumber(r.notes) ? `#${checkNumber(r.notes)} · ` : ''}${what(r)}`, bankAccountId: r.bankAccountId, bankAccountName: bankName(r.bankAccountId), rentPaymentId: r.id,
      })),
      ...mine.map(m => {
        // A check recorded by hand: deposited by the movement that names it.
        const dep = isCheck && m.type === 'OTHER_IN' ? mine.find(d => d.source === 'check-deposit' && d.sourceRef === m.id) : undefined;
        return {
          id: m.id, movementId: m.id, date: m.date.toISOString().slice(0, 10), amount: Number(m.amount), kind: isCheck && m.source === 'check-deposit' ? 'CHECK_DEPOSIT' : m.type,
          description: m.description ?? '', bankAccountId: m.bankAccountId, bankAccountName: bankName(m.bankAccountId), source: m.source,
          category: m.category, categoryLabel: walletCategory(m.category)?.label ?? null, propertyId: m.propertyId, propertyName: propertyName(m.propertyId),
          ...(isCheck && m.type === 'OTHER_IN' ? { deposited: dep ? { date: dep.date.toISOString().slice(0, 10), bankAccountName: bankName(dep.bankAccountId) } : null } : {}),
        };
      }),
    ].sort((a, b) => b.date.localeCompare(a.date));
    const rentIn = r2(rent.reduce((t, r) => t + Number(r.amount), 0));
    const deposited = r2(rent.filter(r => depositOf(r)).reduce((t, r) => t + Number(r.amount), 0));
    const moved = r2(mine.reduce((t, m) => t + Number(m.amount), 0));
    out.push({
      id: w.id, kind: w.kind, label: WALLET_LABEL[w.kind as WalletKind], startedAt: w.startedAt.toISOString().slice(0, 10), openingBalance: Number(w.openingBalance),
      rentIn, movedIn: r2(mine.filter(m => Number(m.amount) > 0).reduce((t, m) => t + Number(m.amount), 0)),
      movedOut: r2(deposited - mine.filter(m => Number(m.amount) < 0).reduce((t, m) => t + Number(m.amount), 0)),
      balance: r2(Number(w.openingBalance) + rentIn - deposited + moved), entries,
      // Checks not deposited yet, oldest first: what to take to the bank.
      ...(isCheck ? { onHand: [
        ...rent.filter(r => !depositOf(r)).reverse().map(r => ({ rentPaymentId: r.id, movementId: null, date: r.paidDate.toISOString().slice(0, 10), amount: Number(r.amount), checkNumber: checkNumber(r.notes), description: what(r), manual: false })),
        // Checks recorded here by hand (not logged as rent), not deposited yet.
        ...mine.filter(m => m.type === 'OTHER_IN' && !mine.some(d => d.source === 'check-deposit' && d.sourceRef === m.id)).reverse()
          .map(m => ({ rentPaymentId: null, movementId: m.id, date: m.date.toISOString().slice(0, 10), amount: Number(m.amount), checkNumber: checkNumber(m.description), description: m.description || 'Check', manual: true })),
      ].sort((a, b) => a.date.localeCompare(b.date)) } : {}),
    });
  }
  return { wallets: out, total: r2(out.reduce((t, w) => t + w.balance, 0)), categories: { income: INCOME_CATEGORIES, spending: SPEND_CATEGORIES } };
}

/** Record money into or out of a wallet. Moving to another wallet records both sides. */
export async function addMovement(userId: string, walletId: string, m: {
  date: Date; amount: number; type: typeof MOVEMENT_TYPES[number]; bankAccountId?: string | null; toWalletId?: string | null; description?: string | null;
  source?: string | null; sourceRef?: string | null; category?: string | null; propertyId?: string | null;
}) {
  const w = await db.wallet.findFirst({ where: { id: walletId, userId } });
  if (!w) throw Object.assign(new Error('Wallet not found'), { status: 404 });
  if (!fits(m.type, m.category)) throw Object.assign(new Error('That category is not for this kind of entry'), { status: 400 });
  if (m.propertyId && !(await db.property.findFirst({ where: { id: m.propertyId, userId }, select: { id: true } }))) throw Object.assign(new Error('Property not found'), { status: 404 });
  if (m.bankAccountId && !(await db.bankAccount.findFirst({ where: { id: m.bankAccountId, userId }, select: { id: true } }))) throw Object.assign(new Error('Bank account not found'), { status: 404 });
  // Out-going kinds take money out whatever sign was typed; a correction keeps its sign.
  const outgoing = m.type === 'TO_BANK' || m.type === 'SPENT' || m.type === 'TO_WALLET';
  const amount = m.type === 'ADJUSTMENT' ? m.amount : outgoing ? -Math.abs(m.amount) : Math.abs(m.amount);
  if (m.type === 'TO_WALLET') {
    const to = m.toWalletId ? await db.wallet.findFirst({ where: { id: m.toWalletId, userId } }) : null;
    if (!to || to.id === w.id) throw Object.assign(new Error('Choose the wallet it went to'), { status: 400 });
    return db.$transaction(async tx => {
      const a = await tx.walletMovement.create({ data: { walletId: w.id, date: m.date, amount, type: 'TO_WALLET', description: m.description ?? `To ${WALLET_LABEL[to.kind as WalletKind]}`, source: m.source ?? 'manual' } });
      const b = await tx.walletMovement.create({ data: { walletId: to.id, date: m.date, amount: -amount, type: 'FROM_WALLET', pairId: a.id, description: m.description ?? `From ${WALLET_LABEL[w.kind as WalletKind]}`, source: m.source ?? 'manual' } });
      return tx.walletMovement.update({ where: { id: a.id }, data: { pairId: b.id } });
    });
  }
  const created = await db.walletMovement.create({
    data: {
      walletId: w.id, date: m.date, amount, type: m.type, bankAccountId: m.bankAccountId ?? null, description: m.description ?? null, source: m.source ?? 'manual', sourceRef: m.sourceRef ?? null,
      ...(m.type === 'OTHER_IN' || m.type === 'SPENT' ? { category: m.category ?? null, propertyId: m.type === 'SPENT' ? m.propertyId ?? null : null } : {}),
    },
  });
  await syncLinked(userId, created.id);
  return created;
}

/**
 * The records an entry makes, kept in step with it: other income for an income category, a property
 * expense for spending on a property. A category changed to one that makes none removes what it made.
 */
async function syncLinked(userId: string, id: string) {
  const m = await db.walletMovement.findUnique({ where: { id }, include: { wallet: { select: { kind: true } } } });
  if (!m) return;
  const cat = walletCategory(m.category);
  const amount = Math.abs(Number(m.amount));
  const what = m.description?.trim() || cat?.label || 'Other';
  let { otherIncomeId, expenseId } = m;
  if (m.type === 'OTHER_IN' && cat?.otherIncome) {
    const data = { category: cat.otherIncome as any, description: what.slice(0, 300), amount, receivedDate: m.date, method: WALLET_LABEL[m.wallet.kind as WalletKind] ?? m.wallet.kind, notes: 'Recorded in Cash, checks & apps' };
    const had = otherIncomeId ? await db.otherIncome.findFirst({ where: { id: otherIncomeId, userId }, select: { id: true } }) : null;
    otherIncomeId = had ? (await db.otherIncome.update({ where: { id: had.id }, data })).id : (await db.otherIncome.create({ data: { userId, ...data } })).id;
  } else if (otherIncomeId) {
    await db.otherIncome.deleteMany({ where: { id: otherIncomeId, userId } });
    otherIncomeId = null;
  }
  if (m.type === 'SPENT' && m.propertyId && cat?.expense) {
    const data = { propertyId: m.propertyId, category: cat.expense as any, amount, date: m.date, description: what.slice(0, 300) };
    const had = expenseId ? await db.expense.findFirst({ where: { id: expenseId, userId }, select: { id: true } }) : null;
    expenseId = had ? (await db.expense.update({ where: { id: had.id }, data })).id : (await db.expense.create({ data: { userId, ...data } })).id;
  } else if (expenseId) {
    await db.expense.deleteMany({ where: { id: expenseId, userId } });
    expenseId = null;
  }
  if (otherIncomeId !== m.otherIncomeId || expenseId !== m.expenseId) await db.walletMovement.update({ where: { id: m.id }, data: { otherIncomeId, expenseId } });
}

/** An entry corrected: what it was for, the property, the wording, the date or amount (its direction stays). */
export async function updateMovement(userId: string, id: string, patch: { category?: string | null; propertyId?: string | null; description?: string | null; date?: Date; amount?: number }) {
  const m = await db.walletMovement.findFirst({ where: { id, wallet: { userId } } });
  if (!m) throw Object.assign(new Error('Not found'), { status: 404 });
  if (patch.category !== undefined && !fits(m.type, patch.category)) throw Object.assign(new Error('That category is not for this kind of entry'), { status: 400 });
  if (patch.propertyId && !(await db.property.findFirst({ where: { id: patch.propertyId, userId }, select: { id: true } }))) throw Object.assign(new Error('Property not found'), { status: 404 });
  const sign = Number(m.amount) < 0 ? -1 : 1;
  await db.walletMovement.update({
    where: { id: m.id },
    data: {
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.propertyId !== undefined && m.type === 'SPENT' ? { propertyId: patch.propertyId } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.date ? { date: patch.date } : {}),
      // A paired move between wallets keeps both sides equal: its amount is not edited here.
      ...(patch.amount != null && !m.pairId && m.type !== 'ADJUSTMENT' ? { amount: sign * Math.abs(patch.amount) } : {}),
    },
  });
  await syncLinked(userId, m.id);
}

export async function deleteMovement(userId: string, id: string) {
  const m = await db.walletMovement.findFirst({ where: { id, wallet: { userId } } });
  if (!m) throw Object.assign(new Error('Not found'), { status: 404 });
  // A check recorded by hand goes with its deposit; a deposit removed puts the check back on hand.
  const deposit = m.type === 'OTHER_IN' ? await db.walletMovement.findFirst({ where: { walletId: m.walletId, source: 'check-deposit', sourceRef: m.id } }) : null;
  await db.walletMovement.deleteMany({ where: { id: { in: [m.id, ...(m.pairId ? [m.pairId] : []), ...(deposit ? [deposit.id] : [])] } } });
  // What it recorded elsewhere goes with it.
  if (m.otherIncomeId) await db.otherIncome.deleteMany({ where: { id: m.otherIncomeId, userId } });
  if (m.expenseId) await db.expense.deleteMany({ where: { id: m.expenseId, userId } });
  const checkId = m.source === 'check-deposit' ? m.sourceRef : deposit ? m.id : null;
  if (checkId) await dropFromPendingDeposit(userId, `m:${checkId}`, Math.abs(Number(m.amount))).catch(() => {});
}

/**
 * Checks taken to the bank: each rent check (or money order) is marked deposited into the account on the
 * date, and each check recorded here by hand gets a deposit movement — which takes them off what is on
 * hand. Several at once are one deposit slip, pending at the bank (Settings → Banking) until it posts.
 */
export async function depositChecks(userId: string, rentPaymentIds: string[], bankAccountId: string, date: Date, movementIds: string[] = []) {
  if (!(await db.bankAccount.findFirst({ where: { id: bankAccountId, userId }, select: { id: true } }))) throw Object.assign(new Error('Bank account not found'), { status: 404 });
  const rents = await db.rentPayment.findMany({
    where: { id: { in: rentPaymentIds }, method: { in: ['CHECK', 'MONEY_ORDER'] }, lease: { unit: { property: { userId } } } },
    select: { id: true, amount: true, lease: { select: { leaseTenants: { select: { tenant: { select: { fullName: true } } }, take: 1 } } } },
  });
  const manual = movementIds.length ? await db.walletMovement.findMany({ where: { id: { in: movementIds }, type: 'OTHER_IN', wallet: { userId, kind: 'CHECK' } } }) : [];
  if (!rents.length && !manual.length) throw Object.assign(new Error('No checks found to deposit'), { status: 404 });
  if (rents.length) await db.rentPayment.updateMany({ where: { id: { in: rents.map(r => r.id) } }, data: { bankAccountId, depositedAt: date } });
  for (const m of manual) {
    if (await db.walletMovement.findFirst({ where: { walletId: m.walletId, source: 'check-deposit', sourceRef: m.id }, select: { id: true } })) continue;
    await db.walletMovement.create({ data: { walletId: m.walletId, date, amount: -Math.abs(Number(m.amount)), type: 'TO_BANK', bankAccountId, description: m.description ?? 'Check', source: 'check-deposit', sourceRef: m.id } });
  }
  // A check logged as deposited earlier had its own pending deposit; this slip replaces it.
  await db.pendingOutflow.deleteMany({ where: { userId, cleared: false, sourceRef: { in: rents.map(r => `rent:${r.id}`) } } });
  const total = r2(rents.reduce((t, r) => t + Number(r.amount), 0) + manual.reduce((t, m) => t + Math.abs(Number(m.amount)), 0));
  const n = rents.length + manual.length;
  const who = n === 1 ? rents[0]?.lease.leaseTenants[0]?.tenant.fullName ?? manual[0]?.description ?? null : null;
  await addPendingDeposit(userId, bankAccountId, total, date, n === 1 ? `Check deposited${who ? ` — ${who}` : ''}` : `${n} checks deposited`,
    `slip:${[...rents.map(r => `r:${r.id}`), ...manual.map(m => `m:${m.id}`)].join(',')}`);
  return n;
}

/** A deposit put back: the check is on hand again. */
export async function undoCheckDeposit(userId: string, rentPaymentId: string) {
  const p = await db.rentPayment.findFirst({ where: { id: rentPaymentId, method: { in: ['CHECK', 'MONEY_ORDER'] }, lease: { unit: { property: { userId } } } }, select: { id: true, amount: true } });
  if (!p) throw Object.assign(new Error('Check not found'), { status: 404 });
  await db.rentPayment.update({ where: { id: p.id }, data: { bankAccountId: null, depositedAt: null } });
  await dropFromPendingDeposit(userId, `r:${p.id}`, Number(p.amount));
}
