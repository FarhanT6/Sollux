import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getClickUpStatus, getClickUpTasks, createClickUpTask, closeClickUpTask, type ClickUpTask } from '../../api/client';
import { EmptyState, Skeleton } from '../ui';

/**
 * One property's operations, read from its ClickUp list. The list is created
 * on first visit, so "Add task" always works once ClickUp is set up.
 */
export default function PropertyOperations({ propertyId }: { propertyId: string }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [listId, setListId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<ClickUpTask[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', dueDate: '', priority: '3' });
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const st = await getClickUpStatus();
      setConnected(!!(st.connected && st.folder));
      if (st.connected && st.folder) {
        const groups = await getClickUpTasks({ propertyId, includeClosed: showDone });
        setListId(groups[0]?.listId ?? null);
        setTasks(groups[0]?.tasks ?? []);
      }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Could not reach ClickUp.');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [propertyId, showDone]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    if (!form.name.trim()) return;
    setBusy('add');
    try {
      await createClickUpTask({ propertyId, name: form.name.trim(), dueDate: form.dueDate || null, priority: Number(form.priority) as 1 | 2 | 3 | 4 });
      setForm({ name: '', dueDate: '', priority: '3' });
      await load();
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Could not create the task.');
    } finally { setBusy(null); }
  }

  async function done(t: ClickUpTask) {
    if (!listId) return;
    setBusy(t.id);
    try {
      await closeClickUpTask(t.id, listId);
      setTasks(prev => prev.map(x => x.id === t.id ? { ...x, status: { ...x.status, type: 'closed', status: 'complete' } } : x));
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Could not close the task.');
    } finally { setBusy(null); }
  }

  if (loading && connected === null) return <Skeleton className="h-32" />;
  if (connected === false) {
    return (
      <EmptyState icon="🗂️" title="Operations live in ClickUp"
        body="Connect ClickUp and choose an operations folder in Settings. This property then gets its own task list there." />
    );
  }

  const open = tasks.filter(t => t.status.type !== 'closed');
  const closed = tasks.filter(t => t.status.type === 'closed');
  const overdue = (t: ClickUpTask) => !!t.due_date && Number(t.due_date) < Date.now() && t.status.type !== 'closed';
  const fmt = (ms: string | null) => ms ? new Date(Number(ms)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          onKeyDown={e => { if (e.key === 'Enter') add(); }}
          placeholder="Add a task for this property…"
          className="flex-1 min-w-[220px] text-sm px-3 py-1.5 rounded-lg text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none"
        />
        <input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
          className="text-xs px-2 py-1.5 rounded-lg text-gray-300 bg-white/5 border border-white/10 outline-none" />
        <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
          className="text-xs px-2 py-1.5 rounded-lg text-gray-300 bg-white/5 border border-white/10 outline-none">
          <option value="1">Urgent</option><option value="2">High</option><option value="3">Normal</option><option value="4">Low</option>
        </select>
        <button onClick={add} disabled={busy === 'add' || !form.name.trim()} className="btn btn-primary text-xs disabled:opacity-50">{busy === 'add' ? 'Adding…' : '+ Add'}</button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {open.length === 0 && !loading ? (
        <p className="text-xs text-gray-500 py-2">No open tasks for this property.</p>
      ) : (
        <div className="rounded-xl divide-y" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.07)', borderColor: 'rgba(255,255,255,0.05)' }}>
          {[...open, ...(showDone ? closed : [])].map(t => {
            const isClosed = t.status.type === 'closed';
            return (
              <div key={t.id} className="px-4 py-2.5 flex items-center gap-3">
                <button onClick={() => !isClosed && done(t)} disabled={isClosed || busy === t.id}
                  className="w-4 h-4 rounded-full flex-shrink-0 text-[10px] flex items-center justify-center"
                  style={{ border: `1.5px solid ${isClosed ? '#34d399' : 'rgba(255,255,255,0.25)'}`, color: '#34d399' }}>
                  {isClosed ? '✓' : ''}
                </button>
                <span className={`flex-1 text-sm truncate ${isClosed ? 'text-gray-500 line-through' : 'text-gray-100'}`}>{t.name}</span>
                {t.tags?.some(x => x.name === 'sollux-bill') && <span className="text-[10px] uppercase px-1.5 py-0.5 rounded" style={{ background: 'rgba(245,166,35,0.12)', color: '#F5A623' }}>bill</span>}
                {t.due_date && <span className={`text-xs ${overdue(t) ? 'text-red-400' : 'text-gray-500'}`}>{fmt(t.due_date)}</span>}
                <a href={t.url} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-500 hover:text-[#F5A623]">↗</a>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between">
        <button onClick={() => setShowDone(v => !v)} className="text-xs text-gray-500 hover:text-gray-300">
          {showDone ? 'Hide completed' : `Show completed${closed.length ? ` (${closed.length})` : ''}`}
        </button>
        <Link to="/operations" className="text-xs text-gray-500 hover:text-[#F5A623]">All properties →</Link>
      </div>
    </div>
  );
}
