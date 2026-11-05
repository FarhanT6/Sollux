import { useMemo } from 'react';
import { billMonthLabel, fmtDate } from '../../lib/date';
import { computePaidMap, computeResolvedByFutureCheckpoint, openBalanceOf, deferredOf, owedByBillWithMarks } from '../../lib/paidState';

const money = (v: number | string | null | undefined) => `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Which bill (or bills) a payment goes toward. One bill is a dropdown; "Split
 * across several bills" turns it into a checklist with an amount per bill,
 * spread oldest-first from each bill's open balance so the last one takes
 * the remainder. The same picker on the account page and the property page.
 */
export interface BillPickerValue {
  statementId: string;
  split: boolean;
  /** statementId → amount as typed; presence is the selection. */
  alloc: Record<string, string>;
  /** Toward the account's payment arrangement (with the bill that bills its installment, if any). */
  towardPlan?: boolean;
  /** Paid more than the bills owe: what the extra is — a late fee not billed yet, or credit toward the next bill. */
  extraTo?: 'late' | 'credit' | null;
  /** The bill a late fee goes on: sent first, since a split's fees sit on its first bill. */
  feeOn?: string | null;
}

export const emptyBillPick: BillPickerValue = { statementId: '', split: false, alloc: {} };

const live = (p: any) => p.status !== 'FAILED' && p.status !== 'PENDING';

/**
 * What one bill adds to the account: its own charges, plus a fee it charged
 * on the unpaid balance before it. A bill's total also carries every older
 * unpaid bill, so splitting a payment by totals counted the same money two or
 * three times: Rincon Water's Sep bill ($756.49) carries Aug's $473.27, which
 * carries Jul's $194.22. A fee charged on the arrears (Rincon's "delinquent
 * charge", printed inside the past-due amount) is what the carried balance
 * grew by beyond the previous bill's unpaid total. Less what was already paid
 * toward this bill.
 */
export function ownShareOf(st: any, statements: any[], payments: any[] = []): { charge: number; fee: number; share: number } {
  const charge = Number(st.amountDue ?? 0) - deferredOf(st);
  const asc = [...statements].sort((a, b) => (a.statementDate ?? '').localeCompare(b.statementDate ?? ''));
  const prev = asc[asc.findIndex(x => x.id === st.id) - 1];
  let fee = 0;
  const carried = st.pastDueCarried != null ? Number(st.pastDueCarried) : 0;
  if (prev && carried > 0) {
    const from = new Date(prev.statementDate ?? 0).getTime(), to = new Date(st.statementDate ?? 0).getTime();
    const paidBetween = payments.filter(p => live(p) && new Date(p.paymentDate).getTime() > from && new Date(p.paymentDate).getTime() <= to)
      .reduce((t, p) => t + Number(p.amount ?? 0), 0);
    const prevUnpaid = Math.max(0, Number(openBalanceOf(prev) ?? prev.amountDue ?? 0) - paidBetween);
    fee = Math.max(0, Number((carried - prevUnpaid).toFixed(2)));
    if (fee > carried) fee = carried;
  }
  const paid = payments.filter(p => live(p) && p.statementId === st.id).reduce((t, p) => t + Number(p.amount ?? 0), 0);
  const share = Math.max(0, Number((charge + fee - paid).toFixed(2)));
  return { charge: Number(charge.toFixed(2)), fee, share };
}

/**
 * What a bill still owes: on a running-balance account its share of the
 * account balance (owedByBillWithMarks — the figure the statement list shows
 * as Owed now), else what it adds less what was paid toward it.
 */
export function owedOf(st: any, statements: any[], payments: any[] = []): number {
  const running = owedByBillWithMarks(statements, payments);
  if (running?.has(st.id)) return running.get(st.id)!;
  if (st.paidOverride === 'PAID') return 0;
  return ownShareOf(st, statements, payments).share;
}

/**
 * Spread `total` across `ids` oldest-first, each bill up to what it owes.
 * Money beyond what the bills owe is not quietly put on the last one: it is
 * left over (`extra`) for the owner to say what it is.
 */
export function allocateAcrossBills(statements: any[], total: number, ids: string[], payments: any[] = []): Record<string, string> {
  const chosen = statements.filter(s => ids.includes(s.id)).slice()
    .sort((a, b) => (a.statementDate ?? '').localeCompare(b.statementDate ?? ''));
  let left = Number((total || 0).toFixed(2));
  const next: Record<string, string> = {};
  chosen.forEach(s => {
    const take = Math.min(owedOf(s, statements, payments), left);
    next[s.id] = take.toFixed(2);
    left = Number((left - take).toFixed(2));
  });
  return next;
}

/** The newest of the chosen bills: where an extra (late fee or credit) goes. */
const newestOf = (statements: any[], ids: string[]) =>
  statements.filter(s => ids.includes(s.id)).sort((a, b) => (b.statementDate ?? '').localeCompare(a.statementDate ?? ''))[0];

/** The allocations to send, or a message saying why they cannot be. */
export function splitAllocations(value: BillPickerValue, total: number): { allocations: { statementId: string; amount: number }[] } | { error: string } {
  const allocations = Object.entries(value.alloc).map(([statementId, v]) => ({ statementId, amount: parseFloat(v) })).filter(a => a.amount > 0);
  // A late fee goes on the bill it was charged with: the split's fees sit on its first part.
  if (value.feeOn) allocations.sort((a, b) => (a.statementId === value.feeOn ? -1 : b.statementId === value.feeOn ? 1 : 0));
  if (allocations.length < 2) return { error: 'Pick at least two bills to split this payment across, or turn the split off.' };
  const assigned = Number(allocations.reduce((a, x) => a + x.amount, 0).toFixed(2));
  if (Math.abs(assigned - total) > 0.01) return { error: `The amounts per bill add up to ${money(assigned)}, not the ${money(total)} paid. Adjust them or use Auto-fill.` };
  return { allocations };
}

export default function BillPicker({ statements, payments, amount, value, onChange, className = '', plan = null, onLateFee }: {
  statements: any[];
  payments: any[];
  amount: number;
  value: BillPickerValue;
  onChange: (v: BillPickerValue) => void;
  className?: string;
  /** An active payment arrangement on the account: offered as its own choice. */
  plan?: { installment: number; agreement?: string | null } | null;
  /** The owner said the extra is a late fee not billed yet: the form adds it as a late fee. */
  onLateFee?: (amount: number) => void;
}) {
  const sorted = useMemo(() => [...statements].sort((a, b) => (b.statementDate ?? '').localeCompare(a.statementDate ?? '')).slice(0, 36), [statements]);
  const paidMap = useMemo(() => computePaidMap(sorted, payments, computeResolvedByFutureCheckpoint(sorted)), [sorted, payments]);

  if (sorted.length === 0) {
    return <p className={`text-xs text-gray-600 ${className}`}>No bills on this account yet — the payment is logged against the account alone.</p>;
  }

  // Each bill by what it adds — its own charges and any fee it charged — not
  // its total, which also carries the older bills listed below it.
  const running = owedByBillWithMarks(sorted, payments);
  const describe = (st: any, open = false) => {
    const own = ownShareOf(st, sorted, payments);
    // On a running balance the same Owed now the statement list shows.
    const figure = open
      ? running?.has(st.id) ? money(running.get(st.id)!) : `${money(own.share)}${own.fee > 0 ? ` (${money(own.charge)} + ${money(own.fee)} fee)` : ''}`
      : money(own.charge + own.fee);
    const inst = Number(st.paymentPlanAmount ?? 0);
    return `${billMonthLabel(st)} — ${figure}${inst > 0 ? ` (incl. ${money(inst)} arrangement installment)` : ''} · billed ${fmtDate(st.statementDate, 'MMM d')}${!open && st.dueDate ? ` · due ${fmtDate(st.dueDate, 'MMM d')}` : ''}${paidMap.get(st.id) ? ' · already paid' : ' · open'}`;
  };
  // "Toward the arrangement": the newest open bill that bills the installment
  // (SDG&E prints it inside the bill — paying that bill pays it), else no
  // bill, and the whole payment comes off the plan.
  const planBill = sorted.find(st => Number(st.paymentPlanAmount ?? 0) > 0 && !paidMap.get(st.id));
  const PLAN = '__plan__';

  if (!value.split) {
    return (
      <div className={className}>
        <select value={value.towardPlan ? PLAN : value.statementId}
          onChange={e => onChange(e.target.value === PLAN ? { ...value, statementId: planBill?.id ?? '', towardPlan: true } : { ...value, statementId: e.target.value, towardPlan: false })}
          className="input-dark text-xs w-full">
          <option value="">— Not against a specific bill —</option>
          {plan && <option value={PLAN}>Payment arrangement{plan.agreement ? ` ${plan.agreement}` : ''} — {money(plan.installment)} installment{planBill ? ` (billed on ${billMonthLabel(planBill)})` : ''}</option>}
          {sorted.map(st => <option key={st.id} value={st.id}>{describe(st)}</option>)}
        </select>
        {value.towardPlan && (
          <p className="text-xs text-sky-400 mt-1">
            {planBill ? `Pays the installment billed on ${billMonthLabel(planBill)}; the arrangement's balance follows the next bill.` : 'The whole payment comes off the arrangement\'s remaining balance.'}
          </p>
        )}
        {(() => {
          // More than the chosen bill owes: say so, and ask what the rest is.
          const st = sorted.find(s => s.id === value.statementId);
          if (!st || value.towardPlan) return null;
          const over = Number((amount - owedOf(st, sorted, payments)).toFixed(2));
          if (over <= 0.01) return null;
          return (
            <div className="text-xs mt-1 rounded-md px-2 py-1.5" style={{ background: 'rgba(245,166,35,0.08)' }}>
              <span className="text-amber-300">{money(over)} more than {billMonthLabel(st)} still owes. </span>
              {value.extraTo === 'late' ? <span className="text-gray-400">Added as a late fee on it.</span>
                : value.extraTo === 'credit' ? <span className="text-gray-400">Kept as credit toward the next bill.</span>
                : <>
                    {onLateFee && <button type="button" className="text-amber-400 hover:text-amber-300 underline mr-2" onClick={() => { onLateFee(over); onChange({ ...value, extraTo: 'late' }); }}>It's a late fee not billed yet</button>}
                    <button type="button" className="text-amber-400 hover:text-amber-300 underline mr-2" onClick={() => onChange({ ...value, extraTo: 'credit' })}>Credit toward the next bill</button>
                    {sorted.length > 1 && <span className="text-gray-500">or split it across other bills.</span>}
                  </>}
            </div>
          );
        })()}
        {sorted.length > 1 && (
          <button type="button" className="text-xs text-amber-400 hover:text-amber-300 mt-1"
            onClick={() => onChange({ statementId: '', split: true, alloc: allocateAcrossBills(sorted, amount, value.statementId ? [value.statementId] : [], payments) })}>
            Split across several bills
          </button>
        )}
      </div>
    );
  }

  const assigned = Object.values(value.alloc).reduce((a, v) => a + (parseFloat(v) || 0), 0);
  const diff = Number((amount - assigned).toFixed(2));
  const ids = Object.keys(value.alloc);
  return (
    <div className={`rounded-lg px-3 py-2 ${className}`} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs text-gray-400">Split across these bills</p>
        <div className="flex gap-3 text-xs">
          <button type="button" className="text-amber-400 hover:text-amber-300" onClick={() => onChange({ ...value, alloc: allocateAcrossBills(sorted, amount, ids, payments) })}>Auto-fill</button>
          <button type="button" className="text-gray-500 hover:text-gray-300" onClick={() => onChange({ statementId: '', split: false, alloc: {} })}>One bill instead</button>
        </div>
      </div>
      <div className="max-h-44 overflow-y-auto space-y-1">
        {sorted.map(st => {
          const checked = st.id in value.alloc;
          return (
            <label key={st.id} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={checked} className="accent-amber-500"
                onChange={e => {
                  const next = e.target.checked ? [...ids, st.id] : ids.filter(id => id !== st.id);
                  onChange({ ...value, alloc: allocateAcrossBills(sorted, amount, next, payments) });
                }} />
              <span className={`flex-1 ${paidMap.get(st.id) ? 'text-gray-500' : 'text-gray-300'}`}>{describe(st, true)}</span>
              {checked && (
                <input type="number" step="0.01" value={value.alloc[st.id] ?? ''} className="input-dark text-xs w-24 py-0.5"
                  onChange={e => onChange({ ...value, alloc: { ...value.alloc, [st.id]: e.target.value } })} />
              )}
            </label>
          );
        })}
      </div>
      <p className={`text-xs mt-1.5 ${Math.abs(diff) > 0.01 ? 'text-amber-400' : 'text-gray-500'}`}>
        {money(assigned)} of {money(amount)} assigned{Math.abs(diff) > 0.01 ? ` · ${money(Math.abs(diff))} ${diff > 0 ? 'still to assign' : 'over'}` : ''}
      </p>
      {(() => {
        // Paid more than the chosen bills owe: the owner says what the extra is.
        const owedAll = Number(sorted.filter(s => ids.includes(s.id)).reduce((t, s) => t + owedOf(s, sorted, payments), 0).toFixed(2));
        const extra = Number((amount - owedAll).toFixed(2));
        const newest = newestOf(sorted, ids);
        if (extra <= 0.01 || !newest || !(diff > 0.01)) return null;
        const put = (to: 'late' | 'credit') => {
          const alloc = { ...value.alloc, [newest.id]: ((parseFloat(value.alloc[newest.id]) || 0) + diff).toFixed(2) };
          if (to === 'late') onLateFee?.(diff);
          onChange({ ...value, alloc, extraTo: to, feeOn: to === 'late' ? newest.id : null });
        };
        return (
          <div className="text-xs mt-1.5 rounded-md px-2 py-1.5" style={{ background: 'rgba(245,166,35,0.08)' }}>
            <p className="text-amber-300 mb-1">{money(diff)} more than these bills owe ({money(owedAll)}). What is it?</p>
            {onLateFee && <button type="button" className="text-amber-400 hover:text-amber-300 underline mr-3" onClick={() => put('late')}>A late fee not billed yet (on {billMonthLabel(newest)})</button>}
            <button type="button" className="text-amber-400 hover:text-amber-300 underline" onClick={() => put('credit')}>Credit toward the next bill</button>
          </div>
        );
      })()}
      {value.extraTo && diff <= 0.01 && (
        <p className="text-xs text-gray-500 mt-1">The extra is {value.extraTo === 'late' ? 'a late fee on the newest bill' : 'credit toward the next bill'}.</p>
      )}
    </div>
  );
}
