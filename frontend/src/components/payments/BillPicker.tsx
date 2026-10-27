import { useMemo } from 'react';
import { billMonthLabel, fmtDate } from '../../lib/date';
import { computePaidMap, computeResolvedByFutureCheckpoint, openBalanceOf, deferredOf } from '../../lib/paidState';

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

/** Spread `total` across `ids` oldest-first by what each bill adds; the last takes what is left. */
export function allocateAcrossBills(statements: any[], total: number, ids: string[], payments: any[] = []): Record<string, string> {
  const chosen = statements.filter(s => ids.includes(s.id)).slice()
    .sort((a, b) => (a.statementDate ?? '').localeCompare(b.statementDate ?? ''));
  let left = Number((total || 0).toFixed(2));
  const next: Record<string, string> = {};
  chosen.forEach((s, i) => {
    const open = ownShareOf(s, statements, payments).share;
    const take = i === chosen.length - 1 ? left : Math.min(open, left);
    next[s.id] = take.toFixed(2);
    left = Number((left - take).toFixed(2));
  });
  return next;
}

/** The allocations to send, or a message saying why they cannot be. */
export function splitAllocations(value: BillPickerValue, total: number): { allocations: { statementId: string; amount: number }[] } | { error: string } {
  const allocations = Object.entries(value.alloc).map(([statementId, v]) => ({ statementId, amount: parseFloat(v) })).filter(a => a.amount > 0);
  if (allocations.length < 2) return { error: 'Pick at least two bills to split this payment across, or turn the split off.' };
  const assigned = Number(allocations.reduce((a, x) => a + x.amount, 0).toFixed(2));
  if (Math.abs(assigned - total) > 0.01) return { error: `The amounts per bill add up to ${money(assigned)}, not the ${money(total)} paid. Adjust them or use Auto-fill.` };
  return { allocations };
}

export default function BillPicker({ statements, payments, amount, value, onChange, className = '', plan = null }: {
  statements: any[];
  payments: any[];
  amount: number;
  value: BillPickerValue;
  onChange: (v: BillPickerValue) => void;
  className?: string;
  /** An active payment arrangement on the account: offered as its own choice. */
  plan?: { installment: number; agreement?: string | null } | null;
}) {
  const sorted = useMemo(() => [...statements].sort((a, b) => (b.statementDate ?? '').localeCompare(a.statementDate ?? '')).slice(0, 36), [statements]);
  const paidMap = useMemo(() => computePaidMap(sorted, payments, computeResolvedByFutureCheckpoint(sorted)), [sorted, payments]);

  if (sorted.length === 0) {
    return <p className={`text-xs text-gray-600 ${className}`}>No bills on this account yet — the payment is logged against the account alone.</p>;
  }

  // Each bill by what it adds — its own charges and any fee it charged — not
  // its total, which also carries the older bills listed below it.
  const describe = (st: any, open = false) => {
    const own = ownShareOf(st, sorted, payments);
    const figure = open
      ? `${money(own.share)}${own.fee > 0 ? ` (${money(own.charge)} + ${money(own.fee)} fee)` : ''}`
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
    </div>
  );
}
