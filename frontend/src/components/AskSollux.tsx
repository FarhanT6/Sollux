import { useRef, useState } from 'react';
import { askSollux, confirmSolluxAction, attachToSollux, type AgentAction, type SolluxAttachment } from '../api/client';
import ChatMarkdown from './ChatMarkdown';
import { filesToPayload } from '../lib/files';
import { todayISO } from '../lib/date';
import { describeApiError } from '../lib/apiError';

const SUGGESTIONS = [
  "Who hasn't paid rent this month?",
  'What do I need to pay this week, and from which account?',
  'Which loans are late or due in the next 10 days?',
  'Any past-due bills?',
  'Why has my electric bill gone up? Compare the last few statements.',
];

type Turn = { role: 'user' | 'assistant'; content: string; attachments?: SolluxAttachment[]; actions?: (AgentAction & { state?: 'done' | 'dismissed' | 'error'; note?: string })[] };

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
  // Files attached to the next question: uploaded as soon as they are picked.
  const [pending, setPending] = useState<SolluxAttachment[]>([]);
  const [uploading, setUploading] = useState(false);

  async function attach(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true); setErr(null);
    try { const added = await attachToSollux(await filesToPayload(list)); setPending(p => [...p, ...added].slice(0, 12)); }
    catch (e) { setErr(describeApiError(e, 'Could not attach that file.')); }
    finally { setUploading(false); }
  }

  async function send(text: string) {
    const content = text.trim() || (pending.length ? 'Take a look at what I attached.' : '');
    if (!content || busy || uploading) return;
    const next: Turn[] = [...turns, { role: 'user', content, ...(pending.length ? { attachments: pending } : {}) }];
    const sentFiles = pending;
    setTurns(next); setQ(''); setPending([]); setBusy(true); setErr(null);
    try {
      const r = await askSollux(next.map(t => ({ role: t.role, content: t.content, ...(t.attachments ? { attachments: t.attachments } : {}) })), todayISO());
      setTurns([...next, { role: 'assistant', content: r.answer, actions: r.actions }]);
    } catch (e) { setErr(describeApiError(e, 'Could not get an answer — try again.')); setTurns(turns); setQ(content); setPending(sentFiles); }
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
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-sm font-semibold text-gray-100">Ask Sollux <span className="font-normal text-gray-500">· it reads your bills and their PDFs, payments, taxes, insurance and documents — attach screenshots too — and can log payments for you</span></p>
        {turns.length > 0 && <button onClick={() => { setTurns([]); setErr(null); }} className="text-xs text-gray-500 hover:text-gray-300">New conversation</button>}
      </div>

      {turns.length > 0 && (
        <div className="space-y-3 mb-3 max-h-[40rem] overflow-y-auto">
          {turns.map((t, ti) => (
            <div key={ti} className={t.role === 'user' ? 'text-right' : ''}>
              {t.role === 'user' ? (
                <div className="inline-block text-left rounded-lg px-3 py-2 text-sm max-w-[90%] whitespace-pre-wrap bg-amber-500/15 text-amber-100">
                  {t.attachments?.length ? <p className="text-xs text-amber-200/70 mb-1">📎 {t.attachments.map(a => a.name).join(', ')}</p> : null}
                  {t.content}
                </div>
              ) : (
                <div className="inline-block text-left rounded-lg px-4 py-3 max-w-[95%] w-full bg-white/5 text-gray-200"><ChatMarkdown text={t.content} /></div>
              )}
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
          {busy && <p className="text-xs text-gray-500">Looking it up — reading statements and comparing them can take a minute or two…</p>}
        </div>
      )}

      {pending.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {pending.map((a, i) => (
            <span key={a.key} className="text-xs text-gray-300 px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.06)' }}>
              📎 {a.name} <button type="button" onClick={() => setPending(p => p.filter((_, j) => j !== i))} className="text-gray-500 hover:text-red-400 ml-1">✕</button>
            </span>
          ))}
        </div>
      )}
      <form onSubmit={e => { e.preventDefault(); send(q); }} className="flex gap-2">
        <label className={`btn text-xs flex-shrink-0 cursor-pointer ${uploading ? 'opacity-50' : ''}`} title="Attach PDFs or screenshots (usage graphs, a solar app, a letter)">
          {uploading ? '…' : '📎'}
          <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" multiple className="hidden" disabled={uploading} onChange={e => { void attach(e.target.files); e.target.value = ''; }} />
        </label>
        <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
          placeholder={turns.length ? 'Ask a follow-up, or say "log it"…' : "e.g. Log Matthew Connolly's $1,950 Zelle from today for September"}
          className="flex-1 rounded-lg px-3 py-2 text-sm text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none placeholder-gray-600" />
        <button type="submit" disabled={busy || uploading || (!q.trim() && !pending.length)} className="btn btn-primary text-xs px-5 flex-shrink-0">{busy ? 'Thinking…' : 'Ask'}</button>
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
