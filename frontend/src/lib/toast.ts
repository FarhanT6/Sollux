/**
 * Brief messages at the bottom of the screen ("Couldn't load bills — check
 * your connection"). Anything can call toast(); <Toaster /> in App shows
 * them. The same message twice within a few seconds shows once.
 */
export type ToastTone = 'error' | 'info';
export interface ToastMsg { id: number; text: string; tone: ToastTone }

type Listener = (t: ToastMsg) => void;
const listeners = new Set<Listener>();
const recent = new Map<string, number>();
let seq = 0;

export function toast(text: string, tone: ToastTone = 'info') {
  const now = Date.now();
  if (now - (recent.get(text) ?? 0) < 5000) return;
  recent.set(text, now);
  const msg = { id: ++seq, text, tone };
  listeners.forEach(l => l(msg));
}

export function onToast(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
