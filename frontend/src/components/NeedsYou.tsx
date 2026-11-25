/**
 * "Needs you" on the Overview: everything waiting on the owner in one list — logins to fix, bills
 * to look at, figures that disagree, loan payments and tenant transfers to confirm, bills that
 * don't add up — each with where to go. Nothing to do shows one quiet line.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getNeedsYou, type NeedsYouSection } from '../api/client';

export default function NeedsYou({ className = '' }: { className?: string }) {
  const [data, setData] = useState<{ total: number; sections: NeedsYouSection[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { getNeedsYou().then(setData).catch(() => setData(null)); }, []);
  if (!data) return null;
  if (!data.sections.length) return (
    <p className={`text-xs text-gray-500 ${className}`}>Nothing needs you right now — logins work, bills add up and every payment is matched.</p>
  );
  return (
    <div className={`card p-4 ${className}`}>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-sm font-semibold text-white">Needs you{data.total ? <span className="ml-2 text-xs font-medium px-1.5 py-0.5 rounded" style={{ background: 'rgba(245,166,35,0.18)', color: '#F5A623' }}>{data.total}</span> : null}</p>
        <p className="text-[11px] text-gray-500">Sollux does the rest on its own</p>
      </div>
      <ul className="divide-y divide-white/5">
        {data.sections.map(s => {
          const isOpen = open === s.key;
          return (
            <li key={s.key} className="py-2">
              <button className="w-full flex items-center gap-3 text-left" onClick={() => setOpen(isOpen ? null : s.key)} aria-expanded={isOpen}>
                <span className={`min-w-[1.75rem] text-center text-xs font-semibold rounded px-1.5 py-0.5 ${s.key === 'blocked' ? 'text-gray-400 bg-white/5' : 'text-amber-300 bg-amber-500/10'}`}>{s.count}</span>
                <span className="flex-1 text-sm text-gray-200">{s.title}</span>
                <span className="text-gray-500 text-xs">{isOpen ? 'Hide' : 'Show'}</span>
              </button>
              {isOpen && (
                <div className="mt-2 ml-10 space-y-1.5">
                  <p className="text-xs text-gray-500">{s.hint}</p>
                  {s.items.map((it, i) => (
                    <Link key={i} to={it.to} className="block rounded-lg px-3 py-2 text-xs hover:bg-white/5" style={{ background: 'rgba(255,255,255,0.03)' }}>
                      <span className="text-gray-100">{it.title}</span>
                      {it.detail && <span className="block text-gray-500 truncate" title={it.detail}>{it.detail}</span>}
                    </Link>
                  ))}
                  {s.count > s.items.length && <p className="text-[11px] text-gray-500">and {s.count - s.items.length} more</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
