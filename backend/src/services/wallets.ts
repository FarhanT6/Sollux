/**
 * Cash and payment-app balances (Finances -> Income -> Cash & apps).
 *
 * One wallet per kind — Cash, Venmo, Cash App, PayPal, Apple Cash. Its balance
 * is its opening balance, plus rent received by that method on or after its
 * start date, plus or minus its movements: a transfer to a bank (read from the
 * app's "transferred to your bank" email, or entered), cash deposited or spent,
 * money moved to another wallet, a correction. A wallet is made the first time
 * the owner opens the page, starting on the first of that month, so rent logged
 * by that method this month counts in.
 */
import { db } from '../config/db';

export const WALLET_KINDS = ['CASH', 'VENMO', 'CASH_APP', 'PAYPAL', 'APPLE_CASH'] as const;
export type WalletKind = typeof WALLET_KINDS[number];
export const WALLET_LABEL: Record<WalletKind, string> = { CASH: 'Cash', VENMO: 'Venmo', CASH_APP: 'Cash App', PAYPAL: 'PayPal', APPLE_CASH: 'Apple Cash' };
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
    const rent = await db.rentPayment.findMany({
      where: { method: w.kind as any, status: 'RECEIVED', paidDate: { gte: w.startedAt }, lease: { unit: { property: { userId } } } },
      select: { id: true, paidDate: true, amount: true, lease: { select: { unit: { select: { unitLabel: true, property: { select: { nickname: true, address: true } } } }, leaseTenants: { select: { tenant: { select: { fullName: true } } }, take: 1 } } } },
      orderBy: { paidDate: 'desc' },
    });
    const mine = movements.filter(m => m.walletId === w.id);
    const entries: WalletEntry[] = [
      ...rent.map(r => ({
        id: `rent-${r.id}`, date: r.paidDate.toISOString().slice(0, 10), amount: Number(r.amount), kind: 'RENT',
        description: `Rent from ${r.lease.leaseTenants[0]?.tenant.fullName ?? 'a tenant'} · ${r.lease.unit.property.nickname || r.lease.unit.property.address}${r.lease.unit.unitLabel ? ` ${r.lease.unit.unitLabel}` : ''}`,
      })),
      ...mine.map(m => ({
        id: m.id, movementId: m.id, date: m.date.toISOString().slice(0, 10), amount: Number(m.amount), kind: m.type,
        description: m.description ?? '', bankAccountId: m.bankAccountId, bankAccountName: bankName(m.bankAccountId), source: m.source,
      })),
    ].sort((a, b) => b.date.localeCompare(a.date));
    const rentIn = r2(rent.reduce((t, r) => t + Number(r.amount), 0));
    const moved = r2(mine.reduce((t, m) => t + Number(m.amount), 0));
    out.push({
      id: w.id, kind: w.kind, label: WALLET_LABEL[w.kind as WalletKind], startedAt: w.startedAt.toISOString().slice(0, 10), openingBalance: Number(w.openingBalance),
      rentIn, movedIn: r2(mine.filter(m => Number(m.amount) > 0).reduce((t, m) => t + Number(m.amount), 0)),
      movedOut: r2(-mine.filter(m => Number(m.amount) < 0).reduce((t, m) => t + Number(m.amount), 0)),
      balance: r2(Number(w.openingBalance) + rentIn + moved), entries,
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
