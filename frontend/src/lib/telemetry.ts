import api from '../api/client';

/**
 * The app reporting its own crashes. A browser error or unhandled promise
 * rejection is posted to the API so the nightly auditor sees what broke
 * without anyone having to describe it. Throttled: the same message once a
 * minute, at most ten reports a page load, and never anything that fails
 * quietly by design (network drops, the user closing a dialog).
 */
const IGNORE = /ResizeObserver loop|Load failed|Failed to fetch|NetworkError|AbortError|Script error\.?$/i;
let sent = 0;
const lastSent = new Map<string, number>();

function report(message: string, stack?: string | null) {
  if (!message || IGNORE.test(message) || sent >= 10) return;
  const last = lastSent.get(message) ?? 0;
  if (Date.now() - last < 60_000) return;
  lastSent.set(message, Date.now());
  sent++;
  api.post('/telemetry/error', {
    message: message.slice(0, 1000),
    stack: stack?.slice(0, 8000) ?? null,
    url: location.pathname + location.search,
    userAgent: navigator.userAgent.slice(0, 300),
  }).catch(() => { /* a report that cannot be sent is not itself a crash */ });
}

export function installErrorReporting(): void {
  window.addEventListener('error', e => {
    report(e.message || String(e.error), e.error?.stack);
  });
  window.addEventListener('unhandledrejection', e => {
    const r: any = e.reason;
    report(r?.message ? String(r.message) : String(r), r?.stack);
  });
}
