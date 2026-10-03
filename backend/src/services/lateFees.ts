/**
 * Late fees the owner adds while logging a late payment.
 *
 * A late fee exists because a payment was late, so it goes on the bill that
 * payment was for, in three places that must agree:
 * - its penalties (penaltiesFees);
 * - its charge (amountDue includes penalties, so the open balance grows);
 * - its charge list (rawDataJson.chargeBreakdown), which the statement row
 *   and the Charge breakdown tab read.
 * The amount is kept on the payment (lateFeeAdded), so an edit or deletion
 * takes exactly that much back off, and a re-import puts it back on.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';

export const LATE_FEE_LINE = 'Late fee (paid late)';

const round = (n: number) => Number(n.toFixed(2));

function withLine(raw: unknown, amount: number): Prisma.InputJsonValue {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const current = data.chargeBreakdown;
  const breakdown: Record<string, number> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, number>) } : {};
  const next = round(Number(breakdown[LATE_FEE_LINE] ?? 0) + amount);
  if (Math.abs(next) < 0.005) delete breakdown[LATE_FEE_LINE];
  else breakdown[LATE_FEE_LINE] = next;
  data.chargeBreakdown = Object.keys(breakdown).length ? breakdown : null;
  return data as Prisma.InputJsonValue;
}

/** Puts `amount` on the bill (negative takes it off). */
export async function applyLateFee(statementId: string | null | undefined, amount: number): Promise<void> {
  if (!statementId || !amount) return;
  const s = await db.statement.findUnique({ where: { id: statementId }, select: { amountDue: true, penaltiesFees: true, rawDataJson: true } });
  if (!s) return;
  const fees = round(Number(s.penaltiesFees ?? 0) + amount);
  await db.statement.update({
    where: { id: statementId },
    data: {
      penaltiesFees: Math.abs(fees) < 0.005 ? null : fees,
      amountDue: round(Number(s.amountDue ?? 0) + amount),
      rawDataJson: withLine(s.rawDataJson, amount),
    },
  });
}

/**
 * After a re-import has rewritten a bill from its PDF, puts back the late
 * fees logged with payments against it — the PDF does not know about them.
 * `billFee` is the late fee the re-import wrote to penaltiesFees (the
 * statement's own), or undefined when the re-import left penaltiesFees
 * as it was (it then still includes the logged fees).
 */
export async function restoreLateFees(statementId: string, billFee?: number | null): Promise<void> {
  const agg = await db.payment.aggregate({ where: { statementId, lateFeeAdded: { gt: 0 } }, _sum: { lateFeeAdded: true } });
  const logged = Number(agg._sum.lateFeeAdded ?? 0);
  if (!logged) return;
  const s = await db.statement.findUnique({ where: { id: statementId }, select: { amountDue: true, penaltiesFees: true, rawDataJson: true } });
  if (!s) return;
  await db.statement.update({
    where: { id: statementId },
    data: {
      amountDue: round(Number(s.amountDue ?? 0) + logged),
      ...(billFee !== undefined ? { penaltiesFees: round(Number(billFee ?? 0) + logged) } : {}),
      // The re-import wrote a fresh charge list; the logged fee goes back on it.
      rawDataJson: withLine({ ...(s.rawDataJson as object ?? {}), chargeBreakdown: { ...(((s.rawDataJson as any)?.chargeBreakdown ?? {}) as object), [LATE_FEE_LINE]: 0 } }, logged),
    },
  });
}
