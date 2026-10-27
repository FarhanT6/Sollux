import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Where each screen sits in the app on a phone: its navigation-bar title and
 * the screen Back returns to. One table, so every page — native screen or
 * not — gets the same bar, and Back always lands one level up (not wherever
 * the browser history happens to point after a deep link).
 *
 * First match wins; patterns are matched against the pathname only.
 */
export interface PhoneRoute { title: string; back?: string; backLabel?: string }

const TABLE: [RegExp, PhoneRoute | ((m: RegExpMatchArray) => PhoneRoute)][] = [
  // Tab roots: no Back.
  [/^\/(dashboard)?$/, { title: 'Overview' }],
  [/^\/properties$/, { title: 'Utilities' }],
  [/^\/scan$/, { title: 'Scan' }],
  [/^\/finances$/, { title: 'Finances' }],
  [/^\/payments$/, { title: 'Payments' }],
  [/^\/more$/, { title: 'More' }],

  // Under Utilities.
  [/^\/properties\/([^/]+)\/utilities\/[^/]+$/, { title: 'Account', back: '/properties', backLabel: 'Utilities' }],
  [/^\/properties\/[^/]+$/, { title: 'Property', back: '/properties', backLabel: 'Utilities' }],

  // Under Payments / Finances.
  [/^\/payments\/priorities$/, { title: 'Pay First', back: '/payments', backLabel: 'Payments' }],
  [/^\/loans\/[^/]+$/, { title: 'Loan', back: '/finances?tab=loans', backLabel: 'Loans' }],

  // Under More.
  [/^\/portfolio\/[^/]+$/, { title: 'Property', back: '/portfolio', backLabel: 'Portfolio' }],
  [/^\/tenants\/[^/]+$/, { title: 'Tenant', back: '/tenants', backLabel: 'Tenants' }],
  [/^\/personal\/cards\/[^/]+$/, { title: 'Card', back: '/personal?tab=cards', backLabel: 'Personal' }],
  [/^\/projects\/[^/]+$/, { title: 'Project', back: '/projects', backLabel: 'Projects' }],
  [/^\/notices\/[^/]+$/, { title: 'Notice', back: '/legal', backLabel: 'Legal' }],
  [/^\/repairs\/[^/]+$/, { title: 'Repair', back: '/repairs', backLabel: 'Repairs' }],
  [/^\/(portfolio|tenants|import|personal|vault|taxes|insurance|compliance|projects|operations|legal|insights|settings|repairs)$/,
    m => ({ title: TITLES[m[1]], back: '/more', backLabel: 'More' })],
];

const TITLES: Record<string, string> = {
  portfolio: 'Portfolio', tenants: 'Tenants', import: 'Import', personal: 'Personal', vault: 'Vault',
  taxes: 'Taxes', insurance: 'Insurance', compliance: 'Compliance', projects: 'Projects', operations: 'Operations',
  legal: 'Legal', insights: 'Insights', settings: 'Settings', repairs: 'Repairs',
};

export function phoneRoute(pathname: string): PhoneRoute {
  for (const [re, r] of TABLE) {
    const m = pathname.match(re);
    if (m) return typeof r === 'function' ? r(m) : r;
  }
  return { title: 'Sollux', back: '/more', backLabel: 'More' };
}

/**
 * Back as iOS does it: to the screen you came from, labelled with its title.
 * React Router numbers history entries (history.state.idx); the path seen at
 * each index is remembered for the tab's session, so the label is right even
 * after going back and forward. A deep link (nothing before it in the app)
 * falls back to the screen's parent from the table.
 */
const SEEN_KEY = 'sollux.phone.seen';
function seen(): Record<number, string> {
  try { return JSON.parse(sessionStorage.getItem(SEEN_KEY) || '{}'); } catch { return {}; }
}
export function rememberEntry(path: string) {
  const idx = (window.history.state as { idx?: number } | null)?.idx;
  if (typeof idx !== 'number') return;
  const s = seen(); s[idx] = path;
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
export function previousEntry(): string | null {
  const idx = (window.history.state as { idx?: number } | null)?.idx;
  if (typeof idx !== 'number' || idx < 1) return null;
  return seen()[idx - 1] ?? null;
}

/**
 * The Back button for the current screen: whether to show it, its label and
 * what it does. `fallback` overrides the table's parent (for deep links).
 */
export function usePhoneBack(fallback?: { back?: string; backLabel?: string }) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const meta = { ...phoneRoute(pathname), ...stripUndefined(fallback) };
  const prev = previousEntry();
  // A section of the same page (?tab=…) counts as its own screen.
  const fromApp = !!prev && prev !== pathname + search;
  // The screen's own name for its parent when that is where Back goes
  // (a property's name, say); otherwise the previous screen's title.
  const label = !fromApp || (meta.back && prev === meta.back)
    ? meta.backLabel ?? 'Back'
    : phoneRoute(prev!.split('?')[0]).title;
  return {
    show: !!meta.back,
    label,
    go: () => (fromApp ? navigate(-1) : navigate(meta.back ?? '/dashboard')),
  };
}

function stripUndefined<T extends object>(o?: T): Partial<T> {
  return o ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T> : {};
}
