/**
 * How long the app took to open, step by step, kept for the Speed check
 * (Settings → Account). The server-side numbers alone could not say why the
 * Overview sat on grey boxes: the time may go to loading the app, signing in
 * (Clerk), a server that was asleep answering its first request, or drawing.
 * Times are from the moment the page started loading (performance.now()).
 * Only an open that lands on the Overview is recorded.
 */
const KEY = 'sollux_last_open';
type Step = 'app' | 'signedIn' | 'firstAnswer' | 'shown';
const marks: Partial<Record<Step, number>> = {};
let firstAsked: number | null = null;
let saved = false;

export function markLoad(step: Step): void {
  if (saved || marks[step] != null) return;
  marks[step] = performance.now();
  if (step === 'shown') {
    saved = true;
    try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), marks, firstAsked })); } catch { /* storage off: nothing kept */ }
  }
}

/** The first request leaving for the server (after sign-in), for how long the server took to answer it. */
export function markFirstAsked(): void { if (firstAsked == null) firstAsked = performance.now(); }

export interface LastOpen { at: number; total: number; steps: { label: string; ms: number; key: 'app' | 'signin' | 'server' | 'draw' }[] }

export function lastOpen(): LastOpen | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const { at, marks: m, firstAsked: asked } = JSON.parse(raw) as { at: number; marks: Partial<Record<Step, number>>; firstAsked: number | null };
    if (m.shown == null) return null;
    const app = m.app ?? 0, signedIn = m.signedIn ?? app, answer = m.firstAnswer ?? m.shown;
    const sent = asked != null ? Math.max(asked, signedIn) : signedIn;
    return {
      at, total: m.shown,
      steps: [
        { key: 'app', label: 'Loading the app', ms: app },
        { key: 'signin', label: 'Signing in', ms: Math.max(0, sent - app) },
        { key: 'server', label: 'The server\'s first answer', ms: Math.max(0, answer - sent) },
        { key: 'draw', label: 'The rest of the Overview', ms: Math.max(0, m.shown - answer) },
      ],
    };
  } catch { return null; }
}
