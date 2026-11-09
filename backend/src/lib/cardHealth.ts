/**
 * A credit card's history, from its statements, their lines and its payments:
 *
 * - Payment history: for each statement, whether its minimum was paid by the
 *   due date, how many days late if not, and where that stands for credit
 *   reporting. A statement's minimum includes any past-due amount (Chase:
 *   "The Past Due amount of $645.00 is included in your Minimum Payment"), so
 *   each statement owes only its minimum less what was already past due — the
 *   printed past-due amount, else what was still unpaid at its closing date; a
 *   late fee or interest charge refunded afterwards is a credit toward it.
 *   Issuers report the account as of each statement date: a late is reported
 *   only when the amount was still 30 or more days past due on a statement
 *   date (60 and 90 worse), not because the payment came 30 days after the due
 *   date. Counting each past-due amount twice made one 25-day-late payment
 *   look like months of 60- and 90-day lates.
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
  /** Credit-reporting bucket: how far past due it was on a statement date; none under 30 days. */
  reported: null | '30' | '60' | '90+';
  /** The most days past due it was on a statement date (when issuers report), and that date. */
  pastDueAtStatement: { date: string; days: number } | null;
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
/** Under a dollar short of a minimum still pays it: a minimum of $1,225.00 met with $1,224.95 drew no late fee. */
const PAID_WITHIN = 1;
/** The same day a month later (the 31st becomes the month's last day). */
const nextMonth = (t: number) => { const d = new Date(t); const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1; return Date.UTC(y, m, Math.min(d.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate())); };

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

  // The dates the account is reported as of: each statement's closing date, and after the last
  // one on file a closing a month on, up to today (statements not uploaded yet still closed).
  const reportDates = sts.map(s => s.c);
  for (let t = sts.length ? nextMonth(sts[sts.length - 1].c) : Infinity; t <= now; t = nextMonth(t)) reportDates.push(t);
  /** How far past due an amount due on `due` and paid on `paid` (null: not yet) was on the statement dates in between. */
  const atStatement = (due: number, paid: number | null): PayRow['pastDueAtStatement'] => {
    const r = reportDates.filter(t => t > due && (paid == null || t < paid)).pop();
    return r != null ? { date: iso(r), days: Math.round((r - due) / DAY) } : null;
  };

  // What pays a minimum: payments, and fees or interest given back afterwards (a waived late fee was part of the
  // minimum it was charged on). A refund line is dated no earlier than the cycle of the statement it is on.
  const credits = sts.flatMap((s, i) => (s.lines ?? []).filter(isRefund).map(l => ({ t: Math.max(d0(l.date), i > 0 ? sts[i - 1].c + DAY : -Infinity), amount: -l.amount })));
  const pool = [...kept, ...credits].map(p => ({ ...p, left: p.amount })).sort((a, b) => a.t - b.t);
  // What each statement newly owed, and what paid it when — for the next one's past-due amount.
  const owedOf: number[] = [];
  const paidOf: { t: number; amount: number }[][] = [];
  const unpaidAt = (k: number, t: number) => Math.max(0, owedOf[k] - paidOf[k].filter(a => a.t <= t).reduce((x, a) => x + a.amount, 0));
  // A later statement printing nothing past due settles every earlier one by its closing date.
  const settledBy = (i: number) => sts.find((x, j) => j > i && x.pastDueAmount != null && Number(x.pastDueAmount) <= 0.005)?.c ?? null;

  // Payments go to the oldest minimum still owed among the statements closed before them;
  // what is left of a payment once a minimum is met can't pay a statement that closed after it.
  const history: PayRow[] = sts.map((s, i) => {
    const next = sts[i + 1];
    const minimum = Number(s.minimumPayment ?? 0);
    const base = { statementId: s.id, closingDate: iso(s.c), dueDate: s.due != null ? iso(s.due) : null, minimum: r2(minimum), lateFee: 0, lateFeeWaivedOn: null as string | null, note: null as string | null, pastDueAtStatement: null as PayRow['pastDueAtStatement'] };
    const fee = lateEvents.find(e => e.forDueDate && s.due != null && e.forDueDate === iso(s.due));
    if (fee) { base.lateFee = fee.fee; base.lateFeeWaivedOn = fee.waivedOn; }
    owedOf[i] = 0; paidOf[i] = [];
    if (Number(s.newBalance) <= 0.005 || minimum <= 0.005 || s.due == null) {
      // Nothing owed: payments made in its cycle are spent on it all the same, so they don't pay a later one.
      for (const p of pool) if (p.t > s.c && (!next || p.t <= next.c)) p.left = 0;
      return { ...base, status: 'NONE_DUE' as const, paidOn: null, paidByDue: 0, daysLate: null, reported: null };
    }
    // The minimum less what was already past due when it closed: printed, else what the earlier ones still owed —
    // when what that leaves looks like a month's own minimum (issuers ask at least ~$15 of a balance that size);
    // a minimum that small beside the unpaid amount is the month's own, the past due not added in.
    const unpaid = owedOf.slice(0, i).reduce((t, _, k) => t + unpaidAt(k, s.c), 0);
    const ownFloor = Math.min(15, Number(s.newBalance));
    const carried = s.pastDueAmount != null ? Number(s.pastDueAmount) : minimum - unpaid >= ownFloor ? unpaid : 0;
    let owed = Math.max(0, minimum - carried);
    owedOf[i] = owed;
    if (owed <= PAID_WITHIN) {
      // All of it was past due (counted on the statements it came from).
      return { ...base, status: 'ON_TIME' as const, paidOn: null, paidByDue: 0, daysLate: null, reported: null, note: 'Its minimum was the earlier past-due amount, counted on the statement it came from.' };
    }
    const until = settledBy(i);
    let paidAt: number | null = null, byDue = 0;
    for (const p of pool) {
      if (p.t <= s.c || p.left <= 0.005) continue;
      if (until != null && p.t > until) break;
      const take = Math.min(p.left, owed);
      if (p.t <= s.due) byDue += take;
      owed -= take;
      paidOf[i].push({ t: p.t, amount: take });
      // A payment in this statement's own cycle is spent here in full (it pays the balance, not only the minimum).
      p.left = !next || p.t <= next.c ? 0 : p.left - take;
      if (owed <= PAID_WITHIN) { paidAt = p.t; break; }
    }
    if (paidAt != null) {
      const daysLate = Math.max(0, Math.round((paidAt - s.due) / DAY));
      const atSt = daysLate > 0 ? atStatement(s.due, paidAt) : null;
      return { ...base, pastDueAtStatement: atSt, status: daysLate > 0 ? 'LATE' as const : 'ON_TIME' as const, paidOn: iso(paidAt), paidByDue: r2(byDue), daysLate: daysLate > 0 ? daysLate : null, reported: bucket(atSt?.days ?? null) };
    }
    if (until != null) {
      // A later statement says nothing was past due: it was paid by then, the payment just isn't on file.
      paidOf[i].push({ t: until, amount: owed });
      return { ...base, status: 'NOT_LOGGED' as const, paidOn: null, paidByDue: r2(byDue), daysLate: null, reported: null,
        note: fee ? 'Paid late (a late fee was charged), but by the next statement nothing was past due; the payment is not on file.' : 'No payment on file, but a later statement shows nothing past due — it was paid.' };
    }
    if (s.due >= now) return { ...base, status: 'DUE' as const, paidOn: null, paidByDue: r2(byDue), daysLate: null, reported: null };
    // Nothing logged and the date gone. The next statement says whether it was missed.
    const missed = fee != null || (next && Number(next.pastDueAmount ?? 0) > 0);
    if (next && !missed) {
      return { ...base, status: 'NOT_LOGGED' as const, paidOn: null, paidByDue: r2(byDue), daysLate: null, reported: null, note: 'No payment on file, but the next statement shows nothing past due — it was probably paid.' };
    }
    const daysLate = Math.round((now - s.due) / DAY);
    const atSt = atStatement(s.due, null);
    return { ...base, pastDueAtStatement: atSt, status: 'PAST_DUE' as const, paidOn: null, paidByDue: r2(byDue), daysLate, reported: bucket(atSt?.days ?? null),
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
