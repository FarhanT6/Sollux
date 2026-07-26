import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUser } from '@clerk/clerk-react';
import { getDashboardSummary, getRecentActivity, getInsights, queryPortfolio } from '../api/client';
import type { DashboardSummary, AIInsight } from '../types';
import { StatCard, InsightCard, Skeleton, EmptyState } from '../components/ui';
import { format } from 'date-fns';
import AddPropertyModal from '../components/property/AddPropertyModal';

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
  const [loading, setLoading] = useState(true);
  const [showAddProperty, setShowAddProperty] = useState(false);

  // AI search bar state
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
    ]).then(([s, a, i]) => {
      setSummary(s);
      setActivity(a);
      setInsights(i.slice(0, 4));
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
        <div className="grid grid-cols-4 gap-3 mb-6">
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
              <StatCard
                label="Bills due this week"
                value={summary?.billsDueSoon ?? '—'}
                sub={summary?.billsDueSoon ? 'Needs attention' : 'All clear'}
                subColor={summary?.billsDueSoon ? 'red' : 'green'}
              />
              <StatCard
                label="AI alerts"
                value={summary?.unreadInsights ?? '—'}
                sub={summary?.alertInsights ? `${summary.alertInsights} urgent` : 'All reviewed'}
                subColor={summary?.alertInsights ? 'red' : 'neutral'}
              />
            </>
          )}
        </div>

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
        <div className="grid grid-cols-5 gap-5">
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
                        {bill.utilityAccount?.providerName} · Due {bill.dueDate ? format(new Date(bill.dueDate), 'MMM d') : '—'}
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
