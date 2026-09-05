import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getClickUpStatus, getClickUpTasks, createClickUpTask, closeClickUpTask, syncClickUpBills,
  type ClickUpStatus, type ClickUpTaskGroup, type ClickUpTask,
} from '../api/client';
import { PageHeader, EmptyState, Skeleton } from '../components/ui';

/**
 * Property operations, read from ClickUp.
 *
 * Sollux keeps the money; ClickUp keeps the work. This page is the portfolio
 * view of that work — every property's list side by side, overdue first —
 * with enough here to add a task or close one without leaving, and a link
 * into ClickUp for everything richer (comments, assignees, attachments).
 */

const PRIORITY_LABEL: Record<string, { label: string; color: string }> = {
  urgent: { label: 'Urgent', color: '#f87171' },
  high:   { label: 'High',   color: '#F5A623' },
  normal: { label: 'Normal', color: '#60a5fa' },
  low:    { label: 'Low',    color: '#9ca3af' },
};

const fmtDue = (ms: string | null) => {
  if (!ms) return null;
  const d = new Date(Number(ms));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const isOverdue = (t: ClickUpTask) => !!t.due_date && Number(t.due_date) < Date.now() && t.status.type !== 'closed';
const isBill = (t: ClickUpTask) => t.tags?.some(tag => tag.name === 'sollux-bill');

type Filter = 'open' | 'overdue' | 'bills' | 'all';

export default function OperationsPage() {
  const [status, setStatus] = useState<ClickUpStatus | null>(null);
  const [groups, setGroups] = useState<ClickUpTaskGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [propertyFilter, setPropertyFilter] = useState<string>('all');
  const [adding, setAdding] = useState<string | null>(null);      // propertyId with the form open
  const [form, setForm] = useState({ name: '', dueDate: '', priority: '3' });
  const [busy, setBusy] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const st = await getClickUpStatus();
      setStatus(st);
      if (st.connected && st.folder) {
        setGroups(await getClickUpTasks({ includeClosed: filter === 'all' }));
      }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Could not reach ClickUp.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [filter === 'all']);   // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => groups
    .filter(g => propertyFilter === 'all' || g.propertyId === propertyFilter)
    .map(g => ({
      ...g,
      tasks: g.tasks
        .filter(t =>
          filter === 'all' ? true
          : filter === 'overdue' ? isOverdue(t)
          : filter === 'bills' ? isBill(t) && t.status.type !== 'closed'
          : t.status.type !== 'closed')
        .sort((a, b) => {
          // Overdue first, then by due date, then undated last.
          const ao = isOverdue(a) ? 0 : 1, bo = isOverdue(b) ? 0 : 1;
          if (ao !== bo) return ao - bo;
          const ad = a.due_date ? Number(a.due_date) : Infinity, bd = b.due_date ? Number(b.due_date) : Infinity;
          return ad - bd;
        }),
    }))
    .filter(g => g.tasks.length > 0 || adding === g.propertyId), [groups, filter, propertyFilter, adding]);

  const counts = useMemo(() => {
    const all = groups.flatMap(g => g.tasks);
    return {
      open: all.filter(t => t.status.type !== 'closed').length,
      overdue: all.filter(isOverdue).length,
      bills: all.filter(t => isBill(t) && t.status.type !== 'closed').length,
    };
  }, [groups]);

  async function submitTask(propertyId: string) {
    if (!form.name.trim()) return;
    setBusy(propertyId);
    try {
      await createClickUpTask({
        propertyId,
        name: form.name.trim(),
        dueDate: form.dueDate || null,
        priority: Number(form.priority) as 1 | 2 | 3 | 4,
      });
      setForm({ name: '', dueDate: '', priority: '3' });
      setAdding(null);
      await load();
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Could not create the task.');
    } finally { setBusy(null); }
  }

  async function complete(task: ClickUpTask, listId: string) {
    setBusy(task.id);
    try {
      await closeClickUpTask(task.id, listId);
      setGroups(prev => prev.map(g => ({ ...g, tasks: g.tasks.map(t => t.id === task.id ? { ...t, status: { ...t.status, type: 'closed', status: 'complete' } } : t) })));
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Could not close the task.');
    } finally { setBusy(null); }
  }

  async function syncBills() {
    setBusy('sync');
    setSyncNote(null);
    try {
      const r = await syncClickUpBills();
      setSyncNote(`${r.created} bill task${r.created === 1 ? '' : 's'} created, ${r.updated} refreshed, ${r.closed} closed${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}`);
      await load();
    } catch (err: any) {
      setSyncNote(err?.response?.data?.error ?? 'Sync failed.');
    } finally { setBusy(null); }
  }

  if (loading && !status) {
    return <div className="p-6 space-y-3"><Skeleton className="h-16" /><Skeleton className="h-48" /></div>;
  }

  if (!status?.connected || !status.folder) {
    return (
      <div>
        <PageHeader title="Operations" subtitle="Property work, tracked in ClickUp" />
        <div className="px-6 py-10">
          <EmptyState
            icon="🗂️"
            title={status?.connected ? 'Choose where operations live' : 'Connect ClickUp'}
            body={status?.connected
              ? 'Pick the ClickUp folder that holds property operations. Sollux keeps one list per property inside it.'
              : 'Sollux turns what it knows — overdue bills, penalty dates — into ClickUp tasks, and shows every property’s work here.'}
          />
          <div className="text-center mt-4">
            <Link to="/settings" className="btn btn-primary text-xs">Open settings →</Link>
          </div>
        </div>
      </div>
    );
  }

  const pill = (active: boolean) => active
    ? { background: '#F5A623', color: '#000', fontWeight: 600 }
    : { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', color: '#9ca3af' };

  return (
    <div>
      <PageHeader
        title="Operations"
        subtitle={`${counts.open} open · ${counts.overdue} overdue · ${counts.bills} bills to pay · in ${status.folder.name ?? 'ClickUp'}`}
      />

      <div className="px-6 py-5 space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          {([['open', 'Open'], ['overdue', `Overdue${counts.overdue ? ` (${counts.overdue})` : ''}`], ['bills', 'Bills to pay'], ['all', 'All incl. done']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)} className="text-xs px-3 py-1.5 rounded-lg" style={pill(filter === k)}>{label}</button>
          ))}
          <select
            value={propertyFilter}
            onChange={e => setPropertyFilter(e.target.value)}
            className="text-xs px-2 py-1.5 rounded-lg focus:outline-none"
            style={pill(propertyFilter !== 'all')}
          >
            <option value="all">All properties</option>
            {groups.map(g => <option key={g.propertyId} value={g.propertyId}>{g.propertyName}</option>)}
          </select>
          <div className="flex-1" />
          {status.syncBills && (
            <button onClick={syncBills} disabled={busy === 'sync'} className="btn text-xs disabled:opacity-50">
              {busy === 'sync' ? 'Syncing…' : '↻ Sync bill tasks'}
            </button>
          )}
          <button onClick={load} className="btn text-xs">Refresh</button>
        </div>

        {syncNote && <p className="text-xs text-gray-400">{syncNote}</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}

        {visible.length === 0 && !loading && (
          <EmptyState icon="✅" title="Nothing here" body={filter === 'open' ? 'No open tasks. Add one to a property below, or sync bill tasks.' : 'No tasks match this view.'} />
        )}

        {groups.map(g => {
          const shown = visible.find(v => v.propertyId === g.propertyId);
          if (!shown && propertyFilter !== 'all' && propertyFilter !== g.propertyId) return null;
          if (!shown && propertyFilter === 'all') {
            // Property with nothing in view: a one-line row with an add button,
            // so a task can be added to any property without hunting.
            return (
              <div key={g.propertyId} className="rounded-xl px-5 py-2.5 flex items-center justify-between"
                style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.05)' }}>
                <Link to={`/properties/${g.propertyId}`} className="text-xs text-gray-500 hover:text-gray-300">{g.propertyName}</Link>
                <button onClick={() => setAdding(g.propertyId)} className="text-xs text-gray-500 hover:text-white">+ task</button>
              </div>
            );
          }
          const tasks = shown?.tasks ?? [];
          return (
            <div key={g.propertyId} className="rounded-xl overflow-hidden" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                <Link to={`/properties/${g.propertyId}`} className="text-sm font-semibold text-white hover:text-[#F5A623]">{g.propertyName} ›</Link>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">{tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
                  <button onClick={() => setAdding(adding === g.propertyId ? null : g.propertyId)} className="btn text-xs">+ Add task</button>
                </div>
              </div>

              {adding === g.propertyId && (
                <div className="px-5 py-3 flex items-center gap-2 flex-wrap" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <input
                    autoFocus
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') submitTask(g.propertyId); if (e.key === 'Escape') setAdding(null); }}
                    placeholder="What needs doing?"
                    className="flex-1 min-w-[240px] text-sm px-3 py-1.5 rounded-lg text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none"
                  />
                  <input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                    className="text-xs px-2 py-1.5 rounded-lg text-gray-300 bg-white/5 border border-white/10 outline-none" />
                  <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                    className="text-xs px-2 py-1.5 rounded-lg text-gray-300 bg-white/5 border border-white/10 outline-none">
                    <option value="1">Urgent</option><option value="2">High</option><option value="3">Normal</option><option value="4">Low</option>
                  </select>
                  <button onClick={() => submitTask(g.propertyId)} disabled={busy === g.propertyId || !form.name.trim()} className="btn btn-primary text-xs disabled:opacity-50">
                    {busy === g.propertyId ? 'Adding…' : 'Add'}
                  </button>
                  <button onClick={() => setAdding(null)} className="btn text-xs">Cancel</button>
                </div>
              )}

              <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                {tasks.map(t => {
                  const closed = t.status.type === 'closed';
                  const overdue = isOverdue(t);
                  const pr = t.priority ? PRIORITY_LABEL[t.priority.priority] : null;
                  return (
                    <div key={t.id} className="px-5 py-3 flex items-center gap-3">
                      <button
                        onClick={() => !closed && complete(t, g.listId)}
                        disabled={closed || busy === t.id}
                        title={closed ? 'Done' : 'Mark done'}
                        className="w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center text-[10px]"
                        style={{ border: `1.5px solid ${closed ? '#34d399' : 'rgba(255,255,255,0.25)'}`, background: closed ? 'rgba(52,211,153,0.15)' : 'transparent', color: '#34d399' }}
                      >
                        {closed ? '✓' : ''}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm truncate ${closed ? 'text-gray-500 line-through' : 'text-gray-100'}`}>{t.name}</p>
                        <p className="text-xs text-gray-500 flex items-center gap-2 flex-wrap mt-0.5">
                          <span style={{ color: t.status.color ?? undefined }}>{t.status.status}</span>
                          {isBill(t) && <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide" style={{ background: 'rgba(245,166,35,0.12)', color: '#F5A623' }}>bill</span>}
                          {t.assignees?.length > 0 && <span>· {t.assignees.map(a => a.username).join(', ')}</span>}
                        </p>
                      </div>
                      {pr && !closed && <span className="text-xs" style={{ color: pr.color }}>{pr.label}</span>}
                      {t.due_date && (
                        <span className={`text-xs w-16 text-right ${overdue ? 'text-red-400' : 'text-gray-500'}`}>{fmtDue(t.due_date)}</span>
                      )}
                      <a href={t.url} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-500 hover:text-[#F5A623]" title="Open in ClickUp">↗</a>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
