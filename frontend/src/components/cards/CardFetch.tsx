import { useEffect, useRef, useState } from 'react';
import {
  getCardLogin, saveCardLogin, deleteCardLogin, fetchCardStatements, submitCardCode, cancelCardFetch,
  type CardLoginT, type CreditCardT,
} from '../../api/client';
import { describeApiError } from '../../lib/apiError';
import { fmtDate } from '../../lib/date';
import PortalCodeBanner from '../utility/PortalCodeBanner';

/**
 * Statements from the card's website: Sollux's browser agent signs in with the
 * card's login and downloads each new statement a few days after it closes
 * (and when a "statement ready" email comes in). It is the AI agent, for the
 * current and coming statements; older ones are uploaded and read free.
 * The login is stored encrypted and never shown again; a code the website
 * sends while the owner watches is typed here.
 */
const host = (u: string | null) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : ''; } catch { return u ?? ''; } };

export default function CardFetch({ card, onFetched }: { card: CreditCardT; onFetched: () => void }) {
  const [s, setS] = useState<CardLoginT | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ loginUrl: '', username: '', password: '', autoFetch: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wasRunning = useRef(false);

  useEffect(() => { void getCardLogin(card.id).then(setS).catch(() => {}); }, [card.id]);
  const running = s?.fetch?.status === 'PENDING';
  // While a fetch runs: its live line every few seconds, and the card again once it ends.
  useEffect(() => {
    if (!running) {
      if (wasRunning.current) { wasRunning.current = false; onFetched(); }
      return;
    }
    wasRunning.current = true;
    const t = setInterval(() => { void getCardLogin(card.id).then(setS).catch(() => {}); }, 3000);
    return () => clearInterval(t);
  }, [running, card.id]);

  if (!s) return null;
  const f = s.fetch;
  const startEdit = () => { setForm({ loginUrl: s.loginUrl ?? '', username: s.username ?? '', password: '', autoFetch: s.autoFetch }); setErr(null); setEditing(true); };
  async function act(fn: () => Promise<CardLoginT | unknown>) {
    setBusy(true); setErr(null);
    try { const r = await fn(); if (r && typeof r === 'object' && 'hasLogin' in (r as object)) setS(r as CardLoginT); else setS(await getCardLogin(card.id)); return true; }
    catch (e) { setErr(describeApiError(e, 'That did not work.')); return false; }
    finally { setBusy(false); }
  }

  return (
    <div className="card p-3 mb-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <p className="text-sm text-gray-200">Statements from the website</p>
          <p className="text-xs text-gray-500">
            {s.hasLogin
              ? <>Signs in to {host(s.startUrl) || 'the card\'s website'}{s.username ? ` as ${s.username}` : ''} · {s.autoFetch ? 'fetches each new statement a few days after it closes' : 'only when you press Fetch now'}{f?.lastFetchedAt ? ` · last fetched ${fmtDate(f.lastFetchedAt, 'MMM d')}` : ''}</>
              : <>Save the login for {host(s.startUrl) || `${card.issuer ?? card.name}'s website`} and Sollux's browser agent (AI, a few cents a run) downloads each new statement after it closes. Older statements: Upload statement, read free.</>}
          </p>
        </div>
        {s.hasLogin && !editing && (running
          ? <button onClick={() => void act(() => cancelCardFetch(card.id))} disabled={busy} className="btn text-xs">Cancel</button>
          : <button onClick={() => void act(() => fetchCardStatements(card.id))} disabled={busy} className="btn btn-primary text-xs disabled:opacity-50">Fetch now</button>)}
        {!editing && <button onClick={startEdit} className="btn text-xs">{s.hasLogin ? 'Login…' : 'Add website login'}</button>}
      </div>

      {running && <p className="text-xs text-amber-300 mt-2">{f?.progress ?? 'Starting…'}</p>}
      {running && f?.mfaPrompt && (
        <PortalCodeBanner className="mt-2 rounded-xl p-3" accountId={card.id} prompt={f.mfaPrompt} requestedAt={f.mfaRequestedAt} providerName={card.issuer ?? card.name}
          submit={code => submitCardCode(card.id, code)} onSent={() => void getCardLogin(card.id).then(setS)} />
      )}
      {!running && f?.status === 'SUCCESS' && f.progress && <p className="text-xs text-gray-500 mt-2">{f.lastRunAt ? `${fmtDate(f.lastRunAt, 'MMM d')}: ` : ''}{f.progress}</p>}
      {!running && (f?.status === 'FAILED' || f?.status === 'CANCELLED') && f.error && <p className="text-xs text-red-400 mt-2">{f.lastRunAt ? `${fmtDate(f.lastRunAt, 'MMM d')}: ` : ''}{f.error}</p>}

      {editing && (
        <form className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2" onSubmit={async e => {
          e.preventDefault();
          const ok = await act(() => saveCardLogin(card.id, { loginUrl: form.loginUrl.trim() || null, username: form.username.trim() || undefined, password: form.password || undefined, autoFetch: form.autoFetch }));
          if (ok) setEditing(false);
        }}>
          <label className="sm:col-span-2"><span className="text-xs text-gray-500 block mb-1">Website (where you sign in)</span>
            <input className="input-dark text-sm w-full" value={form.loginUrl} onChange={e => setForm({ ...form, loginUrl: e.target.value })} placeholder={s.startUrl ?? 'https://…'} /></label>
          <label><span className="text-xs text-gray-500 block mb-1">Username</span>
            <input className="input-dark text-sm w-full" autoComplete="off" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} /></label>
          <label><span className="text-xs text-gray-500 block mb-1">Password</span>
            <input className="input-dark text-sm w-full" type="password" autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder={s.hasLogin ? 'saved — leave blank to keep' : ''} /></label>
          <label className="sm:col-span-2 flex items-center gap-2 text-xs text-gray-400">
            <input type="checkbox" checked={form.autoFetch} onChange={e => setForm({ ...form, autoFetch: e.target.checked })} />
            Fetch each new statement automatically a few days after it closes
          </label>
          <p className="sm:col-span-2 text-xs text-gray-600">Stored encrypted and never shown again. A code the website sends is read from your email, or typed here when you press Fetch now. It only downloads statements: it never pays, changes settings or accepts offers.</p>
          <div className="sm:col-span-2 flex gap-2">
            <button type="submit" disabled={busy} className="btn btn-primary text-xs disabled:opacity-50">Save</button>
            <button type="button" onClick={() => setEditing(false)} className="btn text-xs">Cancel</button>
            {s.hasLogin && <button type="button" disabled={busy} onClick={async () => { if (!confirm('Remove the saved website login for this card?')) return; if (await act(() => deleteCardLogin(card.id))) setEditing(false); }} className="btn text-xs text-red-400 ml-auto">Remove login</button>}
          </div>
        </form>
      )}
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
    </div>
  );
}
