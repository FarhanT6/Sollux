import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MoreMenuItem { label: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string }

/**
 * The actions a page needs now and then (edit a link, deactivate, delete),
 * kept behind one quiet "More" button so the header shows only what is used
 * every visit.
 */
export default function MoreMenu({ items, label = 'More' }: { items: MoreMenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(o => !o)} className="row-action text-sm" aria-haspopup="menu" aria-expanded={open}>{label} ⋯</button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 min-w-[11rem] rounded-xl py-1 z-30 shadow-xl" style={{ background: '#2a2a2a', border: '1px solid rgba(255,255,255,0.08)' }}>
          {items.map((it, i) => (
            <button key={i} role="menuitem" disabled={it.disabled} title={it.title}
              onClick={() => { setOpen(false); it.onClick(); }}
              className={`block w-full text-left px-3 py-2 text-sm transition-colors disabled:opacity-40 hover:bg-white/5 ${it.danger ? 'text-red-400' : 'text-gray-200'}`}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
