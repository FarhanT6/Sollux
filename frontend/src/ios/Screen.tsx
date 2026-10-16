import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { tap } from '../lib/native';
import { useOwnHeader, scrollRootOf } from './chrome';
import { Back } from './icons';

/**
 * A phone screen: navigation bar, large title that folds into the bar as the
 * page scrolls, optional back button and bar actions, and pull to refresh.
 *
 *   <Screen title="Utilities" right={<BarButton …/>} onRefresh={load}>…</Screen>
 *   <Screen title="SDG&E" back="/properties" largeTitle={false}>…</Screen>
 */
export default function Screen({
  title, subtitle, back, backLabel = 'Back', left, right, largeTitle = true, onRefresh, children, flush,
}: {
  title: string;
  subtitle?: ReactNode;
  /** true = go back in history (falling back to /dashboard); a path = go there. */
  back?: true | string;
  backLabel?: string;
  left?: ReactNode;
  right?: ReactNode;
  largeTitle?: boolean;
  onRefresh?: () => Promise<unknown> | void;
  children: ReactNode;
  /** No side padding: the content runs edge to edge. */
  flush?: boolean;
}) {
  useOwnHeader();
  const navigate = useNavigate();
  const sentinel = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(!largeTitle);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // Fold the large title into the bar once it scrolls under it.
  useEffect(() => {
    if (!largeTitle || !sentinel.current) return;
    const root = scrollRootOf(sentinel.current);
    const io = new IntersectionObserver(([e]) => setCollapsed(!e.isIntersecting), {
      root: root === document.scrollingElement ? null : root, rootMargin: '-44px 0px 0px 0px', threshold: 0,
    });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [largeTitle]);

  // Pull to refresh: drag down from the top of the page.
  useEffect(() => {
    if (!onRefresh || !rootRef.current) return;
    const root = scrollRootOf(rootRef.current);
    let startY: number | null = null;
    let dist = 0;
    const start = (e: TouchEvent) => { startY = root.scrollTop <= 0 ? e.touches[0].clientY : null; dist = 0; };
    const move = (e: TouchEvent) => {
      if (startY == null) return;
      dist = Math.max(0, e.touches[0].clientY - startY);
      if (dist > 0 && root.scrollTop <= 0) setPull(Math.min(90, dist * 0.5));
    };
    const end = async () => {
      if (startY == null) return;
      startY = null;
      if (dist * 0.5 >= 60) {
        void tap();
        setRefreshing(true); setPull(52);
        try { await onRefresh(); } finally { setRefreshing(false); setPull(0); }
      } else setPull(0);
    };
    root.addEventListener('touchstart', start, { passive: true });
    root.addEventListener('touchmove', move, { passive: true });
    root.addEventListener('touchend', end);
    return () => { root.removeEventListener('touchstart', start); root.removeEventListener('touchmove', move); root.removeEventListener('touchend', end); };
  }, [onRefresh]);

  const goBack = () => {
    void tap();
    if (typeof back === 'string') navigate(back);
    else if (window.history.length > 1) navigate(-1);
    else navigate('/dashboard');
  };

  return (
    <div ref={rootRef} className="ios-screen ios-enter">
      <header className="ios-navbar" data-collapsed={collapsed} data-compact={!largeTitle}>
        <div className="ios-navbar-row">
          <div className="ios-navbar-side">
            {back ? (
              <button className="ios-barbtn" onClick={goBack} aria-label={backLabel} style={{ paddingLeft: 0 }}>
                <Back /> <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{backLabel}</span>
              </button>
            ) : left}
          </div>
          <div className="ios-navbar-title">{title}</div>
          <div className="ios-navbar-side right">{right}</div>
        </div>
      </header>
      {onRefresh && (
        <div className="ios-ptr" style={{ height: pull, transition: pull === 0 || refreshing ? 'height 220ms ease' : 'none' }}>
          {pull > 0 && <div className="ios-spinner" style={{ marginBottom: 14, animationPlayState: refreshing ? 'running' : 'paused', transform: `rotate(${pull * 4}deg)` }} />}
        </div>
      )}
      {largeTitle && (
        <div className="ios-largetitle">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
      )}
      <div ref={sentinel} style={{ height: 1 }} />
      <div className={flush ? '' : 'ios-content'} style={flush ? { paddingBottom: 'calc(24px + var(--safe-bottom))' } : undefined}>
        {children}
      </div>
    </div>
  );
}

/** A nav bar button: text or an icon, tinted, 44pt target. */
export function BarButton({ children, onClick, label, bold }: { children: ReactNode; onClick: () => void; label?: string; bold?: boolean }) {
  return (
    <button className={`ios-barbtn${bold ? ' bold' : ''}`} onClick={() => { void tap(); onClick(); }} aria-label={label}>
      {children}
    </button>
  );
}
