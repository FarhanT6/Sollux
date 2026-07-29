import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getLoans, createLoan, updateLoan, deleteLoan, getProperties } from '../api/client';
import type { Loan, Property, LoanType } from '../types';
import { format } from 'date-fns';

const money = (n: number | string | undefined) => n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const LOAN_TYPES: LoanType[] = ['MORTGAGE','HELOC','AUTO','PERSONAL','STUDENT','INSTALLMENT_PLAN','CREDIT_LINE','OTHER'];

function MaturityBadge({ maturityDate }: { maturityDate?: string }) {
  if (!maturityDate) return null;
  const days = Math.round((new Date(maturityDate).getTime() - Date.now()) / 86400000);
  if (days < 0) return <span className="text-xs bg-red-900/40 text-red-300 px-1.5 py-0.5 rounded">Matured</span>;
  if (days < 90) return <span className="text-xs bg-amber-900/40 text-amber-300 px-1.5 py-0.5 rounded">{days}d left</span>;
  const months = Math.round(days / 30);
  if (months < 24) return <span className="text-xs bg-blue-900/30 text-blue-300 px-1.5 py-0.5 rounded">{months}mo left</span>;
  return <span className="text-xs text-gray-600">{Math.round(months / 12)}yr left</span>;
}

export default function LoansPage({ embedded }: { embedded?: boolean } = {}) {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    propertyId: '', loanType: 'MORTGAGE' as LoanType,
    lender: '', accountLast4: '', originalAmount: '', interestRate: '',
    originationDate: '', maturityDate: '', monthlyPayment: '', escrowAmount: '', currentBalance: '',
    dueDay: '', gracePeriodDays: '',
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
        propertyId: form.propertyId || undefined,
        loanType: form.loanType,
        lender: form.lender,
        accountLast4: form.accountLast4 || undefined,
        originalAmount: form.originalAmount ? parseFloat(form.originalAmount) : undefined,
        interestRate: form.interestRate ? parseFloat(form.interestRate) : undefined,
        originationDate: form.originationDate || undefined,
        maturityDate: form.maturityDate || undefined,
        monthlyPayment: form.monthlyPayment ? parseFloat(form.monthlyPayment) : undefined,
        escrowAmount: form.escrowAmount ? parseFloat(form.escrowAmount) : undefined,
        currentBalance: form.currentBalance ? parseFloat(form.currentBalance) : undefined,
        dueDay: form.dueDay ? parseInt(form.dueDay, 10) : undefined,
        gracePeriodDays: form.gracePeriodDays ? parseInt(form.gracePeriodDays, 10) : undefined,
        notes: form.notes || undefined,
        isPersonal: form.isPersonal,
        isActive: form.isActive,
      });
      await loadLoans();
      setShowForm(false);
    } finally { setSaving(false); }
  }

  const searchLower = search.toLowerCase();
  const displayedLoans = !searchLower ? loans : loans.filter(l =>
    l.lender.toLowerCase().includes(searchLower) ||
    (l.property?.nickname || '').toLowerCase().includes(searchLower) ||
    (l.property?.address || '').toLowerCase().includes(searchLower)
  );

  const activeLoans = loans.filter(l => l.isActive && !l.isPersonal);
  const totalDebt = activeLoans.reduce((s, l) => s + Number(l.currentBalance ?? 0), 0);
  const monthlyDebt = activeLoans.reduce((s, l) => s + Number(l.monthlyPayment ?? 0) + Number(l.escrowAmount ?? 0), 0);
  const ratesWithValue = activeLoans.filter(l => l.interestRate != null);
  const avgRate = ratesWithValue.length ? ratesWithValue.reduce((s, l) => s + Number(l.interestRate), 0) / ratesWithValue.length : null;

  return (
    <div className={embedded ? '' : 'p-6'}>
      {!embedded ? (
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-white">Loans & Mortgages</h1>
            <p className="text-sm text-gray-400 mt-0.5">{loans.filter(l => l.isActive).length} active · {money(totalDebt)} total balance · {money(monthlyDebt)}/mo</p>
          </div>
          <button onClick={() => setShowForm(v => !v)} className="btn-primary text-sm">
            {showForm ? 'Cancel' : '+ Add Loan'}
          </button>
        </div>
      ) : (
        <div className="mb-4">
          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <p className="text-xs text-gray-400 mb-0.5">Total balance</p>
              <p className="text-base font-semibold text-red-400">{money(totalDebt)}</p>
              <p className="text-xs text-gray-500">{activeLoans.length} active loans</p>
            </div>
            <div className="rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <p className="text-xs text-gray-400 mb-0.5">Monthly payments</p>
              <p className="text-base font-semibold text-white">{money(monthlyDebt)}/mo</p>
              <p className="text-xs text-gray-500">Debt service</p>
            </div>
            <div className="rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <p className="text-xs text-gray-400 mb-0.5">Avg interest rate</p>
              <p className="text-base font-semibold text-white">{avgRate != null ? `${avgRate.toFixed(2)}%` : '—'}</p>
              <p className="text-xs text-gray-500">Across active loans</p>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <p className="section-label mb-0">{loans.filter(l => l.isActive).length} active loans</p>
              <div className="relative">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search lender or property…"
                  className="pl-7 pr-3 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-600 focus:border-amber-500/40 outline-none w-52 transition-colors"
                />
                {search && <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs leading-none">×</button>}
              </div>
            </div>
            <button onClick={() => setShowForm(v => !v)} className="btn text-xs">
              {showForm ? 'Cancel' : '+ Add loan'}
            </button>
          </div>
        </div>
      )}

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
            <div>
              <label className="text-xs text-gray-400 block mb-1">Escrow (taxes/insurance)</label>
              <input type="number" step="0.01" value={form.escrowAmount} onChange={e => setForm(f => ({ ...f, escrowAmount: e.target.value }))} className="input-dark w-full" placeholder="On top of P&I" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Due day of month</label>
              <input type="number" min={1} max={31} value={form.dueDay} onChange={e => setForm(f => ({ ...f, dueDay: e.target.value }))} className="input-dark w-full" placeholder="1" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Grace period (days)</label>
              <input type="number" min={0} value={form.gracePeriodDays} onChange={e => setForm(f => ({ ...f, gracePeriodDays: e.target.value }))} className="input-dark w-full" placeholder="15" />
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
        <div className="rounded-xl overflow-x-auto" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
              <tr className="text-left text-gray-400 text-xs">
                <th className="px-4 py-3">Lender</th>
                <th className="px-4 py-3">Property</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3 text-right">Original</th>
                <th className="px-4 py-3 text-right">Balance</th>
                <th className="px-4 py-3 text-right">Monthly</th>
                <th className="px-4 py-3 text-right">Rate</th>
                <th className="px-4 py-3 text-right">Total interest</th>
                <th className="px-4 py-3 text-right">Interest paid</th>
                <th className="px-4 py-3">Maturity</th>
                <th className="px-4 py-3">Flags</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {displayedLoans.map(loan => (
                <tr key={loan.id} className={`hover:bg-white/[0.02] ${!loan.isActive ? 'opacity-40' : ''}`}>
                  <td className="px-4 py-3 font-medium text-xs whitespace-nowrap">
                    <Link to={`/loans/${loan.id}`} className="text-white hover:text-amber-400">
                      {loan.lender}
                    </Link>
                    {loan.accountLast4 && <span className="text-gray-500 ml-1">···{loan.accountLast4}</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{loan.property?.nickname || loan.property?.address || <span className="text-gray-600">Unattached</span>}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{loan.loanType.replace('_', ' ')}</td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">{money(loan.originalAmount ?? undefined)}</td>
                  <td className="px-4 py-3 text-right text-red-400 text-xs font-medium">{money(loan.currentBalance ?? undefined)}</td>
                  <td className="px-4 py-3 text-right text-gray-300 text-xs" title={loan.escrowAmount ? `${money(loan.monthlyPayment)} P&I + ${money(loan.escrowAmount)} escrow` : undefined}>
                    {money(loan.monthlyPayment != null || loan.escrowAmount != null ? Number(loan.monthlyPayment ?? 0) + Number(loan.escrowAmount ?? 0) : undefined)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">{loan.interestRate != null ? `${loan.interestRate}%` : '—'}</td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">{money(loan.totalInterestLifetime ?? undefined)}</td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">{money(loan.interestPaidToDate ?? undefined)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <MaturityBadge maturityDate={loan.maturityDate} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {loan.isPersonal && <span className="text-xs bg-purple-900/40 text-purple-300 px-1.5 py-0.5 rounded">Personal</span>}
                      {!loan.isActive && <span className="text-xs bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">Closed</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
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
