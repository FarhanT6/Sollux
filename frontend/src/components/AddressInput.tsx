import { useEffect, useRef, useState } from 'react';
import { suggestAddresses, getAddressDetails, type AddressParts, type AddressSuggestion } from '../api/client';

export type { AddressParts };

const newSession = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

/**
 * An address field that suggests real addresses as you type. Picking one
 * hands its parts (street, city, state, ZIP, county) to `onPick` so the form
 * can fill the other fields; typing on without picking works as a plain
 * input. Arrow keys and Enter pick from the list; Escape closes it.
 */
export default function AddressInput({ value, onChange, onPick, className, style, placeholder, id, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  onPick: (a: AddressParts) => void;
  className?: string;
  style?: React.CSSProperties;
  placeholder?: string;
  id?: string;
  autoFocus?: boolean;
}) {
  const [items, setItems] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const typed = useRef(false);        // only search what the owner typed, not what a pick filled in
  const session = useRef(newSession());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!typed.current) return;
    const q = value.trim();
    if (q.length < 3) { setItems([]); setOpen(false); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      suggestAddresses(q, session.current, ctl.signal)
        .then(list => { setItems(list); setActive(-1); setOpen(list.length > 0); })
        .catch(() => { /* a failed search leaves the field as a plain input */ })
        .finally(() => setLoading(false));
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [value]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  async function pick(s: AddressSuggestion) {
    setOpen(false);
    typed.current = false;
    try {
      const parts = s.parts ?? (s.placeId ? await getAddressDetails(s.placeId, session.current) : null);
      if (parts) onPick(parts); else onChange(s.label);
    } catch {
      onChange(s.label);
    } finally {
      session.current = newSession();
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i <= 0 ? items.length - 1 : i - 1)); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); void pick(items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  }

  return (
    <div ref={box} className="relative">
      <input
        id={id}
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder={placeholder}
        className={className}
        style={style}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={e => { typed.current = true; onChange(e.target.value); }}
        onFocus={() => { if (items.length) setOpen(true); }}
        onKeyDown={onKey}
      />
      {loading && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-500 pointer-events-none">…</span>}
      {open && (
        <ul role="listbox" className="absolute z-[60] left-0 right-0 mt-1 rounded-lg overflow-hidden shadow-xl max-h-64 overflow-y-auto"
          style={{ background: '#262626', border: '1px solid rgba(255,255,255,0.12)' }}>
          {items.map((s, i) => (
            <li key={`${s.placeId ?? ''}${s.label}`} role="option" aria-selected={i === active}
              onMouseDown={e => { e.preventDefault(); void pick(s); }}
              onMouseEnter={() => setActive(i)}
              className={`px-3 py-2 text-sm cursor-pointer flex items-start gap-2 ${i === active ? 'bg-white/10 text-white' : 'text-gray-300'}`}>
              <span className="text-amber-400 text-xs mt-0.5">⌖</span>
              <span className="truncate">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The parts as one line, for single-line address fields: "1200 Elm Grove Ln, Oceanside, CA 92056". */
export const oneLine = (a: AddressParts) => a.label;
