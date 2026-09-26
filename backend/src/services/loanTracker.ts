/**
 * The monthly loan-payment tracker — the loans' side of the rent tracker.
 * For a month, every active loan shows what is owed (P&I plus escrow), what
 * was paid toward that month, when it is due and whether it is paid,
 * partly paid, not due yet, inside its grace period, or late.
 *
 * A payment counts toward the month in its periodDate; one logged without a
 * periodDate counts toward the month it was paid in. Months are compared as
 * YYYY-MM strings on the UTC date, the way date-only values are stored.
 */
import { db } from '../config/db';

export type TrackerStatus = 'paid' | 'partial' | 'upcoming' | 'due' | 'late' | 'none';

const ym = (d: Date) => d.toISOString().slice(0, 7);
const monthOf = (p: { periodDate: Date | null; date: Date }) => ym(p.periodDate ?? p.date);
const n = (v: unknown) => (v == null ? 0 : Number(v));
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (x: number) => String(x).padStart(2, '0');

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dueDateFor(month: string, dueDay: number | null): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(Math.min(dueDay ?? 1, daysIn(y, m)))}`;
}

/** Where a loan stands for one month. `today` is YYYY-MM-DD. */
export function statusFor(expected: number, paid: number, dueDate: string, graceEnds: string, today: string): TrackerStatus {
  if (expected <= 0) return paid > 0 ? 'paid' : 'none';
  if (paid >= expected - 0.5) return 'paid';
  if (paid > 0) return 'partial';
  if (today < dueDate) return 'upcoming';
  if (today <= graceEnds) return 'due';
  return 'late';
}

const LOAN_SELECT = {
  id: true, lender: true, loanType: true, isPersonal: true, monthlyPayment: true, escrowAmount: true, dueDay: true, gracePeriodDays: true,
  originationDate: true, paymentMethods: true, paymentInstructions: true, mailingAddress: true, paymentUrl: true,
  propertyId: true, property: { select: { nickname: true, address: true } },
  payFromBankAccount: { select: { id: true, name: true, last4: true } },
} as const;

async function activeLoans(userId: string) {
  return db.loan.findMany({ where: { userId, isActive: true }, select: LOAN_SELECT, orderBy: { lender: 'asc' } });
}

/** Payments touching [from, to] months either by periodDate or, without one, by date. */
async function paymentsBetween(loanIds: string[], from: string, to: string) {
  const start = new Date(`${from}-01T00:00:00.000Z`);
  const [ty, tm] = to.split('-').map(Number);
  const end = new Date(Date.UTC(ty, tm, 1)); // first of the month after
  // A wide net on either date, then filtered by the month each one covers.
  const rows = await db.loanPayment.findMany({
    where: { loanId: { in: loanIds }, OR: [{ periodDate: { gte: start, lt: end } }, { periodDate: null, date: { gte: start, lt: end } }] },
    orderBy: { date: 'asc' },
  });
  return rows.map(p => ({
    id: p.id, loanId: p.loanId, date: p.date.toISOString().slice(0, 10), month: monthOf(p),
    amount: n(p.amount), lateFee: p.lateFee != null ? n(p.lateFee) : null, method: p.method, confirmationNumber: p.confirmationNumber, notes: p.notes,
  }));
}

type Loan = Awaited<ReturnType<typeof activeLoans>>[number];

function base(l: Loan) {
  return {
    loanId: l.id, lender: l.lender, loanType: l.loanType, isPersonal: l.isPersonal,
    property: l.property?.nickname || l.property?.address || (l.isPersonal ? 'Personal' : 'General'), propertyId: l.propertyId,
    expected: Number((n(l.monthlyPayment) + n(l.escrowAmount)).toFixed(2)),
    dueDay: l.dueDay, gracePeriodDays: l.gracePeriodDays,
    paymentMethods: l.paymentMethods, paymentInstructions: l.paymentInstructions, mailingAddress: l.mailingAddress, paymentUrl: l.paymentUrl,
    payFrom: l.payFromBankAccount ? [l.payFromBankAccount.name, l.payFromBankAccount.last4 ? `••${l.payFromBankAccount.last4}` : null].filter(Boolean).join(' ') : null,
  };
}

/** A loan that had not started by the end of the month owes nothing that month. */
const startedBy = (l: Loan, month: string) => !l.originationDate || ym(l.originationDate) <= month;

export async function trackerMonth(userId: string, month: string, today: string) {
  const loans = (await activeLoans(userId)).filter(l => startedBy(l, month));
  const payments = await paymentsBetween(loans.map(l => l.id), month, month);
  // The last payment on record, whatever month it covered.
  const last = await db.loanPayment.findMany({
    where: { loanId: { in: loans.map(l => l.id) } }, orderBy: { date: 'desc' }, distinct: ['loanId'],
    select: { loanId: true, date: true, amount: true },
  });
  const lastBy = new Map(last.map(p => [p.loanId, { date: p.date.toISOString().slice(0, 10), amount: n(p.amount) }]));

  const rows = loans.map(l => {
    const b = base(l);
    const mine = payments.filter(p => p.loanId === l.id && p.month === month);
    const paid = Number(mine.reduce((s, p) => s + p.amount, 0).toFixed(2));
    const dueDate = dueDateFor(month, l.dueDay);
    const graceEnds = addDays(dueDate, l.gracePeriodDays ?? 0);
    return {
      ...b, dueDate, graceEnds, paid,
      remaining: Math.max(0, Number((b.expected - paid).toFixed(2))),
      lateFees: Number(mine.reduce((s, p) => s + (p.lateFee ?? 0), 0).toFixed(2)),
      status: statusFor(b.expected, paid, dueDate, graceEnds, today),
      payments: mine, lastPayment: lastBy.get(l.id) ?? null,
    };
  });
  const sum = (f: (r: typeof rows[number]) => number) => Number(rows.reduce((s, r) => s + f(r), 0).toFixed(2));
  return {
    month, rows,
    totals: { expected: sum(r => r.expected), paid: sum(r => r.paid), remaining: sum(r => r.remaining), late: sum(r => (r.status === 'late' ? r.remaining : 0)) },
  };
}

/** Twelve months side by side, one row per loan. */
export async function trackerYear(userId: string, year: number, today: string) {
  const loans = await activeLoans(userId);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}`);
  const payments = await paymentsBetween(loans.map(l => l.id), months[0], months[11]);
  const rows = loans.map(l => {
    const b = base(l);
    const cells = months.map(month => {
      if (!startedBy(l, month)) return { month, expected: 0, paid: 0, status: 'none' as TrackerStatus };
      const paid = Number(payments.filter(p => p.loanId === l.id && p.month === month).reduce((s, p) => s + p.amount, 0).toFixed(2));
      const dueDate = dueDateFor(month, l.dueDay);
      return { month, expected: b.expected, paid, status: statusFor(b.expected, paid, dueDate, addDays(dueDate, l.gracePeriodDays ?? 0), today) };
    });
    return { ...b, cells, paidYear: Number(cells.reduce((s, c) => s + c.paid, 0).toFixed(2)), lateMonths: cells.filter(c => c.status === 'late').length };
  });
  return { year, months, rows };
}
