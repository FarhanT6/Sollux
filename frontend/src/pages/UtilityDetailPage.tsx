import { useEffect, useState, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  getUtility, syncUtility, deleteUtility, getStatementDownloadUrl,
  getPaymentPlan, createPaymentPlan, updatePaymentPlan, deletePaymentPlan,
} from '../api/client';
import { CATEGORY_LABELS, CATEGORY_COLORS } from '../types';
import { Pill, Skeleton, EmptyState } from '../components/ui';
import { format, isAfter } from 'date-fns';

const CATEGORY_ICONS: Record<string, string> = {
  ELECTRIC: '⚡', GAS: '🔥', WATER: '💧', SEWER: '🚿',
  INTERNET: '🌐', PHONE: '📱', TV: '📺', TRASH: '🗑️',
  SOLAR: '☀️', INSURANCE: '🛡️', HOA: '🏘️', TAXES: '🏛️', OTHER: '📄',
};

function fmtMoney(v?: number | string | null) {
  if (v == null) return '—';
  const n = Number(v);
  return isNaN(n) ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

function statementStatus(s: any): { color: 'green' | 'amber' | 'red'; label: string } {
  if ((s.rawDataJson as any)?.isPaid === true) return { color: 'green', label: 'Paid' };
  if ((s.rawDataJson as any)?.isPastDue === true) return { color: 'red', label: 'Overdue' };
  if (s.dueDate && isAfter(new Date(), new Date(s.dueDate))) return { color: 'red', label: 'Overdue' };
  return { color: 'amber', label: 'Due' };
}

type Tab = 'statements' | 'payments' | 'fees';

// ── Payment Plan Modal ────────────────────────────────────────────────────────
function PaymentPlanModal({
  accountId, existing, onClose, onSave,
}: { accountId: string; existing: any | null; onClose: () => void; onSave: (p: any) => void }) {
  const [total, setTotal] = useState(existing ? String(existing.totalAmount) : '');
  const [monthly, setMonthly] = useState(existing ? String(existing.monthlyAmount) : '');
  const [startDate, setStartDate] = useState(
    existing ? existing.startDate.slice(0, 10) : new Date().toISOString().slice(0, 10)
  );
  const [desc, setDesc] = useState(existing?.description || '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!total || !monthly) return;
    setSaving(true);
    try {
      const plan = await createPaymentPlan(accountId, {
        totalAmount: parseFloat(total),
        monthlyAmount: parseFloat(monthly),
        startDate,
        description: desc || undefined,
      });
      onSave(plan);
      onClose();
    } catch { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="rounded-2xl p-6 w-96 space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.1)' }}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">Payment Plan</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">×</button>
        </div>
        <p className="text-xs text-gray-400">Track a payment arrangement where a fixed monthly installment reduces a total arrears balance.</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Total arrears / plan amount ($)</label>
            <input type="number" value={total} onChange={e => setTotal(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm text-white bg-black/30 border border-white/10 focus:outline-none focus:border-amber-500" placeholder="e.g. 2000" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Monthly installment ($)</label>
            <input type="number" value={monthly} onChange={e => setMonthly(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm text-white bg-black/30 border border-white/10 focus:outline-none focus:border-amber-500" placeholder="e.g. 81.36" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Start date</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm text-white bg-black/30 border border-white/10 focus:outline-none focus:border-amber-500" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Description (optional)</label>
            <input type="text" value={desc} onChange={e => setDesc(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm text-white bg-black/30 border border-white/10 focus:outline-none focus:border-amber-500" placeholder="e.g. COVID arrears payment plan" />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm text-gray-400 hover:text-white" style={{ background: 'rgba(255,255,255,0.06)' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !total || !monthly}
            className="flex-1 py-2 rounded-lg text-sm font-medium text-black bg-amber-500 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Payment Plan Card ─────────────────────────────────────────────────────────
function PaymentPlanCard({
  plan, accountId, onUpdate, onDelete,
}: { plan: any; accountId: string; onUpdate: (p: any) => void; onDelete: () => void }) {
  const [applying, setApplying] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  const total = Number(plan.totalAmount);
  const remaining = Number(plan.remainingBalance);
  const monthly = Number(plan.monthlyAmount);
  const paid = total - remaining;
  const pct = total > 0 ? Math.min(100, (paid / total) * 100) : 0;
  const monthsLeft = monthly > 0 ? Math.ceil(remaining / monthly) : null;
  const isCompleted = plan.status === 'COMPLETED' || remaining <= 0;

  async function handleApplyPayment() {
    setApplying(true);
    try {
      const updated = await updatePaymentPlan(accountId, { applyPayment: monthly });
      onUpdate(updated);
    } finally { setApplying(false); }
  }

  async function handleDelete() {
    if (!confirm('Remove this payment plan?')) return;
    await deletePaymentPlan(accountId);
    onDelete();
  }

  return (
    <>
      {showEdit && (
        <PaymentPlanModal accountId={accountId} existing={plan}
          onClose={() => setShowEdit(false)} onSave={onUpdate} />
      )}
      <div className="rounded-xl px-5 py-4 mb-4" style={{ background: '#1e1e1e', border: '1px solid rgba(245,166,35,0.25)' }}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">📋 Payment Plan</span>
              {isCompleted
                ? <Pill color="green">Completed</Pill>
                : <Pill color="amber">Active</Pill>}
            </div>
            {plan.description && <p className="text-xs text-gray-500 mt-0.5">{plan.description}</p>}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowEdit(true)} className="text-xs text-gray-500 hover:text-white px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.06)' }}>Edit</button>
            <button onClick={handleDelete} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded" style={{ background: 'rgba(255,0,0,0.08)' }}>Remove</button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-3">
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>Paid: {fmtMoney(paid)}</span>
            <span>Remaining: <span className={remaining > 0 ? 'text-amber-400 font-medium' : 'text-emerald-400'}>{fmtMoney(remaining)}</span></span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
            <div className="h-full rounded-full transition-all duration-500"
              style={{ width: `${pct}%`, background: isCompleted ? '#34d399' : '#F5A623' }} />
          </div>
          <div className="flex justify-between text-xs text-gray-600 mt-1">
            <span>{pct.toFixed(0)}% paid off</span>
            <span>of {fmtMoney(total)}</span>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-4 text-xs">
          <div>
            <span className="text-gray-500">Monthly installment: </span>
            <span className="text-white font-medium">{fmtMoney(monthly)}</span>
          </div>
          {monthsLeft != null && !isCompleted && (
            <div>
              <span className="text-gray-500">Est. payoff: </span>
              <span className="text-white font-medium">~{monthsLeft} month{monthsLeft !== 1 ? 's' : ''}</span>
            </div>
          )}
          {plan.startDate && (
            <div>
              <span className="text-gray-500">Started: </span>
              <span className="text-gray-300">{format(new Date(plan.startDate), 'MMM d, yyyy')}</span>
            </div>
          )}
        </div>

        {/* Apply installment button */}
        {!isCompleted && (
          <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between">
            <p className="text-xs text-gray-500">Mark this month's installment ({fmtMoney(monthly)}) as paid</p>
            <button onClick={handleApplyPayment} disabled={applying}
              className="text-xs px-3 py-1.5 rounded-lg font-medium text-black bg-amber-500 hover:bg-amber-400 disabled:opacity-50 transition-colors">
              {applying ? 'Applying…' : '✓ Apply Payment'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export default function UtilityDetailPage() {
  const { propertyId, accountId } = useParams<{ propertyId: string; accountId: string }>();
  const navigate = useNavigate();
  const [account, setAccount] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<Tab>('statements');
  const [search, setSearch] = useState('');
  const [yearFilter, setYearFilter] = useState<string>('all');
  const [plan, setPlan] = useState<any>(null);
  const [showPlanModal, setShowPlanModal] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    Promise.all([
      getUtility(accountId).then(setAccount),
      getPaymentPlan(accountId).then(setPlan),
    ]).finally(() => setLoading(false));
  }, [accountId]);

  async function handleSync() {
    if (!accountId) return;
    setSyncing(true);
    try {
      await syncUtility(accountId);
      const poll = async () => {
        const updated = await getUtility(accountId);
        setAccount(updated);
        if (updated.lastSyncStatus === 'PENDING' || updated.lastSyncStatus === null) {
          setTimeout(poll, 2000);
        } else {
          setSyncing(false);
        }
      };
      setTimeout(poll, 2000);
    } catch { setSyncing(false); }
  }

  async function handleDelete() {
    if (!accountId) return;
    const confirmed = window.confirm(
      `Delete "${account?.providerName}"?\n\nThis will permanently remove the account, all statements, payments, and PDFs. This cannot be undone.`
    );
    if (!confirmed) return;
    setDeleting(true);
    try {
      await deleteUtility(accountId);
      navigate(propertyId ? `/properties/${propertyId}` : '/properties');
    } catch {
      setDeleting(false);
    }
  }

  const statements: any[] = useMemo(() => account?.statements || [], [account]);
  const payments: any[] = useMemo(() => account?.payments || [], [account]);

  const stmtYears = useMemo(() => {
    const years = new Set(statements.map(s => new Date(s.statementDate).getFullYear().toString()));
    return Array.from(years).sort((a, b) => Number(b) - Number(a));
  }, [statements]);

  const pmtYears = useMemo(() => {
    const years = new Set(payments.map(p => new Date(p.paymentDate).getFullYear().toString()));
    return Array.from(years).sort((a, b) => Number(b) - Number(a));
  }, [payments]);

  const years = tab === 'statements' ? stmtYears : pmtYears;

  const filteredStatements = useMemo(() => statements.filter(s => {
    const date = new Date(s.statementDate);
    if (yearFilter !== 'all' && date.getFullYear().toString() !== yearFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!format(date, 'MMMM yyyy').toLowerCase().includes(q) && !String(s.amountDue || '').includes(q)) return false;
    }
    return true;
  }), [statements, yearFilter, search]);

  const filteredPayments = useMemo(() => payments.filter(p => {
    const date = new Date(p.paymentDate);
    if (yearFilter !== 'all' && date.getFullYear().toString() !== yearFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const dateStr = format(date, 'MMMM yyyy').toLowerCase();
      if (!dateStr.includes(q) && !(p.confirmationNumber || '').toLowerCase().includes(q) && !String(p.amount || '').includes(q)) return false;
    }
    return true;
  }), [payments, yearFilter, search]);

  // Fees/penalties aggregated across all statements
  const feesData = useMemo(() => statements.map(s => {
    const raw = s.rawDataJson as Record<string, unknown> | undefined;
    if (!raw) return null;
    const penalties  = raw.penalties  != null ? Number(raw.penalties)  : null;
    const adjustments= raw.adjustments != null ? Number(raw.adjustments): null;
    const taxCharge  = raw.taxCharge  != null ? Number(raw.taxCharge)  : null;
    const afterDue   = raw.afterDueDateAmt != null ? Number(raw.afterDueDateAmt) : null;
    if ([penalties, adjustments, taxCharge, afterDue].every(v => v == null || v === 0)) return null;
    return {
      id: s.id, date: s.statementDate,
      penalties, adjustments, taxCharge, afterDue,
      total: (penalties || 0) + (adjustments || 0) + (taxCharge || 0) + (afterDue || 0),
    };
  }).filter(Boolean), [statements]);

  const totalFees = feesData.reduce((s, r: any) => s + (r?.total || 0), 0);
  const totalPenalties = feesData.reduce((s, r: any) => s + (r?.penalties || 0), 0);
  const totalTax = feesData.reduce((s, r: any) => s + (r?.taxCharge || 0), 0);

  const currentYear = new Date().getFullYear();
  const ytdTotal = statements
    .filter(s => new Date(s.statementDate).getFullYear() === currentYear)
    .reduce((sum, s) => sum + Number(s.amountDue ?? 0), 0);
  const latestAmt = statements[0]?.amountDue != null ? Number(statements[0].amountDue) : null;
  const prevAmt = statements[1]?.amountDue != null ? Number(statements[1].amountDue) : null;
  const momPct = latestAmt != null && prevAmt != null && prevAmt !== 0
    ? ((latestAmt - prevAmt) / prevAmt) * 100 : null;
  const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0);

  // Past due from latest statement
  const latestRaw = statements[0]?.rawDataJson as Record<string, unknown> | undefined;
  const latestPastDue = latestRaw?.pastDue != null ? Number(latestRaw.pastDue) : null;
  const latestTotalDue = (latestRaw?.accountBalance ?? latestRaw?.totalDue) as number | undefined;

  if (loading) return <div className="p-6 space-y-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  if (!account) return <div className="p-6 text-gray-400">Account not found</div>;

  const color = (CATEGORY_COLORS as Record<string, string>)[account.category] || '#888';
  const icon = CATEGORY_ICONS[account.category as string] || '📄';
  const property = account.property;
  const propertyLabel = property?.nickname || property?.address || 'Property';

  return (
    <div>
      {showPlanModal && (
        <PaymentPlanModal accountId={accountId!} existing={plan}
          onClose={() => setShowPlanModal(false)}
          onSave={p => { setPlan(p); setShowPlanModal(false); }} />
      )}

      {/* Header */}
      <div className="px-6 py-4 sticky top-0 z-10 flex items-center justify-between"
        style={{ background: '#1e1e1e', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
            <Link to="/properties" className="hover:text-gray-300 transition-colors">Properties</Link>
            <span>›</span>
            <Link to={`/properties/${propertyId}`} className="hover:text-gray-300 transition-colors">{propertyLabel}</Link>
            <span>›</span>
            <span className="text-gray-300">{account.providerName}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm"
              style={{ background: `${color}22`, border: `1px solid ${color}44` }}>
              {icon}
            </div>
            <h1 className="text-base font-semibold text-white">{account.providerName}</h1>
            <span className="text-xs text-gray-500">{(CATEGORY_LABELS as Record<string, string>)[account.category]}</span>
            {account.accountNumber && (
              <span className="font-mono text-xs text-gray-600">{account.accountNumber}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleSync} disabled={syncing || deleting} className="btn btn-primary text-xs">
            {syncing ? 'Syncing…' : 'Sync ↻'}
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting || syncing}
            className="text-xs px-3 py-1.5 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-40"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="px-6 py-4 grid grid-cols-5 gap-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        {[
          {
            label: 'Current balance',
            value: fmtMoney(latestTotalDue ?? latestAmt),
            sub: latestPastDue && latestPastDue > 0
              ? <span className="text-red-400">{fmtMoney(latestPastDue)} past due</span>
              : undefined,
          },
          {
            label: 'Month over month',
            value: momPct != null ? `${momPct > 0 ? '↑' : '↓'} ${Math.abs(momPct).toFixed(1)}%` : '—',
            color: momPct != null ? (momPct > 0 ? 'text-red-400' : 'text-emerald-400') : 'text-white',
          },
          { label: `YTD ${currentYear}`, value: fmtMoney(ytdTotal || null) },
          { label: 'Total paid', value: fmtMoney(totalPaid || null), sub: `${payments.length} payments` },
          {
            label: 'Total fees & penalties',
            value: fmtMoney(totalFees || null),
            color: totalFees > 0 ? 'text-orange-400' : 'text-white',
            sub: totalFees > 0 ? `across ${feesData.length} bills` : undefined,
          },
        ].map(({ label, value, color: c, sub }) => (
          <div key={label} className="rounded-xl px-4 py-3" style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-xs text-gray-500 mb-1">{label}</p>
            <p className={`text-lg font-semibold ${c || 'text-white'}`}>{value}</p>
            {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
          </div>
        ))}
      </div>

      <div className="px-6 pt-4">
        {/* Payment Plan section */}
        {plan ? (
          <PaymentPlanCard plan={plan} accountId={accountId!}
            onUpdate={setPlan} onDelete={() => setPlan(null)} />
        ) : (
          <button
            onClick={() => setShowPlanModal(true)}
            className="w-full mb-4 py-2.5 rounded-xl text-xs text-gray-500 hover:text-gray-300 transition-colors text-left px-4"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)' }}
          >
            + Add payment plan (for arrears / installment arrangements)
          </button>
        )}

        {/* Tabs + search */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-1">
            {([
              ['statements', `Statements (${statements.length})`],
              ['payments',   `Payments (${payments.length})`],
              ['fees',       `Fees & Penalties${feesData.length > 0 ? ` (${feesData.length})` : ''}`],
            ] as [Tab, string][]).map(([t, label]) => (
              <button key={t} onClick={() => { setTab(t); setYearFilter('all'); setSearch(''); }}
                className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  tab === t ? 'bg-[#F5A623] text-black' : 'text-gray-400 hover:text-white'
                }`}
                style={tab !== t ? { background: 'rgba(255,255,255,0.06)' } : {}}>
                {label}
              </button>
            ))}
          </div>
          {tab !== 'fees' && (
            <div className="flex items-center gap-2">
              <input type="text"
                placeholder={tab === 'statements' ? 'Search by month, amount…' : 'Search by date, confirmation…'}
                value={search} onChange={e => setSearch(e.target.value)}
                className="text-xs px-3 py-1.5 rounded-lg text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', width: 220 }}
              />
              <select value={yearFilter} onChange={e => setYearFilter(e.target.value)}
                className="text-xs px-3 py-1.5 rounded-lg text-gray-300 focus:outline-none"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <option value="all">All years</option>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          )}
        </div>

        {/* ── Statements ───────────────────────────────────── */}
        {tab === 'statements' && (
          filteredStatements.length === 0
            ? <EmptyState icon="📄" title="No statements" body={search || yearFilter !== 'all' ? 'No statements match your filter.' : 'Sync this account to pull statement history.'} />
            : (
              <div className="space-y-2 pb-8">
                {filteredStatements.map((s, idx) => {
                  const { color: sc, label: sl } = statementStatus(s);
                  const raw = s.rawDataJson as Record<string, unknown> | undefined;
                  const pastDue     = raw?.pastDue      != null ? Number(raw.pastDue)      : null;
                  const totalDue    = (raw?.accountBalance ?? raw?.totalDue) != null
                                      ? Number(raw?.accountBalance ?? raw?.totalDue) : null;
                  const prevBal     = raw?.previousBalance != null ? Number(raw.previousBalance) : null;
                  const currentBill = raw?.currentBill   != null ? Number(raw.currentBill)   : null;
                  const isLatest = idx === 0 && yearFilter === 'all' && !search;
                  return (
                    <div key={s.id} className="rounded-xl px-5 py-4 flex items-center gap-4"
                      style={{
                        background: '#1e1e1e',
                        border: isLatest ? '1px solid rgba(245,166,35,0.3)' : '1px solid rgba(255,255,255,0.06)',
                      }}>
                      {/* Month */}
                      <div className="w-20 flex-shrink-0">
                        <p className="text-sm font-semibold text-white">{format(new Date(s.statementDate), 'MMM yyyy')}</p>
                        {isLatest && <p className="text-xs text-amber-500 mt-0.5">Latest</p>}
                      </div>

                      {/* Billing period + flags */}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-500">
                          {s.billingPeriodStart && s.billingPeriodEnd
                            ? `${format(new Date(s.billingPeriodStart), 'MMM d')} – ${format(new Date(s.billingPeriodEnd), 'MMM d, yyyy')}`
                            : 'Billing period —'}
                        </p>
                        {pastDue != null && pastDue > 0 && (
                          <p className="text-xs text-red-400 mt-0.5">⚠ Past due: {fmtMoney(pastDue)}</p>
                        )}
                        {prevBal != null && prevBal > 0 && (
                          <p className="text-xs text-gray-500 mt-0.5">Prev balance: {fmtMoney(prevBal)}</p>
                        )}
                        {s.usageValue && (
                          <p className="text-xs text-gray-600 mt-0.5">{s.usageValue} {s.usageUnit}</p>
                        )}
                      </div>

                      {/* Due date */}
                      <div className="text-right flex-shrink-0 w-24">
                        {s.dueDate && (
                          <p className="text-xs text-gray-500">Due {format(new Date(s.dueDate), 'MMM d')}</p>
                        )}
                        {currentBill != null && totalDue != null && totalDue !== currentBill && (
                          <p className="text-xs text-gray-600 mt-0.5">Bill: {fmtMoney(currentBill)}</p>
                        )}
                      </div>

                      {/* Amount — show totalDue if different from amountDue */}
                      <div className="text-right flex-shrink-0 w-28">
                        <p className="text-base font-semibold text-white">
                          {fmtMoney(totalDue ?? s.amountDue)}
                        </p>
                        {totalDue != null && Number(s.amountDue) !== totalDue && (
                          <p className="text-xs text-gray-500">Current: {fmtMoney(s.amountDue)}</p>
                        )}
                      </div>

                      <div className="flex-shrink-0 w-20 text-right">
                        <Pill color={sc}>{sl}</Pill>
                      </div>

                      {s.pdfS3Key && (
                        <div className="flex-shrink-0">
                          <button
                            onClick={async () => {
                              try {
                                const res = await getStatementDownloadUrl(s.id);
                                window.open(res.url, '_blank', 'noopener,noreferrer');
                              } catch { alert('Could not open PDF.'); }
                            }}
                            className="text-xs px-2 py-1 rounded transition-colors hover:opacity-80"
                            style={{ background: 'rgba(245,166,35,0.12)', border: '1px solid rgba(245,166,35,0.3)', color: '#F5A623' }}
                          >
                            📄 PDF
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
        )}

        {/* ── Payments ─────────────────────────────────────── */}
        {tab === 'payments' && (
          filteredPayments.length === 0
            ? <EmptyState icon="💳" title="No payments" body={search || yearFilter !== 'all' ? 'No payments match your filter.' : 'No payment history found for this account.'} />
            : (
              <div className="space-y-2 pb-8">
                {filteredPayments.map(p => (
                  <div key={p.id} className="rounded-xl px-5 py-4 flex items-center gap-4"
                    style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="w-28 flex-shrink-0">
                      <p className="text-sm font-semibold text-white">{format(new Date(p.paymentDate), 'MMM d, yyyy')}</p>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-300">{p.paymentMethod || 'Payment'}</p>
                      {p.confirmationNumber && (
                        <p className="font-mono text-xs text-gray-500 mt-0.5">Conf# {p.confirmationNumber}</p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0 w-24">
                      <p className="text-base font-semibold text-white">{fmtMoney(p.amount)}</p>
                    </div>
                    <div className="flex-shrink-0 w-20 text-right">
                      <Pill color={p.status === 'PAID' ? 'green' : p.status === 'PENDING' ? 'amber' : 'red'}>{p.status}</Pill>
                    </div>
                  </div>
                ))}
              </div>
            )
        )}

        {/* ── Fees & Penalties ─────────────────────────────── */}
        {tab === 'fees' && (
          feesData.length === 0
            ? <EmptyState icon="🧾" title="No fees or penalties" body="No fees, penalties, or adjustments found across your statements." />
            : (
              <div className="space-y-4 pb-8">
                {/* Summary cards */}
                <div className="grid grid-cols-3 gap-3 mb-2">
                  {[
                    { label: 'Total penalties', value: fmtMoney(totalPenalties), color: totalPenalties > 0 ? 'text-red-400' : 'text-gray-400' },
                    { label: 'Total taxes/fees', value: fmtMoney(totalTax), color: 'text-orange-400' },
                    { label: 'All charges total', value: fmtMoney(totalFees), color: 'text-amber-400' },
                  ].map(({ label, value, color: c }) => (
                    <div key={label} className="rounded-xl px-4 py-3" style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <p className="text-xs text-gray-500 mb-1">{label}</p>
                      <p className={`text-lg font-semibold ${c}`}>{value}</p>
                    </div>
                  ))}
                </div>

                {/* Per-statement breakdown */}
                {(feesData as any[]).map((r: any) => (
                  <div key={r.id} className="rounded-xl px-5 py-4"
                    style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm font-semibold text-white">{format(new Date(r.date), 'MMMM yyyy')}</p>
                      <p className="text-sm font-semibold text-orange-400">{fmtMoney(r.total)}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-1.5">
                      {[
                        ['Penalties',       r.penalties,  'text-red-400'],
                        ['Late fee (after due)', r.afterDue, 'text-red-300'],
                        ['Tax / surcharge', r.taxCharge,  'text-orange-300'],
                        ['Adjustments',     r.adjustments,'text-gray-300'],
                      ].filter(([, v]) => v != null && Number(v) !== 0).map(([label, value, c]) => (
                        <div key={String(label)} className="flex items-center justify-between">
                          <span className="text-xs text-gray-500">{label}</span>
                          <span className={`text-xs font-medium ${c}`}>{fmtMoney(Number(value))}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
        )}
      </div>
    </div>
  );
}
