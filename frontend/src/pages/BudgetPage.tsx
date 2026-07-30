import { Fragment, useEffect, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  getBudgetMonthly, getBudgetDelinquency,
  getBankAccounts, createBankAccount, updateBankAccount, deleteBankAccount, recordBankBalance,
  createOtherIncome, deleteOtherIncome, updateLease,
} from '../api/client';
import type {
  BudgetSummary, BankAccount, DelinquencyTenant, OtherIncome,
  BankAccountType, OtherIncomeCategory,
} from '../types';
import { OTHER_INCOME_LABELS } from '../types';

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

const ACCT_TYPE_LABELS: Record<BankAccountType, string> = {
  CHECKING:    'Checking',
  SAVINGS:     'Savings',
  CREDIT_CARD: 'Credit Card',
  CASH_POOL:   'Cash / Venmo',
};

export default function BudgetPage({ embedded }: { embedded?: boolean } = {}) {
  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [budget,       setBudget]       = useState<BudgetSummary | null>(null);
  const [delinquency,  setDelinquency]  = useState<{ tenants: DelinquencyTenant[]; totalArrears: number; totalExpectedCollection: number } | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [activeTab,       setActiveTab]       = useState<'overview' | 'delinquency' | 'banks' | 'income'>('overview');
  const [includePersonal, setIncludePersonal] = useState(false);

  // Modals / forms
  const [showAddBank,   setShowAddBank]   = useState(false);
  const [showAddIncome, setShowAddIncome] = useState(false);
  const [balanceModal,  setBalanceModal]  = useState<BankAccount | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b, d, ba] = await Promise.all([
        getBudgetMonthly(year, month, includePersonal),
        getBudgetDelinquency(),
        getBankAccounts(),
      ]);
      setBudget(b);
      setDelinquency(d);
      setBankAccounts(ba);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [year, month, includePersonal]);

  useEffect(() => { load(); }, [load]);

  const cashOnHand = budget?.cashSummary.totalCashOnHand ?? 0;
  const net        = budget?.summary.realisticNet ?? 0;
  const idealNet   = budget?.summary.idealNet ?? 0;

  return (
    <div className={embedded ? 'max-w-7xl' : 'p-6 max-w-7xl mx-auto'}>
      {!embedded && (
        <div className="mb-2">
          <h1 className="text-2xl font-bold text-white">Budget</h1>
          <p className="text-sm text-gray-400 mt-0.5">Monthly cash position, rent collection &amp; delinquency analysis</p>
        </div>
      )}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <select value={year} onChange={e => setYear(+e.target.value)} className="input-dark text-sm">
          {[2024,2025,2026,2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={month} onChange={e => setMonth(+e.target.value)} className="input-dark text-sm">
          {MONTHS.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
        </select>
        <label className="flex items-center gap-2 cursor-pointer select-none ml-auto">
          <div
            onClick={() => setIncludePersonal(v => !v)}
            className="relative w-8 h-4 rounded-full transition-colors flex-shrink-0"
            style={{ background: includePersonal ? '#F5A623' : 'rgba(255,255,255,0.15)' }}
          >
            <div
              className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
              style={{ transform: includePersonal ? 'translateX(18px)' : 'translateX(2px)' }}
            />
          </div>
          <span className="text-xs text-gray-400">Include personal expenses</span>
        </label>
      </div>
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <KpiCard label="Cash On Hand" value={fmt(cashOnHand)} sub="bank + cash pools" color="blue" />
        <KpiCard
          label="Net Position (realistic)"
          value={fmt(net, { sign: true })}
          sub="after mortgages & expenses"
          color={net >= 0 ? 'green' : 'red'}
        />
        <KpiCard
          label="Net Position (ideal)"
          value={fmt(idealNet, { sign: true })}
          sub="if all rent collected"
          color={idealNet >= 0 ? 'green' : 'amber'}
        />
        <KpiCard
          label="Total Arrears"
          value={fmt(delinquency?.totalArrears ?? 0)}
          sub={`expect ${fmt(delinquency?.totalExpectedCollection ?? 0)} back`}
          color="amber"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-white/10">
        {(['overview','delinquency','banks','income'] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
              activeTab === t
                ? 'text-white border-b-2 border-gold-500 -mb-px'
                : 'text-gray-400 hover:text-gray-200'
            }`}>
            {t === 'delinquency' ? 'Delinquency' : t === 'banks' ? 'Banks & Cash' : t === 'income' ? 'Other Income' : 'Overview'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64 text-gray-500">Loading…</div>
      ) : (
        <>
          {activeTab === 'overview' && budget && (
            <OverviewTab budget={budget} />
          )}
          {activeTab === 'delinquency' && delinquency && (
            <DelinquencyTab data={delinquency} onChanged={load} />
          )}
          {activeTab === 'banks' && (
            <BanksTab
              accounts={bankAccounts}
              onAddAccount={() => setShowAddBank(true)}
              onUpdateBalance={acct => setBalanceModal(acct)}
              onDelete={async id => { await deleteBankAccount(id); load(); }}
            />
          )}
          {activeTab === 'income' && budget && (
            <OtherIncomeTab
              rows={budget.otherIncome.rows}
              total={budget.otherIncome.total}
              onAdd={() => setShowAddIncome(true)}
              onDelete={async id => { await deleteOtherIncome(id); load(); }}
            />
          )}
        </>
      )}

      {/* Modals */}
      {showAddBank && (
        <AddBankModal
          onClose={() => setShowAddBank(false)}
          onSave={async data => { await createBankAccount(data); setShowAddBank(false); load(); }}
        />
      )}
      {balanceModal && (
        <BalanceModal
          account={balanceModal}
          onClose={() => setBalanceModal(null)}
          onSave={async (id, data) => { await recordBankBalance(id, data); setBalanceModal(null); load(); }}
        />
      )}
      {showAddIncome && (
        <AddIncomeModal
          year={year} month={month}
          onClose={() => setShowAddIncome(false)}
          onSave={async data => { await createOtherIncome(data); setShowAddIncome(false); load(); }}
        />
      )}
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────

function OverviewTab({ budget }: { budget: BudgetSummary }) {
  const { rent, mortgages } = budget;
  return (
    <div className="space-y-6">
      {/* Rent collection by property */}
      <Section title="Rent Collection" badge={`${fmt(rent.collected)} / ${fmt(rent.expected)}`}>
        <ProgressBar value={rent.collected} total={rent.expected} color="emerald" />
        <RentCollectionTable rows={rent.rows} outstanding={rent.outstanding} expected={rent.expected} collected={rent.collected} />
      </Section>

      {/* Mortgages */}
      <Section title="Mortgages" badge={`${fmt(mortgages.paid)} paid of ${fmt(mortgages.total)}`}>
        <ProgressBar value={mortgages.paid} total={mortgages.total} color="blue" />
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-white/5">
                <th className="text-left pb-2">Lender</th>
                <th className="text-left pb-2">Property</th>
                <th className="text-right pb-2">Monthly</th>
                <th className="text-right pb-2">Paid</th>
                <th className="text-left pb-2 pl-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {mortgages.rows.map(row => (
                <tr key={row.loanId} className="border-b border-white/5 hover:bg-white/2">
                  <td className="py-2 text-white">{row.lender}</td>
                  <td className="py-2 text-gray-400">{row.property}</td>
                  <td className="py-2 text-right text-gray-300">{fmt(row.monthlyPayment)}</td>
                  <td className="py-2 text-right text-emerald-500">{row.paid > 0 ? fmt(row.paid) : '—'}</td>
                  <td className="py-2 pl-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      row.status === 'paid'
                        ? 'bg-emerald-900/40 text-emerald-500'
                        : 'bg-red-900/50 text-red-500'
                    }`}>{row.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="text-sm font-semibold text-white border-t border-white/10">
                <td colSpan={2} className="pt-2">Total</td>
                <td className="pt-2 text-right">{fmt(mortgages.total)}</td>
                <td className="pt-2 text-right text-emerald-500">{fmt(mortgages.paid)}</td>
                <td className="pt-2 pl-3 text-red-500">{mortgages.unpaid > 0 ? `${fmt(mortgages.unpaid)} left` : '✓'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>

      {/* Summary */}
      <Section title="Month Summary">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <SummaryLine label="Rent collected" value={fmt(budget.rent.collected)} color="emerald" />
          <SummaryLine label="Other income"   value={fmt(budget.otherIncome.total)} color="emerald" />
          <SummaryLine label="Total income"   value={fmt(budget.summary.totalIncome)} color="emerald" bold />
          <SummaryLine label="Mortgages"      value={fmt(budget.mortgages.total)} color="red" />
          <SummaryLine label="Other expenses" value={fmt(budget.expenses.total)} color="red" />
          <SummaryLine label="Total expenses" value={fmt(budget.summary.totalExpenses)} color="red" bold />
          <div className="col-span-2 md:col-span-3 border-t border-white/10 pt-3 grid grid-cols-2 gap-4">
            <SummaryLine label="Realistic net (rent collected so far)" value={fmt(budget.summary.realisticNet, { sign: true })} color={budget.summary.realisticNet >= 0 ? 'emerald' : 'red'} bold />
            <SummaryLine label="Ideal net (all rent received)" value={fmt(budget.summary.idealNet, { sign: true })} color={budget.summary.idealNet >= 0 ? 'emerald' : 'amber'} bold />
          </div>
        </div>
      </Section>
    </div>
  );
}

// ─── Rent Collection table (filterable, sorted by property) ──

const RENT_STATUS_FILTERS = ['all', 'paid', 'partial', 'unpaid'] as const;
type RentStatusFilter = typeof RENT_STATUS_FILTERS[number];

function RentCollectionTable({ rows, outstanding, expected, collected }: {
  rows: import('../types').BudgetRentRow[];
  outstanding: number; expected: number; collected: number;
}) {
  const [propertyFilter, setPropertyFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<RentStatusFilter>('all');

  const properties = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.propertyId, r.property);
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [rows]);

  const sortedRows = useMemo(() => {
    return [...rows]
      .filter(r => propertyFilter === 'all' || r.propertyId === propertyFilter)
      .filter(r => statusFilter === 'all' || r.status === statusFilter)
      .sort((a, b) =>
        a.property.localeCompare(b.property, undefined, { numeric: true }) ||
        a.unit.localeCompare(b.unit, undefined, { numeric: true }) ||
        a.tenant.localeCompare(b.tenant, undefined, { numeric: true })
      );
  }, [rows, propertyFilter, statusFilter]);

  const filtered = propertyFilter !== 'all' || statusFilter !== 'all';
  const totalExpected  = filtered ? sortedRows.reduce((s, r) => s + r.expected, 0) : expected;
  const totalCollected = filtered ? sortedRows.reduce((s, r) => s + r.collected, 0) : collected;
  const totalRemaining = sortedRows.reduce((s, r) => s + r.remaining, 0);
  const totalArrears   = sortedRows.reduce((s, r) => s + r.arrearsBalance, 0);

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <select value={propertyFilter} onChange={e => setPropertyFilter(e.target.value)} className="input-dark text-xs">
          <option value="all">All properties</option>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="flex gap-1">
          {RENT_STATUS_FILTERS.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`text-xs px-2.5 py-1 rounded-full border capitalize ${
                statusFilter === s
                  ? 'border-amber-500 text-amber-400'
                  : 'border-white/10 text-gray-400 hover:text-gray-200'
              }`}>
              {s}
            </button>
          ))}
        </div>
        {filtered && (
          <button onClick={() => { setPropertyFilter('all'); setStatusFilter('all'); }}
            className="text-xs text-gray-500 hover:text-gray-300 ml-1">Clear filters</button>
        )}
        <span className="text-xs text-gray-500 ml-auto">{sortedRows.length} of {rows.length} tenants</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-white/5">
              <th className="text-left pb-2">Tenant</th>
              <th className="text-left pb-2">Unit / Property</th>
              <th className="text-right pb-2">Expected</th>
              <th className="text-right pb-2">Collected</th>
              <th className="text-right pb-2">Remaining</th>
              <th className="text-right pb-2">Arrears</th>
              <th className="text-left pb-2 pl-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(row => (
              <tr key={row.leaseId} className="border-b border-white/5 hover:bg-white/2">
                <td className="py-2 text-white font-medium">
                  {row.tenantId
                    ? <Link to={`/tenants/${row.tenantId}`} className="hover:text-amber-400">{row.tenant}</Link>
                    : row.tenant}
                </td>
                <td className="py-2 text-gray-400">{row.unit} · {row.property}</td>
                <td className="py-2 text-right text-gray-300">{fmt(row.expected)}</td>
                <td className="py-2 text-right text-emerald-500">{fmt(row.collected)}</td>
                <td className="py-2 text-right text-amber-500">{row.remaining > 0 ? fmt(row.remaining) : '—'}</td>
                <td className="py-2 text-right text-red-500">{row.arrearsBalance > 0 ? fmt(row.arrearsBalance) : '—'}</td>
                <td className="py-2 pl-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    row.status === 'paid'    ? 'bg-emerald-900/40 text-emerald-500' :
                    row.status === 'partial' ? 'bg-amber-900/50 text-amber-500' :
                                               'bg-red-900/50 text-red-500'
                  }`}>
                    {row.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="text-sm font-semibold text-white border-t border-white/10">
              <td colSpan={2} className="pt-2">{filtered ? 'Filtered total' : 'Total'}</td>
              <td className="pt-2 text-right">{fmt(totalExpected)}</td>
              <td className="pt-2 text-right text-emerald-500">{fmt(totalCollected)}</td>
              <td className="pt-2 text-right text-amber-500">{(filtered ? totalRemaining : outstanding) > 0 ? fmt(filtered ? totalRemaining : outstanding) : '—'}</td>
              <td className="pt-2 text-right text-red-500">{fmt(totalArrears)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        {sortedRows.length === 0 && (
          <p className="text-center text-gray-500 py-8">No tenants match the current filters.</p>
        )}
      </div>
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
                      {t.isManualOverride && <span title={`Flagged manually${t.manualLikelihoodNote ? ': ' + t.manualLikelihoodNote : ''} (auto score says ${t.computedLikelihood})`} className="text-xs text-amber-400">✎</span>}
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

// ─── Banks Tab ────────────────────────────────────────────

function BanksTab({
  accounts, onAddAccount, onUpdateBalance, onDelete,
}: {
  accounts: BankAccount[];
  onAddAccount: () => void;
  onUpdateBalance: (a: BankAccount) => void;
  onDelete: (id: string) => void;
}) {
  const bankAccts = accounts.filter(a => a.accountType !== 'CASH_POOL');
  const cashPools = accounts.filter(a => a.accountType === 'CASH_POOL');
  const totalBank = bankAccts.reduce((s, a) => s + a.balance, 0);
  const totalCash = cashPools.reduce((s, a) => s + a.balance, 0);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex gap-6">
          <div><p className="text-xs text-gray-500 uppercase tracking-wider">Bank Total</p><p className="text-xl font-bold text-white mt-0.5">{fmt(totalBank)}</p></div>
          <div><p className="text-xs text-gray-500 uppercase tracking-wider">Cash / Venmo Total</p><p className="text-xl font-bold text-white mt-0.5">{fmt(totalCash)}</p></div>
          <div><p className="text-xs text-gray-500 uppercase tracking-wider">Combined</p><p className="text-xl font-bold text-gold-500 mt-0.5">{fmt(totalBank + totalCash)}</p></div>
        </div>
        <button onClick={onAddAccount} className="btn-primary text-sm px-4 py-2">+ Add Account</button>
      </div>

      <AccountGroup title="Bank Accounts" accounts={bankAccts} onBalance={onUpdateBalance} onDelete={onDelete} />
      <AccountGroup title="Cash &amp; Digital Wallets" accounts={cashPools} onBalance={onUpdateBalance} onDelete={onDelete} />
    </div>
  );
}

function AccountGroup({ title, accounts, onBalance, onDelete }: {
  title: string; accounts: BankAccount[];
  onBalance: (a: BankAccount) => void; onDelete: (id: string) => void;
}) {
  if (!accounts.length) return null;
  return (
    <div>
      <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-2">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {accounts.map(a => (
          <div key={a.id} className="rounded-xl border border-white/10 bg-white/3 p-4">
            <div className="flex justify-between items-start mb-2">
              <div>
                <p className="text-sm font-semibold text-white">{a.name}</p>
                <p className="text-xs text-gray-500">{a.bank}{a.last4 ? ` ···${a.last4}` : ''} · {ACCT_TYPE_LABELS[a.accountType]}</p>
              </div>
              <div className="flex gap-1">
                <button onClick={() => onBalance(a)} className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded border border-blue-800 hover:border-blue-600">Update</button>
                <button onClick={() => { if (confirm('Delete this account?')) onDelete(a.id); }}
                  className="text-xs text-red-500 hover:text-red-300 px-1.5 py-1">✕</button>
              </div>
            </div>
            <p className={`text-2xl font-bold mt-2 ${a.balance < 0 ? 'text-red-500' : 'text-white'}`}>
              {fmt(a.balance)}
            </p>
            {a.creditLimit ? (
              <p className="text-xs text-gray-500 mt-1">Limit: {fmt(a.creditLimit)} · Available: {fmt(a.creditLimit - a.balance)}</p>
            ) : null}
            {a.asOfDate && (
              <p className="text-xs text-gray-600 mt-1">as of {new Date(a.asOfDate).toLocaleDateString()}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Other Income Tab ─────────────────────────────────────

function OtherIncomeTab({ rows, total, onAdd, onDelete }: {
  rows: OtherIncome[]; total: number;
  onAdd: () => void; onDelete: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wider">Total Other Income This Month</p>
          <p className="text-2xl font-bold text-emerald-500 mt-0.5">{fmt(total)}</p>
        </div>
        <button onClick={onAdd} className="btn-primary text-sm px-4 py-2">+ Add Income</button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-white/5">
            <th className="text-left pb-2">Date</th>
            <th className="text-left pb-2">Category</th>
            <th className="text-left pb-2">Description</th>
            <th className="text-left pb-2">Method</th>
            <th className="text-right pb-2">Amount</th>
            <th className="text-right pb-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
              <td className="py-2 text-gray-400">{new Date(r.receivedDate).toLocaleDateString()}</td>
              <td className="py-2 text-gray-300">{OTHER_INCOME_LABELS[r.category]}</td>
              <td className="py-2 text-gray-400">{r.description || '—'}</td>
              <td className="py-2 text-gray-500">{r.method || '—'}</td>
              <td className="py-2 text-right text-emerald-500 font-semibold">{fmt(r.amount)}</td>
              <td className="py-2 text-right">
                <button onClick={() => { if (confirm('Delete?')) onDelete(r.id); }}
                  className="text-red-500 hover:text-red-300 text-xs">✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p className="text-center text-gray-500 py-12">No other income recorded for this month.</p>
      )}
    </div>
  );
}

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

function SummaryLine({ label, value, color, bold }: { label: string; value: string; color: string; bold?: boolean }) {
  const colors: Record<string, string> = { emerald: 'text-emerald-500', red: 'text-red-600', amber: 'text-amber-500' };
  return (
    <div className="flex justify-between items-center py-1">
      <span className={`text-gray-400 ${bold ? 'font-semibold text-gray-300' : ''}`}>{label}</span>
      <span className={`font-${bold ? 'bold' : 'medium'} ${colors[color] ?? 'text-white'}`}>{value}</span>
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

// ─── Modals ───────────────────────────────────────────────

function AddBankModal({ onClose, onSave }: { onClose: () => void; onSave: (data: any) => Promise<void> }) {
  const [form, setForm] = useState({ name: '', last4: '', bank: '', accountType: 'CHECKING' as BankAccountType, notes: '' });
  const [saving, setSaving] = useState(false);

  return (
    <ModalShell title="Add Bank / Cash Account" onClose={onClose}>
      <label className="field-label">Name *</label>
      <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
        placeholder="e.g. Fahim Chase, Dad WF, Venmo" className="field-input mb-3 w-full" />
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="field-label">Bank</label>
          <input value={form.bank} onChange={e => setForm(f => ({ ...f, bank: e.target.value }))}
            placeholder="Chase" className="field-input w-full" />
        </div>
        <div>
          <label className="field-label">Last 4</label>
          <input value={form.last4} onChange={e => setForm(f => ({ ...f, last4: e.target.value }))}
            placeholder="4821" maxLength={4} className="field-input w-full" />
        </div>
      </div>
      <label className="field-label">Type</label>
      <select value={form.accountType} onChange={e => setForm(f => ({ ...f, accountType: e.target.value as BankAccountType }))}
        className="field-input mb-3 w-full">
        {(Object.keys(ACCT_TYPE_LABELS) as BankAccountType[]).map(k => (
          <option key={k} value={k}>{ACCT_TYPE_LABELS[k]}</option>
        ))}
      </select>
      <label className="field-label">Notes</label>
      <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
        className="field-input mb-4 w-full" />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">Cancel</button>
        <button disabled={!form.name || saving} onClick={async () => {
          setSaving(true); try { await onSave(form); } finally { setSaving(false); }
        }} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </ModalShell>
  );
}

function BalanceModal({ account, onClose, onSave }: {
  account: BankAccount;
  onClose: () => void;
  onSave: (id: string, data: any) => Promise<void>;
}) {
  const [balance, setBalance]     = useState(String(account.balance || ''));
  const [creditLimit, setLimit]   = useState(String(account.creditLimit || ''));
  const [notes, setNotes]         = useState('');
  const [saving, setSaving]       = useState(false);

  return (
    <ModalShell title={`Update Balance — ${account.name}`} onClose={onClose}>
      <label className="field-label">Balance *</label>
      <input type="number" value={balance} onChange={e => setBalance(e.target.value)}
        className="field-input mb-3 w-full" placeholder="12500" />
      {account.accountType === 'CREDIT_CARD' && (
        <>
          <label className="field-label">Credit Limit</label>
          <input type="number" value={creditLimit} onChange={e => setLimit(e.target.value)}
            className="field-input mb-3 w-full" placeholder="20000" />
        </>
      )}
      <label className="field-label">Notes</label>
      <input value={notes} onChange={e => setNotes(e.target.value)} className="field-input mb-4 w-full" />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">Cancel</button>
        <button disabled={!balance || saving} onClick={async () => {
          setSaving(true);
          try {
            await onSave(account.id, {
              balance: parseFloat(balance),
              creditLimit: creditLimit ? parseFloat(creditLimit) : undefined,
              notes,
              asOfDate: new Date().toISOString(),
            });
          } finally { setSaving(false); }
        }} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
          {saving ? 'Saving…' : 'Update'}
        </button>
      </div>
    </ModalShell>
  );
}

function AddIncomeModal({ year, month, onClose, onSave }: {
  year: number; month: number;
  onClose: () => void; onSave: (data: any) => Promise<void>;
}) {
  const defaultDate = `${year}-${String(month).padStart(2,'0')}-01`;
  const [form, setForm] = useState({
    category: 'APPLIANCE_SERVICE' as OtherIncomeCategory,
    description: '', amount: '', receivedDate: defaultDate,
    method: '', notes: '',
  });
  const [saving, setSaving] = useState(false);

  return (
    <ModalShell title="Record Other Income" onClose={onClose}>
      <label className="field-label">Category *</label>
      <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as OtherIncomeCategory }))}
        className="field-input mb-3 w-full">
        {(Object.keys(OTHER_INCOME_LABELS) as OtherIncomeCategory[]).map(k => (
          <option key={k} value={k}>{OTHER_INCOME_LABELS[k]}</option>
        ))}
      </select>
      <label className="field-label">Description</label>
      <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
        placeholder="e.g. Dryer repair at 201 State" className="field-input mb-3 w-full" />
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="field-label">Amount *</label>
          <input type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
            placeholder="250" className="field-input w-full" />
        </div>
        <div>
          <label className="field-label">Date *</label>
          <input type="date" value={form.receivedDate} onChange={e => setForm(f => ({ ...f, receivedDate: e.target.value }))}
            className="field-input w-full" />
        </div>
      </div>
      <label className="field-label">Method</label>
      <input value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value }))}
        placeholder="Cash, Venmo, Zelle…" className="field-input mb-3 w-full" />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">Cancel</button>
        <button disabled={!form.amount || !form.receivedDate || saving} onClick={async () => {
          setSaving(true);
          try {
            await onSave({ ...form, amount: parseFloat(form.amount) });
          } finally { setSaving(false); }
        }} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-2xl border border-white/10 p-6" style={{ background: '#0f2235' }}>
        <div className="flex justify-between items-center mb-5">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
