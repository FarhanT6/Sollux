import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { tap } from '../lib/native';

/**
 * A bottom sheet: slides up over the screen, drag the grabber or header down
 * (or tap outside) to dismiss. On a wide screen it is a centered dialog.
 *
 *   <Sheet open={open} onClose={…} title="Log payment"
 *     right={{ label: 'Save', onClick: save, disabled: !amount }}>…</Sheet>
 */
export default function Sheet({ open, onClose, title, left, right, children }: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Defaults to Cancel. */
  left?: { label: string; onClick: () => void } | null;
  right?: { label: string; onClick: () => void; disabled?: boolean; busy?: boolean };
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const [dy, setDy] = useState(0);
  const drag = useRef<number | null>(null);

  useEffect(() => {
    if (open) { setMounted(true); setClosing(false); setDy(0); }
    else if (mounted) { setClosing(true); const t = setTimeout(() => { setMounted(false); setClosing(false); }, 220); return () => clearTimeout(t); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lock the page behind, and Escape closes.
  useEffect(() => {
    if (!mounted) return;
    const root = document.querySelector('[data-scroll-root]') as HTMLElement | null;
    const prev = root?.style.overflow;
    if (root) root.style.overflow = 'hidden';
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => { if (root) root.style.overflow = prev ?? ''; window.removeEventListener('keydown', key); };
  }, [mounted, onClose]);

  if (!mounted) return null;
  const cancel = left === undefined ? { label: 'Cancel', onClick: onClose } : left;

  return createPortal(
    <>
      <div className={`ios-sheet-backdrop${closing ? ' closing' : ''}`} onClick={onClose} />
      <div
        className={`ios-sheet${closing ? ' closing' : ''}`} role="dialog" aria-modal="true"
        style={dy ? { transform: `translateY(${dy}px)`, animation: 'none' } : undefined}
      >
        <div
          onTouchStart={e => { drag.current = e.touches[0].clientY; }}
          onTouchMove={e => { if (drag.current != null) setDy(Math.max(0, e.touches[0].clientY - drag.current)); }}
          onTouchEnd={() => { drag.current = null; if (dy > 110) { void tap(); onClose(); } setDy(0); }}
        >
          <div className="ios-sheet-grabber" />
          <div className="ios-sheet-header">
            <div>{cancel && <button className="ios-barbtn" onClick={cancel.onClick}>{cancel.label}</button>}</div>
            <div className="ios-sheet-title">{title}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              {right && (
                <button className="ios-barbtn bold" disabled={right.disabled || right.busy} style={{ opacity: right.disabled ? 0.35 : 1 }}
                  onClick={() => { void tap(); right.onClick(); }}>
                  {right.busy ? <span className="ios-spinner" style={{ width: 18, height: 18 }} /> : right.label}
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="ios-sheet-body">{children}</div>
      </div>
    </>,
    document.body,
  );
}

/** A labelled input row inside a Section in a sheet. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="ios-field"><label>{label}</label>{children}</div>;
}
