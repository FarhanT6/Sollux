import { useEffect, useState } from 'react';
import { getInsights, markInsightRead, dismissInsight, markAllInsightsRead, dismissAllInfoInsights, runBookkeeper } from '../api/client';
import type { AIInsight, InsightSeverity } from '../types';
import { PageHeader, InsightCard, EmptyState, Skeleton } from '../components/ui';

const SEVERITY_RANK: Record<InsightSeverity, number> = { ALERT: 3, WARNING: 2, INFO: 1 };

export default function InsightsPage() {
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [filter, setFilter] = useState<'all' | 'ALERT' | 'WARNING' | 'INFO'>('all');
  const [search, setSearch] = useState('');
  const [propFilter, setPropFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);

  useEffect(() => {
    getInsights().then(data => setInsights(data.filter(i => !i.isDismissed))).finally(() => setLoading(false));
  }, []);

  // The bookkeeper runs nightly at 5am; this runs it now.
  async function handleRunBookkeeper() {
    setRunning(true); setRunNote(null);
    try {
      const r = await runBookkeeper();
      setRunNote(`${r.count} item${r.count === 1 ? '' : 's'} · ${r.raised} new, ${r.refreshed} refreshed, ${r.cleared} cleared`);
      setInsights((await getInsights()).filter(i => !i.isDismissed));
    } catch { setRunNote('The bookkeeper could not run.'); }
    finally { setRunning(false); }
  }

  // Unique property options from loaded insights
  const propertyOptions = Array.from(
    new Map(
      insights
        .filter(i => i.propertyId && i.property)
        .map(i => [i.propertyId, i.property?.nickname || i.property?.address || i.propertyId])
    ).entries()
  );

  const unread = insights.filter(i => !i.isRead).length;
  const totalSavings = insights
    .filter(i => !i.isDismissed && (i.potentialSavings ?? 0) > 0)
    .reduce((s, i) => s + (i.potentialSavings ?? 0), 0);

  const searchLower = search.toLowerCase();
  const filtered = insights.filter(i => {
    if (filter !== 'all' && i.severity !== filter) return false;
    if (propFilter && i.propertyId !== propFilter) return false;
    if (searchLower && !i.title.toLowerCase().includes(searchLower) && !i.body.toLowerCase().includes(searchLower)) return false;
    return true;
  });

  async function handleRead(id: string) {
    await markInsightRead(id);
    setInsights(prev => prev.map(i => i.id === id ? { ...i, isRead: true } : i));
  }
  async function handleDismiss(id: string) {
    await dismissInsight(id);
    setInsights(prev => prev.filter(i => i.id !== id));
  }
  async function handleMarkAllRead() {
    await markAllInsightsRead();
    setInsights(prev => prev.map(i => ({ ...i, isRead: true })));
  }
  async function handleDismissAllInfo() {
    await dismissAllInfoInsights();
    setInsights(prev => prev.filter(i => i.severity !== 'INFO'));
  }

  // Group the filtered insights by property, most urgent property first
  // (highest severity present, then most unread, then name).
  const groups = new Map<string, { id: string; name: string; items: AIInsight[] }>();
  filtered.forEach(i => {
    const key = i.propertyId || 'unknown';
    const name = i.property?.nickname || i.property?.address || 'Unknown property';
    if (!groups.has(key)) groups.set(key, { id: key, name, items: [] });
    groups.get(key)!.items.push(i);
  });
  const grouped = Array.from(groups.values()).sort((a, b) => {
    const rankA = Math.max(...a.items.map(i => SEVERITY_RANK[i.severity]));
    const rankB = Math.max(...b.items.map(i => SEVERITY_RANK[i.severity]));
    if (rankA !== rankB) return rankB - rankA;
    const unreadA = a.items.filter(i => !i.isRead).length;
    const unreadB = b.items.filter(i => !i.isRead).length;
    if (unreadA !== unreadB) return unreadB - unreadA;
    return a.name.localeCompare(b.name);
  });

  return (
    <div>
      <PageHeader
        title="AI insights"
        subtitle={`${unread} unread · ${insights.length} total${totalSavings > 0 ? ` · $${totalSavings.toLocaleString('en-US', { maximumFractionDigits: 0 })} potential savings` : ''}`}
        action={
          <div className="flex items-center gap-2">
            <button onClick={handleMarkAllRead} disabled={unread === 0} className="btn text-xs disabled:opacity-50">
              Mark all read
            </button>
            <button
              onClick={handleDismissAllInfo}
              disabled={!insights.some(i => i.severity === 'INFO')}
              className="btn text-xs disabled:opacity-50"
            >
              Dismiss all info
            </button>
          </div>
        }
      />
      <div className="px-6 py-5">
        {/* Controls row */}
        <div className="flex gap-3 mb-5 flex-wrap items-center">
          {/* Severity chips */}
          <div className="flex gap-2">
            {(['all', 'ALERT', 'WARNING', 'INFO'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  filter === f ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400 font-medium' : 'bg-transparent border border-white/10 text-gray-400 hover:border-white/20 hover:text-gray-300'
                }`}
              >
                {f === 'all' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
              </button>
            ))}
          </div>

          {/* Property filter */}
          {propertyOptions.length > 1 && (
            <select
              value={propFilter}
              onChange={e => setPropFilter(e.target.value)}
              className="text-xs bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-gray-300 focus:border-amber-500/40 outline-none"
            >
              <option value="">All properties</option>
              {propertyOptions.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          )}

          <button onClick={handleRunBookkeeper} disabled={running}
            className="text-xs px-3 py-1.5 rounded-full border border-white/10 text-gray-300 hover:border-amber-500/40 hover:text-amber-400 disabled:opacity-50 transition-colors"
            title="Goes over every bill, payment, policy and loan and raises what needs a hand. Runs on its own every night at 5am.">
            {running ? 'Bookkeeper running…' : '🧾 Run bookkeeper now'}
          </button>
          {runNote && <span className="text-xs text-gray-500">{runNote}</span>}

          {/* Keyword search */}
          <div className="relative ml-auto">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search insights…"
              className="pl-7 pr-3 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-600 focus:border-amber-500/40 outline-none w-44 transition-colors"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs leading-none">×</button>
            )}
          </div>
        </div>

        {/* Savings banner */}
        {totalSavings > 0 && (
          <div className="mb-4 rounded-xl px-4 py-3 flex items-center gap-3" style={{ background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.18)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
            </svg>
            <p className="text-sm text-emerald-300 font-medium">
              ${totalSavings.toLocaleString('en-US', { maximumFractionDigits: 0 })} in potential annual savings identified
            </p>
          </div>
        )}

        {loading ? Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-28 mb-3" />) :
          filtered.length === 0 ? <EmptyState icon="✨" title="No insights" body="Sollux is monitoring your accounts." /> :
          grouped.map(g => (
            <div key={g.id} className="mb-6">
              <div className="flex items-center gap-3 mb-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{g.name}</p>
                <span className="text-xs text-gray-600">{g.items.length} insight{g.items.length !== 1 ? 's' : ''}</span>
              </div>
              {g.items.map(i => <InsightCard key={i.id} insight={i} onRead={handleRead} onDismiss={handleDismiss} />)}
            </div>
          ))
        }
      </div>
    </div>
  );
}
