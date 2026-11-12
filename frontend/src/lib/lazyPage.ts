import { createElement, lazy, type ComponentType } from 'react';

/**
 * Pages that load when first opened. The app was one file with every page
 * in it (2.3 MB) that had to download before the first screen showed, and
 * again after every deploy; now the first screen comes with the app and each
 * other page is its own small file.
 *
 * After a deploy, a tab still running the old build asks for page files that
 * no longer exist (the host answers with the app's index page instead). Then
 * the page reloads once onto the new build rather than showing an error.
 */
const RELOADED = 'sollux_chunk_reload';
const prefetchers: (() => Promise<unknown>)[] = [];

function reloadOnce(err: unknown): Promise<never> {
  let already = false;
  try { already = sessionStorage.getItem(RELOADED) === '1'; sessionStorage.setItem(RELOADED, '1'); } catch { /* storage off: reload anyway, once per load */ }
  if (!already) {
    window.location.reload();
    return new Promise<never>(() => {});   // the reload replaces the page
  }
  throw err;
}

export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>, opts: { prefetch?: boolean } = {}) {
  if (opts.prefetch) prefetchers.push(() => load().catch(() => undefined));
  return lazy(() => load().then(m => {
    try { sessionStorage.removeItem(RELOADED); } catch { /* ignore */ }
    return m;
  }, reloadOnce));
}

/**
 * Once the first screen is up and the browser is idle, the pages in the menu
 * are fetched in the background, so opening one is instant.
 */
let prefetched = false;
export function prefetchPages(): void {
  if (prefetched) return;
  prefetched = true;
  const run = () => { for (const p of prefetchers) void p(); };
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  window.setTimeout(() => (idle ? idle(run, { timeout: 5000 }) : run()), 3000);
}

/** What shows for the moment a page's file is loading. */
export function PageLoading() {
  return createElement('div', { className: 'flex items-center justify-center py-24 text-sm text-gray-500', role: 'status' }, 'Loading…');
}
