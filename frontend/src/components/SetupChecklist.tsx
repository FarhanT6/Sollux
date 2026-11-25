/**
 * The setup checklist (Settings → Setup): what is connected and what is left, read live from the
 * account — properties, bill inboxes, bank links, provider logins, the connector, the background
 * worker, alerts and loans' last 4. SetupNudge is its one line on the Overview while items are left.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSetupChecklist, type SetupItem } from '../api/client';
import { LoadFailed } from './ui';

const MARK: Record<SetupItem['state'], { glyph: string; color: string; label: string }> = {
  done: { glyph: '✓', color: '#34d399', label: 'Done' },
  todo: { glyph: '○', color: '#F5A623', label: 'To do' },
  warn: { glyph: '!', color: '#f87171', label: 'Needs a look' },
  optional: { glyph: '·', color: '#9ca3af', label: 'Optional' },
};

export default function SetupChecklist() {
  const [data, setData] = useState<{ done: number; total: number; items: SetupItem[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => { setError(null); getSetupChecklist().then(setData).catch(setError); };
  useEffect(load, []);
  if (error) return <LoadFailed what="the setup checklist" error={error} onRetry={load} />;
  if (!data) return <p className="px-6 py-5 text-sm text-gray-500">Loading…</p>;
  const order: SetupItem['state'][] = ['warn', 'todo', 'optional', 'done'];
  const items = [...data.items].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  return (
    <div className="px-6 py-5 max-w-3xl">
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-sm text-gray-300">{data.done} of {data.total} done</p>
        <div className="h-1.5 w-40 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
          <div className="h-full rounded-full" style={{ width: `${data.total ? Math.round(100 * data.done / data.total) : 0}%`, background: '#F5A623' }} />
        </div>
      </div>
      <ul className="card divide-y divide-white/5">
        {items.map(i => {
          const m = MARK[i.state];
          return (
            <li key={i.key} className="flex gap-3 p-4">
              <span aria-label={m.label} title={m.label} className="mt-0.5 h-5 w-5 shrink-0 rounded-full flex items-center justify-center text-[11px] font-bold" style={{ color: m.color, border: `1px solid ${m.color}` }}>{m.glyph}</span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm ${i.state === 'done' ? 'text-gray-400' : 'text-gray-100'}`}>{i.title}</p>
                <p className="text-xs text-gray-500 mt-0.5">{i.detail}</p>
              </div>
              {i.to && i.state !== 'done' && <Link to={i.to} className="self-center shrink-0 text-xs text-amber-400 hover:text-amber-300">{i.action ?? 'Open'}</Link>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One line on the Overview while setup has items left; nothing once it is all done. */
export function SetupNudge({ className = '' }: { className?: string }) {
  const [data, setData] = useState<{ done: number; total: number; items: SetupItem[] } | null>(null);
  useEffect(() => { getSetupChecklist().then(setData).catch(() => setData(null)); }, []);
  if (!data || data.done >= data.total) return null;
  const next = data.items.find(i => i.state === 'warn') ?? data.items.find(i => i.state === 'todo');
  return (
    <Link to="/settings?tab=setup" className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm hover:bg-white/5 ${className}`} style={{ border: '1px solid rgba(245,166,35,0.25)', background: 'rgba(245,166,35,0.06)' }}>
      <span className="text-amber-300 font-medium">Finish setting up · {data.done} of {data.total}</span>
      {next && <span className="text-xs text-gray-400 truncate">Next: {next.title}</span>}
      <span className="ml-auto text-xs text-amber-400">Setup checklist</span>
    </Link>
  );
}
