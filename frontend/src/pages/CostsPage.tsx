import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getCosts, createExpense, deleteExpense, type CostLedger, type CostLine, type CostType } from '../api/client';
import type { ExpenseCategory } from '../types';
import { EXPENSE_CATEGORY_LABELS } from '../types';
import { fmtMoney } from '../lib/money';
import { fmtDate, todayISO } from '../lib/date';
import { describeApiError } from '../lib/apiError';

/**
 * Costs: what each property cost, every dollar under one type — utilities,
 * insurance, property tax, HOA, maintenance, management, other — with debt
 * service and capital work kept below the operating line. Bills come in as
 * one line per account (the bills themselves are on the Bills page), loans
 * as their payments, taxes as their installments, and what is logged by
 * hand as itself. "Charged" counts a cost in the month it was due; "Paid"
 * in the month the money left (backend lib/costLedger.ts).
 */

const TYPES: { key: CostType; label: string; operating: boolean; color: string }[] = [
  { key: 'UTILITIES', label: 'Utilities', operating: true, color: '#3b82f6' },
  { key: 'INSURANCE', label: 'Insurance', operating: true, color: '#af52de' },
  { key: 'PROPERTY_TAX', label: 'Property tax', operating: true, color: '#34c759' },
  { key: 'HOA', label: 'HOA', operating: true, color: '#30b0c7' },
  { key: 'MAINTENANCE', label: 'Maintenance & repairs', operating: true, color: '#ff9f0a' },
  { key: 'MANAGEMENT', label: 'Management', operating: true, color: '#a2845e' },
  { key: 'OTHER', label: 'Other', operating: true, color: '#8e8e93' },
  { key: 'DEBT_SERVICE', label: 'Debt service', operating: false, color: '#ff6b6b' },
  { key: 'CAPITAL', label: 'Capital improvements', operating: false, color: '#64d2ff' },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]}${m.endsWith('-01') ? ` ’${m.slice(2, 4)}` : ''}`;

/** What can be logged by hand, the categories grouped the way the ledger types them. */
const LOG_CATEGORIES: ExpenseCategory[] = [
  'REPAIRS_MAINTENANCE', 'HANDYMAN', 'LANDSCAPING', 'SUPPLIES', 'PROPERTY_MANAGEMENT', 'CAPITAL_IMPROVEMENT',
  'INSURANCE', 'PROPERTY_TAX', 'HOA', 'UTILITIES', 'LEGAL', 'PERMITS', 'CITATIONS_FINES', 'ADVERTISING', 'TRAVEL', 'OTHER',
];

type Period = 'last12' | `${number}`;
function rangeOf(period: Period): [string, string] {
  if (period === 'last12') {
    const now = todayISO().slice(0, 7);
    const [y, m] = now.split('-').map(Number);
    const startY = m === 12 ? y : y - 1, startM = m === 12 ? 1 : m + 1;
    return [`${startY}-${String(startM).padStart(2, '0')}`, now];
  }
  return [`${period}-01`, `${period}-12`];
}
const fmt0 = (v: number) => (v ? `$${Math.round(v).toLocaleString('en-US')}` : '');

export default function CostsPage() {
  const thisYear = Number(todayISO().slice(0, 4));
  const [period, setPeriod] = useState<Period>(String(thisYear) as Period);
  const [pid, setPid] = useState('all');
  const [measure, setMeasure] = useState<'charged' | 'paid'>('charged');
  const [data, setData] = useState<CostLedger | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [logging, setLogging] = useState(false);

  const load = useCallback(async () => {
    const [from, to] = rangeOf(period);
    try { setData(await getCosts(from, to, pid === 'all' ? undefined : pid)); setError(''); }
    catch (e) { setError(describeApiError(e, 'Could not load the costs.')); }
  }, [period, pid]);
  useEffect(() => { void load(); }, [load]);

  const names = useMemo(() => new Map((data?.properties ?? []).map(p => [p.id, p.name])), [data]);
  const val = (l: CostLine, m: string) => l.months[m]?.[measure] ?? 0;
  const lineTotal = (l: CostLine) => (data?.months ?? []).reduce((t, m) => t + val(l, m), 0);

  const sections = useMemo(() => TYPES.map(t => {
    const lines = (data?.lines ?? []).filter(l => l.type === t.key && lineTotal(l) !== 0)
      .sort((a, b) => lineTotal(b) - lineTotal(a));
    return { ...t, lines, total: lines.reduce((s, l) => s + lineTotal(l), 0) };
  }).filter(s => s.lines.length), [data, measure]); // eslint-disable-line react-hooks/exhaustive-deps

  const operating = sections.filter(s => s.operating).reduce((t, s) => t + s.total, 0);
  const debt = sections.find(s => s.key === 'DEBT_SERVICE')?.total ?? 0;
  const capital = sections.find(s => s.key === 'CAPITAL')?.total ?? 0;
  const toggle = (k: string) => setOpen(o => { const n = new Set(o); n.has(k) ? n.delete(k) : n.add(k); return n; });

  async function remove(id: string) {
    if (!confirm('Delete this expense?')) return;
    try { await deleteExpense(id); void load(); } catch (e) { alert(describeApiError(e, 'Could not delete it.')); }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select className="input-dark text-sm" value={period} onChange={e => setPeriod(e.target.value as Period)}>
          <option value="last12">Last 12 months</option>
          {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select className="input-dark text-sm" value={pid} onChange={e => setPid(e.target.value)}>
          <option value="all">All properties</option>
          {(data?.properties ?? []).filter(p => !p.sold).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="inline-flex rounded-lg p-0.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
          {(['charged', 'paid'] as const).map(m => (
            <button key={m} onClick={() => setMeasure(m)} title={m === 'charged' ? 'Counted in the month each bill was due' : 'Counted in the month the money left'}
              className={`text-xs px-3 py-1.5 rounded-md ${measure === m ? 'bg-white/10 text-white font-medium' : 'text-gray-400 hover:text-gray-200'}`}>
              {m === 'charged' ? 'Charged (month due)' : 'Paid (month paid)'}
            </button>
          ))}
        </div>
        <button onClick={() => setLogging(true)} className="btn-primary text-sm ml-auto px-3 py-1.5">+ Log a cost</button>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
      {!data && !error && <p className="text-sm text-gray-500">Loading…</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
            <Stat label="Operating costs" value={operating} hint="utilities, insurance, tax, HOA, maintenance, management, other" />
            <Stat label="Debt service" value={debt} hint="loan payments" />
            <Stat label="Capital improvements" value={capital} hint="kept out of operating cost" />
          </div>
          {operating > 0 && (
            <div className="mb-6">
              <div className="flex h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                {sections.filter(s => s.operating).map(s => <div key={s.key} style={{ width: `${(s.total / operating) * 100}%`, background: s.color }} title={`${s.label} ${fmtMoney(s.total)}`} />)}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-400">
                {sections.filter(s => s.operating).map(s => (
                  <span key={s.key} className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: s.color }} />{s.label} {fmtMoney(s.total)} · {Math.round((s.total / operating) * 100)}%</span>
                ))}
              </div>
            </div>
          )}

          {!sections.length && <p className="text-sm text-gray-500">No costs in this period.</p>}

          <div className="space-y-5">
            {sections.map(s => (
              <section key={s.key} className="rounded-xl overflow-hidden" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="px-4 py-3 flex items-baseline gap-2 border-b border-white/5">
                  <span className="w-2 h-2 rounded-full self-center" style={{ background: s.color }} />
                  <span className="font-semibold text-white">{s.label}</span>
                  {!s.operating && <span className="text-xs text-gray-500">below the operating line</span>}
                  <span className="ml-auto font-semibold tabular-nums text-white">{fmtMoney(s.total)}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="text-xs w-full table-fixed" style={{ minWidth: 980 }}>
                    <colgroup><col style={{ width: 240 }} />{data.months.map(m => <col key={m} />)}<col style={{ width: 104 }} /></colgroup>
                    <thead>
                      <tr className="text-gray-500">
                        <th className="text-left font-medium px-3 py-2 sticky left-0 z-10" style={{ background: '#1e1e1e' }}>{s.key === 'MAINTENANCE' || s.key === 'OTHER' ? 'Vendor' : 'Account'}</th>
                        {data.months.map(m => <th key={m} className="text-right font-medium px-2 py-2">{monthLabel(m)}</th>)}
                        <th className="text-right font-medium px-3 py-2">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.lines.map(l => (
                        <Fragment key={l.key}>
                          <tr className="border-t border-white/5 hover:bg-white/[0.02]">
                            <td className="px-3 py-2 sticky left-0 z-10" style={{ background: '#1e1e1e' }}>
                              {l.link
                                ? <Link to={l.link} className="text-gray-100 hover:text-amber-400 font-medium">{l.label}</Link>
                                : l.items ? <button onClick={() => toggle(l.key)} className="text-gray-100 hover:text-amber-400 font-medium text-left">{open.has(l.key) ? '▾' : '▸'} {l.label}</button>
                                : <span className="text-gray-100 font-medium">{l.label}</span>}
                              <div className="text-gray-500 truncate">{[pid === 'all' ? names.get(l.propertyId) : null, l.sub].filter(Boolean).join(' · ')}</div>
                            </td>
                            {data.months.map(m => <td key={m} className="px-2 py-2 text-right tabular-nums text-gray-300">{fmt0(val(l, m))}</td>)}
                            <td className="px-3 py-2 text-right tabular-nums font-medium text-white">{fmtMoney(lineTotal(l))}</td>
                          </tr>
                          {l.items && open.has(l.key) && l.items.map(it => (
                            <tr key={it.expenseId} className="text-gray-400">
                              <td className="pl-8 pr-3 py-1.5 sticky left-0 z-10" style={{ background: '#1e1e1e' }}>
                                {fmtDate(it.date)} · <span className="text-gray-300">{fmtMoney(it.charged)}</span>
                                {it.expenseId && <button onClick={() => void remove(it.expenseId!)} className="ml-2 text-gray-600 hover:text-red-400">Delete</button>}
                              </td>
                              <td colSpan={data.months.length + 1} className="px-2 py-1.5 truncate">{it.label}</td>
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                      <tr className="border-t border-white/10 font-medium">
                        <td className="px-3 py-2 sticky left-0 z-10 text-gray-400" style={{ background: '#1e1e1e' }}>Total</td>
                        {data.months.map(m => <td key={m} className="px-2 py-2 text-right tabular-nums text-gray-200">{fmt0(s.lines.reduce((t, l) => t + val(l, m), 0))}</td>)}
                        <td className="px-3 py-2 text-right tabular-nums text-white">{fmtMoney(s.total)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        </>
      )}

      {logging && <LogCost properties={(data?.properties ?? []).filter(p => !p.sold)} defaultProperty={pid === 'all' ? '' : pid} onClose={() => setLogging(false)} onSaved={() => { setLogging(false); void load(); }} />}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-xl font-semibold text-white tabular-nums mt-0.5">{fmtMoney(value)}</p>
      <p className="text-[11px] text-gray-600 mt-0.5">{hint}</p>
    </div>
  );
}

function LogCost({ properties, defaultProperty, onClose, onSaved }: {
  properties: { id: string; name: string }[]; defaultProperty: string; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({ propertyId: defaultProperty, category: 'REPAIRS_MAINTENANCE' as ExpenseCategory, amount: '', date: todayISO(), vendor: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    const amount = parseFloat(f.amount);
    if (!f.propertyId) { setErr('Choose the property.'); return; }
    if (!(amount > 0)) { setErr('Enter the amount.'); return; }
    setSaving(true); setErr('');
    try {
      await createExpense({ propertyId: f.propertyId, category: f.category, amount, date: f.date, vendor: f.vendor || null, description: f.description || null, isCapEx: f.category === 'CAPITAL_IMPROVEMENT', isPersonal: false } as any);
      onSaved();
    } catch (e) { setErr(describeApiError(e, 'Could not save it.')); }
    finally { setSaving(false); }
  }
  const label = 'block text-xs text-gray-500 mb-1';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-5 space-y-3" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <p className="font-semibold text-white">Log a cost</p>
            <p className="text-xs text-gray-500">A repair, a handyman, a management fee — what is not a bill. Bills come in on their own.</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">✕</button>
        </div>
        <div>
          <label className={label}>Property</label>
          <select className="input-dark w-full text-sm" value={f.propertyId} onChange={e => setF({ ...f, propertyId: e.target.value })}>
            <option value="">Choose…</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Type</label>
            <select className="input-dark w-full text-sm" value={f.category} onChange={e => setF({ ...f, category: e.target.value as ExpenseCategory })}>
              {LOG_CATEGORIES.map(c => <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>Amount</label>
            <input className="input-dark w-full text-sm" inputMode="decimal" placeholder="0.00" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} />
          </div>
          <div>
            <label className={label}>Date</label>
            <input type="date" className="input-dark w-full text-sm" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} />
          </div>
          <div>
            <label className={label}>Vendor</label>
            <input className="input-dark w-full text-sm" placeholder="Who was paid" value={f.vendor} onChange={e => setF({ ...f, vendor: e.target.value })} />
          </div>
        </div>
        <div>
          <label className={label}>What for</label>
          <input className="input-dark w-full text-sm" placeholder="Replaced water heater" value={f.description} onChange={e => setF({ ...f, description: e.target.value })} />
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={() => void save()} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
