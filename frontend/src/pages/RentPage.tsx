import { Fragment, useEffect, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  getBudgetMonthly, getBudgetDelinquency,
  updateLease,
  getRentPayments,
} from '../api/client';
import RentPaymentTable from '../components/tenant/RentPaymentTable';
import type { RentPayment } from '../types';
import type {
  BudgetSummary, DelinquencyTenant,
} from '../types';
import RentRemindersPanel from '../components/tenant/RentRemindersPanel';
import LogRentPaymentModal from '../components/tenant/LogRentPaymentModal';
import ArrearsAsOfDialog from '../components/tenant/ArrearsAsOfDialog';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmt(n: number, opts?: { sign?: boolean }) {
  const s = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(n));
  if (opts?.sign) return n >= 0 ? `+${s}` : `-${s}`;
  return n < 0 ? `-${s}` : s;
}

function pct(part: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.round((part / total) * 100));
}

function daysAgoLabel(days: number) {
  if (days === 999) return 'Never';
  if (days === 0)   return 'Today';
  if (days === 1)   return '1 day ago';
  return `${days}d ago`;
}

function LikelihoodBadge({ likelihood }: { likelihood: DelinquencyTenant['likelihood'] }) {
  const map = {
    high:   { label: 'Likely',   cls: 'bg-emerald-900/40 text-emerald-500 border border-emerald-700' },
    medium: { label: 'Uncertain',cls: 'bg-amber-900/50  text-amber-500  border border-amber-700'  },
    low:    { label: 'Unlikely', cls: 'bg-orange-900/50 text-orange-400 border border-orange-700' },
    none:   { label: 'Write-off',cls: 'bg-red-900/50    text-red-500    border border-red-700'    },
  };
  const { label, cls } = map[likelihood];
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>;
}

export default function RentPage({ embedded }: { embedded?: boolean } = {}) {
  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [budget,       setBudget]       = useState<BudgetSummary | null>(null);
  const [delinquency,  setDelinquency]  = useState<{ tenants: DelinquencyTenant[]; totalArrears: number; totalExpectedCollection: number } | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [activeTab,       setActiveTab]       = useState<'overview' | 'delinquency'>('overview');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b, d] = await Promise.all([
        getBudgetMonthly(year, month, false),
        getBudgetDelinquency(),
      ]);
      setBudget(b);
      setDelinquency(d);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [year, month]);

  useEffect(() => { load(); }, [load]);


  return (
    <div className={embedded ? 'max-w-7xl' : 'p-6 max-w-7xl mx-auto'}>
      {!embedded && (
        <div className="mb-2">
          <h1 className="text-2xl font-bold text-white">Rent</h1>
          <p className="text-sm text-gray-400 mt-0.5">Rent collection and delinquency</p>
        </div>
      )}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <select value={year} onChange={e => setYear(+e.target.value)} className="input-dark text-sm">
          {[2024,2025,2026,2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={month} onChange={e => setMonth(+e.target.value)} className="input-dark text-sm">
          {MONTHS.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
        </select>
      </div>
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <KpiCard label="Rent Collected" value={fmt(budget?.rent.collected ?? 0)} sub={`of ${fmt(budget?.rent.expected ?? 0)} expected`} color="green" />
        <KpiCard label="Outstanding" value={fmt(budget?.rent.outstanding ?? 0)} sub="this month" color="amber" />
        <KpiCard
          label="Total Arrears"
          value={fmt(delinquency?.totalArrears ?? 0)}
          sub={`expect ${fmt(delinquency?.totalExpectedCollection ?? 0)} back`}
          color="amber"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-white/10">
        {(['overview','delinquency'] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
              activeTab === t
                ? 'text-white border-b-2 border-gold-500 -mb-px'
                : 'text-gray-400 hover:text-gray-200'
            }`}>
            {t === 'delinquency' ? 'Delinquency' : 'This month'}
          </button>
        ))}
      </div>

      {/* Only the first load blanks the page: a refresh after an edit updates in place, so the
          page stays where you were instead of jumping to the top. */}
      {loading && !budget ? (
        <div className="flex items-center justify-center h-64 text-gray-500">Loading…</div>
      ) : (
        <>
          {activeTab === 'overview' && budget && (
            <OverviewTab budget={budget} onChanged={load} />
          )}
          {activeTab === 'delinquency' && delinquency && (
            <DelinquencyTab data={delinquency} onChanged={load} />
          )}
        </>
      )}

    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────

function OverviewTab({ budget, onChanged }: { budget: BudgetSummary; onChanged: () => void }) {
  const { rent } = budget;

  return (
    <div className="space-y-6">
      {/* Rent collection by property */}
      <Section title="Rent Collection" badge={`${fmt(rent.collected)} / ${fmt(rent.expected)}`}>
        <ProgressBar value={rent.collected} total={rent.expected} color="emerald" />
        <div className="mt-3"><RentRemindersPanel /></div>
        <RentCollectionTable rows={rent.rows} outstanding={rent.outstanding} expected={rent.expected} collected={rent.collected} onChanged={onChanged} period={`${budget.year}-${String(budget.month).padStart(2, '0')}`} />
      </Section>

    </div>
  );
}

// ─── Rent Collection table ──
//
// One row per lease, organized the way it is worked through: search by
// tenant, unit or property; quick filters (owes this month, behind on back
// rent, paid…); sort by property, name or what is owed; and grouped by
// property with each property's subtotals, a group folded with a click.
// The choices are remembered between visits.

type RentView = 'all' | 'owes' | 'arrears' | 'paid' | 'partial' | 'unpaid';
const RENT_VIEWS: { key: RentView; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'owes', label: 'Owes this month' }, { key: 'arrears', label: 'Back rent' },
  { key: 'unpaid', label: 'Unpaid' }, { key: 'partial', label: 'Partial' }, { key: 'paid', label: 'Paid' },
];
type RentSort = 'property' | 'tenant' | 'owed' | 'remaining' | 'arrears';
const PREFS = 'sollux:rent-table';
type Prefs = { view: RentView; sort: RentSort; group: boolean; folded: string[] };
const loadPrefs = (): Prefs => {
  const d: Prefs = { view: 'all', sort: 'property', group: true, folded: [] };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') }; } catch { return d; }
};
const savePrefs = (p: Prefs) => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* private window */ } };

function RentCollectionTable({ rows, outstanding, expected, collected, onChanged, period }: {
  /** The month the table is showing, YYYY-MM — what a logged payment applies to by default. */
  period: string;
  rows: import('../types').BudgetRentRow[];
  outstanding: number; expected: number; collected: number;
  onChanged: () => void;
}) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const set = (p: Partial<Prefs>) => setPrefs(cur => { const next = { ...cur, ...p }; savePrefs(next); return next; });
  const [propertyFilter, setPropertyFilter] = useState('all');
  const [q, setQ] = useState('');
  const [logRent, setLogRent] = useState<import('../types').BudgetRentRow | null>(null);
  // The back-rent figure being set from its row (the Arrears cell).
  const [arrearsFor, setArrearsFor] = useState<import('../types').BudgetRentRow | null>(null);
  // Clicking a name opens that lease's payment history under the row.
  const [openLease, setOpenLease] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, RentPayment[] | 'loading'>>({});
  function toggleHistory(leaseId: string) {
    if (openLease === leaseId) { setOpenLease(null); return; }
    setOpenLease(leaseId);
    if (!history[leaseId]) {
      setHistory(h => ({ ...h, [leaseId]: 'loading' }));
      getRentPayments({ leaseId }).then(p => setHistory(h => ({ ...h, [leaseId]: p }))).catch(() => setHistory(h => ({ ...h, [leaseId]: [] })));
    }
  }

  const properties = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.propertyId, r.property);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [rows]);

  const owed = (r: typeof rows[number]) => r.remaining + r.arrearsBalance;
  const matchesView = (r: typeof rows[number], v: RentView) =>
    v === 'all' ? true : v === 'owes' ? r.remaining > 0.005 : v === 'arrears' ? r.arrearsBalance > 0.005 : r.status === v;
  const counts = useMemo(() => Object.fromEntries(RENT_VIEWS.map(v => [v.key, rows.filter(r => matchesView(r, v.key)).length])) as Record<RentView, number>, [rows]);

  const sortedRows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const cmpProp = (a: typeof rows[number], b: typeof rows[number]) =>
      a.property.localeCompare(b.property, undefined, { numeric: true }) || a.unit.localeCompare(b.unit, undefined, { numeric: true });
    return rows
      .filter(r => propertyFilter === 'all' || r.propertyId === propertyFilter)
      .filter(r => matchesView(r, prefs.view))
      .filter(r => words.every(w => `${r.tenant} ${r.unit} ${r.property}`.toLowerCase().includes(w)))
      .sort((a, b) =>
        prefs.sort === 'tenant' ? a.tenant.localeCompare(b.tenant, undefined, { numeric: true })
        : prefs.sort === 'owed' ? owed(b) - owed(a) || cmpProp(a, b)
        : prefs.sort === 'remaining' ? b.remaining - a.remaining || cmpProp(a, b)
        : prefs.sort === 'arrears' ? b.arrearsBalance - a.arrearsBalance || cmpProp(a, b)
        : cmpProp(a, b) || a.tenant.localeCompare(b.tenant));
  }, [rows, propertyFilter, prefs.view, prefs.sort, q]);

  // Grouped by property, in the order the sort puts each property's first row.
  const groups = useMemo(() => {
    if (!prefs.group) return [{ id: '', name: '', rows: sortedRows }];
    const by = new Map<string, { id: string; name: string; rows: typeof sortedRows }>();
    for (const r of sortedRows) {
      const g = by.get(r.propertyId) ?? { id: r.propertyId, name: r.property, rows: [] };
      g.rows.push(r); by.set(r.propertyId, g);
    }
    return [...by.values()];
  }, [sortedRows, prefs.group]);

  const filtered = propertyFilter !== 'all' || prefs.view !== 'all' || q.trim() !== '';
  const sum = (rs: typeof rows, k: 'expected' | 'collected' | 'remaining' | 'arrearsBalance') => rs.reduce((s, r) => s + r[k], 0);
  const totalExpected  = filtered ? sum(sortedRows, 'expected') : expected;
  const totalCollected = filtered ? sum(sortedRows, 'collected') : collected;
  const totalRemaining = filtered ? sum(sortedRows, 'remaining') : outstanding;
  const totalArrears   = sum(sortedRows, 'arrearsBalance');
  const folded = new Set(prefs.folded);
  const fold = (id: string) => set({ folded: folded.has(id) ? prefs.folded.filter(x => x !== id) : [...prefs.folded, id] });
  const chip = (on: boolean) => `text-xs px-2.5 py-1 rounded-full border ${on ? 'border-amber-500 text-amber-400' : 'border-white/10 text-gray-400 hover:text-gray-200'}`;

  const rowEl = (row: typeof rows[number]) => (
    <Fragment key={row.leaseId}>
      <tr className="border-b border-white/5 hover:bg-white/2">
        <td className={`py-2 text-white font-medium ${prefs.group ? 'pl-4' : ''}`}>
          <button onClick={() => toggleHistory(row.leaseId)} className="hover:text-amber-400 text-left" title="Payment history">
            {row.tenant} <span className="text-gray-600 text-xs">{openLease === row.leaseId ? '▴' : '▾'}</span>
          </button>
        </td>
        <td className="py-2 text-gray-400">{prefs.group ? row.unit : `${row.unit} · ${row.property}`}</td>
        <td className="py-2 text-right text-gray-300">{fmt(row.expected)}</td>
        <td className="py-2 text-right text-emerald-500">{fmt(row.collected)}</td>
        <td className="py-2 text-right text-amber-500">{row.remaining > 0 ? fmt(row.remaining) : '—'}</td>
        <td className="py-2 text-right">
          <button onClick={() => setArrearsFor(row)} title="Set or correct back rent"
            className={`${row.arrearsBalance > 0 ? 'text-red-500' : 'text-gray-600'} hover:text-amber-400 hover:underline decoration-dotted`}>
            {row.arrearsBalance > 0 ? fmt(row.arrearsBalance) : '—'}
          </button>
        </td>
        <td className="py-2 pl-3">
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            row.status === 'paid' ? 'bg-emerald-900/40 text-emerald-500' : row.status === 'partial' ? 'bg-amber-900/50 text-amber-500' : 'bg-red-900/50 text-red-500'}`}>
            {row.status}
          </span>
        </td>
        <td className="py-2 text-right">
          {row.status !== 'paid' && <button onClick={() => setLogRent(row)} className="text-xs text-amber-400 hover:text-amber-300">Log payment</button>}
        </td>
      </tr>
      {openLease === row.leaseId && (
        <tr className="border-b border-white/5">
          <td colSpan={8} className="py-3 px-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
            <PaymentHistory row={row} payments={history[row.leaseId]} onLog={() => setLogRent(row)}
              onEdited={() => {
                getRentPayments({ leaseId: row.leaseId }).then(p => setHistory(h => ({ ...h, [row.leaseId]: p }))).catch(() => {});
                onChanged();
              }} />
          </td>
        </tr>
      )}
    </Fragment>
  );

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search tenant, unit or property…" className="input-dark text-xs w-60" />
        <select value={propertyFilter} onChange={e => setPropertyFilter(e.target.value)} className="input-dark text-xs">
          <option value="all">All properties</option>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={prefs.sort} onChange={e => set({ sort: e.target.value as RentSort })} className="input-dark text-xs" title="Sort">
          <option value="property">Sort: property & unit</option>
          <option value="tenant">Sort: tenant name</option>
          <option value="owed">Sort: most owed (month + back rent)</option>
          <option value="remaining">Sort: most left this month</option>
          <option value="arrears">Sort: most back rent</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
          <input type="checkbox" checked={prefs.group} onChange={e => set({ group: e.target.checked })} /> Group by property
        </label>
        {prefs.group && groups.length > 1 && (
          <button onClick={() => set({ folded: folded.size ? [] : groups.map(g => g.id) })} className="text-xs text-gray-500 hover:text-gray-300">
            {folded.size ? 'Expand all' : 'Collapse all'}
          </button>
        )}
        <span className="text-xs text-gray-500 ml-auto">{sortedRows.length} of {rows.length} tenants</span>
      </div>
      <div className="flex gap-1 mb-3 flex-wrap">
        {RENT_VIEWS.map(v => (
          <button key={v.key} onClick={() => set({ view: v.key })} className={chip(prefs.view === v.key)}>
            {v.label} <span className="text-gray-500">{counts[v.key]}</span>
          </button>
        ))}
        {filtered && (
          <button onClick={() => { setPropertyFilter('all'); setQ(''); set({ view: 'all' }); }} className="text-xs text-gray-500 hover:text-gray-300 ml-1">Clear filters</button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-white/5">
              <th className="text-left pb-2">Tenant</th>
              <th className="text-left pb-2">{prefs.group ? 'Unit' : 'Unit / Property'}</th>
              <th className="text-right pb-2">Expected</th>
              <th className="text-right pb-2">Collected</th>
              <th className="text-right pb-2">Remaining</th>
              <th className="text-right pb-2">Arrears</th>
              <th className="text-left pb-2 pl-3">Status</th>
              <th className="text-right pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => prefs.group ? (
              <Fragment key={g.id}>
                <tr className="border-b border-white/10 cursor-pointer select-none" style={{ background: 'rgba(255,255,255,0.025)' }} onClick={() => fold(g.id)}>
                  <td colSpan={2} className="py-2 text-gray-200 font-medium">
                    <span className="text-gray-500 text-xs inline-block w-4">{folded.has(g.id) ? '▸' : '▾'}</span>{g.name}
                    <span className="text-xs text-gray-500 font-normal"> · {g.rows.length} tenant{g.rows.length === 1 ? '' : 's'}{(() => { const n = g.rows.filter(r => r.remaining > 0.005).length; return n ? ` · ${n} owe` : ' · all paid'; })()}</span>
                  </td>
                  <td className="py-2 text-right text-gray-400">{fmt(sum(g.rows, 'expected'))}</td>
                  <td className="py-2 text-right text-emerald-600">{fmt(sum(g.rows, 'collected'))}</td>
                  <td className="py-2 text-right text-amber-600">{sum(g.rows, 'remaining') > 0 ? fmt(sum(g.rows, 'remaining')) : '—'}</td>
                  <td className="py-2 text-right text-red-600">{sum(g.rows, 'arrearsBalance') > 0 ? fmt(sum(g.rows, 'arrearsBalance')) : '—'}</td>
                  <td colSpan={2} />
                </tr>
                {!folded.has(g.id) && g.rows.map(rowEl)}
              </Fragment>
            ) : <Fragment key="flat">{g.rows.map(rowEl)}</Fragment>)}
          </tbody>
          <tfoot>
            <tr className="text-sm font-semibold text-white border-t border-white/10">
              <td colSpan={2} className="pt-2">{filtered ? 'Filtered total' : 'Total'}</td>
              <td className="pt-2 text-right">{fmt(totalExpected)}</td>
              <td className="pt-2 text-right text-emerald-500">{fmt(totalCollected)}</td>
              <td className="pt-2 text-right text-amber-500">{totalRemaining > 0 ? fmt(totalRemaining) : '—'}</td>
              <td className="pt-2 text-right text-red-500">{fmt(totalArrears)}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
        {sortedRows.length === 0 && <p className="text-center text-gray-500 py-8">No tenants match the current filters.</p>}
      </div>

      {logRent && (
        <LogRentPaymentModal
          target={{ leaseId: logRent.leaseId, tenant: logRent.tenant, unit: logRent.unit, property: logRent.property, rent: logRent.expected, arrears: logRent.arrearsBalance, remainingThisMonth: logRent.remaining }}
          period={period}
          onClose={() => setLogRent(null)}
          onSaved={() => { setLogRent(null); onChanged(); }}
        />
      )}
      {arrearsFor && <ArrearsAsOfDialog leaseId={arrearsFor.leaseId} tenant={arrearsFor.tenant} onClose={() => setArrearsFor(null)} onSaved={onChanged} />}
    </div>
  );
}

// ─── Delinquency Tab ──────────────────────────────────────

function DelinquencyTab({ data, onChanged }: {
  data: { tenants: DelinquencyTenant[]; totalArrears: number; totalExpectedCollection: number };
  onChanged: () => void;
}) {
  const [editingLease, setEditingLease] = useState<string | null>(null);
  const [overrideValue, setOverrideValue] = useState<'high' | 'medium' | 'low' | 'none'>('medium');
  const [overrideNote, setOverrideNote] = useState('');
  const [saving, setSaving] = useState(false);

  function openEdit(t: DelinquencyTenant) {
    setOverrideValue(t.likelihood);
    setOverrideNote(t.manualLikelihoodNote ?? '');
    setEditingLease(t.leaseId);
  }

  async function saveOverride(leaseId: string) {
    setSaving(true);
    try {
      await updateLease(leaseId, { manualLikelihood: overrideValue, manualLikelihoodNote: overrideNote || null } as any);
      setEditingLease(null);
      onChanged();
    } finally { setSaving(false); }
  }

  async function clearOverride(leaseId: string) {
    setSaving(true);
    try {
      await updateLease(leaseId, { manualLikelihood: null, manualLikelihoodNote: null } as any);
      setEditingLease(null);
      onChanged();
    } finally { setSaving(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-6 p-4 rounded-xl border border-white/10 bg-white/3 mb-2">
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wider">Total Outstanding Arrears</p>
          <p className="text-2xl font-bold text-red-500 mt-0.5">{fmt(data.totalArrears)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wider">Realistically Collectible</p>
          <p className="text-2xl font-bold text-amber-500 mt-0.5">{fmt(data.totalExpectedCollection)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wider">Likely Write-off</p>
          <p className="text-2xl font-bold text-gray-400 mt-0.5">{fmt(data.totalArrears - data.totalExpectedCollection)}</p>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        Scores are calculated from payment recency, frequency, and average payment ratio over the last 6 months. Click a likelihood badge to flag your own read on a tenant instead — it overrides the automated score until cleared.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-white/5">
              <th className="text-left pb-2">Tenant</th>
              <th className="text-left pb-2">Unit · Property</th>
              <th className="text-right pb-2">Monthly Rent</th>
              <th className="text-right pb-2">Arrears</th>
              <th className="text-right pb-2">Last Payment</th>
              <th className="text-right pb-2">Avg/mo (6m)</th>
              <th className="text-center pb-2">Score</th>
              <th className="text-center pb-2">Likelihood</th>
              <th className="text-right pb-2">Expect to Collect</th>
            </tr>
          </thead>
          <tbody>
            {data.tenants.map(t => (
              <Fragment key={t.leaseId}>
                <tr className="border-b border-white/5 hover:bg-white/2">
                  <td className="py-2 text-white font-medium">
                    {t.tenantId
                      ? <Link to={`/tenants/${t.tenantId}`} className="hover:text-amber-400">{t.tenant}</Link>
                      : t.tenant}
                  </td>
                  <td className="py-2 text-gray-400">{t.unit} · {t.property}</td>
                  <td className="py-2 text-right text-gray-300">{fmt(t.monthlyRent)}</td>
                  <td className="py-2 text-right text-red-500 font-semibold">{fmt(t.arrears)}</td>
                  <td className="py-2 text-right">
                    <span className={t.daysSincePay > 30 ? 'text-red-500' : 'text-gray-300'}>
                      {daysAgoLabel(t.daysSincePay)}
                    </span>
                    {t.lastPaymentAmount > 0 && (
                      <span className="ml-1 text-gray-500 text-xs">({fmt(t.lastPaymentAmount)})</span>
                    )}
                  </td>
                  <td className="py-2 text-right text-gray-400">{fmt(t.recentMonthlyAvg)}</td>
                  <td className="py-2 text-center">
                    <ScoreBar score={t.score} />
                  </td>
                  <td className="py-2 text-center">
                    <button onClick={() => editingLease === t.leaseId ? setEditingLease(null) : openEdit(t)} className="inline-flex items-center gap-1">
                      <LikelihoodBadge likelihood={t.likelihood} />
                      {t.isManualOverride && <span title={`Flagged manually${t.manualLikelihoodNote ? ': ' + t.manualLikelihoodNote : ''} (auto score says ${t.computedLikelihood})`} className="text-xs text-amber-400">edited</span>}
                    </button>
                  </td>
                  <td className="py-2 text-right font-semibold">
                    <span className={t.likelihood === 'none' ? 'text-gray-500 line-through' : 'text-amber-500'}>
                      {fmt(t.expectedCollection)}
                    </span>
                  </td>
                </tr>
                {editingLease === t.leaseId && (
                  <tr className="border-b border-white/5">
                    <td colSpan={9} className="py-3 px-2" style={{ background: 'rgba(255,255,255,0.02)' }}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-gray-500">Flag {t.tenant} as:</span>
                        {(['high', 'medium', 'low', 'none'] as const).map(l => (
                          <button key={l} onClick={() => setOverrideValue(l)}
                            className={`text-xs px-2 py-1 rounded-full border ${overrideValue === l ? 'border-amber-500 text-amber-400' : 'border-white/10 text-gray-400 hover:text-gray-200'}`}>
                            {l === 'high' ? 'Likely to pay' : l === 'medium' ? 'Uncertain' : l === 'low' ? 'Unlikely' : 'Write-off'}
                          </button>
                        ))}
                        <input value={overrideNote} onChange={e => setOverrideNote(e.target.value)} placeholder="Optional note (why?)"
                          className="field-input text-xs flex-1 min-w-40" />
                        <button onClick={() => saveOverride(t.leaseId)} disabled={saving} className="btn-primary text-xs px-3 py-1.5">{saving ? '…' : 'Save flag'}</button>
                        {t.isManualOverride && <button onClick={() => clearOverride(t.leaseId)} disabled={saving} className="text-xs text-gray-500 hover:text-gray-300">Reset to automated</button>}
                        <button onClick={() => setEditingLease(null)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {data.tenants.length === 0 && (
          <p className="text-center text-gray-500 py-12">No tenants with outstanding arrears.</p>
        )}
      </div>
    </div>
  );
}

// ─── Forecast Tab ───────────────────────────────────────────


// ─── Reusable bits ────────────────────────────────────────

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'text-blue-500', green: 'text-emerald-500', red: 'text-red-600', amber: 'text-amber-500',
  };
  return (
    <div className="rounded-xl border border-white/10 bg-white/3 p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold ${colors[color] ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-1">{sub}</p>}
    </div>
  );
}

function Section({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/3 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        {badge && <span className="text-sm text-gray-400">{badge}</span>}
      </div>
      {children}
    </div>
  );
}

function ProgressBar({ value, total, color }: { value: number; total: number; color: 'emerald' | 'blue' }) {
  const p = pct(value, total);
  const colors = { emerald: 'bg-emerald-500', blue: 'bg-blue-500' };
  return (
    <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${colors[color]}`} style={{ width: `${p}%` }} />
    </div>
  );
}


function ScoreBar({ score }: { score: number }) {
  const color = score >= 65 ? 'bg-emerald-500' : score >= 40 ? 'bg-amber-500' : score >= 20 ? 'bg-orange-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-1.5 justify-center">
      <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs text-gray-400">{score}</span>
    </div>
  );
}

// ─── Payment history under a rent row ─────────────────────

function PaymentHistory({ row, payments, onLog, onEdited }: {
  row: import('../types').BudgetRentRow;
  payments: RentPayment[] | 'loading' | undefined;
  onLog: () => void;
  /** A payment was changed or deleted: reload the history and the table. */
  onEdited: () => void;
}) {
  const [settingArrears, setSettingArrears] = useState(false);
  const money = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const list = Array.isArray(payments) ? payments.slice(0, 24) : [];
  const total12 = Array.isArray(payments)
    ? payments.filter(p => p.status === 'RECEIVED' && new Date(p.paidDate) >= new Date(Date.now() - 365 * 86400000)).reduce((s, p) => s + Number(p.amount), 0)
    : 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-400">
          Payment history · {row.unit} · {row.property}
          {Array.isArray(payments) && <span className="text-gray-600"> · {money(total12)} received in the last 12 months</span>}
        </p>
        <div className="flex items-center gap-3">
          <button onClick={onLog} className="text-xs text-amber-400 hover:text-amber-300">Log payment</button>
          <button onClick={() => setSettingArrears(true)} className="text-xs text-gray-400 hover:text-amber-400" title="Set back rent from a figure you know, like a 3-day notice's total">Set back rent…</button>
          {settingArrears && <ArrearsAsOfDialog leaseId={row.leaseId} tenant={row.tenant} onClose={() => setSettingArrears(false)} onSaved={onEdited} />}
          {row.tenantId && <Link to={`/tenants/${row.tenantId}`} className="text-xs text-gray-400 hover:text-amber-400">Tenant page →</Link>}
        </div>
      </div>
      {payments === 'loading' || payments === undefined ? (
        <p className="text-xs text-gray-600">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-xs text-gray-600">No payments logged for this lease.</p>
      ) : (
        <RentPaymentTable payments={list} onEdited={onEdited} />
      )}
    </div>
  );
}

// ─── Modals ───────────────────────────────────────────────
