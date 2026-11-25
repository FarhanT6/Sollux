/**
 * Late fees hidden in the next bill's previous balance (lib/carriedFee.ts), found and recorded on
 * the bill that was paid late — in the three places a fee lives (services/lateFees.ts): its fees
 * (penaltiesFees), its charge (amountDue) and its charge list (a "Late fee (added to the next
 * bill)" line). statements.carriedFee keeps the amount outside the bill's own figures, so a re-read
 * of the PDF (which writes them afresh) puts it back (restoreLateFees).
 *
 * Settled per account after every bill is filed, and once over every account's history.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { CARRIED_FEE_LINE, carriedFeeBetween, type BillFacts, type CarriedFeeResult } from '../lib/carriedFee';
import { feesOf, feesTotal } from './lateFees';

const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v) || 0);
const r2 = (n: number) => Math.round(n * 100) / 100;
const asNum = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

type Row = {
  id: string; statementDate: Date; amountDue: Prisma.Decimal | null; penaltiesFees: Prisma.Decimal | null; pastDueCarried: Prisma.Decimal | null;
  paymentPlanAmount: Prisma.Decimal | null; trueUpDeferred: Prisma.Decimal | null; trueUpBalance: Prisma.Decimal | null; rawDataJson: Prisma.JsonValue; carriedFee: Prisma.Decimal | null;
};

const rawOf = (s: Row) => (s.rawDataJson && typeof s.rawDataJson === 'object' && !Array.isArray(s.rawDataJson) ? s.rawDataJson as Record<string, unknown> : {});
/** The carried fee on a bill now: its charge-list line (gone when a re-read wrote the list afresh). */
const appliedOn = (s: Row) => num((rawOf(s).chargeBreakdown as Record<string, unknown> | null)?.[CARRIED_FEE_LINE]);

function factsOf(s: Row, loggedHere: number): BillFacts {
  const raw = rawOf(s);
  const total = asNum(raw.statedTotalDue) ?? asNum(raw.totalDue);
  const current = asNum(raw.currentCharges);
  // Carried in, after the payments the bill shows; none printed on a bill that asks for its own charges alone is nothing carried.
  const carried = asNum(raw.previousBalance) ?? asNum(s.pastDueCarried) ?? (total != null && current != null ? r2(total - current) : null);
  // A running ledger (an HOA manager's statement) lists its payments on their own dates. A lone
  // "Last payment (effective …)" line is not one: it shows only the latest payment, not all since.
  const rows = (Array.isArray(raw.ledgerPayments) ? raw.ledgerPayments as { date?: unknown; amount?: unknown; description?: unknown }[] : [])
    .map(l => ({ date: typeof l.date === 'string' ? l.date.slice(0, 10) : '', amount: asNum(l.amount) ?? 0, description: String(l.description ?? '') }))
    .filter(l => /^\d{4}-\d{2}-\d{2}$/.test(l.date) && l.amount > 0);
  const ledger = rows.some(l => !/last\s*pay/i.test(l.description)) ? rows.map(({ date, amount }) => ({ date, amount })) : null;
  const listed = (Array.isArray(raw.transactions) ? raw.transactions as { date?: unknown; amount?: unknown; kind?: unknown }[] : [])
    .map(t => ({ date: typeof t.date === 'string' ? t.date.slice(0, 10) : '', amount: asNum(t.amount) ?? 0, payment: t.kind === 'payment' }))
    .filter(t => /^\d{4}-\d{2}-\d{2}$/.test(t.date) && Math.abs(t.amount) > 0.004);
  return {
    statementDate: s.statementDate,
    total,
    carried,
    paymentsShown: asNum(raw.paymentsReceived),
    ledger,
    listed: listed.length ? listed : null,
    ownFee: Math.max(0, r2(num(s.penaltiesFees) - appliedOn(s) - loggedHere)),
    // A loan statement's past due is a missed payment, not a fee folded in; its fees are its own column.
    unsure: !!(raw.paymentPlan || asNum(raw.paymentPlanAmount) || num(s.paymentPlanAmount) || s.trueUpDeferred != null || s.trueUpBalance != null || raw.emailNotice || raw.scheduled || raw.loanStatement),
  };
}

export interface CarriedFeeFinding { statementId: string; nextStatementId: string; result: CarriedFeeResult }

/** Works out and records every carried fee on one account. Returns what it found between each pair of bills. */
export async function settleCarriedFees(utilityAccountId: string, opts: { dryRun?: boolean } = {}): Promise<{ changed: number; findings: CarriedFeeFinding[] }> {
  const rows: Row[] = await db.statement.findMany({
    where: { utilityAccountId, isScheduled: false, isDownPayment: false },
    orderBy: { statementDate: 'asc' },
    select: { id: true, statementDate: true, amountDue: true, penaltiesFees: true, pastDueCarried: true, paymentPlanAmount: true, trueUpDeferred: true, trueUpBalance: true, rawDataJson: true, carriedFee: true },
  });
  if (rows.length < 2 && !rows.some(r => r.carriedFee != null)) return { changed: 0, findings: [] };
  const pays = await db.payment.findMany({ where: { utilityAccountId }, select: { statementId: true, paymentDate: true, amount: true, lateFeeAdded: true, feesAddedJson: true } });
  const logged = new Map<string, number>();
  for (const p of pays) if (p.statementId) logged.set(p.statementId, r2((logged.get(p.statementId) ?? 0) + feesTotal(feesOf(p))));

  const findings: CarriedFeeFinding[] = [];
  let changed = 0;
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    let target = 0;
    if (b) {
      const paidBetween = pays.filter(p => p.paymentDate > a.statementDate && p.paymentDate <= b.statementDate).reduce((t, p) => t + num(p.amount), 0);
      const result = carriedFeeBetween(factsOf(a, logged.get(a.id) ?? 0), factsOf(b, logged.get(b.id) ?? 0), logged.get(a.id) ?? 0, paidBetween);
      findings.push({ statementId: a.id, nextStatementId: b.id, result });
      if (result.kind === 'fee') target = result.fee;
    }
    if (!opts.dryRun && await apply(a, target)) changed++;
  }
  return { changed, findings };
}

/** Puts the carried fee on the bill at `target`, taking off what was there: idempotent. */
async function apply(s: Row, target: number): Promise<boolean> {
  const cur = appliedOn(s);
  const delta = r2(target - cur);
  if (Math.abs(delta) < 0.005 && Math.abs(num(s.carriedFee) - target) < 0.005) return false;
  const raw = { ...rawOf(s) };
  const breakdown = { ...((raw.chargeBreakdown as Record<string, number> | null) ?? {}) };
  if (target > 0) breakdown[CARRIED_FEE_LINE] = target; else delete breakdown[CARRIED_FEE_LINE];
  raw.chargeBreakdown = Object.keys(breakdown).length ? breakdown : null;
  const penalties = r2(num(s.penaltiesFees) + delta);
  await db.statement.update({
    where: { id: s.id },
    data: {
      ...(Math.abs(delta) >= 0.005 ? {
        amountDue: r2(num(s.amountDue) + delta),
        penaltiesFees: Math.abs(penalties) < 0.005 ? null : penalties,
        rawDataJson: raw as Prisma.InputJsonValue,
      } : {}),
      carriedFee: target > 0 ? target : null,
    },
  });
  return true;
}

/** Every account of one owner (or every owner), its whole history. */
export async function settleAllCarriedFees(userId?: string): Promise<{ accounts: number; changed: number; fees: number; total: number; unexplained: number }> {
  const accounts = await db.utilityAccount.findMany({ where: userId ? { property: { userId } } : {}, select: { id: true } });
  let changed = 0, fees = 0, total = 0, unexplained = 0;
  for (const a of accounts) {
    const r = await settleCarriedFees(a.id).catch(() => null);
    if (!r) continue;
    changed += r.changed;
    for (const f of r.findings) {
      if (f.result.kind === 'fee') { fees++; total = r2(total + f.result.fee); }
      if (f.result.kind === 'unexplained') unexplained++;
    }
  }
  return { accounts: accounts.length, changed, fees, total, unexplained };
}

/** The carried fees on one owner's bills, newest first, and differences too large to call a fee. */
export async function carriedFeeReport(userId: string) {
  const accounts = await db.utilityAccount.findMany({
    where: { property: { userId } },
    select: { id: true, providerName: true, accountNumber: true, propertyId: true, property: { select: { nickname: true, address: true } } },
  });
  const out: { accountId: string; propertyId: string; provider: string; last4: string | null; property: string; statementId: string; statementDate: string; billTotal: number | null; nextStatementDate: string; nextCarried: number | null; nextPaymentsShown: number | null; fee: number | null; unexplained: number | null }[] = [];
  for (const a of accounts) {
    const r = await settleCarriedFees(a.id, { dryRun: true }).catch(() => null);
    if (!r) continue;
    const interesting = r.findings.filter(f => f.result.kind === 'fee' || f.result.kind === 'unexplained');
    if (!interesting.length) continue;
    const ids = interesting.flatMap(f => [f.statementId, f.nextStatementId]);
    const st = new Map((await db.statement.findMany({ where: { id: { in: ids } }, select: { id: true, statementDate: true, rawDataJson: true } })).map(s => [s.id, s]));
    for (const f of interesting) {
      const s = st.get(f.statementId)!, n = st.get(f.nextStatementId)!;
      const raw = (s.rawDataJson ?? {}) as Record<string, unknown>, nraw = (n.rawDataJson ?? {}) as Record<string, unknown>;
      out.push({
        accountId: a.id, propertyId: a.propertyId, provider: a.providerName, last4: a.accountNumber ? String(a.accountNumber).replace(/\D/g, '').slice(-4) || null : null,
        property: a.property.nickname || a.property.address,
        statementId: s.id, statementDate: s.statementDate.toISOString().slice(0, 10), billTotal: asNum(raw.statedTotalDue) ?? asNum(raw.totalDue),
        nextStatementDate: n.statementDate.toISOString().slice(0, 10), nextCarried: asNum(nraw.previousBalance), nextPaymentsShown: asNum(nraw.paymentsReceived),
        fee: f.result.kind === 'fee' ? f.result.fee : null, unexplained: f.result.kind === 'unexplained' ? f.result.difference : null,
      });
    }
  }
  out.sort((x, y) => y.statementDate.localeCompare(x.statementDate));
  return { rows: out, total: r2(out.reduce((t, r) => t + (r.fee ?? 0), 0)) };
}
