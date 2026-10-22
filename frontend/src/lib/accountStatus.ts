/**
 * Where a utility account stands, for lists of accounts (the Utilities cards
 * on desktop and the phone list). Paid comes from accountView (paidState.ts),
 * the one paid rule; past due and due soon from the newest bill's due date.
 */
import { accountView, isUpcoming } from './paidState';

export type AccountTone = 'green' | 'red' | 'amber' | 'blue' | 'gray';

export interface AccountStatus {
  latest: any | null;
  isPaid: boolean;
  isPastDue: boolean;
  isDueSoon: boolean;
  dueDate: Date | null;
  /** The newest bill's own charge, or 0 when paid. */
  amount: number | null;
  /** Arrears still owed on top of the newest bill. */
  pastDue: number;
  /** The newest bill's penalty date, when still ahead. */
  penaltyDate: Date | null;
  label: string;
  tone: AccountTone;
}

export function accountStatus(account: { statements?: any[]; payments?: any[] }, now = new Date()): AccountStatus {
  const statements = account.statements ?? [];
  const view = accountView(statements, account.payments ?? []);
  // An installment scheduled ahead (premium financing files the whole
  // schedule) is not the newest bill: the newest that has fallen due is.
  // Once that one is paid, the card shows the next installment coming up —
  // November's in October — not the last one scheduled.
  const next = statements.filter(isUpcoming).sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())[0] ?? null;
  if (next && (!view.latest || view.isPaid)) {
    const due = new Date(next.dueDate);
    const soon = due <= new Date(now.getTime() + 7 * 86400000);
    return {
      latest: next, isPaid: false, isPastDue: false, isDueSoon: soon, dueDate: due,
      amount: next.amountDue != null ? Number(next.amountDue) : null, pastDue: 0, penaltyDate: null,
      label: `Due ${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, tone: soon ? 'amber' : 'blue',
    };
  }
  const latest = view.latest ?? statements[0] ?? null;
  const raw = latest?.rawDataJson as Record<string, unknown> | undefined;
  const dueDate = latest?.dueDate ? new Date(latest.dueDate) : null;
  // Paid wins over Past due / Due soon, so a payment the provider has not
  // posted yet does not show as overdue.
  const isPaid = !!latest && view.isPaid;
  const isPastDue = !isPaid && !!latest && (raw?.isPastDue === true || (!!dueDate && dueDate < now));
  const isDueSoon = !isPaid && !isPastDue && !!dueDate && dueDate <= new Date(now.getTime() + 7 * 86400000);
  const amount = isPaid ? 0 : latest?.amountDue != null ? Number(latest.amountDue) : null;
  const pastDue = isPaid ? 0 : view.pastDue;
  const pen = latest?.penaltyDate ? new Date(latest.penaltyDate) : null;

  let label = '—', tone: AccountTone = 'gray';
  if (!latest) { label = 'No data'; tone = 'gray'; }
  else if (isPaid) { label = 'Paid'; tone = 'green'; }
  else if (isPastDue) { label = 'Past due'; tone = 'red'; }
  else if (isDueSoon) { label = 'Due soon'; tone = 'amber'; }
  else if (dueDate) { label = `Due ${dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`; tone = 'blue'; }
  else { label = 'Unpaid'; tone = 'amber'; }

  return { latest, isPaid, isPastDue, isDueSoon, dueDate, amount, pastDue, penaltyDate: !isPaid && pen && pen >= now ? pen : null, label, tone };
}
