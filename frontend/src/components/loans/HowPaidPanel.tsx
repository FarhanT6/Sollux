import { useEffect, useState } from 'react';
import { updateLoan, getBankAccounts } from '../../api/client';
import type { Loan, BankAccount, LoanPaymentMethod } from '../../types';
import { bankAccountLabel } from '../../lib/bankAccountLabel';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from '../../lib/loanPayment';
import { describeApiError } from '../../lib/apiError';

/**
 * How this loan gets paid: when it is due, how the money moves, which of the
 * owner's accounts it comes out of, where a check is mailed and the lender's
 * own account (last four only).
 */
export default function HowPaidPanel({ loan, onSave }: { loan: Loan; onSave: (l: Loan) => void }) {
  const [editing, setEditing] = useState(false);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const blank = () => ({
    dueDay: loan.dueDay != null ? String(loan.dueDay) : '',
    gracePeriodDays: loan.gracePeriodDays != null ? String(loan.gracePeriodDays) : '',
    paymentMethods: loan.paymentMethods ?? [],
    paymentInstructions: loan.paymentInstructions ?? '',
    mailingAddress: loan.mailingAddress ?? '',
    payeeBankName: loan.payeeBankName ?? '',
    payeeAccountLast4: loan.payeeAccountLast4 ?? '',
    paymentUrl: loan.paymentUrl ?? '',
    payFromBankAccountId: loan.payFromBankAccountId ?? '',
  });
  const [form, setForm] = useState(blank);
  useEffect(() => { getBankAccounts().then(setBankAccounts).catch(() => {}); }, []);
  useEffect(() => { if (!editing) setForm(blank()); }, [loan, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const methods = loan.paymentMethods ?? [];
  const payFrom = bankAccounts.find(b => b.id === loan.payFromBankAccountId);
  const hasAny = loan.dueDay || methods.length || loan.paymentInstructions || loan.mailingAddress || loan.payeeBankName || loan.payeeAccountLast4 || loan.paymentUrl || payFrom;

  async function save() {
    setSaving(true); setErr(null);
    try {
      const updated = await updateLoan(loan.id, {
        dueDay: form.dueDay ? parseInt(form.dueDay, 10) : null,
        gracePeriodDays: form.gracePeriodDays ? parseInt(form.gracePeriodDays, 10) : null,
        paymentMethods: form.paymentMethods,
        paymentInstructions: form.paymentInstructions || null,
        mailingAddress: form.mailingAddress || null,
        payeeBankName: form.payeeBankName || null,
        payeeAccountLast4: form.payeeAccountLast4 || null,
        paymentUrl: form.paymentUrl || null,
        payFromBankAccountId: form.payFromBankAccountId || null,
      } as Partial<Loan>);
      onSave({ ...loan, ...updated });
      setEditing(false);
    } catch (e) { setErr(describeApiError(e, 'Could not save.')); }
    finally { setSaving(false); }
  }

  const toggle = (m: LoanPaymentMethod) => setForm(f => ({ ...f, paymentMethods: f.paymentMethods.includes(m) ? f.paymentMethods.filter(x => x !== m) : [...f.paymentMethods, m] }));
  const set = (k: keyof ReturnType<typeof blank>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm(f => ({ ...f, [k]: e.target.value }));
  const input = 'input-dark w-full text-sm';
  const label = 'block text-xs text-gray-500 mb-1';
  const row = (k: string, v: React.ReactNode) => v ? <div className="flex gap-3 text-sm py-1"><span className="text-gray-500 w-40 shrink-0">{k}</span><span className="text-gray-200 min-w-0 break-words">{v}</span></div> : null;
  const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

  return (
    <div className="card p-4 mt-5">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-semibold text-white">How it's paid</p>
        {!editing && <button onClick={() => setEditing(true)} className="text-xs text-amber-400 hover:text-amber-300">{hasAny ? 'Edit' : 'Add payment details'}</button>}
      </div>

      {!editing && (hasAny ? (
        <div>
          {row('Due', loan.dueDay ? `The ${ordinal(loan.dueDay)} of every month${loan.gracePeriodDays ? ` · late after ${loan.gracePeriodDays} days` : ''}` : null)}
          {row('Method', methods.length ? methods.map(m => PAYMENT_METHOD_LABELS[m] ?? m).join(', ') : null)}
          {row('Instructions', loan.paymentInstructions)}
          {row('Paid from', payFrom ? bankAccountLabel(payFrom) : null)}
          {row("Lender's account", loan.payeeBankName || loan.payeeAccountLast4 ? [loan.payeeBankName, loan.payeeAccountLast4 ? `••${loan.payeeAccountLast4}` : null].filter(Boolean).join(' ') : null)}
          {row('Mail checks to', loan.mailingAddress)}
          {row('Pay online', loan.paymentUrl ? <a href={loan.paymentUrl} target="_blank" rel="noreferrer" className="text-amber-400 hover:underline break-all">{loan.paymentUrl.replace(/^https?:\/\//, '').slice(0, 60)}</a> : null)}
        </div>
      ) : <p className="text-sm text-gray-500">No payment details yet — when it's due, how it's paid and where it goes.</p>)}

      {editing && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div><span className={label}>Due day of month</span><input type="number" min={1} max={31} className={input} value={form.dueDay} onChange={set('dueDay')} /></div>
            <div><span className={label}>Grace period (days)</span><input type="number" min={0} className={input} value={form.gracePeriodDays} onChange={set('gracePeriodDays')} /></div>
          </div>
          <div>
            <span className={label}>Payment method (pick all that apply)</span>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => (
                <button key={m} type="button" onClick={() => toggle(m)}
                  className={`text-xs px-2.5 py-1 rounded-full border ${form.paymentMethods.includes(m) ? 'border-amber-400 text-amber-300' : 'border-white/10 text-gray-400'}`}>
                  {PAYMENT_METHOD_LABELS[m]}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <span className={label}>Taken out of / paid from</span>
              <select className={input} value={form.payFromBankAccountId} onChange={set('payFromBankAccountId')}>
                <option value="">— Not set —</option>
                {bankAccounts.filter(b => b.accountType !== 'CREDIT_CARD').map(b => <option key={b.id} value={b.id}>{bankAccountLabel(b)}</option>)}
              </select>
            </div>
            <div><span className={label}>Payment website</span><input className={input} value={form.paymentUrl} onChange={set('paymentUrl')} placeholder="https://" /></div>
            <div><span className={label}>Lender's bank (for deposits / transfers)</span><input className={input} value={form.payeeBankName} onChange={set('payeeBankName')} placeholder="Chase" /></div>
            <div><span className={label}>Lender's account — last 4 only</span><input className={input} maxLength={4} value={form.payeeAccountLast4} onChange={set('payeeAccountLast4')} /></div>
            <div className="md:col-span-2"><span className={label}>Mail checks to</span><input className={input} value={form.mailingAddress} onChange={set('mailingAddress')} /></div>
            <div className="md:col-span-2"><span className={label}>Instructions</span><textarea rows={2} className={input} value={form.paymentInstructions} onChange={set('paymentInstructions')} placeholder="e.g. Make checks payable to …; Monty deducts from the payout" /></div>
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(false)} className="btn text-xs">Cancel</button>
            <button onClick={save} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
