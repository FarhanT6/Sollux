/**
 * Back rent from a figure the owner knows — a 3-day notice, a ledger, a
 * statement: "$22,550 owed for rent through September, as of October 5".
 * From there Sollux carries it forward with what it has on record:
 *   − payments on or after that date toward those months (all of each) or
 *     toward the balance (the part that went to arrears);
 *   + each month after it that has ended, less what was paid toward it.
 * The month in progress is not in arrears (it is this month's rent), the
 * same as the month-end roll (workers/rentIncreaseWorker.ts).
 */
import { monthRentDue, type LeaseRent } from './rentDue';

export interface AsOfPayment { id: string; amount: number; appliedToArrears: number; periodDate: Date; paidDate: Date; status: string }
export interface AsOfCharge { amount: number; periodDate: Date }
export interface AsOfLine { kind: 'payment' | 'month'; label: string; date: string; amount: number }

const ym = (d: Date) => d.toISOString().slice(0, 7);
const r2 = (n: number) => Math.round(n * 100) / 100;

export function arrearsAsOf(input: {
  lease: LeaseRent; amount: number; through: string; asOf: string; today: string;
  payments: AsOfPayment[]; charges: AsOfCharge[];
}): { balance: number; lastRolled: string | null; lines: AsOfLine[] } {
  const { lease, through, asOf, today } = input;
  const lines: AsOfLine[] = [];
  let balance = input.amount;

  for (const p of input.payments) {
    if (p.status !== 'RECEIVED' || p.paidDate.toISOString().slice(0, 10) < asOf) continue;
    const off = ym(p.periodDate) <= through ? p.amount : p.appliedToArrears;
    if (off <= 0.005) continue;
    balance -= off;
    lines.push({ kind: 'payment', label: ym(p.periodDate) <= through ? `Paid toward ${ym(p.periodDate)}` : 'Paid toward the balance', date: p.paidDate.toISOString().slice(0, 10), amount: -r2(off) });
  }

  // Each month after `through` that has ended, with what is still unpaid on it.
  const current = today.slice(0, 7);
  let [y, m] = through.split('-').map(Number);
  let lastRolled: string | null = null;
  for (let i = 0; i < 120; i++) {
    if (++m > 12) { m = 1; y++; }
    const month = `${y}-${String(m).padStart(2, '0')}`;
    if (month >= current) break;
    const period = new Date(`${month}-01T00:00:00.000Z`);
    const credited = input.payments.filter(p => p.status === 'RECEIVED' && ym(p.periodDate) === month).reduce((s, p) => s + p.amount - p.appliedToArrears, 0);
    const charged = input.charges.filter(c => ym(c.periodDate) === month).reduce((s, c) => s + c.amount, 0);
    const owed = Math.max(0, r2(monthRentDue(input.lease, period) + charged - credited));
    lastRolled = month;
    if (owed > 0) { balance += owed; lines.push({ kind: 'month', label: `${month} rent not paid`, date: `${month}-01`, amount: owed }); }
  }
  lines.sort((a, b) => a.date.localeCompare(b.date));
  return { balance: r2(Math.max(0, balance)), lastRolled, lines };
}
