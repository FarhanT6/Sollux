/**
 * A credit card's history, from its statements, their lines and its payments:
 *
 * - Payment history: for each statement, whether its minimum was paid by the
 *   due date, how many days late if not, and where that stands for credit
 *   reporting (issuers report a payment 30 days past due; 60 and 90 are worse).
 *   A payment that came back (returned check) does not count, and the late fee
 *   an issuer charged for a missed due date is a late payment on record even
 *   when the statement it was for is not on file.
 * - What the card cost: interest, late fees and other fees, less the fees and
 *   interest refunded, by month and for the last 12 months.
 *
 * Pure: the route gathers the rows. Exported for tests.
 */

export interface HLine { date: Date | string; amount: number; kind: string; description: string }
export interface HStatement {
  id: string; closingDate: Date | string; dueDate?: Date | string | null;
  minimumPayment?: number | null; newBalance: number; interestCharged?: number | null; feesCharged?: number | null;
  pastDueAmount?: number | null; fromEmail?: boolean; lines?: HLine[];
}
export interface HPayment { date: Date | string; amount: number }

export type PayStatus = 'ON_TIME' | 'LATE' | 'PAST_DUE' | 'DUE' | 'NOT_LOGGED' | 'NONE_DUE';
export interface PayRow {
  statementId: string; closingDate: string; dueDate: string | null; minimum: number;
  status: PayStatus; paidOn: string | null; paidByDue: number; daysLate: number | null;
  /** Credit-reporting bucket: none under 30 days. */
  reported: null | '30' | '60' | '90+';
  lateFee: number;
  /** The late fee was refunded (a "Late Fee Credit"), and when. */
  lateFeeWaivedOn: string | null;
  note: string | null;
}
export interface LateEvent { date: string; fee: number; waived: boolean; waivedOn: string | null; forDueDate: string | null; onFile: boolean }
export interface CostMonth { month: string; interest: number; lateFees: number; otherFees: number; refunds: number }
export interface ReturnedPayment { paidOn: string; returnedOn: string; amount: number }

export interface CardHealth {
  history: PayRow[];
  lateEvents: LateEvent[];
  returned: ReturnedPayment[];
  costs: CostMonth[];
  last12: { interest: number; lateFees: number; otherFees: number; refunds: number; net: number; onTime: number; late: number; worstDaysLate: number };
  allTime: { interest: number; lateFees: number; otherFees: number; refunds: number; net: number };
  /** The newest statement's minimum not paid and its due date gone: days past due now. */
  daysPastDue: number;
  daysUntil30: number | null;
  onTimeStreak: number;
}

const DAY = 86_400_000;
const d0 = (d: Date | string) => { const x = typeof d === 'string' ? new Date(`${d.slice(0, 10)}T00:00:00Z`) : d; return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()); };
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
const bucket = (days: number | null): PayRow['reported'] => (days == null || days < 30 ? null : days < 60 ? '30' : days < 90 ? '60' : '90+');

const isLateFee = (l: HLine) => l.kind === 'FEE' && /LATE/i.test(l.description) && l.amount > 0;
// A credit that gives back a fee or interest: "Late Fee Credit", "REFUND RETURN CK CHG", "Interest Charge Reversal".
const isRefund = (l: HLine) => l.amount < 0 && l.kind === 'CREDIT' && /FEE|CHG|CHARGE|INTEREST|PENALTY/i.test(l.description);
const REVERSAL = /REVERS|RETURN|NSF|DISHONOU?R/i;

/**
 * Payments that came back: a payment reversal line (positive, on a statement) cancels the
 * payment of the same amount made before it. Both are left out of the history.
 */
function settledPayments(payments: HPayment[], lines: HLine[]): { kept: { t: number; amount: number }[]; returned: ReturnedPayment[] } {
  const pays = payments.map(p => ({ t: d0(p.date), amount: Number(p.amount) })).sort((a, b) => a.t - b.t);
  const returned: ReturnedPayment[] = [];
  // A reversal shows as a negative payment (read from a statement) or as a positive PAYMENT line.
  const reversals = [
    ...pays.filter(p => p.amount < 0).map(p => ({ t: p.t, amount: -p.amount })),
    ...lines.filter(l => l.kind === 'PAYMENT' && l.amount > 0 && REVERSAL.test(l.description)).map(l => ({ t: d0(l.date), amount: l.amount })),
  ];
  const seen = new Set<string>();
  const used = new Set<number>();
  for (const r of reversals) {
    const k = `${r.t}|${r.amount.toFixed(2)}`;
    if (seen.has(k)) continue;   // the same reversal as a payment row and as a line
    seen.add(k);
    let best = -1;
    pays.forEach((p, i) => { if (!used.has(i) && p.amount > 0 && Math.abs(p.amount - r.amount) < 0.005 && p.t <= r.t && r.t - p.t <= 60 * DAY && (best < 0 || p.t > pays[best].t)) best = i; });
    if (best >= 0) { used.add(best); returned.push({ paidOn: iso(pays[best].t), returnedOn: iso(r.t), amount: r2(r.amount) }); }
  }
  return { kept: pays.filter((p, i) => p.amount > 0 && !used.has(i)), returned };
}

export function cardHealth(statements: HStatement[], payments: HPayment[], today: Date = new Date()): CardHealth {
  const now = d0(today);
  const sts = statements.filter(s => !s.fromEmail).map(s => ({ ...s, c: d0(s.closingDate), due: s.dueDate ? d0(s.dueDate) : null })).sort((a, b) => a.c - b.c);
  const allLines = sts.flatMap(s => s.lines ?? []);
  const { kept, returned } = settledPayments(payments, allLines);

  // Late fees: each is for the latest due date before it was charged; a later credit of the same amount waived it.
  const feeLines = allLines.filter(isLateFee).map(l => ({ t: d0(l.date), fee: l.amount })).sort((a, b) => a.t - b.t);
  const refundLines = allLines.filter(l => isRefund(l) && /LATE/i.test(l.description)).map(l => ({ t: d0(l.date), amount: -l.amount }));
  const usedRefund = new Set<number>();
  const lateEvents: LateEvent[] = feeLines.map(f => {
    const ri = refundLines.findIndex((r, i) => !usedRefund.has(i) && Math.abs(r.amount - f.fee) < 0.005 && r.t >= f.t && r.t - f.t <= 120 * DAY);
    if (ri >= 0) usedRefund.add(ri);
    const prior = sts.filter(s => s.due != null && s.due < f.t).pop();
    // An issuer charges the fee within days of the missed date; one much later is for a statement not on file.
    const onFile = !!prior && f.t - prior.due! <= 35 * DAY;
    return { date: iso(f.t), fee: r2(f.fee), waived: ri >= 0, waivedOn: ri >= 0 ? iso(refundLines[ri].t) : null, forDueDate: onFile ? iso(prior!.due!) : null, onFile };
  });

  // Payments go to the oldest minimum still owed among the statements closed before them;
  // what is left of a payment once a minimum is met can't pay a statement that closed after it.
  const pool = kept.map(p => ({ ...p, left: p.amount }));
  const history: PayRow[] = sts.map((s, i) => {
    const next = sts[i + 1];
    const minimum = Number(s.minimumPayment ?? 0);
    const base = { statementId: s.id, closingDate: iso(s.c), dueDate: s.due != null ? iso(s.due) : null, minimum: r2(minimum), lateFee: 0, lateFeeWaivedOn: null as string | null, note: null as string | null };
    const fee = lateEvents.find(e => e.forDueDate && s.due != null && e.forDueDate === iso(s.due));
    if (fee) { base.lateFee = fee.fee; base.lateFeeWaivedOn = fee.waivedOn; }
    if (Number(s.newBalance) <= 0.005 || minimum <= 0.005 || s.due == null) {
      // Nothing owed: payments made in its cycle are spent on it all the same, so they don't pay a later one.
      for (const p of pool) if (p.t > s.c && (!next || p.t <= next.c)) p.left = 0;
      return { ...base, status: 'NONE_DUE' as const, paidOn: null, paidByDue: 0, daysLate: null, reported: null };
    }
    let owed = minimum, paidAt: number | null = null, byDue = 0;
    for (const p of pool) {
      if (p.t <= s.c || p.left <= 0.005) continue;
      const take = Math.min(p.left, owed);
      if (p.t <= s.due) byDue += take;
      owed -= take;
      // A payment in this statement's own cycle is spent here in full (it pays the balance, not only the minimum).
      p.left = !next || p.t <= next.c ? 0 : p.left - take;
      if (owed <= 0.01) { paidAt = p.t; break; }
    }
    if (paidAt != null) {
      const daysLate = Math.max(0, Math.round((paidAt - s.due) / DAY));
      return { ...base, status: daysLate > 0 ? 'LATE' as const : 'ON_TIME' as const, paidOn: iso(paidAt), paidByDue: r2(byDue), daysLate: daysLate > 0 ? daysLate : null, reported: bucket(daysLate) };
    }
    if (s.due >= now) return { ...base, status: 'DUE' as const, paidOn: null, paidByDue: r2(byDue), daysLate: null, reported: null };
    // Nothing logged and the date gone. The next statement says whether it was missed.
    const missed = fee != null || (next && Number(next.pastDueAmount ?? 0) > 0);
    if (next && !missed) {
      return { ...base, status: 'NOT_LOGGED' as const, paidOn: null, paidByDue: r2(byDue), daysLate: null, reported: null, note: 'No payment on file, but the next statement shows nothing past due — it was probably paid.' };
    }
    const daysLate = Math.round((now - s.due) / DAY);
    return { ...base, status: 'PAST_DUE' as const, paidOn: null, paidByDue: r2(byDue), daysLate, reported: bucket(daysLate),
      note: next ? 'Missed: the next statement shows a past-due amount or a late fee, and no payment is on file since.' : null };
  });

  const latest = history[history.length - 1];
  const daysPastDue = latest?.status === 'PAST_DUE' && latest.dueDate && !sts.some(s => s.c > d0(latest.closingDate)) ? Math.max(0, Math.round((now - d0(latest.dueDate)) / DAY)) : 0;

  // Costs by statement month.
  const byMonth = new Map<string, CostMonth>();
  for (const s of sts) {
    const month = iso(s.c).slice(0, 7);
    const m = byMonth.get(month) ?? { month, interest: 0, lateFees: 0, otherFees: 0, refunds: 0 };
    const lines = s.lines ?? [];
    const interestLines = lines.filter(l => l.kind === 'INTEREST').reduce((t, l) => t + l.amount, 0);
    m.interest += Number(s.interestCharged ?? 0) || interestLines;
    const late = lines.filter(isLateFee).reduce((t, l) => t + l.amount, 0);
    const feeLinesSum = lines.filter(l => l.kind === 'FEE' && l.amount > 0).reduce((t, l) => t + l.amount, 0);
    m.lateFees += late;
    // Fees from the lines when they were read; else the statement's own total.
    m.otherFees += lines.length ? feeLinesSum - late : Number(s.feesCharged ?? 0);
    m.refunds += lines.filter(isRefund).reduce((t, l) => t - l.amount, 0);
    byMonth.set(month, m);
  }
  const costs = [...byMonth.values()].map(m => ({ month: m.month, interest: r2(m.interest), lateFees: r2(m.lateFees), otherFees: r2(m.otherFees), refunds: r2(m.refunds) })).sort((a, b) => a.month.localeCompare(b.month));
  const since = iso(now - 365 * DAY).slice(0, 7);
  const sum = (rows: CostMonth[]) => {
    const t = rows.reduce((a, m) => ({ interest: a.interest + m.interest, lateFees: a.lateFees + m.lateFees, otherFees: a.otherFees + m.otherFees, refunds: a.refunds + m.refunds }), { interest: 0, lateFees: 0, otherFees: 0, refunds: 0 });
    return { interest: r2(t.interest), lateFees: r2(t.lateFees), otherFees: r2(t.otherFees), refunds: r2(t.refunds), net: r2(t.interest + t.lateFees + t.otherFees - t.refunds) };
  };
  const recent = history.filter(h => h.dueDate && h.dueDate > iso(now - 365 * DAY) && h.dueDate <= iso(now));
  // A late fee for a statement not on file is a late payment too.
  const orphanLate = lateEvents.filter(e => !e.onFile && e.date > iso(now - 365 * DAY)).length;
  let streak = 0;
  for (const h of [...history].reverse()) {
    if (h.status === 'DUE' || h.status === 'NONE_DUE') continue;
    if (h.status === 'ON_TIME' || h.status === 'NOT_LOGGED') streak++; else break;
  }
  return {
    history: history.reverse(), lateEvents: lateEvents.reverse(), returned, costs: costs.reverse(),
    last12: {
      ...sum(costs.filter(c => c.month >= since)),
      onTime: recent.filter(h => h.status === 'ON_TIME' || h.status === 'NOT_LOGGED').length,
      late: recent.filter(h => h.status === 'LATE' || h.status === 'PAST_DUE').length + orphanLate,
      worstDaysLate: Math.max(0, ...recent.map(h => h.daysLate ?? 0)),
    },
    allTime: sum(costs),
    daysPastDue, daysUntil30: daysPastDue > 0 && daysPastDue < 30 ? 30 - daysPastDue : null,
    onTimeStreak: streak,
  };
}
