/**
 * Logging a transfer from a tenant as rent — from the bank, a payment email,
 * or the owner's Apply — with what to do when it is more than the month owes.
 *
 * Paying more than the month's rent happens now and then. Where the extra
 * goes depends on what else the tenant owes:
 *   - nothing else (no back rent, no utility invoice open): the extra is next
 *     month's rent, logged as such, and the owner is told (an insight on the
 *     property, and a note on the payment in Incoming);
 *   - back rent or utilities owed: the owner chooses — next month, back rent
 *     or utilities — so the payment waits in Incoming with the reason.
 * More than a whole extra month is never guessed at: it waits too.
 */
import { db } from '../config/db';
import { recordRentPayment, chargesFor, creditedTo } from './rentPaymentService';
import { rentMonthFor } from './p2pPaymentEmails';
import { monthRentDue } from '../lib/rentDue';
import { reimbursableItems, recordReimbursementPayment } from './reimbursement';

export type ExtraChoice = 'next' | 'arrears' | 'utilities';

export interface PaymentPlan {
  month: string;              // YYYY-MM the payment is for
  due: number;                // what that month still owes
  extra: number;              // the amount over it (0 when none)
  arrears: number;            // back rent on the lease
  utilitiesOwed: number;      // open utility invoices
  openInvoiceId: string | null;
  nextMonth: string;
  /** null: no extra; 'next': the extra goes to next month on its own; 'ask': the owner chooses. */
  extraGoes: null | 'next' | 'ask';
  note: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const ym = (d: Date) => d.toISOString().slice(0, 7);
const addMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
const monthName = (m: string) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function planPayment(leaseId: string, userId: string, amount: number, period: Date): Promise<PaymentPlan> {
  const lease = await db.lease.findUnique({ where: { id: leaseId }, select: { rentAmount: true, startDate: true, firstMonthRent: true, arrearsBalance: true } });
  const rent = Number(lease?.rentAmount ?? 0);
  const due = lease ? Math.max(0, r2(monthRentDue(lease as any, period) + await chargesFor(leaseId, period) - await creditedTo(leaseId, period))) : 0;
  const extra = Math.max(0, r2(amount - due));
  const arrears = Math.max(0, Number(lease?.arrearsBalance ?? 0));
  const month = ym(period), nextMonth = ym(addMonth(period));
  const base = { month, due, extra, arrears, nextMonth };
  if (extra < 0.5) return { ...base, extra: 0, utilitiesOwed: 0, openInvoiceId: null, extraGoes: null, note: null };

  let utilitiesOwed = 0, openInvoiceId: string | null = null;
  try {
    const { invoices } = await reimbursableItems(leaseId, userId);
    const open = invoices.filter(i => i.outstanding > 0.005).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    utilitiesOwed = r2(open.reduce((s, i) => s + i.outstanding, 0));
    openInvoiceId = open[0]?.id ?? null;
  } catch { /* no utility billing on this lease */ }

  const over = `${usd(extra)} more than ${monthName(month)}'s rent`;
  if (arrears > 0.5 || utilitiesOwed > 0.5) {
    const owes = [arrears > 0.5 && `${usd(arrears)} back rent`, utilitiesOwed > 0.5 && `${usd(utilitiesOwed)} in utilities`].filter(Boolean).join(' and ');
    return { ...base, utilitiesOwed, openInvoiceId, extraGoes: 'ask', note: `${over}. They also owe ${owes} — choose where the extra goes.` };
  }
  if (rent > 0 && extra > rent + 0.5) {
    return { ...base, utilitiesOwed, openInvoiceId, extraGoes: 'ask', note: `${over} — more than a month extra. Choose where it goes.` };
  }
  return { ...base, utilitiesOwed, openInvoiceId, extraGoes: 'next', note: `${over} — the extra was applied to ${monthName(nextMonth)}'s rent.` };
}

export interface IncomingToLog {
  txId: string; userId: string; leaseId: string;
  amount: number; date: Date; memo: string | null;
  method: string; bankAccountId?: string | null; notes: string;
  /** The month the owner chose; it is paid first, before anything older. */
  forMonth?: string | null;
  /** Where the extra goes, when the owner has said. */
  choice?: ExtraChoice | null;
}

/**
 * Logs the transfer and marks it applied — unless the extra needs the owner's
 * word, when it is left waiting (status SUGGESTED) with the reason and the
 * plan is returned for the owner to choose.
 */
export async function logIncomingRent(t: IncomingToLog): Promise<{ applied: boolean; plan: PaymentPlan; rentPaymentId: string | null }> {
  const period = t.forMonth ? new Date(`${t.forMonth}-01T00:00:00.000Z`) : await rentMonthFor(t.leaseId, t.date, t.memo);
  const plan = await planPayment(t.leaseId, t.userId, t.amount, period);
  const choice: ExtraChoice | null = plan.extraGoes === null ? null : t.choice ?? (plan.extraGoes === 'next' ? 'next' : null);

  if (plan.extraGoes !== null && !choice) {
    await db.incomingTransaction.update({ where: { id: t.txId }, data: { status: 'SUGGESTED', matchedLeaseId: t.leaseId, reviewNote: plan.note } });
    return { applied: false, plan, rentPaymentId: null };
  }

  const common = { leaseId: t.leaseId, paidDate: t.date, method: t.method as any, bankAccountId: t.bankAccountId ?? undefined };
  let first: { id: string } | null = null;
  let note: string | null = null;

  if (!choice || choice === 'arrears') {
    // One payment for the month; past what it owes it pays down back rent (splitPayment).
    first = await recordRentPayment({ ...common, periodDate: period, amount: t.amount, notes: t.notes, ...(t.forMonth || choice ? { applyTo: 'CURRENT' as const } : {}) });
    if (choice === 'arrears') note = `${usd(plan.extra)} over ${monthName(plan.month)}'s rent went to back rent.`;
  } else {
    if (plan.due > 0.005) first = await recordRentPayment({ ...common, periodDate: period, amount: plan.due, notes: t.notes, applyTo: 'CURRENT' });
    if (choice === 'next') {
      const nextP = await recordRentPayment({ ...common, periodDate: addMonth(period), amount: plan.extra, applyTo: 'CURRENT', notes: `${t.notes} · paid ahead: ${usd(plan.extra)} over ${monthName(plan.month)}'s rent` });
      first ??= nextP;
      note = `${usd(plan.extra)} over ${monthName(plan.month)}'s rent was applied to ${monthName(plan.nextMonth)}'s rent.`;
    } else {
      await recordReimbursementPayment(t.leaseId, t.userId, {
        amount: plan.extra, paidDate: t.date.toISOString().slice(0, 10), method: t.method, bankAccountId: t.bankAccountId ?? null,
        notes: `${t.notes} · ${usd(plan.extra)} over ${monthName(plan.month)}'s rent`, allocations: [], invoiceId: plan.openInvoiceId,
      });
      note = `${usd(plan.extra)} over ${monthName(plan.month)}'s rent went to utilities.`;
    }
  }

  await db.incomingTransaction.update({ where: { id: t.txId }, data: { status: 'APPLIED', matchedLeaseId: t.leaseId, rentPaymentId: first?.id ?? null, reviewNote: note } });

  // Extra logged on its own: say so where the owner looks.
  if (note && !t.choice) {
    const lease = await db.lease.findUnique({ where: { id: t.leaseId }, select: { unit: { select: { propertyId: true } }, leaseTenants: { select: { tenant: { select: { fullName: true } } } } } });
    const who = lease?.leaseTenants.map(lt => lt.tenant.fullName).join(', ') || 'A tenant';
    if (lease?.unit.propertyId) {
      await db.aIInsight.create({
        data: { propertyId: lease.unit.propertyId, insightType: 'INFO', severity: 'INFO', title: `${who} paid ${usd(plan.extra)} extra`, body: note, dedupeKey: `overpayment:${t.txId}` },
      }).catch(() => {});
    }
  }
  return { applied: true, plan, rentPaymentId: first?.id ?? null };
}
