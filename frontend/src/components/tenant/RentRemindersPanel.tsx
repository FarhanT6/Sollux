import { useEffect, useMemo, useState } from 'react';
import { getMessageDrafts, draftRemindersNow, markDraft, type MessageDraftT } from '../../api/client';
import { fmtMoney } from '../../lib/money';

const KEY = 'sollux:rent-reminders-open';
const remembered = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const remember = (v: boolean) => { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* private window */ } };

type Kind = 'all' | 'FIRM' | 'REMINDER';
type Sort = 'owed' | 'name' | 'newest';

/**
 * Rent reminders the collections assistant drafted for late tenants, folded
 * into one line until opened (the choice is remembered): how many, how many
 * firm, and the total owed. Open, they can be searched, narrowed to firm or
 * friendly ones, and sorted. Sollux never sends them: the owner copies the
 * text or opens it in their own email or messages app, then marks it sent.
 */
export default function RentRemindersPanel({ onChanged }: { onChanged?: () => void }) {
  const [drafts, setDrafts] = useState<MessageDraftT[] | null>(null);
  const [expanded, setExpanded] = useState(remembered);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<Sort>('owed');

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
  const toggle = () => setExpanded(v => { remember(!v); return !v; });

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (drafts ?? [])
      .filter(d => kind === 'all' || d.kind === kind)
      .filter(d => words.every(w => (d.toName ?? '').toLowerCase().includes(w)))
      .sort((a, b) => sort === 'name' ? (a.toName ?? '').localeCompare(b.toName ?? '')
        : sort === 'newest' ? String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
        : (b.amountDue ?? 0) - (a.amountDue ?? 0));
  }, [drafts, q, kind, sort]);

  if (!drafts) return null;
  const firm = drafts.filter(d => d.kind === 'FIRM').length;
  const total = drafts.reduce((s, d) => s + (d.amountDue ?? 0), 0);
  const chip = (on: boolean) => `text-xs px-2.5 py-1 rounded-full border ${on ? 'border-amber-500 text-amber-400' : 'border-white/10 text-gray-400 hover:text-gray-200'}`;

  return (
    <div className="rounded-xl mb-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="flex items-center gap-2 flex-wrap p-4">
        <button onClick={toggle} className="flex items-center gap-2 text-left flex-1 min-w-0" aria-expanded={expanded}>
          <span className="text-gray-500 text-xs w-3">{expanded ? '▾' : '▸'}</span>
          <span className="text-sm font-medium text-gray-200">Rent reminders</span>
          {drafts.length > 0
            ? <span className="text-xs text-gray-400">
                <span className="text-amber-400">{drafts.length} ready</span>
                {firm > 0 && <> · <span className="text-red-400">{firm} firm</span></>}
                {total > 0 && <> · {fmtMoney(total)} owed</>}
              </span>
            : <span className="text-xs text-gray-500">none waiting</span>}
        </button>
        <button onClick={draftNow} disabled={busy} className="btn text-xs disabled:opacity-50">{busy ? 'Checking…' : 'Check now'}</button>
      </div>
      {note && <p className="text-xs text-gray-400 px-4 -mt-2 pb-3">{note}</p>}
      {expanded && (
        <div className="px-4 pb-4">
          <p className="text-xs text-gray-500 mb-3">Drafted each night for tenants past their grace period, one per tenant. Review, send from your phone or email, then mark sent.</p>
          {drafts.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search tenant…" className="input-dark text-xs w-44" />
              <div className="flex gap-1">
                <button onClick={() => setKind('all')} className={chip(kind === 'all')}>All</button>
                <button onClick={() => setKind('FIRM')} className={chip(kind === 'FIRM')}>Firm</button>
                <button onClick={() => setKind('REMINDER')} className={chip(kind === 'REMINDER')}>Friendly</button>
              </div>
              <select value={sort} onChange={e => setSort(e.target.value as Sort)} className="input-dark text-xs">
                <option value="owed">Most owed first</option>
                <option value="name">By name</option>
                <option value="newest">Newest first</option>
              </select>
              <span className="text-xs text-gray-500 ml-auto">{shown.length} of {drafts.length}</span>
            </div>
          )}
          <div className="space-y-2 max-h-[32rem] overflow-y-auto">
            {shown.map(d => (
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
            {drafts.length > 0 && shown.length === 0 && <p className="text-xs text-gray-500">No reminder matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
