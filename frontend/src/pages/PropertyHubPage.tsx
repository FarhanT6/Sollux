import { useEffect, useState, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import {
  getProperty, getLeases, getLoans, getExpenses, getInsurancePolicies,
  getTaxAssessments, getImprovements, getPropertyPnL, getRentPayments,
  createRentPayment, createExpense, createImprovement, createInsurancePolicy,
  createTaxAssessment, createLoan,
  updateExpense, deleteExpense, updateInsurancePolicy, deleteInsurancePolicy,
  updateTaxAssessment, deleteTaxAssessment, updateImprovement, deleteImprovement,
  updateLease,
} from '../api/client';
import type {
  Property, Lease, Loan, Expense, InsurancePolicy, TaxAssessment,
  Improvement, PropertyPnL,
} from '../types';
import { PROPERTY_TYPE_LABELS, EXPENSE_CATEGORY_LABELS } from '../types';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
const fmtDate = (d?: string | null) => d ? format(new Date(d), 'MMM d, yyyy') : '—';
const TABS = ['Overview', 'Tenants', 'Loans', 'Expenses', 'Insurance', 'Maintenance', 'Tax'] as const;
type Tab = typeof TABS[number];

export default function PropertyHubPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get('tab') as Tab) || 'Overview';

  const [property, setProperty] = useState<Property | null>(null);
  const [loading, setLoading] = useState(true);

  // Tab data (lazy)
  const [leases, setLeases] = useState<Lease[]>([]);
  const [loans, setLoans]   = useState<Loan[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [policies, setPolicies] = useState<InsurancePolicy[]>([]);
  const [taxes, setTaxes]       = useState<TaxAssessment[]>([]);
  const [improvements, setImprovements] = useState<Improvement[]>([]);
  const [pnl, setPnl] = useState<PropertyPnL | null>(null);

  const loaded = useRef<Set<Tab>>(new Set());

  function setTab(t: Tab) {
    setSearchParams({ tab: t }, { replace: true });
  }

  // Load property on mount
  useEffect(() => {
    if (!id) return;
    getProperty(id).then(p => { setProperty(p); setLoading(false); });
  }, [id]);

  // Load tab data lazily
  useEffect(() => {
    if (!id || !activeTab || loaded.current.has(activeTab)) return;
    loaded.current.add(activeTab);
    if (activeTab === 'Overview') {
      Promise.all([
        getLeases({ propertyId: id, status: 'ACTIVE' }),
        getLoans({ propertyId: id, isActive: true }),
        getPropertyPnL(id),
      ]).then(([l, lo, p]) => { setLeases(l); setLoans(lo); setPnl(p); });
    } else if (activeTab === 'Tenants') {
      getLeases({ propertyId: id }).then(setLeases);
    } else if (activeTab === 'Loans') {
      getLoans({ propertyId: id }).then(setLoans);
    } else if (activeTab === 'Expenses') {
      getExpenses({ propertyId: id }).then(setExpenses);
    } else if (activeTab === 'Insurance') {
      getInsurancePolicies({ propertyId: id }).then(setPolicies);
    } else if (activeTab === 'Tax') {
      getTaxAssessments({ propertyId: id }).then(setTaxes);
    } else if (activeTab === 'Maintenance') {
      getImprovements({ propertyId: id }).then(setImprovements);
    }
  }, [id, activeTab]);

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-gray-500 text-sm">Loading…</div>
  );
  if (!property) return (
    <div className="flex items-center justify-center h-64 text-gray-500 text-sm">Property not found</div>
  );

  const activeLeases = leases.filter(l => l.status === 'ACTIVE');
  const totalRent = activeLeases.reduce((s, l) => s + Number(l.rentAmount), 0);
  const totalArrears = activeLeases.reduce((s, l) => s + Number(l.arrearsBalance), 0);
  const totalDebt = loans.filter(l => l.isActive).reduce((s, l) => s + Number(l.currentBalance ?? 0), 0);
  const equity = Number(property.estimatedValue ?? 0) - totalDebt;
  const units = property.units ?? [];
  const occ = units.length > 0
    ? Math.round(new Set(activeLeases.map(l => l.unitId)).size / units.length * 100)
    : null;

  return (
    <div>
      {/* Header */}
      <div className="sticky top-0 z-10" style={{ background: '#1e1e1e', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div className="px-6 pt-4 pb-0">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-start gap-3">
              <Link to="/portfolio" className="mt-0.5 text-gray-500 hover:text-gray-300 transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 12H5M12 19l-7-7 7-7"/>
                </svg>
              </Link>
              <div>
                <h1 className="text-base font-semibold text-white leading-tight">
                  {property.nickname || property.address}
                </h1>
                <p className="text-xs text-gray-500 mt-0.5">
                  {property.address}{property.nickname ? '' : ''}, {property.city}, {property.state} {property.zip}
                  {property.ownerEntity ? ` · ${property.ownerEntity}` : ''}
                </p>
              </div>
            </div>
            <div className="flex gap-1.5 flex-wrap justify-end">
              <span className="pill pill-gray">{PROPERTY_TYPE_LABELS[property.type] ?? property.type}</span>
              <span className={`pill ${property.status === 'ACTIVE' ? 'pill-green' : 'pill-gray'}`}>
                {property.status}
              </span>
              {occ !== null && (
                <span className={`pill ${occ === 100 ? 'pill-green' : occ >= 75 ? 'pill-amber' : 'pill-red'}`}>
                  {occ}% occupied
                </span>
              )}
            </div>
          </div>

          {/* Quick stats */}
          <div className="flex gap-6 pb-3 text-xs">
            {[
              { label: 'Rent/mo', value: money(totalRent), color: 'text-white' },
              { label: 'Arrears', value: money(totalArrears), color: totalArrears > 0 ? 'text-red-400' : 'text-gray-600' },
              { label: 'Est. value', value: property.estimatedValue ? money(Number(property.estimatedValue)) : '—', color: 'text-white' },
              { label: 'Equity', value: equity > 0 ? money(equity) : '—', color: 'text-emerald-400' },
              { label: 'Acquired', value: property.acquisitionDate ? format(new Date(property.acquisitionDate), 'MMM yyyy') : '—', color: 'text-gray-400' },
              { label: 'Purchase price', value: property.acquisitionPrice ? money(Number(property.acquisitionPrice)) : '—', color: 'text-gray-400' },
            ].map(s => (
              <div key={s.label}>
                <span className="text-gray-500">{s.label}: </span>
                <span className={`font-medium ${s.color}`}>{s.value}</span>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="flex gap-0.5">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === t
                    ? 'border-amber-500 text-white'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}>
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div className="px-6 py-5">
        {activeTab === 'Overview' && <OverviewTab property={property} pnl={pnl} leases={activeLeases} loans={loans.filter(l => l.isActive)} />}
        {activeTab === 'Tenants' && <TenantsTab propertyId={id!} leases={leases} setLeases={setLeases} />}
        {activeTab === 'Loans' && <LoansTab propertyId={id!} loans={loans} setLoans={setLoans} />}
        {activeTab === 'Expenses' && <ExpensesTab propertyId={id!} expenses={expenses} setExpenses={setExpenses} />}
        {activeTab === 'Insurance' && <InsuranceTab propertyId={id!} policies={policies} setPolicies={setPolicies} />}
        {activeTab === 'Maintenance' && <MaintenanceTab propertyId={id!} items={improvements} setItems={setImprovements} />}
        {activeTab === 'Tax' && <TaxTab propertyId={id!} taxes={taxes} setTaxes={setTaxes} />}
      </div>
    </div>
  );
}

// ─── Overview ──────────────────────────────────────────────────────────────────

function OverviewTab({ property, pnl, leases, loans }: {
  property: Property; pnl: PropertyPnL | null; leases: Lease[]; loans: Loan[];
}) {
  const units = property.units ?? [];
  const occupiedUnitIds = new Set(leases.map(l => l.unitId));
  const totalDebt = loans.reduce((s, l) => s + Number(l.currentBalance ?? 0), 0);
  const equity = Number(property.estimatedValue ?? 0) - totalDebt;
  const ltv = property.estimatedValue && totalDebt
    ? Math.round(totalDebt / Number(property.estimatedValue) * 100)
    : null;
  const appreciation = property.acquisitionPrice && property.estimatedValue
    ? ((Number(property.estimatedValue) - Number(property.acquisitionPrice)) / Number(property.acquisitionPrice) * 100)
    : null;

  return (
    <div className="space-y-5">
      {/* P&L & key metrics */}
      {pnl && (
        <div>
          <p className="section-label">Performance (trailing 12 months)</p>
          <div className="grid grid-cols-5 gap-3">
            {[
              { label: 'Rental income', value: money(pnl.rentalIncome), color: 'text-white' },
              { label: 'Op. expenses',  value: money(pnl.operatingExpenses), color: 'text-gray-300' },
              { label: 'NOI',           value: money(pnl.noi), color: pnl.noi >= 0 ? 'text-emerald-400' : 'text-red-400' },
              { label: 'Debt service',  value: money(pnl.debtService), color: 'text-gray-300' },
              { label: 'Cash flow',     value: money(pnl.cashFlow), color: pnl.cashFlow >= 0 ? 'text-emerald-400' : 'text-red-400' },
            ].map(c => (
              <div key={c.label} className="card p-3.5">
                <p className="text-xs text-gray-500 mb-0.5">{c.label}</p>
                <p className={`text-lg font-semibold ${c.color}`}>{c.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-5">
        {/* Property details */}
        <div>
          <p className="section-label">Property details</p>
          <div className="card p-4 space-y-2.5">
            {[
              ['Address', `${property.address}${property.addressLine2 ? `, ${property.addressLine2}` : ''}, ${property.city}, ${property.state} ${property.zip}`],
              ['County', property.county ?? '—'],
              ['Type', PROPERTY_TYPE_LABELS[property.type] ?? property.type],
              ['Status', property.status],
              ['Owner entity', property.ownerEntity ?? '—'],
              ['Lot size', property.lotSqft ? `${property.lotSqft.toLocaleString()} sqft` : '—'],
              ['Parcel group', property.parcelGroupName ?? '—'],
              ['Notes', property.notes ?? '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 text-sm">
                <span className="text-gray-500 flex-shrink-0">{k}</span>
                <span className="text-gray-200 text-right">{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Financials */}
        <div>
          <p className="section-label">Purchase & valuation</p>
          <div className="card p-4 space-y-2.5">
            {[
              ['Acquisition date', property.acquisitionDate ? fmtDate(property.acquisitionDate) : '—'],
              ['Purchase price', property.acquisitionPrice ? money(Number(property.acquisitionPrice)) : '—'],
              ['Estimated value', property.estimatedValue ? money(Number(property.estimatedValue)) : '—'],
              ['Land value', property.landValue ? money(Number(property.landValue)) : '—'],
              ['Valuation date', property.valuationDate ? fmtDate(property.valuationDate) : '—'],
              ['Appreciation', appreciation !== null ? pct(appreciation) : '—'],
              ['Total debt', totalDebt > 0 ? money(totalDebt) : '—'],
              ['Equity', equity > 0 ? money(equity) : '—'],
              ['LTV', ltv !== null ? `${ltv}%` : '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 text-sm">
                <span className="text-gray-500 flex-shrink-0">{k}</span>
                <span className="text-gray-200 text-right">{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Units */}
      {units.length > 0 && (
        <div>
          <p className="section-label">{units.length} units</p>
          <div className="grid grid-cols-3 gap-3">
            {units.map(u => {
              const occupied = occupiedUnitIds.has(u.id);
              return (
                <div key={u.id} className="card p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-sm font-medium text-white">{u.unitLabel}</p>
                    <span className={`pill ${occupied ? 'pill-green' : 'pill-gray'}`}>
                      {occupied ? 'Occupied' : 'Vacant'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {[u.bedrooms ? `${u.bedrooms}bd` : null, u.bathrooms ? `${u.bathrooms}ba` : null, u.sqft ? `${u.sqft} sqft` : null].filter(Boolean).join(' · ') || 'No details'}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tenants ───────────────────────────────────────────────────────────────────

function TenantsTab({ propertyId, leases, setLeases }: {
  propertyId: string; leases: Lease[]; setLeases: (l: Lease[]) => void;
}) {
  const [filterStatus, setFilterStatus] = useState('ACTIVE');
  const [showPayForm, setShowPayForm] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate]     = useState(() => new Date().toISOString().slice(0, 10));
  const [payMethod, setPayMethod] = useState('ZELLE');
  const [payNotes, setPayNotes]   = useState('');
  const [saving, setSaving]       = useState(false);
  const [expandLease, setExpandLease] = useState<string | null>(null);
  const [payments, setPayments] = useState<Record<string, any[]>>({});
  const [editLease, setEditLease] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ rentAmount: '', securityDeposit: '', startDate: '', endDate: '', leaseType: 'MONTH_TO_MONTH', status: 'ACTIVE', notes: '' });
  const [savingEdit, setSavingEdit] = useState(false);

  function openEditLease(lease: Lease) {
    setEditForm({
      rentAmount: String(lease.rentAmount ?? ''),
      securityDeposit: String(lease.securityDeposit ?? ''),
      startDate: lease.startDate?.slice(0, 10) ?? '',
      endDate: lease.endDate?.slice(0, 10) ?? '',
      leaseType: lease.leaseType,
      status: lease.status,
      notes: lease.notes ?? '',
    });
    setEditLease(lease.id);
  }

  async function saveEditLease(leaseId: string) {
    setSavingEdit(true);
    try {
      await updateLease(leaseId, {
        rentAmount: parseFloat(editForm.rentAmount) || undefined,
        securityDeposit: editForm.securityDeposit ? parseFloat(editForm.securityDeposit) : null,
        startDate: editForm.startDate || undefined,
        endDate: editForm.endDate || null,
        leaseType: editForm.leaseType,
        status: editForm.status,
        notes: editForm.notes || undefined,
      });
      const updated = await getLeases({ propertyId });
      setLeases(updated);
      setEditLease(null);
    } finally { setSavingEdit(false); }
  }

  const filtered = leases
    .filter(l => !filterStatus || l.status === filterStatus)
    .slice()
    .sort((a, b) => (a.unit?.unitLabel ?? '').localeCompare(b.unit?.unitLabel ?? ''));

  async function logPayment(leaseId: string) {
    if (!payAmount || !payDate) return;
    setSaving(true);
    try {
      const now = new Date();
      await createRentPayment({
        leaseId,
        periodDate: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)).toISOString(),
        amount: parseFloat(payAmount),
        paidDate: payDate,
        method: payMethod,
        notes: payNotes || undefined,
      });
      const updated = await getLeases({ propertyId });
      setLeases(updated);
      setShowPayForm(null);
      setPayAmount(''); setPayNotes('');
      // Refresh payment history for this lease if expanded
      if (payments[leaseId]) {
        getRentPayments({ leaseId }).then(p => setPayments(prev => ({ ...prev, [leaseId]: p })));
      }
    } finally { setSaving(false); }
  }

  async function toggleHistory(leaseId: string) {
    if (expandLease === leaseId) { setExpandLease(null); return; }
    setExpandLease(leaseId);
    if (!payments[leaseId]) {
      const p = await getRentPayments({ leaseId });
      setPayments(prev => ({ ...prev, [leaseId]: p }));
    }
  }

  const totalRent    = filtered.filter(l => l.status === 'ACTIVE').reduce((s, l) => s + Number(l.rentAmount), 0);
  const totalArrears = filtered.filter(l => l.status === 'ACTIVE').reduce((s, l) => s + Number(l.arrearsBalance), 0);
  const totalDeposits = filtered.filter(l => l.status === 'ACTIVE').reduce((s, l) => s + Number(l.securityDeposit ?? 0), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2 items-center">
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="input-dark text-sm">
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="ENDED">Ended</option>
            <option value="PENDING">Pending</option>
            <option value="TERMINATED">Terminated</option>
          </select>
          <span className="text-xs text-gray-500">
            {money(totalRent)}/mo · {totalArrears > 0 ? <span className="text-red-400">{money(totalArrears)} arrears</span> : 'no arrears'}
            {totalDeposits > 0 && ` · ${money(totalDeposits)} in deposits`}
          </span>
        </div>
        <Link to="/leases/new" className="btn text-xs">+ New lease</Link>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">No leases for this property</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(lease => {
            const leaseTenants = lease.leaseTenants ?? [];
            const arrears = Number(lease.arrearsBalance);
            const isExpanded = expandLease === lease.id;
            return (
              <div key={lease.id} className="card overflow-hidden">
                <div className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-semibold text-white">
                          {leaseTenants.length === 0 ? '—' : leaseTenants.map((lt, i) => (
                            <span key={lt.tenant.id}>
                              {i > 0 && ', '}
                              <Link to={`/tenants/${lt.tenant.id}`} className="hover:text-amber-400 transition-colors" onClick={e => e.stopPropagation()}>
                                {lt.tenant.fullName}
                              </Link>
                            </span>
                          ))}
                        </p>
                        <span className={`pill text-xs ${lease.status === 'ACTIVE' ? 'pill-green' : lease.status === 'PENDING' ? 'pill-amber' : 'pill-gray'}`}>
                          {lease.status}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500">
                        Unit {lease.unit?.unitLabel} · {lease.leaseType === 'FIXED_TERM' ? `${fmtDate(lease.startDate)} – ${fmtDate(lease.endDate)}` : `Month-to-month from ${fmtDate(lease.startDate)}`}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-white">{money(Number(lease.rentAmount))}/mo</p>
                      {arrears > 0 && <p className="text-xs text-red-400">{money(arrears)} arrears</p>}
                      {Number(lease.securityDeposit ?? 0) > 0 && <p className="text-xs text-gray-500">{money(Number(lease.securityDeposit))} dep.</p>}
                    </div>
                  </div>
                  <div className="flex gap-3 mt-2.5">
                    {lease.status === 'ACTIVE' && (
                      <button onClick={() => setShowPayForm(showPayForm === lease.id ? null : lease.id)}
                        className="text-xs text-amber-400 hover:text-amber-300">
                        Log payment
                      </button>
                    )}
                    <button onClick={() => toggleHistory(lease.id)}
                      className="text-xs text-gray-500 hover:text-gray-300">
                      {isExpanded ? 'Hide history' : 'View history'}
                    </button>
                    <button onClick={() => editLease === lease.id ? setEditLease(null) : openEditLease(lease)}
                      className="text-xs text-gray-500 hover:text-gray-300">
                      {editLease === lease.id ? 'Cancel edit' : 'Edit'}
                    </button>
                  </div>
                </div>

                {editLease === lease.id && (
                  <div className="px-4 py-3 grid grid-cols-3 gap-2" style={{ background: 'rgba(255,255,255,0.03)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <input type="number" placeholder="Rent/mo" value={editForm.rentAmount} onChange={e => setEditForm(f => ({ ...f, rentAmount: e.target.value }))} className="input-dark text-xs" />
                    <input type="number" placeholder="Security deposit" value={editForm.securityDeposit} onChange={e => setEditForm(f => ({ ...f, securityDeposit: e.target.value }))} className="input-dark text-xs" />
                    <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))} className="input-dark text-xs">
                      {['ACTIVE', 'ENDED', 'PENDING', 'TERMINATED'].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input type="date" value={editForm.startDate} onChange={e => setEditForm(f => ({ ...f, startDate: e.target.value }))} className="input-dark text-xs" />
                    <input type="date" value={editForm.endDate} onChange={e => setEditForm(f => ({ ...f, endDate: e.target.value }))} className="input-dark text-xs" placeholder="End date" />
                    <select value={editForm.leaseType} onChange={e => setEditForm(f => ({ ...f, leaseType: e.target.value }))} className="input-dark text-xs">
                      <option value="MONTH_TO_MONTH">Month-to-month</option>
                      <option value="FIXED_TERM">Fixed term</option>
                    </select>
                    <input placeholder="Notes" value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} className="input-dark text-xs col-span-3" />
                    <div className="col-span-3 flex justify-end">
                      <button onClick={() => saveEditLease(lease.id)} disabled={savingEdit} className="btn btn-primary text-xs">{savingEdit ? '…' : 'Save changes'}</button>
                    </div>
                  </div>
                )}

                {showPayForm === lease.id && (
                  <div className="px-4 py-3 flex gap-2 flex-wrap" style={{ background: 'rgba(255,255,255,0.03)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <input type="number" placeholder="Amount" value={payAmount} onChange={e => setPayAmount(e.target.value)} className="input-dark text-xs w-28" />
                    <input type="date"   value={payDate}   onChange={e => setPayDate(e.target.value)}   className="input-dark text-xs w-36" />
                    <select value={payMethod} onChange={e => setPayMethod(e.target.value)} className="input-dark text-xs">
                      {['ZELLE','CHECK','CASH','ACH','MONEY_ORDER','OTHER'].map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <input placeholder="Notes (optional)" value={payNotes} onChange={e => setPayNotes(e.target.value)} className="input-dark text-xs flex-1 min-w-32" />
                    <button onClick={() => logPayment(lease.id)} disabled={saving} className="btn btn-primary text-xs">{saving ? '…' : 'Log'}</button>
                    <button onClick={() => setShowPayForm(null)} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                  </div>
                )}

                {isExpanded && (
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    {!payments[lease.id] ? (
                      <p className="px-4 py-3 text-xs text-gray-500">Loading…</p>
                    ) : payments[lease.id].length === 0 ? (
                      <p className="px-4 py-3 text-xs text-gray-500">No payments recorded yet</p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead style={{ background: 'rgba(255,255,255,0.03)' }}>
                          <tr className="text-left text-gray-500">
                            <th className="px-4 py-2">Date</th>
                            <th className="px-4 py-2">Amount</th>
                            <th className="px-4 py-2">Method</th>
                            <th className="px-4 py-2">Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {payments[lease.id].map((p: any) => (
                            <tr key={p.id} className="border-t border-white/5">
                              <td className="px-4 py-2 text-gray-300">{fmtDate(p.paidDate)}</td>
                              <td className="px-4 py-2 font-medium text-white">{money(Number(p.amount))}</td>
                              <td className="px-4 py-2 text-gray-400">{p.method}</td>
                              <td className="px-4 py-2 text-gray-500">{p.notes || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Loans ─────────────────────────────────────────────────────────────────────

function LoansTab({ propertyId, loans, setLoans }: {
  propertyId: string; loans: Loan[]; setLoans: (l: Loan[]) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ loanType: 'MORTGAGE', lender: '', originalAmount: '', interestRate: '', monthlyPayment: '', currentBalance: '', originationDate: '', maturityDate: '', notes: '' });
  const [saving, setSaving] = useState(false);

  const sorted = [...loans].sort((a, b) => (b.currentBalance ?? 0) - (a.currentBalance ?? 0));
  const totalDebt = loans.filter(l => l.isActive).reduce((s, l) => s + Number(l.currentBalance ?? 0), 0);

  async function save() {
    if (!form.lender) return;
    setSaving(true);
    try {
      await createLoan({
        propertyId,
        loanType: form.loanType as any,
        lender: form.lender,
        originalAmount: form.originalAmount ? parseFloat(form.originalAmount) : undefined,
        interestRate: form.interestRate ? parseFloat(form.interestRate) : undefined,
        monthlyPayment: form.monthlyPayment ? parseFloat(form.monthlyPayment) : undefined,
        currentBalance: form.currentBalance ? parseFloat(form.currentBalance) : undefined,
        originationDate: form.originationDate || undefined,
        maturityDate: form.maturityDate || undefined,
        notes: form.notes || undefined,
        isPersonal: false,
        isActive: true,
      });
      const updated = await getLoans({ propertyId });
      setLoans(updated);
      setShowForm(false);
      setForm({ loanType: 'MORTGAGE', lender: '', originalAmount: '', interestRate: '', monthlyPayment: '', currentBalance: '', originationDate: '', maturityDate: '', notes: '' });
    } finally { setSaving(false); }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-500">Total debt: <span className="text-white font-medium">{money(totalDebt)}</span></p>
        <button onClick={() => setShowForm(!showForm)} className="btn text-xs">+ Add loan</button>
      </div>

      {showForm && (
        <div className="card p-4 mb-4 grid grid-cols-4 gap-3">
          <div className="col-span-4 text-xs font-medium text-gray-400 mb-1">New loan</div>
          <select value={form.loanType} onChange={e => setForm(f => ({ ...f, loanType: e.target.value }))} className="input-dark text-sm">
            {['MORTGAGE','HELOC','INSTALLMENT_PLAN','CREDIT_LINE','OTHER'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <input placeholder="Lender *" value={form.lender} onChange={e => setForm(f => ({ ...f, lender: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Current balance" type="number" value={form.currentBalance} onChange={e => setForm(f => ({ ...f, currentBalance: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Monthly payment" type="number" value={form.monthlyPayment} onChange={e => setForm(f => ({ ...f, monthlyPayment: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Original amount" type="number" value={form.originalAmount} onChange={e => setForm(f => ({ ...f, originalAmount: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Interest rate %" type="number" step="0.01" value={form.interestRate} onChange={e => setForm(f => ({ ...f, interestRate: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Origination date" type="date" value={form.originationDate} onChange={e => setForm(f => ({ ...f, originationDate: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Maturity date" type="date" value={form.maturityDate} onChange={e => setForm(f => ({ ...f, maturityDate: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input-dark text-sm col-span-2" />
          <div className="col-span-2 flex gap-2 justify-end">
            <button onClick={() => setShowForm(false)} className="btn text-xs">Cancel</button>
            <button onClick={save} disabled={saving || !form.lender} className="btn btn-primary text-xs">{saving ? '…' : 'Save'}</button>
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">No loans recorded</div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
              <tr className="text-left text-gray-400 text-xs">
                <th className="px-4 py-3">Lender</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Balance</th>
                <th className="px-4 py-3">Payment/mo</th>
                <th className="px-4 py-3">Rate</th>
                <th className="px-4 py-3">Maturity</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {sorted.map(loan => (
                <tr key={loan.id} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    <Link to={`/loans/${loan.id}`} className="text-white font-medium hover:text-amber-400 transition-colors">{loan.lender}</Link>
                    {loan.accountLast4 && <p className="text-xs text-gray-500">····{loan.accountLast4}</p>}
                  </td>
                  <td className="px-4 py-3 text-gray-400">{loan.loanType}</td>
                  <td className="px-4 py-3 font-medium text-white">{loan.currentBalance ? money(Number(loan.currentBalance)) : '—'}</td>
                  <td className="px-4 py-3 text-gray-300">{loan.monthlyPayment ? money(Number(loan.monthlyPayment)) : '—'}</td>
                  <td className="px-4 py-3 text-gray-400">{loan.interestRate ? `${loan.interestRate}%` : '—'}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{loan.maturityDate ? fmtDate(loan.maturityDate) : '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`pill ${loan.isActive ? 'pill-green' : 'pill-gray'}`}>{loan.isActive ? 'Active' : 'Paid off'}</span>
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

// ─── Expenses ──────────────────────────────────────────────────────────────────

const EMPTY_EXPENSE_FORM = { category: 'REPAIRS_MAINTENANCE', amount: '', date: new Date().toISOString().slice(0, 10), vendor: '', description: '', isCapEx: false, isPersonal: false };

function ExpensesTab({ propertyId, expenses, setExpenses }: {
  propertyId: string; expenses: Expense[]; setExpenses: (e: Expense[]) => void;
}) {
  const [formMode, setFormMode] = useState<'closed' | 'new' | Expense>('closed');
  const [form, setForm] = useState(EMPTY_EXPENSE_FORM);
  const [saving, setSaving] = useState(false);
  const [filterCat, setFilterCat] = useState('');

  const filtered = [...expenses]
    .filter(e => !filterCat || e.category === filterCat)
    .sort((a, b) => b.date.localeCompare(a.date));

  function openNew() {
    setForm(EMPTY_EXPENSE_FORM);
    setFormMode('new');
  }

  function openEdit(e: Expense) {
    setForm({
      category: e.category, amount: String(e.amount), date: e.date.slice(0, 10),
      vendor: e.vendor ?? '', description: e.description ?? '', isCapEx: e.isCapEx, isPersonal: e.isPersonal,
    });
    setFormMode(e);
  }

  async function save() {
    if (!form.amount) return;
    setSaving(true);
    try {
      const payload = {
        propertyId,
        category: form.category as any,
        amount: parseFloat(form.amount),
        date: form.date,
        vendor: form.vendor || undefined,
        description: form.description || undefined,
        isCapEx: form.isCapEx,
        isPersonal: form.isPersonal,
      };
      if (formMode !== 'new' && formMode !== 'closed') {
        await updateExpense(formMode.id, payload);
      } else {
        await createExpense(payload);
      }
      const updated = await getExpenses({ propertyId });
      setExpenses(updated);
      setFormMode('closed');
    } finally { setSaving(false); }
  }

  async function remove() {
    if (formMode === 'new' || formMode === 'closed') return;
    if (!confirm('Delete this expense?')) return;
    await deleteExpense(formMode.id);
    setExpenses(expenses.filter(e => e.id !== formMode.id));
    setFormMode('closed');
  }

  const total = filtered.reduce((s, e) => s + Number(e.amount), 0);
  const isEditing = formMode !== 'new' && formMode !== 'closed';

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2 items-center">
          <select value={filterCat} onChange={e => setFilterCat(e.target.value)} className="input-dark text-sm">
            <option value="">All categories</option>
            {Object.entries(EXPENSE_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="text-xs text-gray-500">Total: <span className="text-white font-medium">{money(total)}</span></span>
        </div>
        <button onClick={() => formMode === 'closed' ? openNew() : setFormMode('closed')} className="btn text-xs">+ Add expense</button>
      </div>

      {formMode !== 'closed' && (
        <div className="card p-4 mb-4 grid grid-cols-4 gap-3">
          <div className="col-span-4 text-xs font-medium text-gray-400 mb-1">{isEditing ? 'Edit expense' : 'New expense'}</div>
          <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="input-dark text-sm col-span-2">
            {Object.entries(EXPENSE_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input type="number" placeholder="Amount *" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} className="input-dark text-sm" />
          <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Vendor / payee" value={form.vendor} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} className="input-dark text-sm col-span-2" />
          <input placeholder="Description" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input-dark text-sm col-span-2" />
          <label className="col-span-2 flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={form.isCapEx} onChange={e => setForm(f => ({ ...f, isCapEx: e.target.checked }))} />
            Capital expenditure (CapEx)
          </label>
          <label className="col-span-2 flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={form.isPersonal} onChange={e => setForm(f => ({ ...f, isPersonal: e.target.checked }))} />
            Personal expense (excluded from P&L)
          </label>
          <div className="col-span-4 flex gap-2 items-center justify-between">
            {form.isPersonal && <span className="text-xs text-amber-400">This expense will be excluded from P&L and budget</span>}
            <div className="flex gap-2 ml-auto">
              {isEditing && <button onClick={remove} className="text-xs text-red-400 hover:text-red-300 mr-auto">Delete</button>}
              <button onClick={() => setFormMode('closed')} className="btn text-xs">Cancel</button>
              <button onClick={save} disabled={saving || !form.amount} className="btn btn-primary text-xs">{saving ? '…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">No expenses recorded</div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
              <tr className="text-left text-gray-400 text-xs">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filtered.map(e => (
                <tr key={e.id} onClick={() => openEdit(e)} className="hover:bg-white/[0.02] cursor-pointer">
                  <td className="px-4 py-3 text-gray-400 text-xs">{fmtDate(e.date)}</td>
                  <td className="px-4 py-3 text-gray-300">{EXPENSE_CATEGORY_LABELS[e.category] ?? e.category}</td>
                  <td className="px-4 py-3 text-gray-400">{e.vendor || '—'}</td>
                  <td className="px-4 py-3 text-gray-400">{e.description || '—'}</td>
                  <td className="px-4 py-3 font-medium text-white">{money(Number(e.amount))}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1 flex-wrap">
                      <span className={`pill ${e.isCapEx ? 'pill-purple' : 'pill-gray'}`}>{e.isCapEx ? 'CapEx' : 'OpEx'}</span>
                      {e.isPersonal && <span className="pill pill-amber">Personal</span>}
                    </div>
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

// ─── Insurance ─────────────────────────────────────────────────────────────────

const EMPTY_INSURANCE_FORM = { carrier: '', policyNumber: '', policyType: 'PROPERTY', premiumAmount: '', premiumFrequency: 'ANNUAL', effectiveDate: '', expirationDate: '', notes: '', isActive: true };

function InsuranceTab({ propertyId, policies, setPolicies }: {
  propertyId: string; policies: InsurancePolicy[]; setPolicies: (p: InsurancePolicy[]) => void;
}) {
  const [formMode, setFormMode] = useState<'closed' | 'new' | InsurancePolicy>('closed');
  const [form, setForm] = useState(EMPTY_INSURANCE_FORM);
  const [saving, setSaving] = useState(false);

  const active = policies.filter(p => p.isActive);
  const totalAnnual = active.reduce((s, p) => {
    const m = p.premiumFrequency === 'ANNUAL' ? 1 : p.premiumFrequency === 'SEMI_ANNUAL' ? 2 : 12;
    return s + Number(p.premiumAmount) * m;
  }, 0);

  function openNew() {
    setForm(EMPTY_INSURANCE_FORM);
    setFormMode('new');
  }

  function openEdit(p: InsurancePolicy) {
    setForm({
      carrier: p.carrier, policyNumber: p.policyNumber ?? '', policyType: p.policyType,
      premiumAmount: String(p.premiumAmount), premiumFrequency: p.premiumFrequency,
      effectiveDate: p.effectiveDate?.slice(0, 10) ?? '', expirationDate: p.expirationDate?.slice(0, 10) ?? '',
      notes: p.notes ?? '', isActive: p.isActive,
    });
    setFormMode(p);
  }

  async function save() {
    if (!form.carrier || !form.premiumAmount) return;
    setSaving(true);
    try {
      const payload = {
        propertyId,
        carrier: form.carrier,
        policyNumber: form.policyNumber || undefined,
        policyType: form.policyType as any,
        premiumAmount: parseFloat(form.premiumAmount),
        premiumFrequency: form.premiumFrequency as any,
        effectiveDate: form.effectiveDate || undefined,
        expirationDate: form.expirationDate || undefined,
        notes: form.notes || undefined,
        isPersonal: false,
        isActive: form.isActive,
      };
      if (formMode !== 'new' && formMode !== 'closed') {
        await updateInsurancePolicy(formMode.id, payload);
      } else {
        await createInsurancePolicy(payload);
      }
      const updated = await getInsurancePolicies({ propertyId });
      setPolicies(updated);
      setFormMode('closed');
    } finally { setSaving(false); }
  }

  async function remove() {
    if (formMode === 'new' || formMode === 'closed') return;
    if (!confirm('Delete this policy?')) return;
    await deleteInsurancePolicy(formMode.id);
    setPolicies(policies.filter(p => p.id !== formMode.id));
    setFormMode('closed');
  }

  const daysUntilExpiry = (d?: string) => {
    if (!d) return null;
    return Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
  };

  const isEditing = formMode !== 'new' && formMode !== 'closed';

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-500">Total annual premium: <span className="text-white font-medium">{money(totalAnnual)}</span></p>
        <button onClick={() => formMode === 'closed' ? openNew() : setFormMode('closed')} className="btn text-xs">+ Add policy</button>
      </div>

      {formMode !== 'closed' && (
        <div className="card p-4 mb-4 grid grid-cols-4 gap-3">
          <div className="col-span-4 text-xs font-medium text-gray-400 mb-1">{isEditing ? 'Edit policy' : 'New policy'}</div>
          <input placeholder="Carrier *" value={form.carrier} onChange={e => setForm(f => ({ ...f, carrier: e.target.value }))} className="input-dark text-sm col-span-2" />
          <input placeholder="Policy number" value={form.policyNumber} onChange={e => setForm(f => ({ ...f, policyNumber: e.target.value }))} className="input-dark text-sm" />
          <select value={form.policyType} onChange={e => setForm(f => ({ ...f, policyType: e.target.value }))} className="input-dark text-sm">
            {['PROPERTY','LIABILITY','FLOOD','UMBRELLA','OTHER'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <input type="number" placeholder="Premium amount *" value={form.premiumAmount} onChange={e => setForm(f => ({ ...f, premiumAmount: e.target.value }))} className="input-dark text-sm" />
          <select value={form.premiumFrequency} onChange={e => setForm(f => ({ ...f, premiumFrequency: e.target.value }))} className="input-dark text-sm">
            <option value="ANNUAL">Annual</option>
            <option value="SEMI_ANNUAL">Semi-annual</option>
            <option value="MONTHLY">Monthly</option>
          </select>
          <input type="date" placeholder="Effective" value={form.effectiveDate} onChange={e => setForm(f => ({ ...f, effectiveDate: e.target.value }))} className="input-dark text-sm" />
          <input type="date" placeholder="Expiration" value={form.expirationDate} onChange={e => setForm(f => ({ ...f, expirationDate: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input-dark text-sm col-span-2" />
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} />
            Active
          </label>
          <div className="col-span-4 flex gap-2 justify-end">
            {isEditing && <button onClick={remove} className="text-xs text-red-400 hover:text-red-300 mr-auto">Delete</button>}
            <button onClick={() => setFormMode('closed')} className="btn text-xs">Cancel</button>
            <button onClick={save} disabled={saving || !form.carrier || !form.premiumAmount} className="btn btn-primary text-xs">{saving ? '…' : 'Save'}</button>
          </div>
        </div>
      )}

      {policies.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">No insurance policies recorded</div>
      ) : (
        <div className="space-y-3">
          {[...policies].sort((a, b) => (a.isActive === b.isActive ? 0 : a.isActive ? -1 : 1)).map(p => {
            const days = daysUntilExpiry(p.expirationDate);
            const urgent = days !== null && days <= 30 && days >= 0;
            return (
              <div key={p.id} onClick={() => openEdit(p)} className="card p-4 cursor-pointer hover:bg-white/[0.02]">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-semibold text-white">{p.carrier}</p>
                    <p className="text-xs text-gray-500">{p.policyType} · {p.policyNumber || 'No policy #'}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-white">{money(Number(p.premiumAmount))}/{p.premiumFrequency === 'ANNUAL' ? 'yr' : p.premiumFrequency === 'MONTHLY' ? 'mo' : '6mo'}</p>
                    {p.expirationDate && (
                      <p className={`text-xs ${urgent ? 'text-red-400' : 'text-gray-500'}`}>
                        Expires {fmtDate(p.expirationDate)}{urgent ? ` (${days}d!)` : ''}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  <span className={`pill ${p.isActive ? 'pill-green' : 'pill-gray'}`}>{p.isActive ? 'Active' : 'Inactive'}</span>
                  {p.effectiveDate && <span className="text-xs text-gray-500">Effective {fmtDate(p.effectiveDate)}</span>}
                </div>
                {p.notes && <p className="text-xs text-gray-500 mt-1.5">{p.notes}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Maintenance ───────────────────────────────────────────────────────────────

const EMPTY_IMPROVEMENT_FORM = { description: '', category: '', cost: '', contractor: '', startDate: '', completionDate: '', notes: '' };

function MaintenanceTab({ propertyId, items, setItems }: {
  propertyId: string; items: Improvement[]; setItems: (i: Improvement[]) => void;
}) {
  const [formMode, setFormMode] = useState<'closed' | 'new' | Improvement>('closed');
  const [form, setForm] = useState(EMPTY_IMPROVEMENT_FORM);
  const [saving, setSaving] = useState(false);
  const [filterCat, setFilterCat] = useState('');

  const cats = [...new Set(items.map(i => i.category).filter(Boolean))] as string[];
  const filtered = [...items]
    .filter(i => !filterCat || i.category === filterCat)
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
  const total = filtered.reduce((s, i) => s + Number(i.cost), 0);

  function openNew() {
    setForm(EMPTY_IMPROVEMENT_FORM);
    setFormMode('new');
  }

  function openEdit(i: Improvement) {
    setForm({
      description: i.description, category: i.category ?? '', cost: String(i.cost),
      contractor: i.contractor ?? '', startDate: i.startDate?.slice(0, 10) ?? '',
      completionDate: i.completionDate?.slice(0, 10) ?? '', notes: i.notes ?? '',
    });
    setFormMode(i);
  }

  async function save() {
    if (!form.description || !form.cost) return;
    setSaving(true);
    try {
      const payload = {
        propertyId,
        description: form.description,
        category: form.category || undefined,
        cost: parseFloat(form.cost),
        contractor: form.contractor || undefined,
        startDate: form.startDate || undefined,
        completionDate: form.completionDate || undefined,
        notes: form.notes || undefined,
      };
      if (formMode !== 'new' && formMode !== 'closed') {
        await updateImprovement(formMode.id, payload);
      } else {
        await createImprovement(payload);
      }
      const updated = await getImprovements({ propertyId });
      setItems(updated);
      setFormMode('closed');
    } finally { setSaving(false); }
  }

  async function remove() {
    if (formMode === 'new' || formMode === 'closed') return;
    if (!confirm('Delete this maintenance record?')) return;
    await deleteImprovement(formMode.id);
    setItems(items.filter(i => i.id !== formMode.id));
    setFormMode('closed');
  }

  const COMMON_CATS = ['Plumbing', 'Electrical', 'HVAC', 'Roofing', 'Flooring', 'Paint', 'Appliances', 'Landscaping', 'General', 'Capital'];
  const isEditing = formMode !== 'new' && formMode !== 'closed';

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2 items-center">
          <select value={filterCat} onChange={e => setFilterCat(e.target.value)} className="input-dark text-sm">
            <option value="">All types</option>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="text-xs text-gray-500">Total: <span className="text-white font-medium">{money(total)}</span></span>
        </div>
        <button onClick={() => formMode === 'closed' ? openNew() : setFormMode('closed')} className="btn text-xs">+ Add work</button>
      </div>

      {formMode !== 'closed' && (
        <div className="card p-4 mb-4 grid grid-cols-4 gap-3">
          <div className="col-span-4 text-xs font-medium text-gray-400 mb-1">{isEditing ? 'Edit maintenance / improvement' : 'New maintenance / improvement'}</div>
          <input placeholder="Description *" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input-dark text-sm col-span-2" />
          <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="input-dark text-sm">
            <option value="">Category</option>
            {COMMON_CATS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <input type="number" placeholder="Cost *" value={form.cost} onChange={e => setForm(f => ({ ...f, cost: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Contractor" value={form.contractor} onChange={e => setForm(f => ({ ...f, contractor: e.target.value }))} className="input-dark text-sm col-span-2" />
          <input type="date" placeholder="Start date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} className="input-dark text-sm" />
          <input type="date" placeholder="Completion" value={form.completionDate} onChange={e => setForm(f => ({ ...f, completionDate: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input-dark text-sm col-span-2" />
          <div className="col-span-2 flex gap-2 justify-end">
            {isEditing && <button onClick={remove} className="text-xs text-red-400 hover:text-red-300 mr-auto">Delete</button>}
            <button onClick={() => setFormMode('closed')} className="btn text-xs">Cancel</button>
            <button onClick={save} disabled={saving || !form.description || !form.cost} className="btn btn-primary text-xs">{saving ? '…' : 'Save'}</button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">No maintenance records</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(item => (
            <div key={item.id} onClick={() => openEdit(item)} className="card p-4 cursor-pointer hover:bg-white/[0.02]">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-white">{item.description}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {[item.category, item.contractor ? `by ${item.contractor}` : null].filter(Boolean).join(' · ')}
                  </p>
                  {(item.startDate || item.completionDate) && (
                    <p className="text-xs text-gray-500">
                      {item.startDate ? fmtDate(item.startDate) : '?'} → {item.completionDate ? fmtDate(item.completionDate) : 'In progress'}
                    </p>
                  )}
                  {item.notes && <p className="text-xs text-gray-600 mt-1">{item.notes}</p>}
                </div>
                <p className="text-sm font-semibold text-white flex-shrink-0 ml-4">{money(Number(item.cost))}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tax ───────────────────────────────────────────────────────────────────────

const EMPTY_TAX_FORM = { taxYear: new Date().getFullYear().toString(), assessedValue: '', annualTaxAmount: '', installment1Due: '', installment2Due: '', installment1Paid: '', installment2Paid: '', status: 'UNPAID', notes: '' };

function TaxTab({ propertyId, taxes, setTaxes }: {
  propertyId: string; taxes: TaxAssessment[]; setTaxes: (t: TaxAssessment[]) => void;
}) {
  const [formMode, setFormMode] = useState<'closed' | 'new' | TaxAssessment>('closed');
  const [form, setForm] = useState(EMPTY_TAX_FORM);
  const [saving, setSaving] = useState(false);

  const sorted = [...taxes].sort((a, b) => b.taxYear.localeCompare(a.taxYear));

  function openNew() {
    setForm(EMPTY_TAX_FORM);
    setFormMode('new');
  }

  function openEdit(t: TaxAssessment) {
    setForm({
      taxYear: t.taxYear, assessedValue: t.assessedValue != null ? String(t.assessedValue) : '',
      annualTaxAmount: String(t.annualTaxAmount),
      installment1Due: t.installment1Due?.slice(0, 10) ?? '', installment2Due: t.installment2Due?.slice(0, 10) ?? '',
      installment1Paid: t.installment1Paid?.slice(0, 10) ?? '', installment2Paid: t.installment2Paid?.slice(0, 10) ?? '',
      status: t.status, notes: t.notes ?? '',
    });
    setFormMode(t);
  }

  async function save() {
    if (!form.annualTaxAmount) return;
    setSaving(true);
    try {
      const payload = {
        propertyId,
        taxYear: form.taxYear,
        assessedValue: form.assessedValue ? parseFloat(form.assessedValue) : undefined,
        annualTaxAmount: parseFloat(form.annualTaxAmount),
        installment1Due: form.installment1Due || undefined,
        installment2Due: form.installment2Due || undefined,
        installment1Paid: form.installment1Paid || undefined,
        installment2Paid: form.installment2Paid || undefined,
        notes: form.notes || undefined,
        status: form.status as any,
      };
      if (formMode !== 'new' && formMode !== 'closed') {
        await updateTaxAssessment(formMode.id, payload);
      } else {
        await createTaxAssessment(payload);
      }
      const updated = await getTaxAssessments({ propertyId });
      setTaxes(updated);
      setFormMode('closed');
    } finally { setSaving(false); }
  }

  async function remove() {
    if (formMode === 'new' || formMode === 'closed') return;
    if (!confirm('Delete this tax assessment?')) return;
    await deleteTaxAssessment(formMode.id);
    setTaxes(taxes.filter(t => t.id !== formMode.id));
    setFormMode('closed');
  }

  const statusColor: Record<string, string> = {
    PAID: 'pill-green', UNPAID: 'pill-red', PARTIALLY_PAID: 'pill-amber', DELINQUENT: 'pill-red',
  };
  const isEditing = formMode !== 'new' && formMode !== 'closed';

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-500">{taxes.length} assessment{taxes.length !== 1 ? 's' : ''}</p>
        <button onClick={() => formMode === 'closed' ? openNew() : setFormMode('closed')} className="btn text-xs">+ Add assessment</button>
      </div>

      {formMode !== 'closed' && (
        <div className="card p-4 mb-4 grid grid-cols-4 gap-3">
          <div className="col-span-4 text-xs font-medium text-gray-400 mb-1">{isEditing ? 'Edit tax assessment' : 'New tax assessment'}</div>
          <input placeholder="Tax year *" value={form.taxYear} onChange={e => setForm(f => ({ ...f, taxYear: e.target.value }))} className="input-dark text-sm" />
          <input type="number" placeholder="Annual tax *" value={form.annualTaxAmount} onChange={e => setForm(f => ({ ...f, annualTaxAmount: e.target.value }))} className="input-dark text-sm" />
          <input type="number" placeholder="Assessed value" value={form.assessedValue} onChange={e => setForm(f => ({ ...f, assessedValue: e.target.value }))} className="input-dark text-sm" />
          <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} className="input-dark text-sm">
            {['UNPAID', 'PARTIALLY_PAID', 'PAID', 'DELINQUENT'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input type="date" placeholder="Install. 1 due" value={form.installment1Due} onChange={e => setForm(f => ({ ...f, installment1Due: e.target.value }))} className="input-dark text-sm" />
          <input type="date" placeholder="Install. 1 paid" value={form.installment1Paid} onChange={e => setForm(f => ({ ...f, installment1Paid: e.target.value }))} className="input-dark text-sm" />
          <input type="date" placeholder="Install. 2 due" value={form.installment2Due} onChange={e => setForm(f => ({ ...f, installment2Due: e.target.value }))} className="input-dark text-sm" />
          <input type="date" placeholder="Install. 2 paid" value={form.installment2Paid} onChange={e => setForm(f => ({ ...f, installment2Paid: e.target.value }))} className="input-dark text-sm" />
          <input placeholder="Notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input-dark text-sm col-span-4" />
          <div className="col-span-4 flex gap-2 justify-end">
            {isEditing && <button onClick={remove} className="text-xs text-red-400 hover:text-red-300 mr-auto">Delete</button>}
            <button onClick={() => setFormMode('closed')} className="btn text-xs">Cancel</button>
            <button onClick={save} disabled={saving || !form.annualTaxAmount} className="btn btn-primary text-xs">{saving ? '…' : 'Save'}</button>
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">No tax assessments recorded</div>
      ) : (
        <div className="space-y-3">
          {sorted.map(t => (
            <div key={t.id} onClick={() => openEdit(t)} className="card p-4 cursor-pointer hover:bg-white/[0.02]">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-sm font-semibold text-white">Tax year {t.taxYear}</p>
                    <span className={`pill ${statusColor[t.status] ?? 'pill-gray'}`}>{t.status}</span>
                  </div>
                  {t.assessedValue && <p className="text-xs text-gray-500">Assessed at {money(Number(t.assessedValue))}</p>}
                  <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                    {t.installment1Due && <p>Installment 1: {fmtDate(t.installment1Due)}{t.installment1Paid ? ` · paid ${fmtDate(t.installment1Paid)}` : ''}</p>}
                    {t.installment2Due && <p>Installment 2: {fmtDate(t.installment2Due)}{t.installment2Paid ? ` · paid ${fmtDate(t.installment2Paid)}` : ''}</p>}
                  </div>
                  {t.notes && <p className="text-xs text-gray-600 mt-1">{t.notes}</p>}
                </div>
                <p className="text-base font-semibold text-white flex-shrink-0 ml-4">{money(Number(t.annualTaxAmount))}/yr</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
