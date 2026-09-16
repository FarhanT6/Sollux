import { useState } from 'react';
import type { Loan, LoanComponent } from '../types';
import { addLoanComponent, updateLoanComponent, deleteLoanComponent, LoanComponentInput } from '../api/client';
import { fmtDate } from '../lib/date';

/**
 * The individual loans a servicer bills together under one account.
 *
 * A federal student-loan statement lists Group AA (Direct Subsidized) and
 * Group BB (Direct Unsubsidized) side by side, each with its own principal,
 * rate and payment, and asks for one combined payment. This panel lists
 * them, lets each be added or corrected by hand, and the account-level loan
 * above it carries their totals (the backend recomputes on every change).
 * Imported statements that print such a table fill this in on their own.
 */
export default function LoanComponentsPanel({ loan, onChange, compact = false }: {
  loan: Pick<Loan, 'id' | 'components'>;
  onChange: (loan: Loan) => void;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState<LoanComponent | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const parts = loan.components ?? [];

  const money = (v?: number | null) => v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const pct = (v?: number | null) => v == null ? '—' : `${Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;

  async function handleDelete(c: LoanComponent) {
    if (!confirm(`Remove ${c.label}${c.loanKind ? ` (${c.loanKind})` : ''} from this account? The account totals will be recomputed from what is left.`)) return;
    setBusyId(c.id);
    try { onChange(await deleteLoanComponent(loan.id, c.id)); } finally { setBusyId(null); }
  }

  const totals = parts.reduce((t, c) => ({
    original: t.original + Number(c.originalAmount ?? 0),
    balance: t.balance + Number(c.currentBalance ?? 0) + Number(c.accruedInterest ?? 0),
    monthly: t.monthly + Number(c.monthlyPayment ?? 0),
  }), { original: 0, balance: 0, monthly: 0 });

  return (
    <div className={compact ? 'mt-3' : 'mt-5'}>
      {editing && (
        <ComponentModal
          loanId={loan.id}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={l => { onChange(l); setEditing(null); }}
        />
      )}
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-400">
          Loans under this account
          {parts.length > 0 && <span className="text-gray-600"> · {parts.length} — the totals above are their sum</span>}
        </p>
        <button type="button" onClick={() => setEditing('new')} className="text-xs text-amber-400 hover:text-amber-300 transition-colors">+ Add loan</button>
      </div>

      {parts.length === 0 ? (
        <p className="text-xs text-gray-600">
          One account, one loan. If the servicer bills several loans together (a subsidized and an unsubsidized student loan, say), add each one here and the account will total them.
        </p>
      ) : (
        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500" style={{ background: 'rgba(255,255,255,0.03)' }}>
                <th className="text-left font-normal px-3 py-2">Loan</th>
                <th className="text-right font-normal px-3 py-2">Original</th>
                <th className="text-right font-normal px-3 py-2">Balance</th>
                <th className="text-right font-normal px-3 py-2">Rate</th>
                <th className="text-right font-normal px-3 py-2">Monthly</th>
                {!compact && <th className="text-right font-normal px-3 py-2">Disbursed</th>}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {parts.map(c => (
                <tr key={c.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <td className="px-3 py-2">
                    <p className="text-white">{c.label}</p>
                    {c.loanKind && <p className="text-gray-500">{c.loanKind}</p>}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-300">{money(c.originalAmount)}</td>
                  <td className="px-3 py-2 text-right">
                    <p className="text-white">{money(c.currentBalance)}</p>
                    {c.accruedInterest != null && Number(c.accruedInterest) > 0 && (
                      <p className="text-gray-500">+ {money(c.accruedInterest)} interest</p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-300">{pct(c.interestRate)}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{money(c.monthlyPayment)}</td>
                  {!compact && <td className="px-3 py-2 text-right text-gray-500">{c.originationDate ? fmtDate(c.originationDate, 'MMM d, yyyy') : '—'}</td>}
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button type="button" onClick={() => setEditing(c)} className="text-gray-500 hover:text-white mr-2">Edit</button>
                    <button type="button" onClick={() => handleDelete(c)} disabled={busyId === c.id} className="text-red-500/70 hover:text-red-400 disabled:opacity-50">Remove</button>
                  </td>
                </tr>
              ))}
              <tr className="text-gray-400" style={{ borderTop: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.02)' }}>
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right">{money(totals.original)}</td>
                <td className="px-3 py-2 text-right text-white">{money(totals.balance)}</td>
                <td className="px-3 py-2 text-right text-gray-600">weighted</td>
                <td className="px-3 py-2 text-right">{money(totals.monthly)}</td>
                {!compact && <td />}
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ComponentModal({ loanId, existing, onClose, onSaved }: {
  loanId: string; existing: LoanComponent | null; onClose: () => void; onSaved: (loan: Loan) => void;
}) {
  const str = (v?: number | string | null) => (v == null ? '' : String(v));
  const [label, setLabel] = useState(existing?.label ?? '');
  const [loanKind, setLoanKind] = useState(existing?.loanKind ?? '');
  const [originalAmount, setOriginalAmount] = useState(str(existing?.originalAmount));
  const [currentBalance, setCurrentBalance] = useState(str(existing?.currentBalance));
  const [interestRate, setInterestRate] = useState(str(existing?.interestRate));
  const [monthlyPayment, setMonthlyPayment] = useState(str(existing?.monthlyPayment));
  const [accruedInterest, setAccruedInterest] = useState(str(existing?.accruedInterest));
  const [originationDate, setOriginationDate] = useState(existing?.originationDate ? existing.originationDate.slice(0, 10) : '');
  const [maturityDate, setMaturityDate] = useState(existing?.maturityDate ? existing.maturityDate.slice(0, 10) : '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const num = (s: string) => (s.trim() === '' ? null : parseFloat(s));

  async function handleSave() {
    if (!label.trim()) return;
    setSaving(true); setError(null);
    const data: LoanComponentInput = {
      label: label.trim(),
      loanKind: loanKind.trim() || null,
      originalAmount: num(originalAmount),
      currentBalance: num(currentBalance),
      interestRate: num(interestRate),
      monthlyPayment: num(monthlyPayment),
      accruedInterest: num(accruedInterest),
      originationDate: originationDate || null,
      maturityDate: maturityDate || null,
      notes: notes.trim() || null,
    };
    try {
      const loan = existing ? await updateLoanComponent(loanId, existing.id, data) : await addLoanComponent(loanId, data);
      onSaved(loan);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Could not save this loan.');
      setSaving(false);
    }
  }

  const inputCls = 'w-full rounded-lg px-3 py-2 text-sm text-white bg-black/30 border border-white/10 focus:outline-none focus:border-amber-500';
  const labelCls = 'text-xs text-gray-400 block mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 overflow-y-auto py-8">
      <div className="rounded-2xl p-6 w-full max-w-md space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.1)' }}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">{existing ? 'Edit loan' : 'Add a loan to this account'}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">×</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Label *</label>
            <input value={label} onChange={e => setLabel(e.target.value)} className={inputCls} placeholder="Group AA" />
          </div>
          <div>
            <label className={labelCls}>Kind</label>
            <input value={loanKind} onChange={e => setLoanKind(e.target.value)} className={inputCls} placeholder="Direct Subsidized" list="loan-kind-options" />
            <datalist id="loan-kind-options">
              <option value="Direct Subsidized" />
              <option value="Direct Unsubsidized" />
              <option value="Direct PLUS" />
              <option value="Parent PLUS" />
              <option value="Grad PLUS" />
              <option value="Consolidation" />
              <option value="Perkins" />
              <option value="Private" />
            </datalist>
          </div>
          <div>
            <label className={labelCls}>Original principal ($)</label>
            <input type="number" step="0.01" value={originalAmount} onChange={e => setOriginalAmount(e.target.value)} className={inputCls} placeholder="2750.00" />
          </div>
          <div>
            <label className={labelCls}>Outstanding principal ($)</label>
            <input type="number" step="0.01" value={currentBalance} onChange={e => setCurrentBalance(e.target.value)} className={inputCls} placeholder="2758.00" />
          </div>
          <div>
            <label className={labelCls}>Interest rate (%)</label>
            <input type="number" step="0.001" value={interestRate} onChange={e => setInterestRate(e.target.value)} className={inputCls} placeholder="6.39" />
          </div>
          <div>
            <label className={labelCls}>Monthly payment ($)</label>
            <input type="number" step="0.01" value={monthlyPayment} onChange={e => setMonthlyPayment(e.target.value)} className={inputCls} placeholder="50.00" />
          </div>
          <div>
            <label className={labelCls}>Unpaid accrued interest ($)</label>
            <input type="number" step="0.01" value={accruedInterest} onChange={e => setAccruedInterest(e.target.value)} className={inputCls} placeholder="0.00" />
            <p className="text-xs text-gray-600 mt-1">Counts toward the balance owed.</p>
          </div>
          <div />
          <div>
            <label className={labelCls}>First disbursed</label>
            <input type="date" value={originationDate} onChange={e => setOriginationDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Estimated payoff</label>
            <input type="date" value={maturityDate} onChange={e => setMaturityDate(e.target.value)} className={inputCls} />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Notes (optional)</label>
            <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} placeholder="In-school deferment until…" />
          </div>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm text-gray-400 hover:text-white" style={{ background: 'rgba(255,255,255,0.06)' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !label.trim()}
            className="flex-1 py-2 rounded-lg text-sm font-medium text-black bg-amber-500 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
