import { useEffect, useMemo, useState } from 'react';
import { createRentPayment, getBankAccounts, getReimbursableItems, payUtilityInvoice, createReimbursementPayment, type OpenInvoice } from '../../api/client';
import type { BankAccount, RentPaymentMethod } from '../../types';
import { RENT_PAYMENT_METHODS, RENT_PAYMENT_METHOD_LABELS, BANK_LINKED_METHODS } from '../../types';
import { todayISO, thisMonthISO } from '../../lib/date';
import { fmtMoney } from '../../lib/money';
import { bankAccountLabel } from '../../lib/bankAccountLabel';
import { describeApiError } from '../../lib/apiError';

/**
 * Logging a rent payment, the same form wherever it is opened (rent roll,
 * budget). Two dates matter and they are different things:
 *  - "Rent for" is the month's rent the payment pays — September's rent paid
 *    on October 3rd is still September's;
 *  - "Date received" is the day the money arrived.
 * Anything over the month's rent goes to back rent (arrears) on its own.
 *
 * Utilities: the same dialog logs a tenant paying back utilities, on their
 * open utility invoice (or on the lease's utility payments when none is open).
 */
export interface LogRentTarget {
  leaseId: string; tenant: string; unit: string; property: string;
  rent: number; arrears: number; remainingThisMonth?: number | null;
}

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
function monthOptions(center: string) {
  const [y, m] = center.split('-').map(Number);
  const out: string[] = [];
  for (let i = 2; i >= -12; i--) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export default function LogRentPaymentModal({ target, period, onClose, onSaved }: {
  target: LogRentTarget; period?: string; onClose: () => void; onSaved: () => void;
}) {
  const thisMonth = thisMonthISO();
  const owedNow = target.remainingThisMonth ?? target.rent;
  const [amount, setAmount] = useState(String(owedNow > 0 ? owedNow : target.rent));
  const [forMonth, setForMonth] = useState(period || thisMonth);
  const [paidDate, setPaidDate] = useState(() => todayISO());
  const [method, setMethod] = useState<RentPaymentMethod>('ZELLE');
  const [pending, setPending] = useState(false);
  const [allToArrears, setAllToArrears] = useState(false);
  const [bankAccountId, setBankAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Rent, or a utility payment (on the lease's utility invoices).
  const [kind, setKind] = useState<'rent' | 'utilities'>('rent');
  const [invoices, setInvoices] = useState<OpenInvoice[] | null>(null);
  const [invoiceId, setInvoiceId] = useState('');
  useEffect(() => {
    if (kind !== 'utilities' || invoices) return;
    getReimbursableItems(target.leaseId)
      .then(r => {
        const open = r.invoices.filter(i => i.outstanding > 0.005).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
        setInvoices(open);
        if (open[0]) { setInvoiceId(open[0].id); setAmount(open[0].outstanding.toFixed(2)); }
      })
      .catch(() => setInvoices([]));
  }, [kind, invoices, target.leaseId]);
  const invoiceLabel = (i: OpenInvoice) => {
    const a = monthLabel(i.periodStart.slice(0, 7)), b = monthLabel(i.periodEnd.slice(0, 7));
    return a === b ? a : `${a} – ${b}`;
  };

  useEffect(() => { getBankAccounts().then(a => setAccounts(a.filter(x => x.accountType !== 'CREDIT_CARD'))).catch(() => {}); }, []);
  const months = useMemo(() => monthOptions(thisMonth), [thisMonth]);
  const amt = parseFloat(amount);
  const extra = !allToArrears && amt > target.rent ? amt - target.rent : 0;

  async function save() {
    if (!(amt > 0)) { setErr('Enter the amount received.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) { setErr('Enter the date the money was received.'); return; }
    setSaving(true); setErr(null);
    const note = [reference ? `Ref ${reference}` : null, notes || null].filter(Boolean).join(' · ') || null;
    const bank = bankAccountId && BANK_LINKED_METHODS.includes(method) ? bankAccountId : null;
    if (kind === 'utilities') {
      try {
        if (invoiceId) await payUtilityInvoice(invoiceId, { amount: amt, paidAt: paidDate, method, bankAccountId: bank, notes: note });
        else await createReimbursementPayment(target.leaseId, { amount: amt, paidDate, method, bankAccountId: bank, notes: note, allocations: [] });
        onSaved();
      } catch (e) {
        setErr(describeApiError(e, 'The utility payment was not saved.'));
      } finally { setSaving(false); }
      return;
    }
    try {
      await createRentPayment({
        leaseId: target.leaseId,
        periodDate: `${forMonth}-01T00:00:00.000Z`,
        amount: amt,
        paidDate,
        method,
        status: pending ? 'PENDING' : 'RECEIVED',
        ...(allToArrears ? { appliedToArrears: amt } : {}),
        ...(bankAccountId && BANK_LINKED_METHODS.includes(method) ? { bankAccountId } : {}),
        notes: [reference ? `Ref ${reference}` : null, notes || null].filter(Boolean).join(' · ') || undefined,
      });
      onSaved();
    } catch (e) {
      setErr(describeApiError(e, 'The payment was not saved.'));
    } finally { setSaving(false); }
  }

  const input = 'input-dark text-sm w-full';
  const label = 'block text-xs text-gray-500 mb-1';
  const quick = (l: string, v: number) => v > 0 && (
    <button type="button" onClick={() => { setAmount(v.toFixed(2)); setAllToArrears(l === 'Back rent only'); }}
      className="text-xs px-2 py-0.5 rounded-full border border-white/10 text-gray-400 hover:text-amber-300 hover:border-amber-500/50">{l} {fmtMoney(v)}</button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="card p-5 w-full max-w-lg space-y-3 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div>
          <p className="text-sm font-semibold text-white">Log {kind === 'utilities' ? 'utility' : 'rent'} payment — {target.tenant}</p>
          <p className="text-xs text-gray-500">{target.unit} · {target.property} · rent {fmtMoney(target.rent)}{target.arrears > 0 ? <span className="text-red-400"> · {fmtMoney(target.arrears)} back rent owed</span> : null}</p>
        </div>

        {/* What it pays: rent, or utilities the tenant pays back. */}
        <div className="flex gap-1 p-0.5 rounded-lg w-fit" style={{ background: 'rgba(255,255,255,0.05)' }}>
          {(['rent', 'utilities'] as const).map(k => (
            <button key={k} type="button" onClick={() => { setKind(k); if (k === 'rent') setAmount(String(owedNow > 0 ? owedNow : target.rent)); else if (invoices?.[0]) { setInvoiceId(invoices[0].id); setAmount(invoices[0].outstanding.toFixed(2)); } }}
              className={`text-xs px-3 py-1 rounded-md ${kind === k ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              {k === 'rent' ? 'Rent' : 'Utilities'}
            </button>
          ))}
        </div>

        <div>
          <span className={label}>Amount received</span>
          <input type="number" step="0.01" inputMode="decimal" className={input} value={amount} onChange={e => setAmount(e.target.value)} autoFocus />
          {kind === 'rent' && <div className="flex flex-wrap gap-1.5 mt-1.5">
            {quick('Full rent', target.rent)}
            {target.remainingThisMonth != null && target.remainingThisMonth > 0 && target.remainingThisMonth < target.rent ? quick('Rest of this month', target.remainingThisMonth) : null}
            {quick('Rent + back rent', target.rent + target.arrears)}
            {quick('Back rent only', target.arrears)}
          </div>}
        </div>

        {kind === 'utilities' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={label}>Utility invoice it pays</span>
              {invoices === null ? <p className="text-xs text-gray-500 py-2">Loading…</p> : (
                <select className={input} value={invoiceId} onChange={e => { setInvoiceId(e.target.value); const i = invoices.find(x => x.id === e.target.value); if (i) setAmount(i.outstanding.toFixed(2)); }}>
                  {invoices.map(i => <option key={i.id} value={i.id}>{invoiceLabel(i)} · {fmtMoney(i.outstanding)} open</option>)}
                  <option value="">Not on an invoice</option>
                </select>
              )}
              {invoices?.length === 0 && <p className="text-[11px] text-gray-500 mt-1">No open utility invoice: it is kept on the lease's utility payments.</p>}
            </div>
            <div>
              <span className={label}>Date received</span>
              <input type="date" className={input} value={paidDate} onChange={e => setPaidDate(e.target.value)} />
            </div>
          </div>
        )}

        {kind === 'rent' && <>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={label}>Rent for (which month it pays)</span>
            <select className={input} value={forMonth} onChange={e => setForMonth(e.target.value)} disabled={allToArrears}>
              {months.map(m => <option key={m} value={m}>{monthLabel(m)}{m === thisMonth ? ' (this month)' : ''}</option>)}
            </select>
          </div>
          <div>
            <span className={label}>Date received</span>
            <input type="date" className={input} value={paidDate} onChange={e => setPaidDate(e.target.value)} />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
          <input type="checkbox" checked={allToArrears} onChange={e => setAllToArrears(e.target.checked)} />
          All of it pays back rent (none toward {monthLabel(forMonth)})
        </label>
        {extra > 0.005 && <p className="text-xs text-gray-500">{fmtMoney(target.rent)} goes to {monthLabel(forMonth)}'s rent; the other {fmtMoney(extra)} pays down back rent.</p>}
        </>}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={label}>How it was paid</span>
            <select className={input} value={method} onChange={e => setMethod(e.target.value as RentPaymentMethod)}>
              {RENT_PAYMENT_METHODS.map(m => <option key={m} value={m}>{RENT_PAYMENT_METHOD_LABELS[m]}</option>)}
            </select>
          </div>
          {BANK_LINKED_METHODS.includes(method) && accounts.length > 0 ? (
            <div>
              <span className={label}>Deposited into</span>
              <select className={input} value={bankAccountId} onChange={e => setBankAccountId(e.target.value)}>
                <option value="">— Not recorded —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{bankAccountLabel(a)}</option>)}
              </select>
            </div>
          ) : <div />}
          <div>
            <span className={label}>{method === 'CHECK' || method === 'MONEY_ORDER' ? 'Check / money order #' : 'Confirmation # (optional)'}</span>
            <input className={input} value={reference} onChange={e => setReference(e.target.value)} />
          </div>
          {kind === 'rent' ? (
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input type="checkbox" checked={pending} onChange={e => setPending(e.target.checked)} />
              Promised / not received yet
            </label>
          </div>) : <div />}
        </div>
        <div><span className={label}>Notes</span><input className={input} value={notes} onChange={e => setNotes(e.target.value)} /></div>

        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn text-xs">Cancel</button>
          <button onClick={save} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : `Log ${amt > 0 ? fmtMoney(amt) : 'payment'}`}</button>
        </div>
      </div>
    </div>
  );
}
