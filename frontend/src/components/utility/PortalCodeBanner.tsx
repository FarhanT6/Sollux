import { useState } from 'react';
import { submitPortalCode } from '../../api/client';
import { describeApiError } from '../../lib/apiError';

/**
 * Shown while the portal agent is logged into a provider's site and the site
 * has sent a verification code. The owner types it here; the agent enters it
 * in the portal. It waits five minutes.
 */
export default function PortalCodeBanner({ accountId, prompt, requestedAt, providerName, onSent }: {
  accountId: string; prompt: string; requestedAt?: string | null; providerName: string; onSent?: () => void;
}) {
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const minutesLeft = requestedAt ? Math.max(0, 5 - Math.floor((Date.now() - new Date(requestedAt).getTime()) / 60000)) : null;

  async function send() {
    setState('sending'); setErr(null);
    try { await submitPortalCode(accountId, code); setState('sent'); onSent?.(); }
    catch (e) { setState('idle'); setErr(describeApiError(e, 'Could not send the code.')); }
  }

  return (
    <div className="mx-6 mt-4 rounded-xl p-4" style={{ background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.35)' }}>
      <p className="text-sm font-medium text-amber-300">{providerName} sent a verification code</p>
      <p className="text-xs text-gray-400 mt-0.5">{prompt}{minutesLeft != null ? ` · about ${minutesLeft} min left` : ''}</p>
      {state === 'sent' ? (
        <p className="text-xs text-emerald-400 mt-2">Code sent — Sollux is entering it now.</p>
      ) : (
        <form onSubmit={e => { e.preventDefault(); if (code.trim()) send(); }} className="flex gap-2 mt-2">
          <input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="Code" className="input-dark text-sm w-40" autoFocus />
          <button type="submit" disabled={!code.trim() || state === 'sending'} className="btn btn-primary text-xs disabled:opacity-50">{state === 'sending' ? 'Sending…' : 'Send code'}</button>
        </form>
      )}
      {err && <p className="text-xs text-red-400 mt-1">{err}</p>}
    </div>
  );
}
