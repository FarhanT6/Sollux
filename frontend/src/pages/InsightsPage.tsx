// ── InsightsPage ──────────────────────────────────────────
import { useEffect, useState } from 'react';
import { getInsights, markInsightRead, dismissInsight } from '../api/client';
import type { AIInsight } from '../types';
import { PageHeader, InsightCard, EmptyState, Skeleton } from '../components/ui';

export default function InsightsPage() {
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [filter, setFilter] = useState<'all' | 'ALERT' | 'WARNING' | 'INFO'>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getInsights().then(data => setInsights(data.filter(i => !i.isDismissed))).finally(() => setLoading(false));
  }, []);

  const filtered = filter === 'all' ? insights : insights.filter(i => i.severity === filter);
  const unread = insights.filter(i => !i.isRead).length;

  async function handleRead(id: string) {
    await markInsightRead(id);
    setInsights(prev => prev.map(i => i.id === id ? { ...i, isRead: true } : i));
  }
  async function handleDismiss(id: string) {
    await dismissInsight(id);
    setInsights(prev => prev.filter(i => i.id !== id));
  }

  return (
    <div>
      <PageHeader
        title="AI insights"
        subtitle={`${unread} unread · ${insights.length} total`}
      />
      <div className="px-6 py-5">
        <div className="flex gap-2 mb-5">
          {(['all', 'ALERT', 'WARNING', 'INFO'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                filter === f ? 'bg-amber-50 border-amber-300 text-amber-800 font-medium' : 'bg-white border-gray-200 text-gray-500'
              }`}
            >
              {f === 'all' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        {loading ? Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-28 mb-3" />) :
          filtered.length === 0 ? <EmptyState icon="✨" title="No insights" body="Sollux is monitoring your accounts." /> :
          filtered.map(i => <InsightCard key={i.id} insight={i} onRead={handleRead} onDismiss={handleDismiss} />)
        }
      </div>
    </div>
  );
}
