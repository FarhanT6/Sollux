/**
 * Fees the owner adds while logging a payment: a late fee, a contamination
 * charge, an extra pickup, …
 *
 * A fee charged because of a payment goes on the bill that payment was for,
 * in three places that must agree:
 * - its penalties (penaltiesFees);
 * - its charge (amountDue includes penalties, so the open balance grows);
 * - its charge list (rawDataJson.chargeBreakdown), one line per kind, which
 *   the statement row and the Charge breakdown tab read.
 * The fees are kept on the payment (feesAddedJson by kind, lateFeeAdded as
 * their total), so an edit or deletion takes exactly that much back off,
 * and a re-import puts it back on.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';

export const LATE_FEE_LINE = 'Late fee (paid late)';

/** The kinds of fee a payment can log, and the charge-list line each is written to. */
export const FEE_KINDS = {
  late: LATE_FEE_LINE,
  contamination: 'Contaminated materials (logged)',
  delinquent: 'Delinquent charge (logged)',
  disconnection: 'Disconnection / reconnection fee (logged)',
  additional: 'Additional service (logged)',
  returned: 'Returned payment fee (logged)',
  other: 'Other fee (logged)',
} as const;
export type FeeKind = keyof typeof FEE_KINDS;
export const FEE_KIND_IDS = Object.keys(FEE_KINDS) as [FeeKind, ...FeeKind[]];
export interface LoggedFee { kind: FeeKind; amount: number }

const LOGGED_LINES = new Set<string>(Object.values(FEE_KINDS));

const round = (n: number) => Number(n.toFixed(2));

/** The fees a payment added: by kind, or (older payments) its lateFeeAdded as a late fee. */
export function feesOf(p: { feesAddedJson?: unknown; lateFeeAdded?: unknown }): LoggedFee[] {
  if (Array.isArray(p.feesAddedJson)) {
    return (p.feesAddedJson as any[])
      .filter(f => f && f.kind in FEE_KINDS && Number(f.amount) > 0)
      .map(f => ({ kind: f.kind as FeeKind, amount: round(Number(f.amount)) }));
  }
  const late = Number(p.lateFeeAdded ?? 0);
  return late > 0 ? [{ kind: 'late', amount: round(late) }] : [];
}

/** One entry per kind, amounts summed and rounded; zero amounts dropped. */
export function mergeFees(fees: LoggedFee[]): LoggedFee[] {
  const by = new Map<FeeKind, number>();
  for (const f of fees) by.set(f.kind, (by.get(f.kind) ?? 0) + f.amount);
  return [...by].map(([kind, amount]) => ({ kind, amount: round(amount) })).filter(f => f.amount > 0.005);
}

export const feesTotal = (fees: LoggedFee[]) => round(fees.reduce((t, f) => t + f.amount, 0));

function withLines(raw: unknown, fees: LoggedFee[], sign: 1 | -1): Prisma.InputJsonValue {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const current = data.chargeBreakdown;
  const breakdown: Record<string, number> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, number>) } : {};
  for (const f of fees) {
    const line = FEE_KINDS[f.kind];
    const next = round(Number(breakdown[line] ?? 0) + sign * f.amount);
    if (Math.abs(next) < 0.005) delete breakdown[line];
    else breakdown[line] = next;
  }
  data.chargeBreakdown = Object.keys(breakdown).length ? breakdown : null;
  return data as Prisma.InputJsonValue;
}

/** Puts `fees` on the bill, or takes them off (sign -1). */
export async function applyFees(statementId: string | null | undefined, fees: LoggedFee[], sign: 1 | -1 = 1): Promise<void> {
  const total = feesTotal(fees);
  if (!statementId || !total) return;
  const s = await db.statement.findUnique({ where: { id: statementId }, select: { amountDue: true, penaltiesFees: true, rawDataJson: true } });
  if (!s) return;
  const penalties = round(Number(s.penaltiesFees ?? 0) + sign * total);
  await db.statement.update({
    where: { id: statementId },
    data: {
      penaltiesFees: Math.abs(penalties) < 0.005 ? null : penalties,
      amountDue: round(Number(s.amountDue ?? 0) + sign * total),
      rawDataJson: withLines(s.rawDataJson, fees, sign),
    },
  });
}

/** Puts a late fee of `amount` on the bill (negative takes it off). */
export async function applyLateFee(statementId: string | null | undefined, amount: number): Promise<void> {
  if (!amount) return;
  await applyFees(statementId, [{ kind: 'late', amount: Math.abs(amount) }], amount > 0 ? 1 : -1);
}

/** The logged-fee lines of a charge list, to carry onto a rewritten one. */
export function loggedLines(breakdown: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(breakdown ?? {})) if (LOGGED_LINES.has(k)) out[k] = v;
  return out;
}

/**
 * After a re-import has rewritten a bill from its PDF, puts back the fees
 * logged with payments against it — the PDF does not know about them.
 * `billFee` is the fee total the re-import wrote to penaltiesFees (the
 * statement's own), or undefined when the re-import left penaltiesFees
 * as it was (it then still includes the logged fees).
 */
export async function restoreLateFees(statementId: string, billFee?: number | null): Promise<void> {
  const payments = await db.payment.findMany({ where: { statementId, lateFeeAdded: { gt: 0 } }, select: { feesAddedJson: true, lateFeeAdded: true } });
  const fees = mergeFees(payments.flatMap(feesOf));
  const logged = feesTotal(fees);
  if (!logged) return;
  const s = await db.statement.findUnique({ where: { id: statementId }, select: { amountDue: true, penaltiesFees: true, rawDataJson: true } });
  if (!s) return;
  // The re-import wrote a fresh charge list; the logged fees go back on it.
  const fresh = { ...(((s.rawDataJson as any)?.chargeBreakdown ?? {}) as Record<string, number>) };
  for (const line of LOGGED_LINES) delete fresh[line];
  await db.statement.update({
    where: { id: statementId },
    data: {
      amountDue: round(Number(s.amountDue ?? 0) + logged),
      ...(billFee !== undefined ? { penaltiesFees: round(Number(billFee ?? 0) + logged) } : {}),
      rawDataJson: withLines({ ...((s.rawDataJson as object) ?? {}), chargeBreakdown: fresh }, fees, 1),
    },
  });
}
