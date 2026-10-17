import { useEffect, useState } from 'react';
import { onToast, type ToastMsg } from '../lib/toast';

/** Shows toast() messages: bottom-centre, above the phone tab bar, for four seconds. */
export default function Toaster() {
  const [items, setItems] = useState<ToastMsg[]>([]);
  useEffect(() => onToast(t => {
    setItems(xs => [...xs.slice(-2), t]);
    setTimeout(() => setItems(xs => xs.filter(x => x.id !== t.id)), 4000);
  }), []);
  if (!items.length) return null;
  return (
    <div role="status" aria-live="polite"
      style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(env(safe-area-inset-bottom) + 72px)', zIndex: 90, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, pointerEvents: 'none', padding: '0 16px' }}>
      {items.map(t => (
        <div key={t.id} className="ios-enter"
          style={{ maxWidth: 420, padding: '10px 14px', borderRadius: 12, fontSize: 14, lineHeight: 1.35, color: '#fff', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            background: t.tone === 'error' ? 'rgba(180, 40, 40, 0.95)' : 'rgba(40, 40, 40, 0.95)', backdropFilter: 'blur(12px)' }}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
