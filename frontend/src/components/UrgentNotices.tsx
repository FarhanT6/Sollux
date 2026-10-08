/**
 * Open shut-off, past-due and cancellation notices, with days until the
 * cut-off. On the Overview (all accounts) and on an account's page (its own).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getServiceNotices, resolveServiceNotice, type ServiceNotice } from '../api/client';
import { fmtMoney } from '../lib/money';
import { fmtDate, todayISO } from '../lib/date';

const KIND: Record<string, string> = { DISCONNECTION: 'Disconnection', CANCELLATION: 'Cancellation', PAST_DUE: 'Past due' };

function countdown(n: ServiceNotice): { text: string; urgent: boolean } {
  if (!n.cutoffDate) return { text: 'no cut-off date stated', urgent: false };
  const cut = n.cutoffDate.slice(0, 10);
  const days = Math.round((Date.parse(cut) - Date.parse(todayISO())) / 86400000);
  const what = n.kind === 'CANCELLATION' ? 'Coverage ends' : 'Shut-off';
  if (days < 0) return { text: `${what} date passed ${fmtDate(cut, 'MMM d')} (${-days} day${days === -1 ? '' : 's'} ago)`, urgent: true };
  if (days === 0) return { text: `${what} today`, urgent: true };
  return { text: `${what} ${fmtDate(cut, 'MMM d')}: in ${days} day${days === 1 ? '' : 's'}`, urgent: days <= 7 };
}

export default function UrgentNotices({ utilityAccountId, className = '' }: { utilityAccountId?: string; className?: string }) {
  const [notices, setNotices] = useState<ServiceNotice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => getServiceNotices().then(setNotices).catch(() => setNotices([])), []);
  useEffect(() => { load(); }, [load]);
  const shown = utilityAccountId ? notices.filter(n => n.utilityAccountId === utilityAccountId) : notices;
  if (!shown.length) return null;

  async function resolve(n: ServiceNotice) {
    if (!confirm(`Mark the ${KIND[n.kind]?.toLowerCase() ?? 'notice'} from ${n.provider ?? 'this provider'} as paid / resolved?\n\nSollux closes it on its own once payments logged on the account cover it.`)) return;
    setBusy(n.id);
    try { await resolveServiceNotice(n.id); await load(); } finally { setBusy(null); }
  }

  return (
    <div className={`rounded-xl p-4 space-y-2 ${className}`} style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)' }}>
      <p className="text-xs font-semibold text-red-300">⚠ {shown.length} urgent notice{shown.length === 1 ? '' : 's'}: pay before the cut-off</p>
      {shown.map(n => {
        const c = countdown(n);
        const where = n.property ?? (n.accountLast4 ? `account ending ${n.accountLast4} (not matched to an account yet)` : 'not matched to an account yet');
        return (
          <div key={n.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs rounded-lg px-3 py-2" style={{ background: 'rgba(0,0,0,0.2)' }}>
            <span className="px-1.5 py-0.5 rounded text-red-200" style={{ background: 'rgba(239,68,68,0.25)' }}>{KIND[n.kind] ?? n.kind}</span>
            {n.utilityAccountId && n.propertyId
              ? <Link to={`/properties/${n.propertyId}/utilities/${n.utilityAccountId}`} className="text-gray-100 hover:underline">{n.provider} · {where}</Link>
              : <Link to="/import" className="text-gray-100 hover:underline">{n.provider ?? 'Provider'} · {where}</Link>}
            <span className={c.urgent ? 'text-red-300 font-medium' : 'text-amber-300'}>{c.text}</span>
            {n.amountDemanded != null && <span className="text-gray-300">{fmtMoney(n.amountDemanded)} to pay</span>}
            <button className="ml-auto text-gray-400 hover:text-white disabled:opacity-50" disabled={busy === n.id} onClick={() => resolve(n)}>Paid / resolved</button>
            {n.summary && <p className="basis-full text-gray-500 truncate" title={n.summary}>{n.summary}</p>}
          </div>
        );
      })}
    </div>
  );
}
