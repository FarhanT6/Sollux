import { useEffect, useMemo, useState } from 'react';
import { getExpenses, createExpense, deleteExpense } from '../api/client';
import type { Expense, ExpenseCategory } from '../types';
import { EXPENSE_CATEGORY_LABELS, PERSONAL_EXPENSE_CATEGORIES } from '../types';
import { format } from 'date-fns';
import { PageHeader } from '../components/ui';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const CATEGORY_ICONS: Record<ExpenseCategory, string> = {
  AUTO_LOAN: '🚗', AUTO_INSURANCE: '🛡️', CREDIT_CARD: '💳', MEDICAL: '🩺',
  PHONE: '📱', STUDENT_LOAN: '🎓', LIFE_INSURANCE: '❤️', SUBSCRIPTIONS: '🔁',
  OTHER: '📄',
} as Record<ExpenseCategory, string>;

export default function PersonalExpensesPage({ embedded }: { embedded?: boolean } = {}) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [openCategory, setOpenCategory] = useState<ExpenseCategory | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    category: 'CREDIT_CARD' as ExpenseCategory,
    amount: '', date: new Date().toISOString().slice(0, 10),
    vendor: '', description: '',
  });
  const [saving, setSaving] = useState(false);

  const load = () => getExpenses({ isPersonal: true }).then(setExpenses);

  useEffect(() => { load().finally(() => setLoading(false)); }, []);

  const byCategory = useMemo(() => {
    const map = new Map<ExpenseCategory, Expense[]>();
    for (const cat of PERSONAL_EXPENSE_CATEGORIES) map.set(cat, []);
    for (const e of expenses) {
      if (!map.has(e.category)) map.set(e.category, []);
      map.get(e.category)!.push(e);
    }
    return map;
  }, [expenses]);

  const grandTotal = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const currentYear = new Date().getFullYear();
  const ytdTotal = expenses
    .filter(e => new Date(e.date).getFullYear() === currentYear)
    .reduce((s, e) => s + Number(e.amount), 0);

  async function handleCreate(ev: React.FormEvent) {
    ev.preventDefault();
    if (!form.amount) return;
    setSaving(true);
    try {
      await createExpense({ ...form, isPersonal: true, propertyId: undefined, amount: parseFloat(form.amount) });
      await load();
      setShowForm(false);
      setForm(f => ({ ...f, amount: '', vendor: '', description: '' }));
    } finally { setSaving(false); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this expense?')) return;
    await deleteExpense(id);
    setExpenses(prev => prev.filter(e => e.id !== id));
  }

  return (
    <div>
      {!embedded && (
        <PageHeader title="Personal Expenses" subtitle="Auto loans, insurance, credit cards, and other non-property spending — feeds the &quot;Include personal expenses&quot; toggle on Finances → Budget" />
      )}

      <div className={embedded ? '' : 'p-6 max-w-4xl mx-auto'}>
        <div className="flex items-end justify-between mb-6 flex-wrap gap-3">
          <div className="flex gap-6">
            <div>
              <p className="text-xs text-gray-500">Total</p>
              <p className="text-xl font-semibold text-amber-400">{money(grandTotal)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">YTD {currentYear}</p>
              <p className="text-xl font-semibold text-white">{money(ytdTotal)}</p>
            </div>
          </div>
          <button onClick={() => setShowForm(v => !v)} className="btn-primary text-sm">
            {showForm ? 'Cancel' : '+ Log personal expense'}
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleCreate} className="rounded-xl p-5 mb-6" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Category *</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as ExpenseCategory }))} className="input-dark w-full">
                  {PERSONAL_EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}
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
                <input value={form.vendor} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} className="input-dark w-full" placeholder="e.g. Wells Fargo" />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-gray-400 block mb-1">Description</label>
                <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input-dark w-full" />
              </div>
            </div>
            <button type="submit" disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Log Expense'}</button>
          </form>
        )}

        {loading ? (
          <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>
        ) : (
          <div className="space-y-2">
            {PERSONAL_EXPENSE_CATEGORIES.map(cat => {
              const rows = (byCategory.get(cat) || []).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
              if (rows.length === 0) return null;
              const total = rows.reduce((s, e) => s + Number(e.amount), 0);
              const isOpen = openCategory === cat;
              return (
                <div key={cat} className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
                  <button
                    onClick={() => setOpenCategory(isOpen ? null : cat)}
                    className="w-full flex items-center justify-between px-4 py-3 text-left"
                    style={{ background: 'rgba(255,255,255,0.04)' }}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-white">
                      <span>{CATEGORY_ICONS[cat] || '📄'}</span>
                      {EXPENSE_CATEGORY_LABELS[cat]}
                      <span className="text-xs text-gray-500 font-normal">({rows.length})</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-sm font-semibold text-amber-400">{money(total)}</span>
                      <span className="text-gray-500 text-xs">{isOpen ? '▲' : '▼'}</span>
                    </span>
                  </button>
                  {isOpen && (
                    <table className="w-full text-sm">
                      <tbody className="divide-y divide-white/5">
                        {rows.map(e => (
                          <tr key={e.id}>
                            <td className="px-4 py-2 text-gray-400 text-xs whitespace-nowrap">{format(new Date(e.date), 'MMM d, yyyy')}</td>
                            <td className="px-4 py-2 text-gray-300 text-xs">{e.vendor || e.description || '—'}</td>
                            <td className="px-4 py-2 text-right font-mono text-white">{money(Number(e.amount))}</td>
                            <td className="px-4 py-2 text-right w-16">
                              <button onClick={() => handleDelete(e.id)} className="text-xs text-red-500 hover:text-red-400">Del</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
            {expenses.length === 0 && (
              <p className="text-sm text-gray-500 py-8 text-center">No personal expenses logged yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
