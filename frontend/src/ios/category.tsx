import { CATEGORY_COLORS, type UtilityCategory } from '../types';

/** A utility's Settings-style icon: its category color and glyph. */
const P: Record<string, JSX.Element> = {
  ELECTRIC: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  GAS: <path d="M12 3c2 3 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-8z" />,
  WATER: <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
  SEWER: <><path d="M4 8h16M4 16h16" /><path d="M8 8v8M16 8v8" /></>,
  TRASH: <><path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13" /></>,
  SOLAR: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  INTERNET: <><path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" /><circle cx="12" cy="19.5" r="0.8" /></>,
  PHONE: <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></>,
  INSURANCE: <path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6z" />,
  HOA: <><path d="M3 21h18M5 21V10l7-6 7 6v11" /></>,
  TAXES: <><path d="M3 21h18M4 10h16M12 3l9 5H3z" /></>,
  LOAN: <><path d="M3 10l9-6 9 6M5 10v10h14V10" /></>,
  CREDIT_CARD: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>,
  OTHER: <circle cx="12" cy="12" r="3" />,
};

export function categoryIcon(category?: string | null) {
  const c = (category ?? 'OTHER') as UtilityCategory;
  return {
    bg: CATEGORY_COLORS[c] ?? '#8e8e93',
    glyph: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[c] ?? P.OTHER}</svg>,
  };
}
