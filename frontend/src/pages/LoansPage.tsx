import { useEffect, useState } from 'react';
import { getLoans, createLoan, updateLoan, deleteLoan, getProperties } from '../api/client';
import type { Loan, Property, LoanType } from '../types';
import { format } from 'date-fns';

const money = (n: number | undefined) => n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const LOAN_TYPES: LoanType[] = ['MORTGAGE','HELOC','AUTO','PERSONAL','STUDENT','INSTALLMENT_PLAN','CREDIT_LINE','OTHER'];

export default function LoansPage() {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    propertyId: '', loanType: 'MORTGAGE' as LoanType,
    lender: '', accountLast4: '', originalAmount: '', interestRate: '',
    originationDate: '', maturityDate: '', monthlyPayment: '', currentBalance: '',
    notes: '', isPersonal: false, isActive: true,
  });
  const [saving, setSaving] = useState(false);

  const loadLoans = () => getLoans().then(setLoans);

  useEffect(() => {
    Promise.all([loadLoans(), getProperties().then(setProperties)]).finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.lender) return;
    setSaving(true);
    try {
      await createLoan({
        propertyId: form.propertyId || null,
        loanType: form.loanType,
        lender: form.lender,
        accountLast4: form.accountLast4 || null,
        originalAmount: form.originalAmount ? parseFloat(form.originalAmount) : null,
        interestRate: form.interestRate ? parseFloat(form.interestRate) : null,
        originationDate: form.originationDate || null,
        maturityDate: form.maturityDate || null,
        monthlyPayment: form.monthlyPayment ? parseFloat(form.monthlyPayment) : null,
        currentBalance: form.currentBalance ? parseFloat(form.currentBalance) : null,
        notes: form.notes || null,
        isPersonal: form.isPersonal,
        isActive: form.isActive,
      });
      await loadLoans();
      setShowForm(false);
    } finally { setSaving(false); }
  }

  const totalDebt = loans.filter(l => l.isActive && !l.isPersonal).reduce((s, l) => s + (l.currentBalance ?? 0), 0);
  const monthlyDebt = loans.filter(l => l.isActive && !l.isPersonal).reduce((s, l) => s + (l.monthlyPayment ?? 0), 0);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Loans & Mortgages</h1>
          <p className="text-sm text-gray-400 mt-0.5">{loans.filter(l => l.isActive).length} active · {money(totalDebt)} total balance · {money(monthlyDebt)}/mo</p>
        </div>
        <button onClick={() => setShowForm(v => !v)} className="btn-primary text-sm">
          {showForm ? 'Cancel' : '+ Add Loan'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl p-5 mb-5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Property</label>
              <select value={form.propertyId} onChange={e => setForm(f => ({ ...f, propertyId: e.target.value }))} className="input-dark w-full">
                <option value="">Unattached</option>
                {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Loan type *</label>
              <select value={form.loanType} onChange={e => setForm(f => ({ ...f, loanType: e.target.value as LoanType }))} className="input-dark w-full">
                {LOAN_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Lender *</label>
              <input value={form.lender} onChange={e => setForm(f => ({ ...f, lender: e.target.value }))} className="input-dark w-full" required />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Account (last 4)</label>
              <input maxLength={4} value={form.accountLast4} onChange={e => setForm(f => ({ ...f, accountLast4: e.target.value }))} className="input-dark w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Original amount</label>
              <input type="number" step="0.01" value={form.originalAmount} onChange={e => setForm(f => ({ ...f, originalAmount: e.target.value }))} className="input-dark w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Current balance</label>
              <input type="number" step="0.01" value={form.currentBalance} onChange={e => setForm(f => ({ ...f, currentBalance: e.target.value }))} className="input-dark w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Interest rate (%)</label>
              <input type="number" step="0.001" value={form.interestRate} onChange={e => setForm(f => ({ ...f, interestRate: e.target.value }))} className="input-dark w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Monthly payment</label>
              <input type="number" step="0.01" value={form.monthlyPayment} onChange={e => setForm(f => ({ ...f, monthlyPayment: e.target.value }))} className="input-dark w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Origination date</label>
              <input type="date" value={form.originationDate} onChange={e => setForm(f => ({ ...f, originationDate: e.target.value }))} className="input-dark w-full" />
            </div>
          </div>
          <div className="flex gap-4 mb-4">
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
              <input type="checkbox" checked={form.isPersonal} onChange={e => setForm(f => ({ ...f, isPersonal: e.target.checked }))} />
              Personal loan (exclude from P&L)
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
              <input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} />
              Active
            </label>
          </div>
          <button type="submit" disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Add Loan'}</button>
        </form>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
              <tr className="text-left text-gray-400 text-xs">
                <th className="px-4 py-3">Lender</th>
                <th className="px-4 py-3">Property</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3 text-right">Balance</th>
                <th className="px-4 py-3 text-right">Monthly</th>
                <th className="px-4 py-3 text-right">Rate</th>
                <th className="px-4 py-3">Flags</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {loans.map(loan => (
                <tr key={loan.id} className={`hover:bg-white/[0.02] ${!loan.isActive ? 'opacity-40' : ''}`}>
                  <td className="px-4 py-3 font-medium text-white text-xs">
                    {loan.lender}
                    {loan.accountLast4 && <span className="text-gray-500 ml-1">···{loan.accountLast4}</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{loan.property?.nickname || loan.property?.address || <span className="text-gray-600">Unattached</span>}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{loan.loanType.replace('_', ' ')}</td>
                  <td className="px-4 py-3 text-right text-white text-xs font-medium">{money(loan.currentBalance ?? undefined)}</td>
                  <td className="px-4 py-3 text-right text-gray-300 text-xs">{money(loan.monthlyPayment ?? undefined)}</td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">{loan.interestRate != null ? `${loan.interestRate}%` : '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {loan.isPersonal && <span className="text-xs bg-purple-900/40 text-purple-300 px-1.5 py-0.5 rounded">Personal</span>}
                      {!loan.isActive && <span className="text-xs bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">Closed</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={async () => { const u = await updateLoan(loan.id, { isActive: !loan.isActive }); setLoans(prev => prev.map(l => l.id === loan.id ? { ...l, isActive: u.isActive } : l)); }}
                      className="text-xs text-gray-500 hover:text-gray-300 mr-2"
                    >
                      {loan.isActive ? 'Close' : 'Reopen'}
                    </button>
                    <button
                      onClick={async () => { if (confirm('Delete?')) { await deleteLoan(loan.id); setLoans(prev => prev.filter(l => l.id !== loan.id)); } }}
                      className="text-xs text-red-500 hover:text-red-400"
                    >Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
