import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { tap } from '../lib/native';
import { Chevron } from './icons';

/**
 * Inset grouped lists, the way iOS Settings and Mail lay out content.
 *
 *   <Section header="Due soon" action={{ label: 'See all', to: '/payments' }}>
 *     <Row title="SDG&E" subtitle="1536 Hunsaker St" value="$444.26" to="/…" />
 *   </Section>
 */
export function Section({ header, footer, action, plain, children }: {
  header?: ReactNode;
  footer?: ReactNode;
  action?: { label: string; onClick?: () => void; to?: string };
  /** A big bold header (a content heading) instead of the small caps one. */
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="ios-section">
      {(header || action) && (
        <div className={`ios-section-header${plain ? ' plain' : ''}`}>
          <span>{header}</span>
          {action && (action.to
            ? <Link className="action" to={action.to} onClick={() => void tap()}>{action.label}</Link>
            : <button className="action" onClick={() => { void tap(); action.onClick?.(); }}>{action.label}</button>)}
        </div>
      )}
      <div className="ios-group">{children}</div>
      {footer && <div className="ios-section-footer">{footer}</div>}
    </section>
  );
}

export interface SwipeAction { label: string; color: string; onClick: () => void }

export function Row({
  title, subtitle, value, icon, to, onClick, chevron, destructive, tinted, wrap, swipe, inset, children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-hand text. Strings render muted; pass a node for custom styling. */
  value?: ReactNode;
  /** A colored rounded square with a glyph or initials, like Settings. */
  icon?: { bg: string; glyph: ReactNode };
  to?: string;
  onClick?: () => void;
  chevron?: boolean;
  destructive?: boolean;
  tinted?: boolean;
  /** Let title and subtitle wrap instead of truncating. */
  wrap?: boolean;
  /** Actions revealed by swiping the row left. */
  swipe?: SwipeAction[];
  /** Separator inset from the left (defaults past the icon when there is one). */
  inset?: number;
  children?: ReactNode;
}) {
  const showChevron = chevron ?? !!(to || onClick);
  const cls = `ios-row${to || onClick ? ' tappable' : ''}${destructive ? ' destructive' : ''}${tinted ? ' tinted' : ''}`;
  const style = { ['--ios-inset' as string]: `${inset ?? (icon ? 58 : 16)}px` };
  const body = (
    <>
      {icon && <span className="ios-row-icon" style={{ background: icon.bg }}>{icon.glyph}</span>}
      <span className="ios-row-body">
        <span className={`ios-row-title${wrap ? ' wrap' : ''}`} style={{ display: 'block' }}>{title}</span>
        {subtitle && <span className={`ios-row-sub${wrap ? ' wrap' : ''}`} style={{ display: 'block' }}>{subtitle}</span>}
        {children}
      </span>
      {value != null && <span className="ios-row-value">{value}</span>}
      {showChevron && <span className="ios-chevron"><Chevron /></span>}
    </>
  );
  const row = to
    ? <Link to={to} className={cls} style={style} onClick={() => void tap()}>{body}</Link>
    : onClick
      ? <button type="button" className={cls} style={style} onClick={() => { void tap(); onClick(); }}>{body}</button>
      : <div className={cls} style={style}>{body}</div>;
  return swipe?.length ? <Swipeable actions={swipe}>{row}</Swipeable> : row;
}

/** Swipe left to reveal actions; tap elsewhere or swipe back to close. */
function Swipeable({ actions, children }: { actions: SwipeAction[]; children: ReactNode }) {
  const width = actions.length * 80;
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; base: number; locked: boolean | null } | null>(null);

  return (
    <div className="ios-swipe">
      <div className="ios-swipe-actions" aria-hidden={x === 0}>
        {actions.map(a => (
          <button key={a.label} style={{ background: a.color }} onClick={() => { void tap(); setX(0); a.onClick(); }}>{a.label}</button>
        ))}
      </div>
      <div
        className={`ios-swipe-track${dragging ? ' dragging' : ''}`}
        style={{ transform: `translateX(${x}px)` }}
        onTouchStart={e => { start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, base: x, locked: null }; }}
        onTouchMove={e => {
          const s = start.current; if (!s) return;
          const dx = e.touches[0].clientX - s.x, dy = e.touches[0].clientY - s.y;
          if (s.locked == null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) s.locked = Math.abs(dx) > Math.abs(dy);
          if (!s.locked) return;
          setDragging(true);
          setX(Math.max(-width - 30, Math.min(0, s.base + dx)));
        }}
        onTouchEnd={() => {
          if (start.current?.locked) setX(x < -width / 2 ? -width : 0);
          start.current = null; setDragging(false);
        }}
        onClickCapture={e => { if (x !== 0) { e.preventDefault(); e.stopPropagation(); setX(0); } }}
      >
        {children}
      </div>
    </div>
  );
}
