import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUser } from '@clerk/clerk-react';
import { getDashboardSummary, getRecentActivity, getInsights, queryPortfolio, getPlaidItems, getBankAccounts, getLeases, getRentPayments } from '../api/client';
import type { DashboardSummary, AIInsight, BankAccount, Lease, RentPayment } from '../types';
import type { PlaidItem } from '../api/client';
import { StatCard, InsightCard, Skeleton, EmptyState } from '../components/ui';
import { format } from 'date-fns';
import AddPropertyModal from '../components/property/AddPropertyModal';
import { fmtDate } from '../lib/date';

const SUGGESTIONS = [
  "Who hasn't paid rent this month?",
  "What utilities are due soon?",
  "Total loan balance?",
  "Any past-due bills?",
];

export default function DashboardPage() {
  const { user } = useUser();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [activity, setActivity] = useState<any>(null);
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [plaidItems, setPlaidItems] = useState<PlaidItem[]>([]);
  const [manualAccounts, setManualAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddProperty, setShowAddProperty] = useState(false);

  // AI search bar state
  const [leases, setLeases] = useState<Lease[]>([]);
  const [rentPayments, setRentPayments] = useState<RentPayment[]>([]);
  const [showDue, setShowDue] = useState(false);
  const [query, setQuery] = useState('');
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryAnswer, setQueryAnswer] = useState('');
  const [queryError, setQueryError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  useEffect(() => {
    Promise.all([
      getDashboardSummary(),
      getRecentActivity(),
      getInsights({ unread: true }),
      getPlaidItems().catch(() => []),
      getBankAccounts().catch(() => []),
      getLeases({ status: 'ACTIVE' }).catch(() => []),
      getRentPayments().catch(() => []),
    ]).then(([s, a, i, p, ba, ls, rp]) => {
      setSummary(s);
      setLeases(ls as Lease[]);
      setRentPayments(rp as RentPayment[]);
      setActivity(a);
      setInsights(i.slice(0, 4));
      setPlaidItems(p as PlaidItem[]);
      const plaidIds = new Set((p as PlaidItem[]).flatMap((pi: PlaidItem) => pi.accounts.map((ac: any) => ac.id)));
      setManualAccounts((ba as any[]).filter((ac: any) => !ac.plaidAccountId && !plaidIds.has(ac.id)));
    }).finally(() => setLoading(false));
  }, []);

  async function handleQuery(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setQueryLoading(true);
    setQueryAnswer('');
    setQueryError('');
    try {
      const { answer } = await queryPortfolio(query.trim());
      setQueryAnswer(answer);
    } catch {
      setQueryError('Could not get an answer — please try again.');
    } finally {
      setQueryLoading(false);
    }
  }

  function applySuggestion(s: string) {
    setQuery(s);
    setQueryAnswer('');
    setQueryError('');
    inputRef.current?.focus();
  }

  return (
    <div>
      {/* Top bar */}
      <div className="px-6 py-4 flex items-center justify-between sticky top-0 z-10"
        style={{ background: '#1e1e1e', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div>
          <h1 className="text-base font-semibold text-white">
            {greeting}, {user?.firstName || 'there'} ☀️
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            {summary?.billsDueSoon ? ` — ${summary.billsDueSoon} bill${summary.billsDueSoon === 1 ? '' : 's'} due this week` : ''}
          </p>
        </div>
        <button onClick={() => setShowAddProperty(true)} className="btn btn-primary text-xs">
          + Add property
        </button>
      </div>

      <div className="px-6 py-5">
        {/* Stats */}
        <p className="section-label mb-2">Portfolio summary</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {loading ? Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-20" />) : (
            <>
              <StatCard
                label="Total due this month"
                value={`$${summary?.monthlyTotal?.toLocaleString('en-US', { minimumFractionDigits: 0 }) ?? '—'}`}
                sub="Across all utility accounts"
                subColor="neutral"
              />
              <StatCard
                label="Properties tracked"
                value={summary?.totalProperties ?? '—'}
                sub={`${summary?.totalUtilityAccounts ?? 0} utility accounts`}
                subColor="neutral"
              />
              <div className="relative">
                <button
                  type="button"
                  onClick={() => summary?.billsDueSoon && setShowDue(v => !v)}
                  className="stat-card w-full text-left"
                  style={{ cursor: summary?.billsDueSoon ? 'pointer' : 'default' }}
                  aria-expanded={showDue}
                >
                  <p className="text-xs text-gray-500 mb-1">Bills due this week</p>
                  <p className="text-xl font-semibold text-white leading-none">{summary?.billsDueSoon ?? '—'}</p>
                  <p className={`text-xs mt-1 flex items-center gap-1 ${summary?.billsDueSoon ? 'text-red-400' : 'text-emerald-400'}`}>
                    {summary?.billsDueSoon ? 'Needs attention' : 'All clear'}
                    {!!summary?.billsDueSoon && <span className="text-gray-500">{showDue ? '▴' : '▾'}</span>}
                  </p>
                </button>
                {showDue && !!summary?.billsDueSoonList?.length && (
                  <div className="absolute left-0 right-0 z-20 mt-1 rounded-xl overflow-hidden shadow-2xl" style={{ background: '#151515', border: '1px solid rgba(255,255,255,0.1)', minWidth: 320 }}>
                    {summary.billsDueSoonList.map(b => (
                      <Link
                        key={b.id}
                        to={`/properties/${b.propertyId}/utilities/${b.accountId}`}
                        className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-white/5"
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                        onClick={() => setShowDue(false)}
                      >
                        <div className="min-w-0">
                          <p className="text-xs text-white truncate">{b.propertyLabel}</p>
                          <p className="text-[11px] text-gray-500 truncate">{b.providerName} · due {fmtDate(b.dueDate, 'MMM d')}</p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-xs font-medium text-white">${(b.amountDue ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                          {!!b.pastDueCarried && b.pastDueCarried > 0 && <p className="text-[11px] text-red-400">+${b.pastDueCarried.toLocaleString('en-US', { minimumFractionDigits: 2 })} past due</p>}
                        </div>
                      </Link>
                    ))}
                    <Link to="/payments" className="block px-3 py-2 text-[11px] text-gold-500 hover:underline" onClick={() => setShowDue(false)}>All payments →</Link>
                  </div>
                )}
              </div>
              <StatCard
                label="AI alerts"
                value={summary?.unreadInsights ?? '—'}
                sub={summary?.alertInsights ? `${summary.alertInsights} urgent` : 'All reviewed'}
                subColor={summary?.alertInsights ? 'red' : 'neutral'}
              />
            </>
          )}
        </div>

        {/* Cash Position */}
        {(plaidItems.length > 0 || manualAccounts.length > 0) && <CashPositionCard items={plaidItems} manualAccounts={manualAccounts} />}

        {/* Rent */}
        {!loading && leases.length > 0 && <RentSummaryCard leases={leases} payments={rentPayments} />}

        {/* AI Search Bar */}
        <div className="mb-6">
          <div className="rounded-xl p-4" style={{ background: 'rgba(245,166,35,0.05)', border: '1px solid rgba(245,166,35,0.2)' }}>
            <div className="flex items-center gap-2 mb-3">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F5A623" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
              </svg>
              <p className="text-xs font-medium text-amber-400">Ask anything about your portfolio</p>
            </div>
            <form onSubmit={handleQuery} className="flex gap-2">
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Who hasn't paid rent this month?"
                className="flex-1 rounded-lg px-3 py-2 text-sm text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none placeholder-gray-600 transition-colors"
              />
              <button
                type="submit"
                disabled={queryLoading || !query.trim()}
                className="btn btn-primary text-xs px-5 flex-shrink-0"
              >
                {queryLoading ? (
                  <span className="flex items-center gap-1.5">
                    <svg className="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                    Thinking
                  </span>
                ) : 'Ask'}
              </button>
            </form>
            <div className="flex gap-2 mt-2.5 flex-wrap">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => applySuggestion(s)}
                  className="text-xs text-gray-600 hover:text-amber-400 px-2.5 py-1 rounded-full border border-white/6 hover:border-amber-400/25 hover:bg-amber-400/5 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {(queryAnswer || queryError) && (
            <div className="mt-2 rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
              {queryError ? (
                <p className="text-xs text-red-400">{queryError}</p>
              ) : (
                <>
                  <p className="text-xs font-medium text-amber-400 mb-2">Answer</p>
                  <p className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">{queryAnswer}</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Two column layout */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-5">
          {/* Upcoming bills */}
          <div className="col-span-3">
            <div className="flex items-center justify-between mb-2.5">
              <p className="section-label">My properties</p>
              <Link to="/properties" className="text-xs text-gold-500 hover:underline">View all →</Link>
            </div>
            {loading ? (
              <div className="space-y-2">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
            ) : activity?.upcomingBills?.length === 0 ? (
              <EmptyState icon="🏠" title="No properties yet" body="Add your first property to get started." />
            ) : (
              <div className="space-y-2">
                {(activity?.upcomingBills || []).map((bill: any) => (
                  <Link
                    key={bill.id}
                    to={`/properties/${bill.utilityAccount?.property?.id || ''}`}
                    className="card p-3 flex items-center gap-3 hover:border-gold-300 transition-colors block"
                  >
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center text-base flex-shrink-0"
                      style={{ background: 'rgba(245,166,35,0.15)' }}>
                      🏠
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">
                        {bill.utilityAccount?.property?.nickname || bill.utilityAccount?.property?.address}
                      </p>
                      <p className="text-xs text-gray-500">
                        {bill.utilityAccount?.providerName} · Due {bill.dueDate ? fmtDate(bill.dueDate, 'MMM d') : '—'}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-white">${Number(bill.amountDue).toFixed(2)}</p>
                      <span className="pill pill-amber text-xs">Due soon</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* AI Insights panel */}
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-2.5">
              <p className="section-label">AI insights</p>
              <Link to="/insights" className="text-xs text-gold-500 hover:underline">View all →</Link>
            </div>
            {loading ? (
              <div className="space-y-2">{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
            ) : insights.length === 0 ? (
              <EmptyState icon="✨" title="All clear" body="No new alerts. Sollux is monitoring your accounts." />
            ) : (
              <div>
                {insights.map(insight => (
                  <InsightCard key={insight.id} insight={insight} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {showAddProperty && <AddPropertyModal onClose={() => setShowAddProperty(false)} />}
    </div>
  );
}

// ── Cash Position Card ────────────────────────────────────────────────────────

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function EyeIcon({ hidden }: { hidden: boolean }) {
  return hidden ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

const THIRD_PARTY_KEYWORDS = ['venmo', 'apple', 'cash app', 'paypal'];
function isThirdParty(a: any) {
  const text = ((a.name || '') + ' ' + (a.bank || '')).toLowerCase();
  return THIRD_PARTY_KEYWORDS.some(k => text.includes(k));
}

function CashPositionCard({ items, manualAccounts }: { items: PlaidItem[]; manualAccounts: any[] }) {
  const [hidden, setHidden] = useState(() => sessionStorage.getItem('sollux_bal_vis') !== '1');
  const plaidAccounts = items.flatMap(i => i.accounts).filter(a => a.isActive);
  const bankAccounts  = plaidAccounts.filter(a => a.accountType !== 'CREDIT_CARD');
  const creditAccounts = plaidAccounts.filter(a => a.accountType === 'CREDIT_CARD');
  const thirdPartyAccounts = manualAccounts.filter(a => a.isActive && isThirdParty(a));
  const cashAccounts = manualAccounts.filter(a => a.isActive && !isThirdParty(a) && a.accountType !== 'CREDIT_CARD');

  const bankTotal       = bankAccounts.reduce((s, a) => s + Number(a.balances[0]?.available ?? a.balances[0]?.balance ?? 0), 0);
  const thirdPartyTotal = thirdPartyAccounts.reduce((s, a) => s + Number((a as any).balances?.[0]?.balance ?? 0), 0);
  const cashTotal       = cashAccounts.reduce((s, a) => s + Number((a as any).balances?.[0]?.balance ?? 0), 0);
  const grandTotal      = bankTotal + thirdPartyTotal + cashTotal;
  const creditTotal     = creditAccounts.reduce((s, a) => s + Number(a.balances[0]?.balance ?? 0), 0);

  const lastSync = items.map(i => i.lastSyncedAt).filter(Boolean).sort().at(-1);
  const mask = '••••';

  const buckets = [
    { label: 'Banks', total: bankTotal, count: bankAccounts.length, unit: 'accounts' },
    { label: '3rd party', total: thirdPartyTotal, count: thirdPartyAccounts.length, unit: 'services' },
    { label: 'Cash', total: cashTotal, count: cashAccounts.length, unit: 'accounts' },
  ].filter(b => b.count > 0);

  const allDisplayAccounts = [...bankAccounts, ...thirdPartyAccounts, ...cashAccounts, ...creditAccounts];

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2.5">
        <p className="section-label">Cash position</p>
        <Link to="/settings?tab=banking" className="text-xs text-gold-500 hover:underline">Manage accounts →</Link>
      </div>
      <div className="card p-4">
        {/* Grand total + toggle */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-1.5 mb-0.5">
              <p className="text-xs text-gray-400">Total available</p>
              <button
                onClick={() => setHidden(h => { const next = !h; sessionStorage.setItem('sollux_bal_vis', next ? '0' : '1'); return next; })}
                className="text-gray-600 hover:text-gray-400 transition-colors"
                title={hidden ? 'Show balances' : 'Hide balances'}
              >
                <EyeIcon hidden={hidden} />
              </button>
            </div>
            <p className="text-2xl font-semibold text-white">{hidden ? '••••••' : money(grandTotal)}</p>
            {creditAccounts.length > 0 && (
              <p className="text-xs text-gray-500 mt-0.5">
                {hidden ? mask : money(creditTotal)} credit outstanding
              </p>
            )}
          </div>
          {lastSync && (
            <span className="text-xs text-gray-600">Synced {new Date(lastSync).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
          )}
        </div>

        {/* 3-bucket breakdown */}
        {buckets.length > 1 && (
          <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            {buckets.map(b => (
              <div key={b.label} className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <p className="text-xs text-gray-500 mb-1">{b.label}</p>
                <p className="text-sm font-semibold text-white">{hidden ? mask : money(b.total)}</p>
                <p className="text-xs text-gray-600 mt-0.5">{b.count} {b.unit}</p>
              </div>
            ))}
          </div>
        )}

        {/* Individual account chips */}
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          {allDisplayAccounts.slice(0, 8).map((acct: any) => {
            const bal = acct.balances?.[0];
            const displayBal = acct.accountType === 'CREDIT_CARD'
              ? Number(bal?.balance ?? 0)
              : Number(bal?.available ?? bal?.balance ?? 0);
            return (
              <div key={acct.id} className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <p className="text-xs text-gray-400 truncate mb-0.5">{acct.name}</p>
                {acct.ownerLabel && <p className="text-xs text-amber-500/70 mb-0.5">{acct.ownerLabel}</p>}
                <p className={`text-sm font-semibold ${acct.accountType === 'CREDIT_CARD' ? 'text-red-400' : 'text-white'}`}>
                  {hidden ? mask : acct.accountType === 'CREDIT_CARD' ? `(${money(displayBal)})` : money(displayBal)}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}


/**
 * Rent, the way the utility cards already show bills: what the roll expects
 * this month, what has come in against it, who has not paid yet, and what is
 * owed from before. Paid means a received payment whose period is this
 * month, the same rule the rent roll uses when it logs one.
 */
const ordinal = (n: number) => {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

function RentSummaryCard({ leases, payments }: { leases: Lease[]; payments: RentPayment[] }) {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  const paidByLease = new Map<string, number>();
  for (const p of payments) {
    if (p.status !== 'RECEIVED') continue;
    if (String(p.periodDate).slice(0, 7) !== ym) continue;
    paidByLease.set(p.leaseId, (paidByLease.get(p.leaseId) ?? 0) + Number(p.amount));
  }

  const expected = leases.reduce((s, l) => s + Number(l.rentAmount), 0);
  const collected = leases.reduce((s, l) => s + Math.min(paidByLease.get(l.id) ?? 0, Number(l.rentAmount)), 0);
  const arrears = leases.reduce((s, l) => s + Number(l.arrearsBalance ?? 0), 0);
  const unpaid = leases
    .filter(l => (paidByLease.get(l.id) ?? 0) + 0.01 < Number(l.rentAmount))
    .map(l => ({
      lease: l,
      remaining: Number(l.rentAmount) - (paidByLease.get(l.id) ?? 0),
      overdue: now.getDate() > (l.rentDueDay ?? 1),
    }))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.remaining - a.remaining);

  const pct = expected > 0 ? Math.round((collected / expected) * 100) : 0;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2.5">
        <p className="section-label">Rent · {format(now, 'MMMM')}</p>
        <Link to="/tenants?tab=rent-roll" className="text-xs text-gold-500 hover:underline">Rent roll →</Link>
      </div>
      <div className="card p-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <div>
            <p className="text-xs text-gray-500 mb-1">Expected</p>
            <p className="text-xl font-semibold text-white leading-none">{money(expected)}</p>
            <p className="text-xs text-gray-500 mt-1">{leases.length} active lease{leases.length === 1 ? '' : 's'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Collected</p>
            <p className="text-xl font-semibold text-emerald-400 leading-none">{money(collected)}</p>
            <p className="text-xs text-gray-500 mt-1">{pct}% of expected</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Still owed this month</p>
            <p className={`text-xl font-semibold leading-none ${expected - collected > 0 ? 'text-amber-400' : 'text-white'}`}>{money(Math.max(expected - collected, 0))}</p>
            <p className="text-xs text-gray-500 mt-1">{unpaid.length} lease{unpaid.length === 1 ? '' : 's'} unpaid</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Arrears</p>
            <p className={`text-xl font-semibold leading-none ${arrears > 0 ? 'text-red-400' : 'text-white'}`}>{money(arrears)}</p>
            <p className="text-xs text-gray-500 mt-1">owed from earlier months</p>
          </div>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden mb-4" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div className="h-full rounded-full" style={{ width: `${Math.min(pct, 100)}%`, background: '#10b981' }} />
        </div>
        {unpaid.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {unpaid.slice(0, 8).map(({ lease, remaining, overdue }) => {
              const prop = lease.unit?.property;
              const tenants = lease.leaseTenants?.map(lt => lt.tenant.fullName).join(', ') || '—';
              return (
                <Link
                  key={lease.id}
                  to={lease.leaseTenants?.[0]?.tenant?.id ? `/tenants/${lease.leaseTenants[0].tenant.id}` : '/tenants?tab=rent-roll'}
                  className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-white/5"
                  style={{ border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  <div className="min-w-0">
                    <p className="text-xs text-white truncate">{prop?.nickname || prop?.address || '—'}{lease.unit?.unitLabel ? ` · ${lease.unit.unitLabel}` : ''}</p>
                    <p className="text-[11px] text-gray-500 truncate">{tenants}{lease.rentDueDay ? ` · due the ${ordinal(lease.rentDueDay)}` : ''}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs font-medium text-white">{money(remaining)}</p>
                    <p className={`text-[11px] ${overdue ? 'text-red-400' : 'text-gray-500'}`}>{overdue ? 'Late' : 'Not yet due'}</p>
                  </div>
                </Link>
              );
            })}
            {unpaid.length > 8 && <Link to="/tenants?tab=rent-roll" className="text-xs text-gold-500 hover:underline px-3 py-2">+{unpaid.length - 8} more →</Link>}
          </div>
        ) : (
          <p className="text-xs text-emerald-400">Every lease has paid for {format(now, 'MMMM')}.</p>
        )}
      </div>
    </div>
  );
}
