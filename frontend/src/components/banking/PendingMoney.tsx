import { useState } from 'react';
import { addPendingOutflow, updatePendingOutflow, deletePendingOutflow, getPendingMoney } from '../../api/client';
import type { PendingOutflow } from '../../types';
import { fmtMoney } from '../../lib/money';
import { fmtDate, todayISO } from '../../lib/date';
import { describeApiError } from '../../lib/apiError';

/**
 * One bank account's money in flight: checks written and payments scheduled
 * that the bank hasn't taken yet, and checks deposited it hasn't credited —
 * with what the balance is once they clear. Each clears itself when the bank
 * shows the matching transaction (Sync now, or the nightly sync), and a
 * payment that is not a check also a few days after its date or once its loan
 * payment is on record (backend settlePending); Mark cleared does it by hand,
 * and Cleared lately shows what cleared and how.
 */
export function afterPending(balance: number, items: PendingOutflow[]) {
  const out = items.filter(p => p.direction !== 'IN').reduce((t, p) => t + Number(p.amount), 0);
  const inn = items.filter(p => p.direction === 'IN').reduce((t, p) => t + Number(p.amount), 0);
  return { out, in: inn, after: balance - out + inn };
}

const DAY = 86_400_000;
/** Days after its date by which the bank has surely taken it (backend settlePending); checks wait. */
const SETTLES_AFTER: Record<string, number> = { SCHEDULED: 5, TRANSFER: 5, CARD: 5, OTHER: 14 };
const KIND_LABEL: Record<string, string> = { SCHEDULED: 'Payment going out', TRANSFER: 'Transfer', CARD: 'Card payment', OTHER: 'Going out' };
const plusDays = (iso: string, n: number) => new Date(new Date(iso).getTime() + n * DAY).toISOString();

/** What a pending item is and when it goes, in words: "Check written · sent Oct 20 · 23 days, not cashed yet". */
function itemLine(p: PendingOutflow): { text: string; warn: boolean } {
  const when = p.expectedDate ?? p.createdAt;
  const days = Math.floor((Date.now() - new Date(when).getTime()) / DAY);
  if (p.direction === 'IN') return { text: `Deposit · ${fmtDate(when, 'MMM d')} · the bank usually credits it within a few days`, warn: false };
  if (p.kind === 'CHECK') {
    return days > 30
      ? { text: `Check written · sent ${fmtDate(when, 'MMM d')} · ${days} days and not cashed yet`, warn: true }
      : { text: `Check written · sent ${fmtDate(when, 'MMM d')}${days > 0 ? ` · ${days} day${days === 1 ? '' : 's'}, not cashed yet` : ''}`, warn: false };
  }
  const settles = SETTLES_AFTER[p.kind] ?? 14;
  return { text: `${KIND_LABEL[p.kind] ?? 'Going out'}${p.loan ? ` · ${p.loan.lender} loan` : ''} · ${days >= 0 ? 'went out' : 'goes out'} ${fmtDate(when, 'MMM d')} · clears on its own by ${fmtDate(plusDays(when, settles), 'MMM d')}`, warn: false };
}
const HOW_CLEARED = (by?: string | null) =>
  !by ? 'cleared' : by.startsWith('plaid:') ? 'the bank showed it' : by === 'auto:loan' ? 'the loan payment is on record' : by === 'auto:date' ? 'cleared on its own after its date' : 'marked cleared by you';

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
  const [cleared, setCleared] = useState<PendingOutflow[] | null>(null);
  const showCleared = async () => {
    if (cleared) { setCleared(null); return; }
    const all = await getPendingMoney(true).catch(() => [] as PendingOutflow[]);
    setCleared((Array.isArray(all) ? all : []).filter(p => p.cleared && p.bankAccountId === accountId && p.clearedAt && Date.now() - new Date(p.clearedAt).getTime() < 45 * DAY));
  };
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
          {items.map(p => {
            const line = itemLine(p);
            return (
              <div key={p.id} className="text-xs py-1">
                <div className="flex items-baseline gap-2">
                  <span className={`tabular-nums shrink-0 sm:w-20 ${p.direction === 'IN' ? 'text-emerald-400' : 'text-red-300'}`}>{p.direction === 'IN' ? '+' : '−'}{m(Number(p.amount))}</span>
                  <span className="text-gray-300 flex-1 min-w-0 truncate" title={p.description}>{p.description}</span>
                  <button onClick={async () => { if (confirm('Remove this pending item? It was never sent.')) { await deletePendingOutflow(p.id); onChanged(); } }} className="text-gray-600 hover:text-red-400 shrink-0" title="Remove: it was never sent" aria-label="Remove">✕</button>
                </div>
                <p className={`sm:pl-[5.5rem] ${line.warn ? 'text-amber-400/90' : 'text-gray-500'}`}>
                  {line.text} · <button onClick={async () => { await updatePendingOutflow(p.id, { cleared: true }); onChanged(); }}
                    className="text-amber-400 hover:text-amber-300 whitespace-nowrap" title="The bank has taken it (or credited it): stop holding it out of the balance">Mark cleared</button>
                </p>
              </div>
            );
          })}
          <p className="text-[11px] text-gray-500">Each clears when the bank shows it (Sync now, or overnight). Payments that aren't checks also clear on their own a few days after their date, or once the loan payment is on record; checks wait for the bank.</p>
        </div>
      )}
      {cleared && (
        <div className="mt-2 rounded-lg px-3 py-2 space-y-1" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
          {cleared.length === 0 ? <p className="text-xs text-gray-500">Nothing cleared on this account in the last 45 days.</p> : cleared.map(p => (
            <div key={p.id} className="flex items-start gap-2 text-xs">
              <span className="tabular-nums w-20 shrink-0 text-gray-500">{p.direction === 'IN' ? '+' : '−'}{m(Number(p.amount))}</span>
              <span className="flex-1 min-w-0">
                <span className="text-gray-400 block truncate" title={p.description}>{p.description}</span>
                <span className="text-gray-600 block">Cleared {fmtDate(p.clearedAt, 'MMM d')}: {HOW_CLEARED(p.clearedBy)}</span>
              </span>
              <button onClick={async () => { await updatePendingOutflow(p.id, { cleared: false }); setCleared(c => c?.filter(x => x.id !== p.id) ?? null); onChanged(); }}
                className="text-gray-500 hover:text-amber-400 shrink-0 whitespace-nowrap" title="Still not taken by the bank: hold it out of the balance again">Still pending</button>
            </div>
          ))}
        </div>
      )}
      {!adding ? (
        <div className="flex gap-4 mt-1">
          <button onClick={() => setAdding(true)} className="text-xs text-gray-500 hover:text-amber-400">+ Pending check or payment</button>
          <button onClick={() => void showCleared()} className="text-xs text-gray-500 hover:text-gray-300">{cleared ? 'Hide cleared' : 'Cleared lately'}</button>
        </div>
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
