import { useMemo } from 'react';
import { billMonthLabel, fmtDate } from '../../lib/date';
import { computePaidMap, computeResolvedByFutureCheckpoint, openBalanceOf } from '../../lib/paidState';

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
}

export const emptyBillPick: BillPickerValue = { statementId: '', split: false, alloc: {} };

/** Spread `total` across `ids` oldest-first by open balance; the last takes what is left. */
export function allocateAcrossBills(statements: any[], total: number, ids: string[]): Record<string, string> {
  const chosen = statements.filter(s => ids.includes(s.id)).slice()
    .sort((a, b) => (a.statementDate ?? '').localeCompare(b.statementDate ?? ''));
  let left = Number((total || 0).toFixed(2));
  const next: Record<string, string> = {};
  chosen.forEach((s, i) => {
    const open = Math.max(0, Number(openBalanceOf(s) ?? s.amountDue ?? 0));
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

export default function BillPicker({ statements, payments, amount, value, onChange, className = '' }: {
  statements: any[];
  payments: any[];
  amount: number;
  value: BillPickerValue;
  onChange: (v: BillPickerValue) => void;
  className?: string;
}) {
  const sorted = useMemo(() => [...statements].sort((a, b) => (b.statementDate ?? '').localeCompare(a.statementDate ?? '')).slice(0, 36), [statements]);
  const paidMap = useMemo(() => computePaidMap(sorted, payments, computeResolvedByFutureCheckpoint(sorted)), [sorted, payments]);

  if (sorted.length === 0) {
    return <p className={`text-xs text-gray-600 ${className}`}>No bills on this account yet — the payment is logged against the account alone.</p>;
  }

  const describe = (st: any, open = false) =>
    `${billMonthLabel(st)} — ${money(open ? openBalanceOf(st) ?? st.amountDue : st.amountDue)} · billed ${fmtDate(st.statementDate, 'MMM d')}${!open && st.dueDate ? ` · due ${fmtDate(st.dueDate, 'MMM d')}` : ''}${paidMap.get(st.id) ? ' · already paid' : ' · open'}`;

  if (!value.split) {
    return (
      <div className={className}>
        <select value={value.statementId} onChange={e => onChange({ ...value, statementId: e.target.value })} className="input-dark text-xs w-full">
          <option value="">— Not against a specific bill —</option>
          {sorted.map(st => <option key={st.id} value={st.id}>{describe(st)}</option>)}
        </select>
        {sorted.length > 1 && (
          <button type="button" className="text-xs text-amber-400 hover:text-amber-300 mt-1"
            onClick={() => onChange({ statementId: '', split: true, alloc: allocateAcrossBills(sorted, amount, value.statementId ? [value.statementId] : []) })}>
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
          <button type="button" className="text-amber-400 hover:text-amber-300" onClick={() => onChange({ ...value, alloc: allocateAcrossBills(sorted, amount, ids) })}>Auto-fill</button>
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
                  onChange({ ...value, alloc: allocateAcrossBills(sorted, amount, next) });
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
