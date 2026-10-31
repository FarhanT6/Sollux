import { useEffect, useState } from 'react';
import { getRentCatchUp, runRentCatchUp, undoRentCatchUp, type RentCatchUp as Preview } from '../../api/client';
import { fmtMoney } from '../../lib/money';
import { fmtDate, thisMonthISO } from '../../lib/date';
import { describeApiError } from '../../lib/apiError';

const lastMonth = () => {
  const [y, m] = thisMonthISO().split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const monthName = (ym: string) => fmtDate(`${ym}-01`, 'MMMM yyyy');

/**
 * Rent marked paid to date, for records that start partway. Active leases
 * with nothing owed from earlier months get every month from move-in through
 * last month with no payment logged, at the rent then in effect; this
 * month stays as it is recorded. Leases with arrears are listed to review
 * by hand. One click undoes the whole batch.
 */
export default function RentCatchUp({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const through = lastMonth();
  const [data, setData] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    getRentCatchUp(through).then(d => { setData(d); setPicked(new Set(d.ready.map(l => l.leaseId))); })
      .catch(e => setErr(describeApiError(e, 'Could not load the leases.')));
  }, [through]);

  const chosen = (data?.ready ?? []).filter(l => picked.has(l.leaseId));
  const months = chosen.reduce((t, l) => t + l.months.length, 0);
  const total = chosen.reduce((t, l) => t + l.months.reduce((s, m) => s + m.amount, 0), 0);
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function run() {
    setBusy(true); setErr('');
    try { const r = await runRentCatchUp(through, chosen.map(l => l.leaseId)); setDone(`Logged ${r.rentPayments} month${r.rentPayments === 1 ? '' : 's'} of rent across ${r.leases} lease${r.leases === 1 ? '' : 's'}.`); }
    catch (e) { setErr(describeApiError(e, 'Could not log the rent.')); }
    finally { setBusy(false); }
  }
  async function undo() {
    if (!confirm('Undo the last rent catch-up? The rent it logged is removed.')) return;
    setBusy(true); setErr('');
    try { const r = await undoRentCatchUp(); setDone(`Undone: ${r.rentPayments} rent payments removed.`); }
    catch (e) { setErr(describeApiError(e, 'Could not undo it.')); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-xl p-5" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-1">
          <p className="font-semibold text-white">Mark rent paid to date</p>
          <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          For tenants who owe nothing from earlier months: every month from move-in through {monthName(through)} with no payment logged is recorded as paid,
          at the rent then in effect. Months with a payment already logged are left as they are, and {monthName(thisMonthISO())} stays as recorded.
        </p>

        {done ? (
          <div>
            <p className="text-sm text-emerald-400 mb-4">{done}</p>
            <div className="flex justify-end"><button onClick={onDone} className="btn-primary text-sm px-4 py-2">Done</button></div>
          </div>
        ) : !data ? <p className="text-xs text-gray-500">{err || 'Loading…'}</p> : (
          <>
            {data.ready.length === 0 ? <p className="text-sm text-gray-400 mb-4">Every month is already recorded for the tenants with no arrears.</p> : (
              <div className="mb-5">
                <div className="flex items-center mb-2">
                  <p className="text-sm font-medium text-white">To log</p>
                  <span className="ml-auto flex gap-3 text-xs">
                    <button onClick={() => setPicked(new Set(data.ready.map(l => l.leaseId)))} className="text-gray-400 hover:text-white">All</button>
                    <button onClick={() => setPicked(new Set())} className="text-gray-400 hover:text-white">None</button>
                  </span>
                </div>
                <div className="space-y-1">
                  {data.ready.map(l => (
                    <label key={l.leaseId} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                      <input type="checkbox" checked={picked.has(l.leaseId)} onChange={() => toggle(l.leaseId)} />
                      <span className="flex-1">{l.tenant}<span className="text-gray-500"> · {l.property}</span></span>
                      <span className="text-gray-500 tabular-nums">{l.months.length} month{l.months.length === 1 ? '' : 's'} · from {fmtDate(`${l.months[0].month}-01`, 'MMM yyyy')}</span>
                      <span className="tabular-nums w-24 text-right">{fmtMoney(l.months.reduce((s, m) => s + m.amount, 0))}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {data.review.length > 0 && (
              <div className="mb-5">
                <p className="text-sm font-medium text-white mb-1">Left for you to review</p>
                <p className="text-[11px] text-gray-500 mb-2">Nothing is logged for these.</p>
                <div className="space-y-1">
                  {data.review.map(l => (
                    <div key={l.leaseId} className="flex items-center gap-2 text-xs text-gray-400">
                      <span className="flex-1">{l.tenant}<span className="text-gray-600"> · {l.property}</span></span>
                      <span className="text-gray-500">{l.reason}</span>
                      {l.arrears > 0 && <span className="tabular-nums w-24 text-right text-red-400">{fmtMoney(l.arrears)}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {err && <p className="text-xs text-red-400 mb-3">{err}</p>}
            <div className="flex items-center gap-2">
              {data.lastCatchUp && <button disabled={busy} onClick={() => void undo()} className="text-xs text-gray-400 hover:text-white">Undo last rent catch-up ({fmtDate(data.lastCatchUp)})</button>}
              <span className="flex-1" />
              <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
              <button disabled={busy || !months} onClick={() => void run()} className="btn-primary text-sm px-4 py-2">
                {busy ? 'Logging…' : `Log ${months} month${months === 1 ? '' : 's'} · ${fmtMoney(total)}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
