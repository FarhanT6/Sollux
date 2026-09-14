import { db } from '../config/db';
import { getPaymentPriorities } from '../services/paymentPriority';

/**
 * The pay planner.
 *
 * The question it answers: the payments coming due in the next few days,
 * the money actually free in each account once everything already sent is
 * taken off, and which account each payment should come from.
 *
 * "Free" money is the latest balance on file (the bank's available figure
 * when there is one) less every pending outflow on the account that has not
 * cleared, less any cushion the owner wants left untouched. Nothing here
 * moves money; it recommends, and the owner pays.
 */

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface PlanAccount {
  id: string;
  name: string;
  bank: string | null;
  last4: string | null;
  ownerLabel: string | null;
  accountType: string;
  balance: number;              // latest snapshot, ledger figure
  available: number | null;     // the bank's available figure, when known
  asOfDate: string | null;
  stale: boolean;               // snapshot older than a week
  pending: { id: string; amount: number; description: string; kind: string; expectedDate: string | null; loanId: string | null }[];
  pendingTotal: number;
  cushion: number;
  spendable: number;            // what the planner may draw on
  assigned: number;             // what the plan draws from it
  remaining: number;            // spendable − assigned
}

export interface PlanObligation {
  key: string;
  kind: 'LOAN' | 'UTILITY';
  id: string;                   // loanId or utilityAccountId
  label: string;                // lender or provider
  detail: string | null;        // property, service
  propertyId: string | null;
  amount: number;
  dueDate: string;
  daysUntil: number;            // negative = overdue
  status: 'DUE' | 'SENT' | 'SHORT';
  preferredAccountId: string | null;
  payFrom: { accountId: string; amount: number }[];
  reason: string;
  link: string;
}

export interface PayPlan {
  asOf: string;
  horizonDays: number;
  cushion: number;
  accounts: PlanAccount[];
  obligations: PlanObligation[];
  totals: {
    due: number;                // everything still to pay in the window
    sent: number;               // already committed (pending outflows tied to a loan)
    spendable: number;
    afterPlan: number;          // spendable − due
    short: number;              // what could not be covered
  };
  warnings: string[];
}

const SPENDABLE_TYPES = new Set(['CHECKING', 'SAVINGS', 'CASH_POOL']);

function nextDue(dueDay: number, from: Date): Date {
  // The next occurrence of the due day on or after `from`, in UTC.
  const y = from.getUTCFullYear(), m = from.getUTCMonth();
  const clamp = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, Math.min(dueDay, new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate())));
  const thisMonth = clamp(y, m);
  return thisMonth >= from ? thisMonth : clamp(y, m + 1);
}

export async function buildPayPlan(userId: string, opts: { horizonDays?: number; cushion?: number; includeUtilities?: boolean } = {}): Promise<PayPlan> {
  const horizonDays = Math.max(1, Math.min(90, opts.horizonDays ?? 14));
  const cushion = Math.max(0, opts.cushion ?? 0);
  const includeUtilities = opts.includeUtilities ?? true;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const horizonEnd = new Date(today.getTime() + horizonDays * DAY);
  // An item due in the last three weeks with no payment logged is still an
  // obligation; anything older is almost always a payment nobody logged and
  // would only add noise.
  const lookback = new Date(today.getTime() - 21 * DAY);
  const warnings: string[] = [];

  const [rawAccounts, pending, loans] = await Promise.all([
    db.bankAccount.findMany({
      where: { userId, isActive: true },
      include: { balances: { orderBy: { asOfDate: 'desc' }, take: 1 } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    db.pendingOutflow.findMany({ where: { userId, cleared: false }, orderBy: { createdAt: 'asc' } }),
    db.loan.findMany({
      where: { userId, isActive: true },
      include: {
        property: { select: { id: true, address: true, nickname: true } },
        loanPayments: { where: { date: { gte: lookback } }, select: { date: true, status: true, amount: true } },
      },
    }),
  ]);

  // ── Accounts ────────────────────────────────────────────────────────────
  const accounts: PlanAccount[] = rawAccounts
    .filter(a => SPENDABLE_TYPES.has(a.accountType))
    .map(a => {
      const snap = a.balances[0];
      const balance = snap ? Number(snap.balance) : 0;
      const available = snap?.available != null ? Number(snap.available) : null;
      const asOf = snap?.asOfDate ?? null;
      const stale = !asOf || (today.getTime() - asOf.getTime()) > 7 * DAY;
      const mine = pending.filter(p => p.bankAccountId === a.id).map(p => ({
        id: p.id, amount: Number(p.amount), description: p.description, kind: p.kind,
        expectedDate: p.expectedDate?.toISOString() ?? null, loanId: p.loanId ?? null,
      }));
      const pendingTotal = r2(mine.reduce((s, p) => s + p.amount, 0));
      const base = available ?? balance;
      return {
        id: a.id, name: a.name, bank: a.bank, last4: a.last4, ownerLabel: a.ownerLabel, accountType: a.accountType,
        balance: r2(balance), available, asOfDate: asOf?.toISOString() ?? null, stale,
        pending: mine, pendingTotal, cushion,
        spendable: r2(base - pendingTotal - cushion),
        assigned: 0, remaining: r2(base - pendingTotal - cushion),
      };
    });
  for (const a of accounts) {
    if (!a.asOfDate) warnings.push(`${a.name} has no balance on file — record one before trusting this plan.`);
    else if (a.stale) warnings.push(`${a.name}'s balance is from ${a.asOfDate.slice(0, 10)}; update it if anything has moved since.`);
  }

  // ── Obligations: loans ──────────────────────────────────────────────────
  const obligations: PlanObligation[] = [];
  const sentByLoan = new Map<string, number>();
  for (const p of pending) if (p.loanId) sentByLoan.set(p.loanId, (sentByLoan.get(p.loanId) ?? 0) + Number(p.amount));

  for (const loan of loans) {
    const amount = r2(Number(loan.monthlyPayment ?? 0) + Number(loan.escrowAmount ?? 0));
    if (amount <= 0) continue;
    if (loan.maturityDate && loan.maturityDate < lookback) continue;
    const dueDay = loan.dueDay ?? 1;
    // Look at this month's and next month's due dates; the first one that is
    // unpaid and inside the window (or overdue within the lookback) counts.
    const candidates = [nextDue(dueDay, lookback)];
    for (let i = 0; i < 3; i++) {
      const last = candidates[candidates.length - 1];
      candidates.push(nextDue(dueDay, new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1))));
    }
    const due = candidates.find(d => {
      if (d > horizonEnd) return false;
      if (d < lookback) return false;
      const mStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      const mEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      const paid = loan.loanPayments.some(lp => lp.status !== 'UNPAID' && lp.date.getTime() >= mStart && lp.date.getTime() < mEnd);
      return !paid;
    });
    if (!due) continue;
    const daysUntil = Math.round((due.getTime() - today.getTime()) / DAY);
    const sent = sentByLoan.get(loan.id) ?? 0;
    const property = loan.property ? (loan.property.nickname || loan.property.address) : null;
    obligations.push({
      key: `loan:${loan.id}`, kind: 'LOAN', id: loan.id,
      label: loan.lender, detail: property, propertyId: loan.property?.id ?? null,
      amount, dueDate: due.toISOString(), daysUntil,
      status: sent >= amount - 0.005 ? 'SENT' : 'DUE',
      preferredAccountId: loan.payFromBankAccountId ?? null,
      payFrom: [], reason: sent >= amount - 0.005 ? 'Already sent — waiting to clear' : '',
      link: `/loans/${loan.id}`,
    });
  }

  // ── Obligations: utility bills ──────────────────────────────────────────
  if (includeUtilities) {
    try {
      const priorities = await getPaymentPriorities(userId);
      // The account each provider was last paid from is the natural default.
      const lastPaid = await db.payment.findMany({
        where: { utilityAccount: { property: { userId } }, bankAccountId: { not: null } },
        orderBy: { paymentDate: 'desc' },
        distinct: ['utilityAccountId'],
        select: { utilityAccountId: true, bankAccountId: true },
      });
      const lastAcct = new Map(lastPaid.map(p => [p.utilityAccountId, p.bankAccountId!]));
      for (const p of priorities) {
        const amount = r2(p.payThisMonth > 0 ? p.payThisMonth : p.balanceToCurrent);
        if (amount <= 0 || !p.dueDate) continue;
        const due = new Date(p.dueDate);
        if (due > horizonEnd || due < lookback) continue;
        const daysUntil = Math.round((due.getTime() - today.getTime()) / DAY);
        obligations.push({
          key: `utility:${p.accountId}`, kind: 'UTILITY', id: p.accountId,
          label: p.providerName, detail: [p.serviceLabel, p.propertyName].filter(Boolean).join(' · ') || null,
          propertyId: p.propertyId, amount, dueDate: due.toISOString(), daysUntil,
          status: 'DUE', preferredAccountId: lastAcct.get(p.accountId) ?? null,
          payFrom: [], reason: '', link: `/properties/${p.propertyId}/utilities/${p.accountId}`,
        });
      }
    } catch {
      warnings.push('Utility bills could not be loaded; only loans are planned.');
    }
  }

  // ── Allocation ──────────────────────────────────────────────────────────
  // Soonest first, then largest, so the payment with the least slack gets
  // first pick of the money. Each payment goes to its usual account when
  // that account can carry it; otherwise to the account with the most room
  // left, so no single account is run down while another sits full. A
  // payment nothing can cover alone is split across accounts; one the
  // accounts cannot cover together is marked short.
  obligations.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.amount - a.amount);
  const byId = new Map(accounts.map(a => [a.id, a]));
  const acctName = (id: string) => byId.get(id)?.name ?? 'account';
  let short = 0;

  for (const o of obligations) {
    if (o.status === 'SENT') continue;
    const pref = o.preferredAccountId ? byId.get(o.preferredAccountId) : undefined;
    if (pref && pref.remaining >= o.amount) {
      pref.assigned = r2(pref.assigned + o.amount); pref.remaining = r2(pref.remaining - o.amount);
      o.payFrom = [{ accountId: pref.id, amount: o.amount }];
      o.reason = o.kind === 'LOAN' ? `Usual account · ${money(pref.remaining)} left after` : `Paid from here last time · ${money(pref.remaining)} left after`;
      continue;
    }
    const fits = accounts.filter(a => a.remaining >= o.amount).sort((a, b) => b.remaining - a.remaining);
    if (fits.length > 0) {
      const a = fits[0];
      a.assigned = r2(a.assigned + o.amount); a.remaining = r2(a.remaining - o.amount);
      o.payFrom = [{ accountId: a.id, amount: o.amount }];
      o.reason = pref
        ? `${pref.name} only has ${money(pref.remaining)} free — ${a.name} has the most room (${money(a.remaining)} left after)`
        : `Most room of any account · ${money(a.remaining)} left after`;
      continue;
    }
    // Split across whatever is left, biggest first.
    let need = o.amount;
    const parts: { accountId: string; amount: number }[] = [];
    for (const a of [...accounts].sort((x, y) => y.remaining - x.remaining)) {
      if (need <= 0.005) break;
      if (a.remaining <= 0.005) continue;
      const take = r2(Math.min(a.remaining, need));
      a.assigned = r2(a.assigned + take); a.remaining = r2(a.remaining - take);
      parts.push({ accountId: a.id, amount: take });
      need = r2(need - take);
    }
    o.payFrom = parts;
    if (need > 0.005) {
      o.status = 'SHORT';
      short = r2(short + need);
      o.reason = parts.length > 0
        ? `No account can cover it alone; ${parts.map(p => `${money(p.amount)} from ${acctName(p.accountId)}`).join(' + ')} still leaves ${money(need)} short`
        : `Nothing free in any account — ${money(need)} short`;
    } else {
      o.reason = `No account can cover it alone — split ${parts.map(p => `${money(p.amount)} from ${acctName(p.accountId)}`).join(' + ')}`;
    }
  }

  const due = r2(obligations.filter(o => o.status !== 'SENT').reduce((s, o) => s + o.amount, 0));
  const sent = r2(obligations.filter(o => o.status === 'SENT').reduce((s, o) => s + o.amount, 0));
  const spendable = r2(accounts.reduce((s, a) => s + a.spendable, 0));
  if (accounts.length === 0) warnings.push('No checking, savings or cash accounts are set up. Add them under Settings → Banking.');

  return {
    asOf: now.toISOString(),
    horizonDays, cushion,
    accounts, obligations,
    totals: { due, sent, spendable, afterPlan: r2(spendable - due), short },
    warnings,
  };
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
