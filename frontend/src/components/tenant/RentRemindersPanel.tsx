import { useEffect, useState } from 'react';
import { getMessageDrafts, draftRemindersNow, markDraft, type MessageDraftT } from '../../api/client';
import { fmtMoney } from '../../lib/money';

/**
 * Rent reminders the collections assistant drafted for late tenants. Sollux
 * never sends them: the owner copies the text or opens it in their own
 * email or messages app, then marks it sent.
 */
export default function RentRemindersPanel({ onChanged }: { onChanged?: () => void }) {
  const [drafts, setDrafts] = useState<MessageDraftT[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () => getMessageDrafts().then(setDrafts).catch(() => setDrafts([]));
  useEffect(() => { load(); }, []);

  async function draftNow() {
    setBusy(true); setNote(null);
    try {
      const r = await draftRemindersNow();
      setNote(r.late === 0 ? 'No tenant is late past their grace period.' : r.drafted ? `${r.drafted} new reminder${r.drafted === 1 ? '' : 's'} drafted.` : 'Reminders for every late tenant are already drafted.');
      await load();
    } finally { setBusy(false); }
  }
  async function act(id: string, action: 'sent' | 'dismiss') { await markDraft(id, action); await load(); onChanged?.(); }
  function copy(id: string, text: string) { navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(null), 1500); }); }

  if (!drafts) return null;
  return (
    <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <p className="text-sm font-medium text-gray-200">Rent reminders {drafts.length ? <span className="text-amber-400">· {drafts.length} ready</span> : null}</p>
          <p className="text-xs text-gray-500">Drafted each night for tenants past their grace period. Review, send from your phone or email, then mark sent.</p>
        </div>
        <button onClick={draftNow} disabled={busy} className="btn text-xs disabled:opacity-50">{busy ? 'Checking…' : 'Check now'}</button>
      </div>
      {note && <p className="text-xs text-gray-400 mt-2">{note}</p>}
      {drafts.length > 0 && (
        <div className="mt-3 space-y-2">
          {drafts.map(d => (
            <div key={d.id} className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => setOpen(o => (o === d.id ? null : d.id))} className="text-sm text-white hover:text-amber-400 text-left">
                  {d.toName} <span className="text-gray-600 text-xs">{open === d.id ? '▴' : '▾'}</span>
                </button>
                <span className={`text-xs px-2 py-0.5 rounded-full ${d.kind === 'FIRM' ? 'bg-red-900/50 text-red-400' : 'bg-amber-900/50 text-amber-400'}`}>{d.kind === 'FIRM' ? 'firm' : 'reminder'}</span>
                {d.amountDue != null && <span className="text-xs text-gray-400">{fmtMoney(d.amountDue)} owed</span>}
                <div className="ml-auto flex gap-2">
                  {d.toPhone && d.sms && <a href={`sms:${d.toPhone}?&body=${encodeURIComponent(d.sms)}`} className="text-xs text-amber-400 hover:text-amber-300">Text</a>}
                  {d.toEmail && <a href={`mailto:${d.toEmail}?subject=${encodeURIComponent(d.subject ?? '')}&body=${encodeURIComponent(d.body)}`} className="text-xs text-amber-400 hover:text-amber-300">Email</a>}
                  <button onClick={() => act(d.id, 'sent')} className="text-xs text-emerald-400 hover:text-emerald-300">Mark sent</button>
                  <button onClick={() => act(d.id, 'dismiss')} className="text-xs text-gray-500 hover:text-gray-300">Dismiss</button>
                </div>
              </div>
              {open === d.id && (
                <div className="mt-2 grid md:grid-cols-2 gap-3 text-xs">
                  {d.sms && (
                    <div>
                      <div className="flex justify-between mb-1"><span className="text-gray-500">Text{d.toPhone ? ` · ${d.toPhone}` : ' · no phone on file'}</span><button onClick={() => copy(d.id + 's', d.sms!)} className="text-amber-400">{copied === d.id + 's' ? 'Copied' : 'Copy'}</button></div>
                      <p className="text-gray-300 whitespace-pre-line rounded p-2" style={{ background: 'rgba(0,0,0,0.2)' }}>{d.sms}</p>
                    </div>
                  )}
                  <div>
                    <div className="flex justify-between mb-1"><span className="text-gray-500">Email{d.toEmail ? ` · ${d.toEmail}` : ' · no email on file'}</span><button onClick={() => copy(d.id + 'e', `${d.subject}\n\n${d.body}`)} className="text-amber-400">{copied === d.id + 'e' ? 'Copied' : 'Copy'}</button></div>
                    <p className="text-gray-400 mb-1">{d.subject}</p>
                    <p className="text-gray-300 whitespace-pre-line rounded p-2" style={{ background: 'rgba(0,0,0,0.2)' }}>{d.body}</p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
