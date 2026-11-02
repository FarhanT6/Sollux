import { useEffect, useState } from 'react';
import { arrearsAsOf, type ArrearsAsOf } from '../../api/client';
import { describeApiError } from '../../lib/apiError';
import { fmtMoney } from '../../lib/money';
import { lastMonthISO, todayISO } from '../../lib/date';

/**
 * Back rent from a figure you know — the total on a 3-day notice, a ledger —
 * carried forward with what Sollux has on record since: payments made on or
 * after that date come off; months that have ended since go on, less what
 * was paid toward them. Shows the working before anything is saved.
 */
export default function ArrearsAsOfDialog({ leaseId, tenant, onClose, onSaved }: { leaseId: string; tenant: string; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [through, setThrough] = useState(lastMonthISO());
  const [asOf, setAsOf] = useState(todayISO());
  const [preview, setPreview] = useState<ArrearsAsOf | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const n = parseFloat(amount);

  useEffect(() => {
    setPreview(null); setErr('');
    if (!(n >= 0) || !through || !asOf) return;
    const t = setTimeout(() => {
      arrearsAsOf(leaseId, { amount: n, through, asOf }).then(setPreview).catch(e => setErr(describeApiError(e, 'Could not work it out.')));
    }, 300);
    return () => clearTimeout(t);
  }, [leaseId, n, through, asOf]);

  async function save() {
    setBusy(true);
    try { await arrearsAsOf(leaseId, { amount: n, through, asOf, save: true }); onSaved(); onClose(); }
    catch (e) { setErr(describeApiError(e, 'Could not save it.')); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl p-5 space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-white">Set back rent — {tenant}</p>
            <p className="text-xs text-gray-500 mt-0.5">From a figure you know, like the total on a 3-day notice. Sollux carries it forward with the payments and months since.</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">✕</button>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <label className="block"><span className="text-gray-400">Owed</span>
            <input type="number" min={0} step="0.01" className="input-dark w-full text-sm mt-1" placeholder="22550" value={amount} onChange={e => setAmount(e.target.value)} autoFocus /></label>
          <label className="block"><span className="text-gray-400">For rent through</span>
            <input type="month" className="input-dark w-full text-sm mt-1" value={through} max={lastMonthISO()} onChange={e => e.target.value && setThrough(e.target.value)} /></label>
          <label className="block"><span className="text-gray-400">As of (notice date)</span>
            <input type="date" className="input-dark w-full text-sm mt-1" value={asOf} max={todayISO()} onChange={e => e.target.value && setAsOf(e.target.value)} /></label>
        </div>
        <p className="text-[11px] text-gray-600">Payments made on or after the "as of" date come off the figure. If a payment on that day was already counted in it, set the date to the day after.</p>

        {err && <p className="text-xs text-red-400">{err}</p>}
        {preview && (
          <div className="rounded-lg p-3 text-xs space-y-1" style={{ background: 'rgba(255,255,255,0.03)' }}>
            <div className="flex justify-between text-gray-300"><span>Owed through {through}</span><span className="tabular-nums">{fmtMoney(n)}</span></div>
            {preview.lines.map((l, i) => (
              <div key={i} className="flex justify-between text-gray-400">
                <span>{l.date} · {l.label}</span>
                <span className={`tabular-nums ${l.amount < 0 ? 'text-emerald-400' : 'text-red-400'}`}>{l.amount < 0 ? '−' : '+'}{fmtMoney(Math.abs(l.amount))}</span>
              </div>
            ))}
            <div className="flex justify-between text-white font-semibold pt-1 border-t border-white/10"><span>Back rent now</span><span className="tabular-nums">{fmtMoney(preview.balance)}</span></div>
            <p className="text-gray-500">Sollux has {fmtMoney(preview.current)} now{Math.abs(preview.current - preview.balance) > 0.5 ? ` — ${fmtMoney(Math.abs(preview.current - preview.balance))} ${preview.current > preview.balance ? 'too high' : 'too low'}` : ' — it matches'}. This month's rent is counted on its own.</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn text-sm">Cancel</button>
          <button onClick={() => void save()} disabled={!preview || busy} className="btn-primary text-sm px-4 py-2 disabled:opacity-40">{busy ? 'Saving…' : preview ? `Set back rent to ${fmtMoney(preview.balance)}` : 'Set back rent'}</button>
        </div>
      </div>
    </div>
  );
}
