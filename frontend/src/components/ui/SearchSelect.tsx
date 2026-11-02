import { useEffect, useMemo, useRef, useState } from 'react';

export interface SearchOption { value: string; label: string }

/**
 * A select you can type into: the list narrows to the options whose label
 * holds every word typed ("troy ramona" finds "Troy Arbar … — 2453 Ramona
 * Dr"). Arrow keys and Enter pick; Escape closes and keeps the choice.
 */
export default function SearchSelect({ value, options, onChange, placeholder = 'Type to search…', emptyLabel, className }: {
  value: string;
  options: SearchOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Offered first when set, e.g. "— No tenant matched —" (value ''). */
  emptyLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const current = options.find(o => o.value === value);

  const all = useMemo(() => (emptyLabel != null ? [{ value: '', label: emptyLabel }, ...options] : options), [options, emptyLabel]);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return all;
    return all.filter(o => o.value && words.every(w => o.label.toLowerCase().includes(w)));
  }, [all, q]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setQ(''); } };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  function pick(o: SearchOption) { onChange(o.value); setOpen(false); setQ(''); }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { if (open && shown[active]) { e.preventDefault(); pick(shown[active]); } }
    else if (e.key === 'Escape') { setOpen(false); setQ(''); }
  }

  return (
    <div ref={box} className={`relative ${className ?? ''}`}>
      <input
        className="field-input text-xs w-full"
        role="combobox"
        aria-expanded={open}
        value={open ? q : (current?.label ?? '')}
        placeholder={open ? (current?.label ?? placeholder) : (emptyLabel ?? placeholder)}
        onFocus={() => { setOpen(true); setQ(''); }}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={onKey}
      />
      {open && (
        <ul ref={list} role="listbox" className="absolute z-[60] left-0 right-0 mt-1 rounded-lg overflow-y-auto max-h-72 shadow-xl"
          style={{ background: '#262626', border: '1px solid rgba(255,255,255,0.12)' }}>
          {shown.length === 0 && <li className="px-3 py-2 text-xs text-gray-500">Nothing matches “{q}”.</li>}
          {shown.map((o, i) => (
            <li key={o.value || '__none'} data-i={i} role="option" aria-selected={o.value === value}
              onMouseDown={e => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setActive(i)}
              className={`px-3 py-1.5 text-xs cursor-pointer ${i === active ? 'bg-white/10 text-white' : o.value ? 'text-gray-300' : 'text-gray-500'}`}>
              {o.value === value && <span className="text-amber-400 mr-1">✓</span>}{o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
