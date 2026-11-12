import { db } from '../config/db';
import { websiteFor } from './providerDirectory';
import { getPaymentPriorities } from '../services/paymentPriority';
import { dueBy } from './loanStart';

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
  remaining: number;            // spendable − assigned + what is moved into it
  shortBy: number;              // how far the payments planned from it go past what it can spare
  madeUp: number;               // what deposits and transfers bring in toward that
  stillShort: number;           // what nothing could make up
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
  /** How this one gets paid: method, where a check goes, the lender's account. */
  howToPay: string | null;
  payUrl: string | null;
}

/** Money that is not in a bank account yet: cash, checks on hand, payment-app balances (Cash, checks & apps). */
export interface PlanFund { label: string; amount: number; detail: string | null; asOf: string | null }
/**
 * Money moved into an account: a DEPOSIT of cash, checks on hand or an app balance, or — only for what
 * those cannot cover — a TRANSFER from another account (fromAccountId) that has it to spare.
 */
export interface PlanDeposit {
  kind: 'DEPOSIT' | 'TRANSFER'; from: string; fromAccountId: string | null; amount: number; intoAccountId: string; into: string; why: string;
  /** Making up an account that is short (false: the rest of the checks on hand, deposited anyway). */
  makeUp: boolean;
}

export interface PayPlan {
  asOf: string;
  horizonDays: number;
  cushion: number;
  accounts: PlanAccount[];
  obligations: PlanObligation[];
  /** Cash, checks on hand and app balances — paid into an account before they can pay a lender. */
  funds: PlanFund[];
  /** Making up an account that is short (deposits first, a transfer only for the rest), and checks on hand to deposit. */
  deposits: PlanDeposit[];
  totals: {
    due: number;                // everything still to pay in the window
    sent: number;               // already committed (pending outflows tied to a loan)
    spendable: number;
    afterPlan: number;          // spendable − due
    short: number;              // what could not be covered
  };
  warnings: string[];
}

// Accounts a payment is drawn from. Cash and app balances (CASH_POOL, and the wallets on Cash, checks &
// apps) are not: a lender takes a check, a transfer or a card, so they are money to deposit first (funds).
const SPENDABLE_TYPES = new Set(['CHECKING', 'SAVINGS']);
const WALLET_WORDS: [RegExp, string][] = [[/apple/i, 'APPLE_CASH'], [/cash\s*app/i, 'CASH_APP'], [/venmo/i, 'VENMO'], [/paypal/i, 'PAYPAL'], [/cash/i, 'CASH']];

/**
 * A choice the owner made for this plan ("Sample Servicing and Example Mortgage from x1111"): the payment by lender,
 * provider, property or id; the account by its last 4 digits, name or id.
 */
export interface PlanChoice { payment: string; account: string }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function matchesPayment(o: { id: string; key: string; label: string; detail: string | null }, q: string): boolean {
  const t = norm(q);
  if (!t) return false;
  if (q === o.id || q === o.key) return true;
  const hay = norm(`${o.label} ${o.detail ?? ''}`);
  return hay.includes(t) || t.split(' ').filter(w => w.length > 2).every(w => hay.includes(w));
}
export function findAccount<T extends { id: string; name: string; last4: string | null }>(accounts: T[], q: string): T | null {
  const byId = accounts.find(a => a.id === q);
  if (byId) return byId;
  const digits = (q.match(/\d{4}/g) ?? []).pop();
  if (digits) {
    const hits = accounts.filter(a => a.last4 === digits || a.name.includes(digits));
    if (hits.length === 1) return hits[0];
  }
  const t = norm(q);
  const named = accounts.filter(a => norm(a.name).includes(t));
  return named.length === 1 ? named[0] : null;
}

function nextDue(dueDay: number, from: Date): Date {
  // The next occurrence of the due day on or after `from`, in UTC.
  const y = from.getUTCFullYear(), m = from.getUTCMonth();
  const clamp = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, Math.min(dueDay, new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate())));
  const thisMonth = clamp(y, m);
  return thisMonth >= from ? thisMonth : clamp(y, m + 1);
}

const METHOD_WORDS: Record<string, string> = {
  AUTOPAY: 'autopay', ONLINE: 'pay online', CHECK: 'mail a check', ZELLE: 'Zelle', BANK_DEPOSIT: "deposit to the lender's account",
  CASH: 'cash', WIRE: 'wire', DEDUCTED: 'deducted by the broker', OTHER: 'other',
};
/** "Mail a check to 6408 Crestview Lane … · Deposit to their Chase ••7058" — from the loan's payment details. */
export function howToPay(l: { paymentMethods?: string[]; paymentInstructions?: string | null; mailingAddress?: string | null; payeeBankName?: string | null; payeeAccountLast4?: string | null }): string | null {
  const parts: string[] = [];
  const methods = (l.paymentMethods ?? []).map(m => METHOD_WORDS[m] ?? m.toLowerCase());
  if (methods.length) parts.push(methods.join(' or ').replace(/^./, c => c.toUpperCase()));
  if (l.mailingAddress && (l.paymentMethods ?? []).includes('CHECK')) parts.push(`to ${l.mailingAddress}`);
  if (l.payeeBankName || l.payeeAccountLast4) parts.push(`lender's account: ${[l.payeeBankName, l.payeeAccountLast4 ? `••${l.payeeAccountLast4}` : null].filter(Boolean).join(' ')}`);
  if (l.paymentInstructions && !parts.length) parts.push(l.paymentInstructions);
  return parts.length ? parts.join(' · ') : null;
}

export async function buildPayPlan(userId: string, opts: {
  horizonDays?: number; cushion?: number; includeUtilities?: boolean;
  /** Only these payments (lender, provider, property or id), e.g. this month's mortgages. */
  only?: string[];
  /** The owner's choice of account for a payment; it is followed even when it leaves the account short. */
  choices?: PlanChoice[];
} = {}): Promise<PayPlan> {
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
    // Only money going out: a deposit on its way in is not spendable until the bank has it.
    db.pendingOutflow.findMany({ where: { userId, cleared: false, direction: 'OUT' }, orderBy: { createdAt: 'asc' } }),
    db.loan.findMany({
      where: { userId, isActive: true },
      include: {
        property: { select: { id: true, address: true, nickname: true } },
        loanPayments: { where: { OR: [{ date: { gte: lookback } }, { periodDate: { gte: lookback } }] }, select: { date: true, periodDate: true, status: true, amount: true } },
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
        assigned: 0, remaining: r2(base - pendingTotal - cushion), shortBy: 0, madeUp: 0, stillShort: 0,
      };
    });
  for (const a of accounts) {
    if (!a.asOfDate) warnings.push(`${a.name} has no balance on file — record one before trusting this plan.`);
    else if (a.stale) warnings.push(`${a.name}'s balance is from ${a.asOfDate.slice(0, 10)}; update it if anything has moved since.`);
  }

  // ── Funds: cash, checks on hand, app balances ──────────────────────────
  // From Cash, checks & apps (kept current as rent comes in and money moves); a
  // manual cash or app account (CASH_POOL) only where no wallet of its kind has a balance.
  const funds: PlanFund[] = [];
  const walletKinds = new Set<string>();
  try {
    const { walletReport } = await import('../services/wallets');
    const rep = await walletReport(userId);
    for (const w of rep.wallets as any[]) {
      if (w.kind === 'CHECK') {
        const onHand = (w.onHand ?? []) as { amount: number; from?: string | null; payer?: string | null }[];
        const total = r2(onHand.reduce((t, c) => t + Number(c.amount), 0));
        if (total > 0.005) { funds.push({ label: 'Checks on hand', amount: total, detail: `${onHand.length} check${onHand.length === 1 ? '' : 's'} not deposited yet`, asOf: today.toISOString() }); walletKinds.add('CHECK'); }
        continue;
      }
      if (Math.abs(Number(w.balance)) > 0.005 || (w.entries ?? []).length) walletKinds.add(w.kind);
      if (Number(w.balance) > 0.005) funds.push({ label: w.label, amount: r2(Number(w.balance)), detail: null, asOf: today.toISOString() });
    }
  } catch { /* wallets not set up */ }
  for (const a of rawAccounts.filter(x => x.accountType === 'CASH_POOL')) {
    const kind = WALLET_WORDS.find(([re]) => re.test(a.name))?.[1] ?? null;
    const snap = a.balances[0];
    if (kind && walletKinds.has(kind)) {
      warnings.push(`${a.name} (a balance entered by hand${snap ? ` on ${snap.asOfDate.toISOString().slice(0, 10)}` : ''}) is left out: Cash, checks & apps keeps the current figure.`);
      continue;
    }
    if (snap && Number(snap.balance) > 0.005) funds.push({ label: a.name, amount: r2(Number(snap.balance)), detail: 'entered by hand', asOf: snap.asOfDate.toISOString() });
  }

  // ── Obligations: loans ──────────────────────────────────────────────────
  const obligations: PlanObligation[] = [];
  // Sent toward a loan, by the month it pays: September's payment still in flight is not October's.
  const sentByLoan = new Map<string, number>();
  const sentKey = (loanId: string, d: Date) => `${loanId}:${d.toISOString().slice(0, 7)}`;
  for (const p of pending) if (p.loanId) {
    const k = sentKey(p.loanId, p.expectedDate ?? p.createdAt);
    sentByLoan.set(k, (sentByLoan.get(k) ?? 0) + Number(p.amount));
  }

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
      if (!dueBy(loan, d.toISOString().slice(0, 7))) return false;
      const mStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      const mEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      // A payment covers the month it says it covers; without one, the month it was paid in.
      const paid = loan.loanPayments.some(lp => { const t = (lp.periodDate ?? lp.date).getTime(); return lp.status !== 'UNPAID' && t >= mStart && t < mEnd; });
      return !paid;
    });
    if (!due) continue;
    const daysUntil = Math.round((due.getTime() - today.getTime()) / DAY);
    const sent = sentByLoan.get(sentKey(loan.id, due)) ?? 0;
    const property = loan.property ? (loan.property.nickname || loan.property.address) : null;
    obligations.push({
      key: `loan:${loan.id}`, kind: 'LOAN', id: loan.id,
      label: loan.lender, detail: property, propertyId: loan.property?.id ?? null,
      amount, dueDate: due.toISOString(), daysUntil,
      status: sent >= amount - 0.005 ? 'SENT' : 'DUE',
      preferredAccountId: loan.payFromBankAccountId ?? null,
      payFrom: [], reason: sent >= amount - 0.005 ? 'Already sent — waiting to clear' : '',
      link: `/loans/${loan.id}`,
      howToPay: howToPay(loan), payUrl: loan.paymentUrl ?? null,
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
      // Where each account is paid online: the saved page, else the provider directory.
      const sites = new Map((await db.utilityAccount.findMany({
        where: { id: { in: priorities.map(p => p.accountId) } },
        select: { id: true, providerName: true, providerSlug: true, loginUrl: true },
      })).map(a => [a.id, websiteFor(a)?.url ?? null]));
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
          payFrom: [], reason: '', link: `/properties/${p.propertyId}/utilities/${p.accountId}`, howToPay: null, payUrl: sites.get(p.accountId) ?? null,
        });
      }
    } catch {
      warnings.push('Utility bills could not be loaded; only loans are planned.');
    }
  }

  // Only the payments asked about (the rest are left out of the plan entirely).
  const only = (opts.only ?? []).map(q => q.trim()).filter(Boolean);
  if (only.length) {
    const keep = obligations.filter(o => only.some(q => matchesPayment(o, q)));
    for (const q of only) if (!obligations.some(o => matchesPayment(o, q))) warnings.push(`Nothing due in the next ${horizonDays} days matches "${q}".`);
    obligations.splice(0, obligations.length, ...keep);
  }
  // The owner's choices: that account, whatever it leaves.
  const chosen = new Map<string, string>();
  for (const c of opts.choices ?? []) {
    const acct = findAccount(accounts, c.account);
    if (!acct) { warnings.push(`No one checking or savings account matches "${c.account}".`); continue; }
    const hits = obligations.filter(o => matchesPayment(o, c.payment));
    if (!hits.length) warnings.push(`No payment in the plan matches "${c.payment}".`);
    for (const o of hits) chosen.set(o.key, acct.id);
  }

  // ── Allocation ──────────────────────────────────────────────────────────
  // Each payment comes out of one account, never split across accounts. The owner's choices
  // are fixed; the rest are placed by placeOneEach to leave the least to make up.
  obligations.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.amount - a.amount);
  const byId = new Map(accounts.map(a => [a.id, a]));
  const open = obligations.filter(o => o.status !== 'SENT');
  const put = (o: PlanObligation, a: PlanAccount) => {
    a.assigned = r2(a.assigned + o.amount); a.remaining = r2(a.remaining - o.amount);
    o.payFrom = [{ accountId: a.id, amount: o.amount }];
  };
  for (const o of open) { const id = chosen.get(o.key); if (id) put(o, byId.get(id)!); }
  const free = open.filter(o => !chosen.has(o.key)).sort((a, b) => b.amount - a.amount || a.dueDate.localeCompare(b.dueDate));
  if (accounts.length) {
    const idx = new Map(accounts.map((a, i) => [a.id, i]));
    const pick = placeOneEach(free.map(o => ({ amount: o.amount, usual: o.preferredAccountId ? idx.get(o.preferredAccountId) ?? -1 : -1 })), accounts.map(a => a.remaining));
    free.forEach((o, i) => put(o, accounts[pick[i]]));
  }
  const due = r2(open.reduce((s, o) => s + o.amount, 0));
  const sent = r2(obligations.filter(o => o.status === 'SENT').reduce((s, o) => s + o.amount, 0));
  const spendable = r2(accounts.reduce((s, a) => s + a.spendable, 0));
  if (accounts.length === 0) warnings.push('No checking or savings accounts are set up. Add them under Settings → Banking.');

  // ── Making up an account that is short ───────────────────────────────────
  // What its payments go past what it can spare: cash, checks on hand and app balances are
  // deposited into it first (checks, then cash, then apps); a transfer from another account
  // only for what those cannot cover — from the one with the most to spare after its own
  // payments, in one transfer when one account can cover it.
  const deposits: PlanDeposit[] = [];
  const order = (l: string) => (l === 'Checks on hand' ? 0 : /^cash$/i.test(l) ? 1 : 2);
  const pool = funds.map(f => ({ ...f, left: f.amount })).sort((a, b) => order(a.label) - order(b.label));
  const draw = (need: number, into: PlanAccount, why: string, from = pool, makeUp = true) => {
    for (const f of from) {
      if (need <= 0.005) break;
      if (f.left <= 0.005) continue;
      const take = r2(Math.min(f.left, need));
      f.left = r2(f.left - take); need = r2(need - take);
      into.remaining = r2(into.remaining + take);
      deposits.push({ kind: 'DEPOSIT', from: f.label, fromAccountId: null, amount: take, intoAccountId: into.id, into: into.name, why, makeUp });
    }
    return need;
  };
  const paysFrom = (a: PlanAccount) => open.filter(o => o.payFrom[0]?.accountId === a.id);
  const firstDue = (a: PlanAccount) => paysFrom(a)[0]?.dueDate ?? '';
  let short = 0;
  for (const a of accounts.filter(x => x.remaining < -0.005).sort((x, y) => firstDue(x).localeCompare(firstDue(y)))) {
    a.shortBy = r2(-a.remaining);
    const what = paysFrom(a).map(o => o.label).join(', ');
    const why = `${a.name} is ${money2(a.shortBy)} short for ${what}`;
    let need = draw(a.shortBy, a, why);
    if (need > 0.005) {
      const donors = accounts.filter(d => d !== a && d.remaining > 0.005).sort((x, y) => y.remaining - x.remaining);
      for (const d of donors) {
        if (need <= 0.005) break;
        const take = r2(Math.min(d.remaining, need));
        d.remaining = r2(d.remaining - take); a.remaining = r2(a.remaining + take); need = r2(need - take);
        deposits.push({ kind: 'TRANSFER', from: d.name, fromAccountId: d.id, amount: take, intoAccountId: a.id, into: a.name, why: `${why}; deposits don't cover it — ${d.name} has ${money2(d.remaining)} to spare after this`, makeUp: true });
      }
    }
    a.madeUp = r2(a.shortBy - need);
    if (need > 0.005) {
      a.stillShort = need; short = r2(short + need);
      // The payments that run past what the account has, latest due first.
      let room = r2(a.spendable + a.madeUp);
      for (const o of paysFrom(a)) { room = r2(room - o.amount); if (room < -0.005) o.status = 'SHORT'; }
    }
  }
  // ── Why each payment comes from where it does ────────────────────────────
  const moves = (a: PlanAccount) => deposits.filter(d => d.intoAccountId === a.id && d.makeUp)
    .map(d => moveWords(d));
  for (const o of open) {
    const a = o.payFrom[0] ? byId.get(o.payFrom[0].accountId) : undefined;
    if (!a) { o.status = 'SHORT'; short = r2(short + o.amount); o.reason = 'No checking or savings account to pay it from'; continue; }
    const pref = o.preferredAccountId ? byId.get(o.preferredAccountId) : undefined;
    const base = chosen.has(o.key) ? 'Your choice'
      : pref?.id === a.id ? (o.kind === 'LOAN' ? 'Usual account' : 'Paid from here last time')
      : pref ? `${pref.name}, the usual account, would come up short with the rest planned from it`
      : 'Fits best with everything else due';
    if (!a.shortBy) { o.reason = `${base} · ${money(a.remaining)} left in ${a.name} after`; continue; }
    const fix = moves(a);
    o.reason = `${base} — ${a.name} is ${money2(a.shortBy)} short for its payments${fix.length ? `: ${fix.join(', then ')}` : ''}${a.stillShort ? `; still ${money2(a.stillShort)} short with nothing left to move` : ''}`;
  }
  for (const a of accounts.filter(x => x.shortBy)) {
    const fix = moves(a);
    warnings.push(`${a.name} is ${money2(a.shortBy)} short for what is planned from it${fix.length ? ` — ${fix.join(', then ')}` : ''}${a.stillShort ? `; still ${money2(a.stillShort)} short` : ''}.`);
  }
  const lowest = [...accounts].sort((x, y) => x.remaining - y.remaining)[0];
  const checks = pool.find(f => f.label === 'Checks on hand' && f.left > 0.005);
  // Checks are deposited anyway: into the account left lowest. Cash and app balances are only suggested where needed.
  if (lowest && checks) draw(checks.left, lowest, `checks on hand — ${lowest.name} is left lowest after these payments`, [checks], false);

  return {
    asOf: now.toISOString(),
    horizonDays, cushion,
    accounts, obligations, funds, deposits,
    totals: { due, sent, spendable, afterPlan: r2(spendable - due), short },
    warnings,
  };
}

/**
 * Which account pays each payment, one account each (no splitting): `items` are the payments
 * (amount, and the index of their usual account or -1), `room` what each account can still spare.
 * Returns an account index per payment. Best is, in order: the least in total to make up (what
 * accounts go past what they can spare), in the fewest accounts, the most payments on their usual
 * account, and the most left in the account left lowest. It searches every placement (the first
 * tried is the plain one — usual account when it fits, else the most room) and gives up improving
 * after `budget` steps on a very large plan.
 */
export function placeOneEach(items: { amount: number; usual: number }[], room: number[], budget = 200_000): number[] {
  const n = items.length;
  const rem = room.map(r2);
  const pick = new Array<number>(n).fill(0);
  let best: number[] | null = null;
  let bestScore: number[] | null = null;
  let steps = 0;
  const over = (r: number) => (r < -0.005 ? -r : 0);
  const score = (): number[] => {
    let total = 0, places = 0, lowest = Infinity;
    for (const r of rem) { total += over(r); if (r < -0.005) places++; lowest = Math.min(lowest, r); }
    let offUsual = 0;
    for (let i = 0; i < n; i++) if (items[i].usual >= 0 && pick[i] !== items[i].usual) offUsual++;
    return [Math.round(total * 100), places, offUsual, -Math.round(lowest * 100)];
  };
  const better = (s: number[], t: number[]) => { for (let i = 0; i < s.length; i++) if (s[i] !== t[i]) return s[i] < t[i]; return false; };
  const walk = (i: number, total: number) => {
    if (best && steps >= budget) return;
    steps++;
    if (i === n) {
      const s = score();
      if (!bestScore || better(s, bestScore)) { bestScore = s; best = [...pick]; }
      return;
    }
    const it = items[i];
    const tryOrder = [...rem.keys()].sort((a, b) => rem[b] - rem[a]);
    if (it.usual >= 0 && it.usual < rem.length && rem[it.usual] >= it.amount - 0.005) tryOrder.unshift(...tryOrder.splice(tryOrder.indexOf(it.usual), 1));
    for (const a of tryOrder) {
      const before = rem[a], after = r2(before - it.amount);
      const t = total + over(after) - over(before);
      if (bestScore && Math.round(t * 100) > bestScore[0]) continue;   // already more to make up than the best found
      rem[a] = after; pick[i] = a;
      walk(i + 1, t);
      rem[a] = before;
    }
  };
  walk(0, rem.reduce((t, r) => t + over(r), 0));
  return best ?? pick;
}

/** "deposit $500.00 of checks on hand", "deposit $200.00 cash", "move $80.00 from Venmo", "transfer $300.00 from …". */
export function moveWords(d: Pick<PlanDeposit, 'kind' | 'from' | 'amount'>): string {
  if (d.kind === 'TRANSFER') return `transfer ${money2(d.amount)} from ${d.from}`;
  if (d.from === 'Checks on hand') return `deposit ${money2(d.amount)} of checks on hand`;
  if (/cash/i.test(d.from) && !/app/i.test(d.from)) return `deposit ${money2(d.amount)} cash`;
  return `move ${money2(d.amount)} from ${d.from}`;
}

function money2(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
