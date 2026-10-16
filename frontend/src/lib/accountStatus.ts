/**
 * Where a utility account stands, for lists of accounts (the Utilities cards
 * on desktop and the phone list). Paid comes from accountView (paidState.ts),
 * the one paid rule; past due and due soon from the newest bill's due date.
 */
import { accountView } from './paidState';

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
  const latest = statements[0] ?? null;
  const view = accountView(statements, account.payments ?? []);
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
