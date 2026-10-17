import './brand.css';

/**
 * The Sollux mark — the owner's artwork (public/brand/sollux-mark.png): a
 * gold ribbon folded into an S around a white building front. Cut from its
 * white background with the building kept (scripts/brand-assets.mjs).
 * `size` is the mark's height; it is two-thirds as wide.
 */
const MARK_RATIO = 746 / 1120;

export function LogoMark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <img src="/brand/sollux-mark.png" alt={title ?? ''} aria-hidden={title ? undefined : true}
      width={Math.round(size * MARK_RATIO)} height={size} style={{ display: 'block', flexShrink: 0 }} draggable={false} />
  );
}

/** Mark and wordmark, as on the brand board; the tagline where there is room. */
export default function Logo({ size = 28, tagline = false }: { size?: number; tagline?: boolean }) {
  return (
    <span className="sollux-logo" style={{ gap: Math.round(size * 0.28) }}>
      <LogoMark size={size} title="Sollux" />
      <span className="sollux-logo-text">
        <span className="sollux-wordmark" style={{ fontSize: Math.round(size * 0.8) }}>sollux</span>
        {tagline && <span className="sollux-tagline" style={{ fontSize: Math.max(8, Math.round(size * 0.2)) }}>Property utility intelligence</span>}
      </span>
    </span>
  );
}
