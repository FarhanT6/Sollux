import { useState } from 'react';
import { addPendingOutflow, updatePendingOutflow, deletePendingOutflow } from '../../api/client';
import type { PendingOutflow } from '../../types';
import { fmtMoney } from '../../lib/money';
import { fmtDate, todayISO } from '../../lib/date';
import { describeApiError } from '../../lib/apiError';

/**
 * One bank account's money in flight: checks written and payments scheduled
 * that the bank hasn't taken yet, and checks deposited it hasn't credited —
 * with what the balance is once they clear. Each clears itself when the bank
 * shows the matching transaction (Sync now, or the nightly sync); Cleared
 * marks one by hand.
 */
export function afterPending(balance: number, items: PendingOutflow[]) {
  const out = items.filter(p => p.direction !== 'IN').reduce((t, p) => t + Number(p.amount), 0);
  const inn = items.filter(p => p.direction === 'IN').reduce((t, p) => t + Number(p.amount), 0);
  return { out, in: inn, after: balance - out + inn };
}

const KINDS = [
  { id: 'CHECK_OUT', label: 'A check I wrote', direction: 'OUT', kind: 'CHECK', ph: 'e.g. Check #1205 to Example Trust — 514 E St' },
  { id: 'PAYMENT_OUT', label: 'A payment going out', direction: 'OUT', kind: 'SCHEDULED', ph: 'e.g. Mortgage payment scheduled on the lender site' },
  { id: 'DEPOSIT_IN', label: 'A deposit coming in', direction: 'IN', kind: 'CHECK', ph: 'e.g. Mobile deposit — 2 rent checks' },
] as const;

export default function PendingMoney({ accountId, balance, items, visible, onChanged }: {
  accountId: string; balance: number; items: PendingOutflow[]; visible: boolean; onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ type: 'CHECK_OUT' as (typeof KINDS)[number]['id'], amount: '', description: '', date: todayISO() });
  const [err, setErr] = useState('');
  const m = (n: number) => (visible ? fmtMoney(n) : '••••');
  const t = afterPending(balance, items);
  const k = KINDS.find(x => x.id === form.type)!;

  async function add() {
    const amount = Number(form.amount);
    if (!(amount > 0)) { setErr('Enter the amount.'); return; }
    if (!form.description.trim()) { setErr('Say what it is.'); return; }
    setErr('');
    try {
      await addPendingOutflow(accountId, { amount, description: form.description.trim(), kind: k.kind, direction: k.direction, expectedDate: form.date || null });
      setForm(f => ({ ...f, amount: '', description: '' })); setAdding(false); onChanged();
    } catch (e) { setErr(describeApiError(e, 'Not saved.')); }
  }

  return (
    <div className="mt-2 w-full">
      {items.length > 0 && (
        <div className="rounded-lg px-3 py-2 space-y-1" style={{ background: 'rgba(245,166,35,0.06)', border: '1px solid rgba(245,166,35,0.18)' }}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-amber-300 font-medium">Pending{t.out ? ` −${m(t.out)}` : ''}{t.in ? ` +${m(t.in)}` : ''}</span>
            <span className="text-gray-400">after it clears <span className="text-white font-semibold">{m(t.after)}</span></span>
          </div>
          {items.map(p => (
            <div key={p.id} className="flex items-center gap-2 text-xs">
              <span className={`tabular-nums w-24 shrink-0 ${p.direction === 'IN' ? 'text-emerald-400' : 'text-red-300'}`}>{p.direction === 'IN' ? '+' : '−'}{m(Number(p.amount))}</span>
              <span className="text-gray-300 flex-1 min-w-0 truncate" title={p.description}>{p.description}</span>
              <span className="text-gray-600 shrink-0">{fmtDate(p.expectedDate ?? p.createdAt, 'MMM d')}</span>
              <button onClick={async () => { await updatePendingOutflow(p.id, { cleared: true }); onChanged(); }} className="text-gray-500 hover:text-emerald-400 shrink-0" title="The bank has it now">Cleared</button>
              <button onClick={async () => { if (confirm('Remove this pending item?')) { await deletePendingOutflow(p.id); onChanged(); } }} className="text-gray-600 hover:text-red-400 shrink-0">✕</button>
            </div>
          ))}
          <p className="text-[11px] text-gray-500">Each clears on its own when the bank shows it (Sync now, or overnight).</p>
        </div>
      )}
      {!adding ? (
        <button onClick={() => setAdding(true)} className="text-xs text-gray-500 hover:text-amber-400 mt-1">+ Pending check or payment</button>
      ) : (
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
          <label className="col-span-2"><span className="block text-[11px] text-gray-500 mb-0.5">What</span>
            <select className="input-dark text-xs w-full" value={form.type} onChange={e => setForm({ ...form, type: e.target.value as typeof form.type })}>
              {KINDS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select></label>
          <label className="col-span-2 sm:col-span-4"><span className="block text-[11px] text-gray-500 mb-0.5">To / for (a check number helps it clear itself)</span>
            <input className="input-dark text-xs w-full" value={form.description} placeholder={k.ph} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
          <label><span className="block text-[11px] text-gray-500 mb-0.5">Amount</span>
            <input type="number" step="0.01" className="input-dark text-xs w-full" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></label>
          <label><span className="block text-[11px] text-gray-500 mb-0.5">{k.direction === 'IN' ? 'Deposited' : 'Sent'}</span>
            <input type="date" className="input-dark text-xs w-full" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></label>
          <div className="col-span-2 sm:col-span-4 flex gap-2">
            <button onClick={() => void add()} className="btn btn-primary text-xs">Add</button>
            <button onClick={() => { setAdding(false); setErr(''); }} className="btn text-xs">Cancel</button>
            {err && <span className="text-xs text-red-400 self-center">{err}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
