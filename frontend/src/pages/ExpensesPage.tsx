import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getExpenses, createExpense, updateExpense, deleteExpense, getProperties } from '../api/client';
import type { Expense, Property, ExpenseCategory } from '../types';
import { EXPENSE_CATEGORY_LABELS } from '../types';
import { format } from 'date-fns';
import { fmtDate } from '../lib/date';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const CATEGORIES: ExpenseCategory[] = [
  'UTILITIES','REPAIRS_MAINTENANCE','LANDSCAPING','PROPERTY_MANAGEMENT','LEGAL',
  'INSURANCE','PROPERTY_TAX','HOA','MORTGAGE_DEBT_SERVICE','CAPITAL_IMPROVEMENT',
  'SUPPLIES','TRAVEL','ADVERTISING','OTHER',
];

type SortKey = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc';

export default function ExpensesPage({ embedded }: { embedded?: boolean } = {}) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterPropId, setFilterPropId] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [filterPersonal, setFilterPersonal] = useState(false);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('date-desc');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    propertyId: '', category: 'REPAIRS_MAINTENANCE' as ExpenseCategory,
    amount: '', date: new Date().toISOString().slice(0, 10),
    vendor: '', description: '', isCapEx: false, isPersonal: false,
  });
  const [saving, setSaving] = useState(false);

  const loadExpenses = () =>
    getExpenses({ propertyId: filterPropId || undefined, isPersonal: filterPersonal || undefined })
      .then(setExpenses);

  useEffect(() => {
    Promise.all([loadExpenses(), getProperties().then(setProperties)]).finally(() => setLoading(false));
  }, [filterPropId, filterPersonal]);

  const searchLower = search.toLowerCase();
  const filtered = expenses.filter(e => {
    if (filterCat && e.category !== filterCat) return false;
    if (searchLower && !(e.vendor || '').toLowerCase().includes(searchLower) && !(e.description || '').toLowerCase().includes(searchLower)) return false;
    if (dateFrom && e.date < dateFrom) return false;
    if (dateTo && e.date > dateTo + 'T23:59:59') return false;
    return true;
  }).sort((a, b) => {
    if (sortBy === 'date-desc') return new Date(b.date).getTime() - new Date(a.date).getTime();
    if (sortBy === 'date-asc') return new Date(a.date).getTime() - new Date(b.date).getTime();
    if (sortBy === 'amount-desc') return Number(b.amount) - Number(a.amount);
    return Number(a.amount) - Number(b.amount);
  });
  const total = filtered.filter(e => !e.isPersonal && !e.isCapEx).reduce((s, e) => s + Number(e.amount), 0);
  const capexTotal = filtered.filter(e => e.isCapEx && !e.isPersonal).reduce((s, e) => s + Number(e.amount), 0);

  async function handleCreate(ev: React.FormEvent) {
    ev.preventDefault();
    if ((!form.propertyId && !form.isPersonal) || !form.amount) return;
    setSaving(true);
    try {
      await createExpense({ ...form, propertyId: form.propertyId || undefined, amount: parseFloat(form.amount) });
      await loadExpenses();
      setShowForm(false);
      setForm(f => ({ ...f, amount: '', vendor: '', description: '' }));
    } finally { setSaving(false); }
  }

  async function togglePersonal(expense: Expense) {
    const updated = await updateExpense(expense.id, { isPersonal: !expense.isPersonal });
    setExpenses(prev => prev.map(e => e.id === expense.id ? { ...e, isPersonal: updated.isPersonal } : e));
  }

  return (
    <div className={embedded ? '' : 'p-6'}>
      {!embedded ? (
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-white">Expenses</h1>
            <p className="text-sm text-gray-400 mt-0.5">{filtered.length} records · {money(total)} operating</p>
          </div>
          <button onClick={() => setShowForm(v => !v)} className="btn-primary text-sm">
            {showForm ? 'Cancel' : '+ Log Expense'}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between mb-4">
          <p className="section-label mb-0">{filtered.length} records · {money(total)} operating{capexTotal > 0 ? ` · ${money(capexTotal)} CapEx` : ''}</p>
          <button onClick={() => setShowForm(v => !v)} className="btn text-xs">
            {showForm ? 'Cancel' : '+ Log expense'}
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-3 flex-wrap items-center">
        <select value={filterPropId} onChange={e => setFilterPropId(e.target.value)} className="input-dark text-sm max-w-xs">
          <option value="">All properties</option>
          {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
        </select>
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} className="input-dark text-sm w-52">
          <option value="">All categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
          <input type="checkbox" checked={filterPersonal} onChange={e => setFilterPersonal(e.target.checked)} />
          Show personal
        </label>
      </div>
      <div className="flex gap-3 mb-4 flex-wrap items-center">
        {/* Text search */}
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search vendor / description…"
            className="pl-7 pr-3 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-600 focus:border-amber-500/40 outline-none w-52 transition-colors"
          />
          {search && <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs leading-none">×</button>}
        </div>
        {/* Date range */}
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="input-dark text-xs py-1.5" title="From date" />
        <span className="text-gray-600 text-xs">—</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="input-dark text-xs py-1.5" title="To date" />
        {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(''); setDateTo(''); }} className="text-xs text-gray-500 hover:text-gray-300">Clear dates</button>}
        {/* Sort */}
        <select value={sortBy} onChange={e => setSortBy(e.target.value as SortKey)} className="input-dark text-xs py-1.5 ml-auto">
          <option value="date-desc">Newest first</option>
          <option value="date-asc">Oldest first</option>
          <option value="amount-desc">Highest amount</option>
          <option value="amount-asc">Lowest amount</option>
        </select>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl p-5 mb-5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                Property {form.isPersonal ? '(optional)' : '*'}
              </label>
              <select value={form.propertyId} onChange={e => setForm(f => ({ ...f, propertyId: e.target.value }))} className="input-dark w-full" required={!form.isPersonal}>
                <option value="">{form.isPersonal ? 'None — purely personal' : 'Select…'}</option>
                {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Category *</label>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as ExpenseCategory }))} className="input-dark w-full">
                {CATEGORIES.map(c => <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Amount *</label>
              <input type="number" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} className="input-dark w-full" required />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Date *</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="input-dark w-full" required />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Vendor</label>
              <input value={form.vendor} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} className="input-dark w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input-dark w-full" />
            </div>
          </div>
          <div className="flex gap-4 mb-4">
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
              <input type="checkbox" checked={form.isCapEx} onChange={e => setForm(f => ({ ...f, isCapEx: e.target.checked }))} />
              Capital improvement (CapEx)
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
              <input type="checkbox" checked={form.isPersonal} onChange={e => setForm(f => ({ ...f, isPersonal: e.target.checked }))} />
              Personal (excluded from P&L — property optional)
            </label>
          </div>
          <button type="submit" disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Log Expense'}</button>
        </form>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-500">No expenses found</div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
                <tr className="text-left text-gray-400">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Property</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Flags</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filtered.map(e => (
                  <tr key={e.id} className={`hover:bg-white/[0.02] ${e.isPersonal ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3 text-gray-400 text-xs">{fmtDate(e.date, 'MMM d, yyyy')}</td>
                    <td className="px-4 py-3 text-gray-300 text-xs">
                      {e.propertyId ? (
                        <Link to={`/portfolio/${e.propertyId}?tab=Expenses`} className="hover:text-amber-400 transition-colors">
                          {e.property?.nickname || e.property?.address || '—'}
                        </Link>
                      ) : (
                        <span className="text-gray-500 italic">Personal</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs bg-white/5 text-gray-300 px-2 py-0.5 rounded">
                        {EXPENSE_CATEGORY_LABELS[e.category]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{e.vendor || e.description || '—'}</td>
                    <td className="px-4 py-3 font-medium text-white">{money(Number(e.amount))}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1.5">
                        {e.source === 'utility' && <span className="text-xs bg-blue-900/40 text-blue-300 px-1.5 py-0.5 rounded">Utility</span>}
                        {e.isCapEx && <span className="text-xs bg-blue-900/40 text-blue-300 px-1.5 py-0.5 rounded">CapEx</span>}
                        {e.isPersonal && <span className="text-xs bg-purple-900/40 text-purple-300 px-1.5 py-0.5 rounded">Personal</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {e.source === 'utility' ? (
                        <Link to={`/properties/${e.propertyId}/utilities/${e.utilityAccountId}`} className="text-xs text-amber-400 hover:text-amber-300">View bill</Link>
                      ) : (
                        <>
                          <button
                            onClick={() => togglePersonal(e)}
                            className="text-xs text-gray-500 hover:text-gray-300 mr-3"
                            title={e.isPersonal ? 'Mark as property expense' : 'Mark as personal'}
                          >
                            {e.isPersonal ? 'Unmk personal' : 'Mk personal'}
                          </button>
                          <button onClick={async () => { if (confirm('Delete?')) { await deleteExpense(e.id); setExpenses(prev => prev.filter(x => x.id !== e.id)); } }} className="text-xs text-red-500 hover:text-red-400">Del</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
