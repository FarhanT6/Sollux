import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { updateRentPayment, deleteRentPayment, rentPaymentToUtilities, getBankAccounts } from '../../api/client';
import type { BankAccount, RentPayment, RentPaymentMethod } from '../../types';
import { RENT_PAYMENT_METHOD_LABELS, BANK_LINKED_METHODS, creditLabel } from '../../types';
import { fmtDate } from '../../lib/date';
import { bankAccountLabel } from '../../lib/bankAccountLabel';
import { WALLET_PAGE } from '../../lib/moneyPicture';

/**
 * Logged rent payments with Edit on each row — the same table under a rent
 * row (Finances → Income → Rent) and on the tenant's page, so a payment can
 * be corrected wherever it is looked at.
 */
const money = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/** Rent paid this way stays in that wallet (Cash, checks & apps) until it is moved. */
const WALLET_OF: Partial<Record<RentPaymentMethod, string>> = { CASH: 'Cash on hand', VENMO: 'Venmo', CASH_APP: 'Cash App', PAYPAL: 'PayPal', APPLE_CASH: 'Apple Cash' };
const ON_HAND = new Set<RentPaymentMethod>(['CHECK', 'MONEY_ORDER']);

/** Where the money went: the bank account it was deposited into, the wallet it sits in, or a check still on hand. */
function DepositedTo({ p }: { p: RentPayment }) {
  if (p.method === 'CREDIT') return <span className="text-gray-600">—</span>;
  const deposited = p.depositedAt;
  if (p.bankAccount) {
    const day = deposited && deposited.slice(0, 10) !== String(p.paidDate).slice(0, 10) ? ` · ${fmtDate(deposited, 'MMM d')}` : '';
    return <span className="text-gray-300" title={bankAccountLabel(p.bankAccount)}>{bankAccountLabel(p.bankAccount)}{day}</span>;
  }
  if (ON_HAND.has(p.method) && p.status === 'RECEIVED') {
    return <Link to={WALLET_PAGE} className="text-amber-400 hover:underline" title="Mark it deposited under Cash, checks & apps → Checks, or pick the account with Edit">On hand — not deposited</Link>;
  }
  const wallet = WALLET_OF[p.method];
  if (wallet) return <Link to={WALLET_PAGE} className="text-gray-400 hover:underline">{wallet}</Link>;
  return <span className="text-gray-600" title="Edit to say which account it went into">Not recorded</span>;
}

// The owner's bank accounts, loaded once for the account picker.
let accountsOnce: Promise<BankAccount[]> | null = null;
const loadAccounts = () => (accountsOnce ??= getBankAccounts().then(a => a.filter(x => x.accountType !== 'CREDIT_CARD')).catch(() => { accountsOnce = null; return []; }));

export default function RentPaymentTable({ payments, onEdited }: {
  payments: RentPayment[];
  /** A payment was changed or deleted: reload whatever shows it. */
  onEdited: () => void;
}) {
  const monthOf = (iso: string) => fmtDate(iso, 'MMM yyyy');
  const day = (iso: string) => fmtDate(iso, 'MMM d, yyyy');
  const [editing, setEditing] = useState<string | null>(null);
  // Newest first by the day paid; two payments the same day show the later
  // month on top (August above July), then the one logged last.
  const rows = [...payments].sort((a, b) =>
    String(b.paidDate).slice(0, 10).localeCompare(String(a.paidDate).slice(0, 10))
    || String(b.periodDate).slice(0, 10).localeCompare(String(a.periodDate).slice(0, 10))
    || String((b as any).createdAt ?? '').localeCompare(String((a as any).createdAt ?? '')));
  return (
    <table className="text-xs w-full max-w-5xl">
      <thead>
        <tr className="text-gray-500">
          <th className="text-left pb-1 font-normal">For month</th>
          <th className="text-left pb-1 font-normal">Paid on</th>
          <th className="text-right pb-1 font-normal">Amount</th>
          <th className="text-right pb-1 font-normal">To arrears</th>
          <th className="text-left pb-1 pl-4 font-normal">Method</th>
          <th className="text-left pb-1 pl-4 font-normal">Deposited to</th>
          <th className="text-left pb-1 pl-4 font-normal">Status</th>
          <th className="text-left pb-1 pl-4 font-normal">Notes</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map(p => editing === p.id ? (
          <PaymentEditRow key={p.id} payment={p} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onEdited(); }} />
        ) : (
          <tr key={p.id} className="border-t border-white/5">
            <td className="py-1 text-gray-200">{monthOf(p.periodDate)}</td>
            <td className="py-1 text-gray-400">{day(p.paidDate)}</td>
            <td className="py-1 text-right text-emerald-500 font-mono">{money(Number(p.amount))}</td>
            <td className="py-1 text-right text-gray-500 font-mono">{p.applyTo === 'HISTORY' ? <span className="font-sans" title="Logged for the record; back rent was left as it is">record only</span> : Number(p.appliedToArrears) > 0 ? money(Number(p.appliedToArrears)) : '—'}</td>
            <td className="py-1 pl-4 text-gray-400">{p.method === 'CREDIT' ? <span className="text-sky-300" title="A credit toward rent — no money received">Credit · {creditLabel(p.creditFor)}</span> : RENT_PAYMENT_METHOD_LABELS[p.method] ?? p.method}</td>
            <td className="py-1 pl-4 max-w-[220px] truncate"><DepositedTo p={p} /></td>
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
    bankAccountId: p.bankAccountId ?? '',
  });
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  useEffect(() => { void loadAccounts().then(setAccounts); }, []);
  const bankLinked = BANK_LINKED_METHODS.includes(f.method);
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
      // The account only when it changed (a method that does not go to a bank has none).
      const account = bankLinked ? f.bankAccountId || null : null;
      await updateRentPayment(p.id, {
        periodDate: `${f.month}-01`, paidDate: f.paidDate, amount, applyTo: f.applyTo,
        method: f.method, status: f.status, notes: f.notes || null,
        ...(account !== (p.bankAccountId ?? null) ? { bankAccountId: account } : {}),
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

  async function toUtilities() {
    if (!confirm(`Was this ${money(Number(p.amount))} the tenant paying utilities back? It comes off the rent and is recorded as a utility payment.`)) return;
    setBusy(true); setErr(null);
    try { await rentPaymentToUtilities(p.id); onSaved(); }
    catch (e: any) { setErr(e?.response?.data?.error ?? 'Could not move that payment.'); setBusy(false); }
  }

  const tint = { background: 'rgba(245,166,35,0.04)' };
  return (
    <>
    <tr className="border-t border-white/5 align-top" style={tint}>
      <td className="py-1.5 pr-2"><input type="month" value={f.month} onChange={set('month')} className={`${input} w-32`} /></td>
      <td className="py-1.5 pr-2"><input type="date" value={f.paidDate} onChange={set('paidDate')} className={`${input} w-32`} /></td>
      <td className="py-1.5 pr-2 text-right"><input type="number" step="0.01" min="0" value={f.amount} onChange={set('amount')} className={`${input} w-20 text-right`} /></td>
      <td className="py-1.5 pr-2 text-right">
        <select value={f.applyTo} onChange={set('applyTo')} className={input} title="Where the payment goes first">
          <option value="CURRENT">Month first</option>
          <option value="ARREARS">Arrears first</option>
          <option value="HISTORY">Record only</option>
        </select>
      </td>
      <td className="py-1.5 pl-4">
        <select value={f.method} onChange={set('method')} className={`${input} w-28`}>
          {Object.entries(RENT_PAYMENT_METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </td>
      <td className="py-1.5 pl-4">
        {bankLinked ? (
          <select value={f.bankAccountId} onChange={set('bankAccountId')} className={`${input} w-32`} title="The account it was deposited into">
            <option value="">{ON_HAND.has(f.method) ? 'On hand' : 'Not recorded'}</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{bankAccountLabel(a)}</option>)}
            {f.bankAccountId && !accounts.some(a => a.id === f.bankAccountId) && p.bankAccount && <option value={f.bankAccountId}>{bankAccountLabel(p.bankAccount)}</option>}
          </select>
        ) : <span className="text-gray-500">{WALLET_OF[f.method] ?? '—'}</span>}
      </td>
      <td className="py-1.5 pl-4">
        <select value={f.status} onChange={set('status')} className={input}>
          <option value="RECEIVED">received</option>
          <option value="PENDING">pending</option>
        </select>
      </td>
      <td className="py-1.5 pl-4"><input value={f.notes} onChange={set('notes')} placeholder="Notes" className={`${input} w-full min-w-[90px]`} /></td>
      <td />
    </tr>
    {/* The buttons on their own line: with every column open, a row no longer fits beside them. */}
    <tr style={tint}>
      <td colSpan={9} className="pb-2 pt-0.5 whitespace-nowrap">
        <button onClick={save} disabled={busy} className="text-amber-400 hover:text-amber-300 disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        <button onClick={onCancel} disabled={busy} className="text-gray-500 hover:text-gray-300 ml-3">Cancel</button>
        {p.method !== 'CREDIT' && (
          <button onClick={toUtilities} disabled={busy} className="text-sky-400 hover:text-sky-300 ml-3" title="The tenant paid utilities back with this, not rent">It was utilities</button>
        )}
        <button onClick={remove} disabled={busy} className="text-red-400 hover:text-red-300 ml-3">Delete</button>
        {err && <span className="text-red-400 ml-3 whitespace-normal">{err}</span>}
      </td>
    </tr>
    </>
  );
}

