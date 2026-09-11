import { isAfter } from 'date-fns';

/**
 * Whether a bill is paid, and what an account owes right now — one
 * answer, used by the account page, the property page's account cards and
 * the properties list alike. Three pages each had their own version and
 * disagreed: a bill the account page showed Paid still read "Past due:
 * $1,661.62" on the property card, because that card only summed payments
 * dated after the bill and knew nothing of what the payment was for.
 */

// All statement figures come from the dedicated, editable columns
// (amountDue, amountPaid, pastDueCarried, chargesExcludingFees,
// penaltiesFees) — never from rawDataJson, which is a frozen import-time
// snapshot that user edits can't change. Reading rawDataJson here is what
// made edits appear to "not stick".

// Open balance a statement is asking for: this period's charge plus any
// prior balance carried into it.
export function openBalanceOf(s: any): number | null {
  if (!s) return null;
  if (s.amountDue == null && s.pastDueCarried == null) return null;
  return Number(s.amountDue ?? 0) + Number(s.pastDueCarried ?? 0);
}

// Determine if a statement is paid, including reconciliation against payments that
// may not yet have posted on the provider's API. Sums all payments dated on/after
// the statement date; if the sum covers the open balance, treat as paid.
export function isStatementPaid(s: any, payments: any[] = [], priorSettled = false): boolean {
  // What this bill still needs: its own charge, plus what it carried in —
  // unless the bill that balance came from is already settled, in which
  // case the carried figure is stale and only the charge counts. Paying
  // the July bill's $1,661.62 in full left it Overdue because the check
  // demanded $3,210.77, half of which the prior bill had already cleared.
  // A carried credit always applies.
  const carried = s?.pastDueCarried != null ? Number(s.pastDueCarried) : 0;
  const openBalance = s == null || (s.amountDue == null && s.pastDueCarried == null)
    ? null
    : Number(s.amountDue ?? 0) + (carried < 0 ? carried : priorSettled ? 0 : carried);
  // A bill with no amount on file cannot be measured against payments, but
  // a payment made against it, or a mark-paid, still settles it.
  if (openBalance == null) {
    if (Number(s.amountPaid ?? 0) > 0) return true;
    const marker = `[marked-paid:${s.id}]`;
    return payments.some(p => typeof p.notes === 'string' && p.notes.includes(marker));
  }
  if (openBalance <= 0.01) return true;
  // amountPaid is what the bill says was received during its cycle — on most
  // layouts that is the payment that settled the PREVIOUS bill ("Payments
  // Received, Thank You"), and it says nothing about whether THIS bill was
  // paid. Treating its mere presence as "paid" stamped an account with
  // $1,042 outstanding as fully paid, row by row, because every imported
  // statement records some payment. A payment only proves this bill paid
  // when it covers this bill's own open balance.
  if (Number(s.amountPaid ?? 0) >= openBalance - 0.01) return true;
  const stmtDate = s.statementDate ? new Date(s.statementDate) : null;
  if (!stmtDate) return false;
  // A payment logged against a specific bill is that bill's alone; one
  // logged "toward Jul 2026" must not also count as paying August.
  const sumSinceStmt = payments
    .filter(p => new Date(p.paymentDate) >= stmtDate && (!p.statementId || p.statementId === s.id) && p.status !== 'FAILED' && p.status !== 'PENDING')
    .reduce((acc, p) => acc + Number(p.amount ?? 0), 0);
  return sumSinceStmt >= openBalance - 0.01;
}

// Whether an arrears balance was ever cleared, looked up across the WHOLE
// forward chain of later statements — not just the very next one. A past-due
// amount routinely takes more than one billing cycle to clear (e.g. Dec's
// balance still shows up on Jan's bill, but is gone by Feb's). Checking only
// one statement ahead meant Dec would show "Overdue" forever the moment Jan
// didn't fully clear it, even though Feb proves it eventually did.
// `statements` must be sorted newest-first (as the API already returns it).
export function computeResolvedByFutureCheckpoint(statements: any[]): Set<string> {
  const resolved = new Set<string>();
  let sawZeroCheckpoint = false;
  // Iterate newest -> oldest; sawZeroCheckpoint tracks whether any statement
  // strictly newer than the current one carried in a zero balance (its
  // pastDueCarried is 0/empty), proving the prior bill was cleared.
  for (const s of statements) {
    if (sawZeroCheckpoint) resolved.add(s.id);
    // A missing past-due figure is not evidence of a zero one — an extractor
    // that found no such line proves nothing about the balance. A bill only
    // counts as carrying in nothing when it says so: an explicit zero, or a
    // balance equal to its own charge (nothing older rolled in).
    const carried = s.pastDueCarried != null ? Number(s.pastDueCarried) : null;
    const balance = s.balance != null ? Number(s.balance) : null;
    const due = s.amountDue != null ? Number(s.amountDue) : null;
    // A credit carried in (negative) proves nothing older is owed, as a zero does.
    const provenZero = (carried != null && carried <= 0)
      || (carried == null && balance != null && due != null && Math.abs(balance - due) < 0.01);
    if (provenZero) sawZeroCheckpoint = true;
  }

  // The provider's own arrears figure also says how far back the debt
  // reaches. A newest bill carrying $191.36 past due, over bills of $95.68
  // each, accounts for exactly the two preceding cycles — so everything
  // older is settled, even though no intervening bill ever carried zero.
  // Without this, one long-running balance kept every historical bill
  // marked Overdue forever.
  //
  // For each statement that reports what it carried in, walk older bills
  // accumulating their charges: once the accumulated newer charges reach the
  // carried amount, the debt is fully attributed and every older bill is
  // resolved. Attribution is newest-debt-first, which matches how providers
  // roll balances forward.
  for (let k = 0; k < statements.length; k++) {
    const carried = statements[k].pastDueCarried != null ? Number(statements[k].pastDueCarried) : null;
    if (carried == null || carried <= 0) continue;
    let accounted = 0;
    for (let j = k + 1; j < statements.length; j++) {
      if (accounted >= carried - 0.01) {
        resolved.add(statements[j].id);
      } else {
        accounted += Number(statements[j].amountDue ?? 0);
      }
    }
  }
  return resolved;
}

/**
 * Paid state for every statement, decided oldest-first so each bill knows
 * whether the bill before it is settled. `statements` newest-first, as the
 * API returns them.
 */
export function computePaidMap(statements: any[], payments: any[], resolvedByFuture: Set<string>): Map<string, boolean> {
  const paid = new Map<string, boolean>();
  // A dollar pays one bill. Payments tied to a bill go to that bill only;
  // the rest are a pool, drawn down oldest bill first, so a payment that
  // cleared July is not counted again as clearing August.
  const counted = (p: any) => p.status !== 'FAILED' && p.status !== 'PENDING';
  const pool = payments
    .filter(p => counted(p) && !p.statementId)
    .map(p => ({ date: new Date(p.paymentDate).getTime(), left: Number(p.amount ?? 0) }))
    .sort((a, b) => a.date - b.date);
  for (let i = statements.length - 1; i >= 0; i--) {
    const s = statements[i];
    const prior = statements[i + 1];
    const priorSettled = prior ? (paid.get(prior.id) ?? false) : false;
    if (resolvedByFuture.has(s.id)) { paid.set(s.id, true); continue; }
    const carried = s?.pastDueCarried != null ? Number(s.pastDueCarried) : 0;
    if (s.amountDue == null && s.pastDueCarried == null) {
      paid.set(s.id, isStatementPaid(s, payments, priorSettled));
      continue;
    }
    const open = Number(s.amountDue ?? 0) + (carried < 0 ? carried : priorSettled ? 0 : carried);
    let need = open - Number(s.amountPaid ?? 0)
      - payments.filter(p => counted(p) && p.statementId === s.id).reduce((t, p) => t + Number(p.amount ?? 0), 0);
    const since = new Date(s.statementDate).getTime() - 86400000;
    for (const p of pool) {
      if (need <= 0.01) break;
      if (p.left <= 0 || p.date < since) continue;
      const take = Math.min(p.left, need); p.left -= take; need -= take;
    }
    paid.set(s.id, need <= 0.01);
  }
  return paid;
}

export function isEffectivelyPaid(s: any, payments: any[], resolvedByFuture: Set<string>, paidMap?: Map<string, boolean>): boolean {
  if (paidMap?.has(s.id)) return paidMap.get(s.id)!;
  return isStatementPaid(s, payments) || resolvedByFuture.has(s.id);
}

// Past due carried on a statement reflects an older unpaid balance. Once the
// prior (chronologically older) statement is marked paid in Sollux, that
// carried-forward figure is stale — suppress the past-due display for it.
export function isPriorStatementPaid(current: any, all: any[], payments: any[] = [], resolvedByFuture: Set<string> = new Set(), paidMap?: Map<string, boolean>): boolean {
  const idx = all.findIndex(x => x.id === current.id);
  if (idx === -1 || idx + 1 >= all.length) return false;
  return isEffectivelyPaid(all[idx + 1], payments, resolvedByFuture, paidMap);
}

export function statementStatus(s: any, payments: any[] = [], newerStmt?: any, isLatest = false, resolvedByFuture: Set<string> = new Set(), paidMap?: Map<string, boolean>): { color: 'green' | 'amber' | 'red'; label: string } {
  if (isEffectivelyPaid(s, payments, resolvedByFuture, paidMap)) return { color: 'green', label: 'Paid' };

  if (!isLatest && newerStmt) {
    // The next bill's carried-in balance tells us whether this one was paid:
    // 0 carried in = this bill was cleared before the next was issued.
    const newerCarriedIn = Number(newerStmt.pastDueCarried ?? 0);
    const thisDue = Number(s.amountDue ?? 0);
    if (newerCarriedIn <= 0) return { color: 'green', label: 'Paid' };
    if (thisDue > 0 && newerCarriedIn >= thisDue - 0.01) {
      const pastDueDate = s.dueDate && isAfter(new Date(), new Date(s.dueDate));
      return pastDueDate ? { color: 'red', label: 'Overdue' } : { color: 'amber', label: 'Due' };
    }
    return { color: 'green', label: 'Paid' };
  }

  if (s.dueDate && isAfter(new Date(), new Date(s.dueDate))) return { color: 'red', label: 'Overdue' };
  return { color: 'amber', label: 'Due' };
}


export interface AccountView {
  latest: any | null;
  /** The newest bill is settled. */
  isPaid: boolean;
  /** The bill before the newest is settled, so its carried balance is stale. */
  priorSettled: boolean;
  /** Arrears actually still owed (0 when the prior bill is settled). */
  pastDue: number;
  /** A credit carried into the newest bill, as a positive number. */
  credit: number;
  /** The newest bill's own charge. */
  current: number;
  /** What the account owes now: 0 when paid, else charge + live arrears − credit. */
  owed: number;
}

/**
 * The account's position from its statements (newest first) and payments.
 * Works with however many statements the caller loaded; with only the
 * newest, the prior bill is treated as unsettled, as before.
 */
export function accountView(statements: any[], payments: any[] = []): AccountView {
  const sorted = [...(statements ?? [])].sort((a, b) => new Date(b.statementDate).getTime() - new Date(a.statementDate).getTime());
  const latest = sorted[0] ?? null;
  if (!latest) return { latest: null, isPaid: false, priorSettled: false, pastDue: 0, credit: 0, current: 0, owed: 0 };
  const resolved = computeResolvedByFutureCheckpoint(sorted);
  const paid = computePaidMap(sorted, payments, resolved);
  const isPaid = paid.get(latest.id) ?? false;
  const priorSettled = sorted[1] ? (paid.get(sorted[1].id) ?? false) : false;
  const carried = latest.pastDueCarried != null ? Number(latest.pastDueCarried) : 0;
  const current = Number(latest.amountDue ?? 0);
  const pastDue = carried > 0 && !priorSettled ? carried : 0;
  const credit = carried < 0 ? -carried : 0;
  const owed = isPaid ? 0 : Math.max(current + pastDue - credit, 0);
  return { latest, isPaid, priorSettled, pastDue, credit, current, owed };
}
