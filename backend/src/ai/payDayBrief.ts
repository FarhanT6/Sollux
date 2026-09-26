/**
 * The pay-day brief: every morning, one note listing what to pay in the next
 * seven days — amount, due date, which account to pay from (the pay
 * planner's choice) and how (autopay, check and where it goes, Zelle, the
 * lender's account). Built on the pay planner; it recommends, it moves
 * nothing. Raised through the bookkeeper as a single refreshed insight.
 */
import { buildPayPlan } from '../lib/payPlan';
import { db } from '../config/db';
import type { Finding } from './bookkeeper';

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (d: number, iso: string) => {
  const date = new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return d < 0 ? `overdue since ${date}` : d === 0 ? 'due today' : d === 1 ? 'due tomorrow' : `due ${date}`;
};

export async function payDayBrief(userId: string): Promise<Finding[]> {
  const home = await db.property.findFirst({ where: { userId }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  if (!home) return [];
  const plan = await buildPayPlan(userId, { horizonDays: 7 });
  const todo = plan.obligations.filter(o => o.status !== 'SENT').sort((a, b) => a.daysUntil - b.daysUntil);
  if (!todo.length) return [];
  const acct = new Map(plan.accounts.map(a => [a.id, `${a.name}${a.last4 ? ` ••${a.last4}` : ''}`]));
  const lines = todo.map(o => {
    const from = o.payFrom.length ? `from ${o.payFrom.map(p => acct.get(p.accountId) ?? 'account').join(' + ')}` : 'no account has room';
    return `• ${o.label}${o.detail ? ` (${o.detail})` : ''} — ${money(o.amount)}, ${when(o.daysUntil, o.dueDate)}, ${from}${o.howToPay ? `. ${o.howToPay}` : ''}`;
  });
  const total = todo.reduce((s, o) => s + o.amount, 0);
  const overdue = todo.filter(o => o.daysUntil < 0).length;
  return [{
    key: 'pay-week', propertyId: home.id, type: 'REMINDER',
    severity: plan.totals.short > 0 || overdue ? 'ALERT' : todo.some(o => o.daysUntil <= 1) ? 'WARNING' : 'INFO',
    title: `To pay this week: ${todo.length} payment${todo.length === 1 ? '' : 's'}, ${money(total)}${overdue ? ` (${overdue} overdue)` : ''}${plan.totals.short > 0 ? ` — ${money(plan.totals.short)} short` : ''}`,
    body: lines.join('\n') + (plan.warnings.length ? `\n\n${plan.warnings.join(' ')}` : ''),
    recommendation: 'Open the pay planner (Payments) to adjust accounts or mark something sent.',
  }];
}
