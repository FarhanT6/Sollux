/**
 * A bill's own figures must add up to what it printed: its charge (less any part deferred to a
 * solar true-up) plus what it carried in is the total it asked for. Where they do not (#278), one
 * figure was misread, and the bill before says which: what it carried in is the bill before's
 * printed total less what was paid since (services/emailTotals.ts carriedInto).
 *  - the total less the charge is that carried balance → the carried figure was misread (City of
 *    Oceanside's read with something already inside the total; an SDG&E bill with none at all);
 *  - the carried figure as read is that balance → the charge was misread;
 *  - the charge is the whole total and nothing was owed before → the carried balance was counted
 *    twice (a Nationwide bill that asks for its premium alone).
 * Anything else is left as read and stays on the audit's list. Fees Sollux added to a bill (logged
 * with a payment, or folded into the next bill) are not printed on it and are set aside first.
 * Bills the owner edited, email and page stand-ins, loan statements, scheduled installments and
 * bills that printed no total, or a total of zero, are left.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { carriedInto } from './emailTotals';
import { feesOf, feesTotal } from './lateFees';

const r2 = (n: number) => Math.round(n * 100) / 100;
const asNum = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export type IdentityOutcome = 'ok' | 'carried' | 'charge' | 'double-carried' | 'unsure' | 'skipped';

export async function reconcileStatement(statementId: string, opts: { dryRun?: boolean } = {}): Promise<IdentityOutcome> {
  const s = await db.statement.findUnique({
    where: { id: statementId },
    select: { id: true, utilityAccountId: true, statementDate: true, amountDue: true, pastDueCarried: true, carriedFee: true, trueUpDeferred: true, isScheduled: true, isDownPayment: true, rawDataJson: true },
  });
  if (!s || s.isScheduled || s.isDownPayment || s.amountDue == null) return 'skipped';
  const raw = (s.rawDataJson && typeof s.rawDataJson === 'object' && !Array.isArray(s.rawDataJson) ? s.rawDataJson : {}) as Record<string, unknown>;
  if (raw.ownerEditedAt || raw.emailNotice || raw.pageSaved || raw.loanStatement || raw.scheduled) return 'skipped';
  const stated = asNum(raw.statedTotalDue);
  if (stated == null || stated <= 0.005) return 'skipped';
  const pays = await db.payment.findMany({ where: { statementId: s.id }, select: { feesAddedJson: true, lateFeeAdded: true } });
  const added = r2(Number(s.carriedFee ?? 0) + pays.reduce((t, p) => t + feesTotal(feesOf(p)), 0));
  const own = r2(Number(s.amountDue) - added);
  const deferred = asNum((raw.netMetering as Record<string, unknown> | null)?.deferred) ?? asNum(s.trueUpDeferred) ?? 0;
  const carried = Number(s.pastDueCarried ?? 0);
  if (Math.abs(own - deferred + carried - stated) <= 0.05) return 'ok';

  const before = await carriedInto(s.utilityAccountId, s.statementDate, s.id);
  const expected = before ? before.carried : null;
  const needCarried = r2(stated - own + deferred);
  let outcome: IdentityOutcome = 'unsure';
  let data: Prisma.StatementUpdateInput | null = null;
  if (Math.abs(needCarried) <= 0.05 && carried > 0.005 && (expected == null || expected <= 0.5)) {
    outcome = 'double-carried';
    data = { pastDueCarried: null, rawDataJson: { ...raw, previousBalance: 0, identityFixed: 'double-carried' } as Prisma.InputJsonValue };
  } else if (expected != null && needCarried >= -0.005 && Math.abs(needCarried - expected) <= 1) {
    outcome = 'carried';
    data = { pastDueCarried: Math.abs(needCarried) > 0.005 ? needCarried : null, rawDataJson: { ...raw, previousBalance: needCarried, identityFixed: 'carried' } as Prisma.InputJsonValue };
  } else if (expected != null && carried > 0.005 && Math.abs(carried - expected) <= 1) {
    const charge = r2(stated + deferred - carried);
    if (charge > 0.005) {
      outcome = 'charge';
      data = { amountDue: r2(charge + added), chargesExcludingFees: charge, rawDataJson: { ...raw, currentCharges: charge, identityFixed: 'charge' } as Prisma.InputJsonValue };
    }
  }
  if (data && !opts.dryRun) await db.statement.update({ where: { id: s.id }, data });
  return outcome;
}

/** Every bill of one owner (or every owner) that printed a total, checked; counts by outcome. */
export async function reconcileAll(userId?: string): Promise<Record<IdentityOutcome, number>> {
  const rows = await db.statement.findMany({
    where: { isScheduled: false, isDownPayment: false, amountDue: { not: null }, ...(userId ? { utilityAccount: { property: { userId } } } : {}) },
    orderBy: { statementDate: 'asc' },
    select: { id: true },
  });
  const counts: Record<IdentityOutcome, number> = { ok: 0, carried: 0, charge: 0, 'double-carried': 0, unsure: 0, skipped: 0 };
  for (const r of rows) counts[await reconcileStatement(r.id).catch(() => 'skipped' as const)]++;
  return counts;
}

/** After a bill is filed: the account's newest bills checked (a bill and the one after it change together). */
export async function reconcileRecent(utilityAccountId: string, n = 3): Promise<void> {
  const rows = await db.statement.findMany({ where: { utilityAccountId, isScheduled: false, isDownPayment: false }, orderBy: { statementDate: 'desc' }, take: n, select: { id: true } });
  for (const r of rows.reverse()) await reconcileStatement(r.id).catch(() => null);
}
