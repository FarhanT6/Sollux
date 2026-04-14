import { useEffect, useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getUtility, syncUtility, getStatementDownloadUrl } from '../api/client';
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

type Tab = 'statements' | 'payments';

export default function UtilityDetailPage() {
  const { propertyId, accountId } = useParams<{ propertyId: string; accountId: string }>();
  const [account, setAccount] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<Tab>('statements');
  const [search, setSearch] = useState('');
  const [yearFilter, setYearFilter] = useState<string>('all');

  useEffect(() => {
    if (!accountId) return;
    getUtility(accountId).then(setAccount).finally(() => setLoading(false));
  }, [accountId]);

  async function handleSync() {
    if (!accountId) return;
    setSyncing(true);
    try {
      await syncUtility(accountId);
      // Poll until done
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

  const statements: any[] = useMemo(() => account?.statements || [], [account]);
  const payments: any[] = useMemo(() => account?.payments || [], [account]);

  // Available years for filter
  const stmtYears = useMemo(() => {
    const years = new Set(statements.map(s => new Date(s.statementDate).getFullYear().toString()));
    return Array.from(years).sort((a, b) => Number(b) - Number(a));
  }, [statements]);

  const pmtYears = useMemo(() => {
    const years = new Set(payments.map(p => new Date(p.paymentDate).getFullYear().toString()));
    return Array.from(years).sort((a, b) => Number(b) - Number(a));
  }, [payments]);

  const years = tab === 'statements' ? stmtYears : pmtYears;

  // Filter + search statements
  const filteredStatements = useMemo(() => {
    return statements.filter(s => {
      const date = new Date(s.statementDate);
      if (yearFilter !== 'all' && date.getFullYear().toString() !== yearFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const dateStr = format(date, 'MMMM yyyy').toLowerCase();
        const amt = String(s.amountDue || '');
        if (!dateStr.includes(q) && !amt.includes(q)) return false;
      }
      return true;
    });
  }, [statements, yearFilter, search]);

  // Filter + search payments
  const filteredPayments = useMemo(() => {
    return payments.filter(p => {
      const date = new Date(p.paymentDate);
      if (yearFilter !== 'all' && date.getFullYear().toString() !== yearFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const dateStr = format(date, 'MMMM yyyy').toLowerCase();
        const conf = (p.confirmationNumber || '').toLowerCase();
        const amt = String(p.amount || '');
        if (!dateStr.includes(q) && !conf.includes(q) && !amt.includes(q)) return false;
      }
      return true;
    });
  }, [payments, yearFilter, search]);

  // YTD + stats
  const currentYear = new Date().getFullYear();
  const ytdTotal = statements
    .filter(s => new Date(s.statementDate).getFullYear() === currentYear)
    .reduce((sum, s) => sum + Number(s.amountDue ?? 0), 0);
  const latestAmt = statements[0]?.amountDue != null ? Number(statements[0].amountDue) : null;
  const prevAmt = statements[1]?.amountDue != null ? Number(statements[1].amountDue) : null;
  const momPct = latestAmt != null && prevAmt != null && prevAmt !== 0
    ? ((latestAmt - prevAmt) / prevAmt) * 100 : null;
  const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0);

  if (loading) return <div className="p-6 space-y-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  if (!account) return <div className="p-6 text-gray-400">Account not found</div>;

  const color = (CATEGORY_COLORS as Record<string, string>)[account.category] || '#888';
  const icon = CATEGORY_ICONS[account.category as string] || '📄';
  const property = account.property;
  const propertyLabel = property?.nickname || property?.address || 'Property';

  return (
    <div>
      {/* Header */}
      <div className="px-6 py-4 sticky top-0 z-10 flex items-center justify-between"
        style={{ background: '#1e1e1e', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div>
          {/* Breadcrumb */}
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
        <button
          onClick={handleSync}
          disabled={syncing}
          className="btn btn-primary text-xs"
        >
          {syncing ? 'Syncing…' : 'Sync ↻'}
        </button>
      </div>

      {/* Stats bar */}
      <div className="px-6 py-4 grid grid-cols-4 gap-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        {[
          { label: 'Latest bill', value: fmtMoney(latestAmt) },
          {
            label: 'Month over month',
            value: momPct != null ? `${momPct > 0 ? '↑' : '↓'} ${Math.abs(momPct).toFixed(1)}%` : '—',
            color: momPct != null ? (momPct > 0 ? 'text-red-400' : 'text-emerald-400') : 'text-white',
          },
          { label: `YTD ${currentYear}`, value: fmtMoney(ytdTotal || null) },
          { label: 'Total paid', value: fmtMoney(totalPaid || null), sub: `${payments.length} payments` },
        ].map(({ label, value, color: c, sub }) => (
          <div key={label} className="rounded-xl px-4 py-3" style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-xs text-gray-500 mb-1">{label}</p>
            <p className={`text-lg font-semibold ${c || 'text-white'}`}>{value}</p>
            {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
          </div>
        ))}
      </div>

      {/* Tabs + search */}
      <div className="px-6 pt-4">
        <div className="flex items-center justify-between mb-4">
          {/* Tab pills */}
          <div className="flex gap-1">
            {(['statements', 'payments'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setYearFilter('all'); setSearch(''); }}
                className={`px-4 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                  tab === t ? 'bg-[#F5A623] text-black' : 'text-gray-400 hover:text-white'
                }`}
                style={tab !== t ? { background: 'rgba(255,255,255,0.06)' } : {}}
              >
                {t === 'statements' ? `Statements (${statements.length})` : `Payments (${payments.length})`}
              </button>
            ))}
          </div>

          {/* Search + year filter */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder={tab === 'statements' ? 'Search by month, amount…' : 'Search by date, confirmation…'}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-52 px-3 py-1.5 rounded-lg text-xs text-white outline-none"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            />
            <select
              value={yearFilter}
              onChange={e => setYearFilter(e.target.value)}
              className="px-3 py-1.5 rounded-lg text-xs text-white outline-none"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <option value="all">All years</option>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {/* ── Statements ─────────────────────────────────────────── */}
        {tab === 'statements' && (
          filteredStatements.length === 0
            ? <EmptyState icon="📄" title="No statements" body={search || yearFilter !== 'all' ? 'No statements match your filter.' : 'Sync this account to pull statement history.'} />
            : (
              <div className="space-y-2 pb-8">
                {filteredStatements.map((s, idx) => {
                  const { color: sc, label: sl } = statementStatus(s);
                  const raw = s.rawDataJson as Record<string, unknown> | undefined;
                  const pastDue = raw?.pastDue as number | undefined;
                  const isLatest = idx === 0 && yearFilter === 'all' && !search;
                  return (
                    <div
                      key={s.id}
                      className="rounded-xl px-5 py-4 flex items-center gap-4"
                      style={{
                        background: '#1e1e1e',
                        border: isLatest ? '1px solid rgba(245,166,35,0.3)' : '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      {/* Month label */}
                      <div className="w-20 flex-shrink-0">
                        <p className="text-sm font-semibold text-white">
                          {format(new Date(s.statementDate), 'MMM yyyy')}
                        </p>
                        {isLatest && <p className="text-xs text-amber-500 mt-0.5">Latest</p>}
                      </div>

                      {/* Billing period */}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-500">
                          {s.billingPeriodStart && s.billingPeriodEnd
                            ? `${format(new Date(s.billingPeriodStart), 'MMM d')} – ${format(new Date(s.billingPeriodEnd), 'MMM d, yyyy')}`
                            : 'Billing period —'}
                        </p>
                        {pastDue && pastDue > 0 && (
                          <p className="text-xs text-red-400 mt-0.5">Past due: {fmtMoney(pastDue)}</p>
                        )}
                        {s.usageValue && (
                          <p className="text-xs text-gray-600 mt-0.5">{s.usageValue} {s.usageUnit}</p>
                        )}
                      </div>

                      {/* Due date */}
                      <div className="text-right flex-shrink-0 w-24">
                        {s.dueDate && (
                          <p className="text-xs text-gray-500">
                            Due {format(new Date(s.dueDate), 'MMM d')}
                          </p>
                        )}
                      </div>

                      {/* Amount */}
                      <div className="text-right flex-shrink-0 w-24">
                        <p className="text-base font-semibold text-white">{fmtMoney(s.amountDue)}</p>
                      </div>

                      {/* Status */}
                      <div className="flex-shrink-0 w-20 text-right">
                        <Pill color={sc}>{sl}</Pill>
                      </div>

                      {/* PDF — click to open signed S3 URL in new tab */}
                      {s.pdfS3Key && (
                        <div className="flex-shrink-0">
                          <button
                            onClick={async () => {
                              try {
                                const res = await getStatementDownloadUrl(s.id);
                                window.open(res.url, '_blank', 'noopener,noreferrer');
                              } catch {
                                alert('Could not open PDF. Please try again.');
                              }
                            }}
                            className="text-xs px-2 py-1 rounded transition-colors hover:opacity-80"
                            style={{ background: 'rgba(245,166,35,0.12)', border: '1px solid rgba(245,166,35,0.3)', color: '#F5A623' }}
                            title="View PDF statement"
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

        {/* ── Payments ────────────────────────────────────────────── */}
        {tab === 'payments' && (
          filteredPayments.length === 0
            ? <EmptyState icon="💳" title="No payments" body={search || yearFilter !== 'all' ? 'No payments match your filter.' : 'No payment history found for this account.'} />
            : (
              <div className="space-y-2 pb-8">
                {filteredPayments.map(p => (
                  <div
                    key={p.id}
                    className="rounded-xl px-5 py-4 flex items-center gap-4"
                    style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}
                  >
                    {/* Date */}
                    <div className="w-28 flex-shrink-0">
                      <p className="text-sm font-semibold text-white">
                        {format(new Date(p.paymentDate), 'MMM d, yyyy')}
                      </p>
                    </div>

                    {/* Method + confirmation */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-300">{p.paymentMethod || 'Payment'}</p>
                      {p.confirmationNumber && (
                        <p className="font-mono text-xs text-gray-500 mt-0.5">
                          Conf# {p.confirmationNumber}
                        </p>
                      )}
                    </div>

                    {/* Amount */}
                    <div className="text-right flex-shrink-0 w-24">
                      <p className="text-base font-semibold text-white">{fmtMoney(p.amount)}</p>
                    </div>

                    {/* Status */}
                    <div className="flex-shrink-0 w-20 text-right">
                      <Pill color={p.status === 'PAID' ? 'green' : p.status === 'PENDING' ? 'amber' : 'red'}>
                        {p.status}
                      </Pill>
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
