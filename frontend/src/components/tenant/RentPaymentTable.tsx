import { useState } from 'react';
import { updateRentPayment, deleteRentPayment } from '../../api/client';
import type { RentPayment, RentPaymentMethod } from '../../types';
import { RENT_PAYMENT_METHOD_LABELS } from '../../types';
import { fmtDate } from '../../lib/date';

/**
 * Logged rent payments with Edit on each row — the same table under a rent
 * row (Finances → Income → Rent) and on the tenant's page, so a payment can
 * be corrected wherever it is looked at.
 */
const money = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export default function RentPaymentTable({ payments, onEdited }: {
  payments: RentPayment[];
  /** A payment was changed or deleted: reload whatever shows it. */
  onEdited: () => void;
}) {
  const monthOf = (iso: string) => fmtDate(iso, 'MMM yyyy');
  const day = (iso: string) => fmtDate(iso, 'MMM d, yyyy');
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <table className="text-xs w-full max-w-5xl">
      <thead>
        <tr className="text-gray-500">
          <th className="text-left pb-1 font-normal">For month</th>
          <th className="text-left pb-1 font-normal">Paid on</th>
          <th className="text-right pb-1 font-normal">Amount</th>
          <th className="text-right pb-1 font-normal">To arrears</th>
          <th className="text-left pb-1 pl-4 font-normal">Method</th>
          <th className="text-left pb-1 pl-4 font-normal">Status</th>
          <th className="text-left pb-1 pl-4 font-normal">Notes</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {payments.map(p => editing === p.id ? (
          <PaymentEditRow key={p.id} payment={p} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onEdited(); }} />
        ) : (
          <tr key={p.id} className="border-t border-white/5">
            <td className="py-1 text-gray-200">{monthOf(p.periodDate)}</td>
            <td className="py-1 text-gray-400">{day(p.paidDate)}</td>
            <td className="py-1 text-right text-emerald-500 font-mono">{money(Number(p.amount))}</td>
            <td className="py-1 text-right text-gray-500 font-mono">{Number(p.appliedToArrears) > 0 ? money(Number(p.appliedToArrears)) : '—'}</td>
            <td className="py-1 pl-4 text-gray-400">{RENT_PAYMENT_METHOD_LABELS[p.method] ?? p.method}</td>
            <td className={`py-1 pl-4 ${p.status === 'RECEIVED' ? 'text-emerald-500' : 'text-amber-500'}`}>{p.status === 'RECEIVED' ? 'received' : 'pending'}</td>
            <td className="py-1 pl-4 text-gray-500 truncate max-w-[200px]">{p.notes || ''}</td>
            <td className="py-1 pl-4 text-right"><button onClick={() => setEditing(p.id)} className="text-gray-500 hover:text-amber-400">Edit</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One logged payment opened for correction: month, date, amount, where it
 *  goes, method, status and notes. The server re-splits current rent and
 *  arrears on save, and puts back what a deleted payment took off arrears. */
function PaymentEditRow({ payment: p, onCancel, onSaved }: { payment: RentPayment; onCancel: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    month: p.periodDate.slice(0, 7),
    paidDate: p.paidDate.slice(0, 10),
    amount: String(Number(p.amount)),
    applyTo: (p.applyTo ?? (Number(p.appliedToArrears) > 0 && Number(p.appliedToArrears) >= Number(p.amount) ? 'ARREARS' : 'CURRENT')) as 'CURRENT' | 'ARREARS',
    method: p.method as RentPaymentMethod,
    status: p.status as 'PENDING' | 'RECEIVED',
    notes: p.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF(x => ({ ...x, [k]: e.target.value }));
  const input = 'input-dark text-xs py-1 px-1.5';

  async function save() {
    const amount = parseFloat(f.amount);
    if (!(amount > 0)) { setErr('Enter an amount greater than zero.'); return; }
    if (!/^\d{4}-\d{2}$/.test(f.month) || !f.paidDate) { setErr('Pick the month and the date paid.'); return; }
    setBusy(true); setErr(null);
    try {
      await updateRentPayment(p.id, {
        periodDate: `${f.month}-01`, paidDate: f.paidDate, amount, applyTo: f.applyTo,
        method: f.method, status: f.status, notes: f.notes || null,
      });
      onSaved();
    } catch (e: any) { setErr(e?.response?.data?.error ?? 'Could not save that payment.'); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm(`Delete this ${money(Number(p.amount))} payment? Anything it paid toward arrears goes back on the balance.`)) return;
    setBusy(true); setErr(null);
    try { await deleteRentPayment(p.id); onSaved(); }
    catch (e: any) { setErr(e?.response?.data?.error ?? 'Could not delete that payment.'); setBusy(false); }
  }

  return (
    <tr className="border-t border-white/5 align-top" style={{ background: 'rgba(245,166,35,0.04)' }}>
      <td className="py-1.5 pr-2"><input type="month" value={f.month} onChange={set('month')} className={`${input} w-32`} /></td>
      <td className="py-1.5 pr-2"><input type="date" value={f.paidDate} onChange={set('paidDate')} className={`${input} w-32`} /></td>
      <td className="py-1.5 pr-2 text-right"><input type="number" step="0.01" min="0" value={f.amount} onChange={set('amount')} className={`${input} w-20 text-right`} /></td>
      <td className="py-1.5 pr-2 text-right">
        <select value={f.applyTo} onChange={set('applyTo')} className={input} title="Where the payment goes first">
          <option value="CURRENT">Month first</option>
          <option value="ARREARS">Arrears first</option>
        </select>
      </td>
      <td className="py-1.5 pl-4">
        <select value={f.method} onChange={set('method')} className={`${input} w-28`}>
          {Object.entries(RENT_PAYMENT_METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </td>
      <td className="py-1.5 pl-4">
        <select value={f.status} onChange={set('status')} className={input}>
          <option value="RECEIVED">received</option>
          <option value="PENDING">pending</option>
        </select>
      </td>
      <td className="py-1.5 pl-4"><input value={f.notes} onChange={set('notes')} placeholder="Notes" className={`${input} w-full min-w-[120px]`} /></td>
      <td className="py-1.5 pl-4 text-right whitespace-nowrap">
        <button onClick={save} disabled={busy} className="text-amber-400 hover:text-amber-300 disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        <button onClick={onCancel} disabled={busy} className="text-gray-500 hover:text-gray-300 ml-2">Cancel</button>
        <button onClick={remove} disabled={busy} className="text-red-400 hover:text-red-300 ml-2">Delete</button>
        {err && <div className="text-red-400 mt-1 whitespace-normal">{err}</div>}
      </td>
    </tr>
  );
}

