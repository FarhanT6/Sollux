import { useId } from 'react';
import './brand.css';

/**
 * The Sollux mark: a folded gold ribbon — the roof, the front with its
 * window, the sweep out — that reads as both a house and an S. Amber Gold
 * palette: charcoal #1F2937, amber #F59E0B, light gold #FCD34D, pale cream
 * #FFF7E6. The same drawing is public/favicon.svg and the iOS app icon.
 */
export function LogoMark({ size = 28, title }: { size?: number; title?: string }) {
  // Gradient ids are per instance: two marks on a page must not share them.
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={`${id}a`} x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#F59E0B" /><stop offset="1" stopColor="#FCD34D" /></linearGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#D97706" /><stop offset="1" stopColor="#B45309" /></linearGradient>
        <linearGradient id={`${id}c`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#F59E0B" /><stop offset="1" stopColor="#FCD34D" /></linearGradient>
      </defs>
      <path d="M12 38 L50 8 L72 24 L34 54 Z" fill={`url(#${id}a)`} />
      <path d="M34 54 L34 80 L52 92 L52 66 Z" fill={`url(#${id}b)`} />
      <path d="M12 38 L34 54 L34 80 L12 64 Z" fill="#B45309" />
      <path d="M52 66 L88 44 L88 62 L52 92 Z" fill={`url(#${id}c)`} />
      <path d="M19 52 L28 58 L28 70 L19 64 Z" fill="#1F2937" />
    </svg>
  );
}

/** Mark and wordmark; the tagline under it where there is room. */
export default function Logo({ size = 28, tagline = false }: { size?: number; tagline?: boolean }) {
  return (
    <span className="sollux-logo" style={{ gap: Math.round(size * 0.32) }}>
      <LogoMark size={size} title="Sollux" />
      <span className="sollux-logo-text">
        <span className="sollux-wordmark" style={{ fontSize: Math.round(size * 0.78) }}>sollux</span>
        {tagline && <span className="sollux-tagline">Property utility intelligence</span>}
      </span>
    </span>
  );
}
