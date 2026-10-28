/**
 * Keeping an open tab on the newest build. A page left open keeps running
 * the code it loaded — after a deploy it showed the old Finances tabs until
 * a hard refresh. Every few minutes, and whenever the tab comes back into
 * view, /version.json is checked against the build this bundle came from;
 * when a newer one is out, the app reloads at the next page change, or at
 * once when the tab is coming back into view (nothing is being typed then).
 */
let stale = false;

async function check(): Promise<boolean> {
  if (__BUILD_ID__ === 'dev' || stale) return stale;
  try {
    const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return false;
    const { build } = await r.json();
    if (typeof build === 'string' && build && build !== __BUILD_ID__) stale = true;
  } catch { /* offline, or the app was loaded from bundled files */ }
  return stale;
}

/** Start watching; call once. */
export function watchForNewBuild(): void {
  if (__BUILD_ID__ === 'dev') return;
  setInterval(() => { void check(); }, 5 * 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check().then(s => { if (s) window.location.reload(); });
  });
}

/** On a page change: reload onto the newer build if one is out. */
export function reloadIfStale(): void {
  if (stale) window.location.reload();
}
