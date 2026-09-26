/**
 * The deadline watcher — the dates that cost the most to miss, raised well
 * ahead of time as bookkeeper findings:
 *
 *  - a loan's maturity or balloon: 6 months out, then 3, then 1, and every
 *    night after it has passed while the loan is still active;
 *  - a variable rate about to reset;
 *  - a prepayment penalty about to end (the window to refinance opens);
 *  - a property-tax installment coming due and unpaid;
 *  - a citation, notice or permit with a deadline or fine due;
 *  - a fixed-term lease ending.
 *
 * Pure date arithmetic on what is on file; the findings go through the
 * bookkeeper, which keeps one live insight per key and clears it when the
 * condition goes away.
 */
import { db } from '../config/db';
import type { Finding } from './bookkeeper';

const DAY = 86400000;
const money = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Stored dates are date-only at UTC midnight; read them in UTC so a date never shifts a day.
const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const daysUntil = (d: Date, now: Date) => Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / DAY);
const inDays = (n: number) => (n === 0 ? 'today' : n > 0 ? `in ${n} day${n === 1 ? '' : 's'}` : `${-n} day${n === -1 ? '' : 's'} ago`);

/** Which warning a maturity is at: six months, three months, one month, or past. */
export function maturityStage(days: number): { stage: string; severity: Finding['severity'] } | null {
  if (days < 0) return { stage: 'past', severity: 'ALERT' };
  if (days <= 30) return { stage: '1m', severity: 'ALERT' };
  if (days <= 90) return { stage: '3m', severity: 'WARNING' };
  if (days <= 183) return { stage: '6m', severity: 'INFO' };
  return null;
}

export async function watchDeadlines(userId: string, now = new Date()): Promise<Finding[]> {
  const out: Finding[] = [];
  const props = await db.property.findMany({ where: { userId }, select: { id: true, address: true, nickname: true }, orderBy: { createdAt: 'asc' } });
  if (!props.length) return out;
  const name = new Map(props.map(p => [p.id, p.nickname || p.address]));
  // Insights hang off a property; a personal loan with none goes on the first.
  const home = props[0].id;

  // ── Loans ────────────────────────────────────────────────────────────────
  const loans = await db.loan.findMany({
    where: { userId, isActive: true },
    select: {
      id: true, lender: true, propertyId: true, isPersonal: true, maturityDate: true, balloonPaymentAmount: true, currentBalance: true, originalAmount: true,
      paymentType: true, rateType: true, rateIndex: true, rateMargin: true, interestRate: true, nextRateAdjustment: true, originationDate: true, prepaymentPenaltyJson: true,
      mailingAddress: true, paymentUrl: true, loanExtensions: { select: { id: true }, take: 1 },
    },
  });
  for (const l of loans) {
    const where = l.propertyId ? name.get(l.propertyId) ?? 'property' : 'personal';
    const pid = l.propertyId ?? home;
    const label = `${l.lender} · ${where}`;

    if (l.maturityDate) {
      const d = daysUntil(l.maturityDate, now);
      const st = maturityStage(d);
      if (st) {
        const owed = l.balloonPaymentAmount != null ? Number(l.balloonPaymentAmount) : l.currentBalance != null ? Number(l.currentBalance) : null;
        const balloon = l.paymentType === 'INTEREST_ONLY' || l.balloonPaymentAmount != null;
        const what = balloon ? 'Balloon' : 'Maturity';
        const contact = [l.mailingAddress ? `mail: ${l.mailingAddress}` : null, l.paymentUrl ? `online: ${l.paymentUrl}` : null].filter(Boolean).join(' · ');
        out.push({
          // The stage is in the key so each milestone is a fresh, unread insight.
          key: `loan-maturity:${l.id}:${st.stage}`, propertyId: pid, type: 'REMINDER', severity: st.severity,
          title: d < 0
            ? `${label}: ${what.toLowerCase()} was due ${fmt(l.maturityDate)} (${-d} days ago) — loan still active`
            : `${label}: ${what.toLowerCase()} due ${fmt(l.maturityDate)} (${inDays(d)})${owed != null ? ` — ${money(owed)}` : ''}`,
          body: d < 0
            ? `The maturity date has passed and the loan is still marked active.${owed != null ? ` ${money(owed)} was due.` : ''} If it was paid off, mark the loan inactive; if the lender extended it, record the extension so the new date is watched.`
            : `${what} of ${owed != null ? money(owed) : 'the remaining balance'} falls due ${fmt(l.maturityDate)}.${l.loanExtensions.length ? ' This loan has been extended before.' : ''}${contact ? ` Lender — ${contact}.` : ''}`,
          recommendation: d < 0 ? 'Mark it paid off, or use Extend on the loan page.' : d <= 90 ? 'Line up the payoff money, ask the lender for an extension, or start a refinance now — these take weeks.' : 'Decide now: pay off, extend, or refinance.',
        });
      }
    }

    if (l.rateType === 'VARIABLE' && l.nextRateAdjustment) {
      const d = daysUntil(l.nextRateAdjustment, now);
      if (d >= 0 && d <= 45) {
        out.push({
          key: `rate-reset:${l.id}:${l.nextRateAdjustment.toISOString().slice(0, 10)}`, propertyId: pid, type: 'REMINDER', severity: d <= 14 ? 'WARNING' : 'INFO',
          title: `${label}: rate resets ${fmt(l.nextRateAdjustment)} (${inDays(d)})`,
          body: `The rate is ${l.rateIndex ?? 'the index'} ${Number(l.rateMargin ?? 0) >= 0 ? '+' : '−'} ${Math.abs(Number(l.rateMargin ?? 0))}%, now ${l.interestRate != null ? `${Number(l.interestRate)}%` : 'not on file'}. Log the index's current value so the new payment is right.`,
        });
      }
    }

    // A prepayment penalty that is about to run out: the cheapest time to refinance.
    const pp = l.prepaymentPenaltyJson as { enabled?: boolean; periodMonths?: number } | null;
    if (pp?.enabled && pp.periodMonths && l.originationDate) {
      const ends = new Date(Date.UTC(l.originationDate.getUTCFullYear(), l.originationDate.getUTCMonth() + pp.periodMonths, l.originationDate.getUTCDate()));
      const d = daysUntil(ends, now);
      if (d >= 0 && d <= 60) {
        out.push({
          key: `prepay-ends:${l.id}`, propertyId: pid, type: 'SAVINGS', severity: 'INFO',
          title: `${label}: prepayment penalty ends ${fmt(ends)} (${inDays(d)})`,
          body: `After that the loan can be paid off or refinanced without the penalty.${l.interestRate != null ? ` It carries ${Number(l.interestRate)}%.` : ''}`,
        });
      }
    }
  }

  // ── Property tax installments ───────────────────────────────────────────
  const taxes = await db.taxAssessment.findMany({
    where: { property: { userId }, status: { not: 'PAID' }, escrowLoanId: null },
    select: { id: true, propertyId: true, taxYear: true, installment1Due: true, installment2Due: true, installment1Paid: true, installment2Paid: true, installment1Amount: true, installment2Amount: true, annualTaxAmount: true },
  });
  for (const t of taxes) {
    for (const n of [1, 2] as const) {
      const due = n === 1 ? t.installment1Due : t.installment2Due;
      const paid = n === 1 ? t.installment1Paid : t.installment2Paid;
      if (!due || paid) continue;
      const d = daysUntil(due, now);
      if (d > 30 || d < -60) continue;
      const amt = n === 1 ? t.installment1Amount : t.installment2Amount;
      const amount = amt != null ? Number(amt) : Number(t.annualTaxAmount) / 2;
      out.push({
        key: `tax-installment:${t.id}:${n}`, propertyId: t.propertyId, type: 'REMINDER', severity: d < 0 ? 'ALERT' : d <= 10 ? 'WARNING' : 'INFO',
        title: `${name.get(t.propertyId)}: ${t.taxYear} property tax, installment ${n} — ${money(amount)} ${d < 0 ? `was due ${fmt(due)}` : `due ${fmt(due)} (${inDays(d)})`}`,
        body: d < 0 ? 'Not marked paid. A delinquent installment carries a 10% penalty in California; mark it paid on the Taxes page if it was.' : 'Mark it paid on the Taxes page once paid.',
      });
    }
  }

  // ── Citations, notices and permits ──────────────────────────────────────
  const items = await db.complianceItem.findMany({
    where: { userId, status: { in: ['OPEN', 'IN_PROGRESS', 'APPEALED'] } },
    select: { id: true, propertyId: true, kind: true, title: true, agency: true, dueDate: true, paymentDueDate: true, fineAmount: true, escalation: true },
  });
  for (const c of items) {
    for (const [what, date] of [['Correct by', c.dueDate], ['Fine due', c.paymentDueDate]] as const) {
      if (!date) continue;
      const d = daysUntil(date, now);
      if (d > 21 || d < -90) continue;
      out.push({
        key: `compliance:${c.id}:${what === 'Fine due' ? 'fine' : 'correct'}`, propertyId: c.propertyId, type: 'REMINDER', severity: d < 0 ? 'ALERT' : d <= 7 ? 'WARNING' : 'INFO',
        title: `${name.get(c.propertyId)}: ${c.title}${c.agency ? ` (${c.agency})` : ''} — ${what.toLowerCase()} ${fmt(date)} (${inDays(d)})`,
        body: `${what === 'Fine due' && c.fineAmount != null ? `${money(Number(c.fineAmount))} fine. ` : ''}${c.escalation ? `If missed: ${c.escalation}` : 'Mark it resolved on the Compliance page once done.'}`,
      });
    }
  }

  // ── Fixed-term leases ending ────────────────────────────────────────────
  const leases = await db.lease.findMany({
    where: { status: 'ACTIVE', leaseType: { not: 'MONTH_TO_MONTH' }, endDate: { not: null }, unit: { property: { userId } } },
    select: { id: true, endDate: true, unit: { select: { unitLabel: true, propertyId: true } }, leaseTenants: { where: { isPrimary: true }, select: { tenant: { select: { fullName: true } } }, take: 1 } },
  });
  for (const le of leases) {
    const d = daysUntil(le.endDate!, now);
    if (d > 60 || d < 0) continue;
    const who = le.leaseTenants[0]?.tenant.fullName ?? 'Tenant';
    out.push({
      key: `lease-ending:${le.id}`, propertyId: le.unit.propertyId, type: 'REMINDER', severity: d <= 30 ? 'WARNING' : 'INFO',
      title: `${name.get(le.unit.propertyId)} · ${le.unit.unitLabel}: ${who}'s lease ends ${fmt(le.endDate!)} (${inDays(d)})`,
      body: 'Renew, raise the rent, convert to month-to-month, or give notice — California needs 30 to 90 days\' notice depending on the change.',
    });
  }

  return out;
}
