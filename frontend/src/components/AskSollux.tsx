import { useRef, useState } from 'react';
import { askSollux, confirmSolluxAction, type AgentAction } from '../api/client';
import { todayISO } from '../lib/date';
import { describeApiError } from '../lib/apiError';

const SUGGESTIONS = [
  "Who hasn't paid rent this month?",
  'What do I need to pay this week, and from which account?',
  'Which loans are late or due in the next 10 days?',
  'Any past-due bills?',
];

type Turn = { role: 'user' | 'assistant'; content: string; actions?: (AgentAction & { state?: 'done' | 'dismissed' | 'error'; note?: string })[] };

/**
 * Ask Sollux: a conversation that looks things up across the app — bills,
 * the loan tracker, rent, the pay plan, alerts — and can record a rent,
 * loan or bill payment once the owner presses Confirm on it.
 */
export default function AskSollux() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next: Turn[] = [...turns, { role: 'user', content }];
    setTurns(next); setQ(''); setBusy(true); setErr(null);
    try {
      const r = await askSollux(next.map(t => ({ role: t.role, content: t.content })), todayISO());
      setTurns([...next, { role: 'assistant', content: r.answer, actions: r.actions }]);
    } catch (e) { setErr(describeApiError(e, 'Could not get an answer — try again.')); setTurns(turns); setQ(content); }
    finally { setBusy(false); inputRef.current?.focus(); }
  }

  async function act(ti: number, ai: number, confirm: boolean) {
    const a = turns[ti].actions![ai];
    const set = (patch: Partial<Turn['actions'] extends (infer X)[] | undefined ? X : never>) =>
      setTurns(ts => ts.map((t, i) => (i !== ti ? t : { ...t, actions: t.actions!.map((x, j) => (j === ai ? { ...x, ...patch } : x)) })));
    if (!confirm) return set({ state: 'dismissed' });
    try { const r = await confirmSolluxAction(a); set({ state: 'done', note: r.result }); }
    catch (e) { set({ state: 'error', note: describeApiError(e, 'Not recorded.') }); }
  }

  return (
    <div className="rounded-xl p-4" style={{ background: 'rgba(245,166,35,0.05)', border: '1px solid rgba(245,166,35,0.2)' }}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium text-amber-400">Ask Sollux — it can look things up and log payments for you</p>
        {turns.length > 0 && <button onClick={() => { setTurns([]); setErr(null); }} className="text-xs text-gray-500 hover:text-gray-300">New conversation</button>}
      </div>

      {turns.length > 0 && (
        <div className="space-y-3 mb-3 max-h-[28rem] overflow-y-auto">
          {turns.map((t, ti) => (
            <div key={ti} className={t.role === 'user' ? 'text-right' : ''}>
              <div className={`inline-block text-left rounded-lg px-3 py-2 text-sm max-w-[90%] whitespace-pre-wrap ${t.role === 'user' ? 'bg-amber-500/15 text-amber-100' : 'bg-white/5 text-gray-200'}`}>{t.content}</div>
              {t.actions?.map((a, ai) => (
                <div key={ai} className="mt-2 rounded-lg px-3 py-2 text-xs flex items-center gap-3 flex-wrap" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(245,166,35,0.3)' }}>
                  <span className="text-gray-200 flex-1 min-w-[12rem]">{a.state === 'done' || a.state === 'error' ? a.note : a.summary}</span>
                  {!a.state && (
                    <>
                      <button onClick={() => act(ti, ai, true)} className="btn btn-primary text-xs">Confirm</button>
                      <button onClick={() => act(ti, ai, false)} className="text-gray-500 hover:text-gray-300">Don't record</button>
                    </>
                  )}
                  {a.state === 'done' && <span className="text-emerald-400">✓ Recorded</span>}
                  {a.state === 'dismissed' && <span className="text-gray-500">Not recorded</span>}
                  {a.state === 'error' && <span className="text-red-400">Failed</span>}
                </div>
              ))}
            </div>
          ))}
          {busy && <p className="text-xs text-gray-500">Looking it up…</p>}
        </div>
      )}

      <form onSubmit={e => { e.preventDefault(); send(q); }} className="flex gap-2">
        <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
          placeholder={turns.length ? 'Ask a follow-up, or say "log it"…' : "e.g. Log Matthew Connolly's $1,950 Zelle from today for September"}
          className="flex-1 rounded-lg px-3 py-2 text-sm text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none placeholder-gray-600" />
        <button type="submit" disabled={busy || !q.trim()} className="btn btn-primary text-xs px-5 flex-shrink-0">{busy ? 'Thinking…' : 'Ask'}</button>
      </form>
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
      {turns.length === 0 && (
        <div className="flex gap-2 mt-2.5 flex-wrap">
          {SUGGESTIONS.map(s => (
            <button key={s} type="button" onClick={() => send(s)} className="text-xs text-gray-500 hover:text-amber-400 px-2.5 py-1 rounded-full border border-white/10 hover:border-amber-400/25">{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}
