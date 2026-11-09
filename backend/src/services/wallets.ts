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

export const WALLET_KINDS = ['CASH', 'CHECK', 'VENMO', 'CASH_APP', 'PAYPAL', 'APPLE_CASH'] as const;
export type WalletKind = typeof WALLET_KINDS[number];
export const WALLET_LABEL: Record<WalletKind, string> = { CASH: 'Cash', CHECK: 'Checks', VENMO: 'Venmo', CASH_APP: 'Cash App', PAYPAL: 'PayPal', APPLE_CASH: 'Apple Cash' };
/** The rent payment methods each wallet holds: a money order is kept with the checks. */
const METHODS: Record<WalletKind, string[]> = { CASH: ['CASH'], CHECK: ['CHECK', 'MONEY_ORDER'], VENMO: ['VENMO'], CASH_APP: ['CASH_APP'], PAYPAL: ['PAYPAL'], APPLE_CASH: ['APPLE_CASH'] };
/** The check or money order number, as Log rent payment notes it ("Ref 1234 · …"). */
export const checkNumber = (notes: string | null | undefined) => String(notes ?? '').match(/\bRef\s+([\w-]+)/i)?.[1] ?? null;
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
}

/** Each wallet's balance and what went in and out of it. */
export async function walletReport(userId: string) {
  const wallets = await ensureWallets(userId);
  const [movements, banks] = await Promise.all([
    db.walletMovement.findMany({ where: { walletId: { in: wallets.map(w => w.id) } }, orderBy: { date: 'desc' } }),
    db.bankAccount.findMany({ where: { userId }, select: { id: true, name: true, bank: true, last4: true } }),
  ]);
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
      ...mine.map(m => ({
        id: m.id, movementId: m.id, date: m.date.toISOString().slice(0, 10), amount: Number(m.amount), kind: m.type,
        description: m.description ?? '', bankAccountId: m.bankAccountId, bankAccountName: bankName(m.bankAccountId), source: m.source,
      })),
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
      ...(isCheck ? { onHand: rent.filter(r => !depositOf(r)).reverse().map(r => ({ rentPaymentId: r.id, date: r.paidDate.toISOString().slice(0, 10), amount: Number(r.amount), checkNumber: checkNumber(r.notes), description: what(r) })) } : {}),
    });
  }
  return { wallets: out, total: r2(out.reduce((t, w) => t + w.balance, 0)) };
}

/** Record money into or out of a wallet. Moving to another wallet records both sides. */
export async function addMovement(userId: string, walletId: string, m: {
  date: Date; amount: number; type: typeof MOVEMENT_TYPES[number]; bankAccountId?: string | null; toWalletId?: string | null; description?: string | null;
  source?: string | null; sourceRef?: string | null;
}) {
  const w = await db.wallet.findFirst({ where: { id: walletId, userId } });
  if (!w) throw Object.assign(new Error('Wallet not found'), { status: 404 });
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
  return db.walletMovement.create({
    data: { walletId: w.id, date: m.date, amount, type: m.type, bankAccountId: m.bankAccountId ?? null, description: m.description ?? null, source: m.source ?? 'manual', sourceRef: m.sourceRef ?? null },
  });
}

export async function deleteMovement(userId: string, id: string) {
  const m = await db.walletMovement.findFirst({ where: { id, wallet: { userId } } });
  if (!m) throw Object.assign(new Error('Not found'), { status: 404 });
  await db.walletMovement.deleteMany({ where: { id: { in: [m.id, ...(m.pairId ? [m.pairId] : [])] } } });
}

/**
 * Checks taken to the bank: each rent check (or money order) is marked deposited into the account on the
 * date, which takes it off what is on hand. Several at once are one deposit slip.
 */
export async function depositChecks(userId: string, rentPaymentIds: string[], bankAccountId: string, date: Date) {
  if (!(await db.bankAccount.findFirst({ where: { id: bankAccountId, userId }, select: { id: true } }))) throw Object.assign(new Error('Bank account not found'), { status: 404 });
  const r = await db.rentPayment.updateMany({
    where: { id: { in: rentPaymentIds }, method: { in: ['CHECK', 'MONEY_ORDER'] }, lease: { unit: { property: { userId } } } },
    data: { bankAccountId, depositedAt: date },
  });
  if (!r.count) throw Object.assign(new Error('No checks found to deposit'), { status: 404 });
  return r.count;
}

/** A deposit put back: the check is on hand again. */
export async function undoCheckDeposit(userId: string, rentPaymentId: string) {
  const r = await db.rentPayment.updateMany({
    where: { id: rentPaymentId, method: { in: ['CHECK', 'MONEY_ORDER'] }, lease: { unit: { property: { userId } } } },
    data: { bankAccountId: null, depositedAt: null },
  });
  if (!r.count) throw Object.assign(new Error('Check not found'), { status: 404 });
}
