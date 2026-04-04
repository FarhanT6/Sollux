import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUser } from '@clerk/clerk-react';
import { getDashboardSummary, getRecentActivity, getInsights } from '../api/client';
import type { DashboardSummary, AIInsight } from '../types';
import { StatCard, InsightCard, Skeleton, EmptyState } from '../components/ui';
import { format } from 'date-fns';

export default function DashboardPage() {
  const { user } = useUser();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [activity, setActivity] = useState<any>(null);
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div>
      {/* Top bar */}
      <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between bg-white sticky top-0 z-10">
        <div>
          <h1 className="text-base font-semibold text-gray-900">
            {greeting}, {user?.firstName || 'there'} ☀
          </h1>
          <p className="text-xs text-gray-400 mt-0.5">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            {summary?.billsDueSoon ? ` · ${summary.billsDueSoon} bill${summary.billsDueSoon === 1 ? '' : 's'} due this week` : ''}
          </p>
        </div>
        <Link to="/properties/new" className="btn btn-primary text-xs">
          + Add property
        </Link>
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

        {/* Two column layout */}
        <div className="grid grid-cols-5 gap-5">
          {/* Properties list */}
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
                {(activity?.upcomingBills || []).slice(0, 5).map((bill: any) => (
                  <Link
                    key={bill.id}
                    to={`/properties/${bill.utilityAccount?.property?.id || ''}`}
                    className="card p-3 flex items-center gap-3 hover:border-gold-300 transition-colors block"
                  >
                    <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center text-base flex-shrink-0">
                      🏠
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {bill.utilityAccount?.property?.nickname || bill.utilityAccount?.property?.address}
                      </p>
                      <p className="text-xs text-gray-400">
                        {bill.utilityAccount?.providerName} · Due {bill.dueDate ? format(new Date(bill.dueDate), 'MMM d') : '—'}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-gray-900">${Number(bill.amountDue).toFixed(2)}</p>
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
    </div>
  );
}
