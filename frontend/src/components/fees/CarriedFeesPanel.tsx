import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getCarriedFees, scanCarriedFees, type CarriedFeeRow } from '../../api/client';
import { fmtMoney } from '../../lib/money';
import { fmtDate } from '../../lib/date';
import { describeApiError } from '../../lib/apiError';

/**
 * Late fees no bill lists: a bill left unpaid, and the next one carrying in more than it asked
 * (City of Imperial adds 10% and folds it into "previous balance"). Each is on the bill that was
 * paid late — in its charge and its fees — so it counts wherever fees and costs are totalled.
 */
export default function CarriedFeesPanel({ propertyName }: { propertyName?: string }) {
  const [data, setData] = useState<{ rows: CarriedFeeRow[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = () => getCarriedFees().then(setData).catch(e => setNote(describeApiError(e, 'Could not load the late fees carried into later bills.')));
  useEffect(() => { void load(); }, []);

  const rescan = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await scanCarriedFees();
      setNote(r.fees ? `${r.fees} late fee${r.fees === 1 ? '' : 's'} found across every bill (${fmtMoney(r.total)}).` : 'No late fees hidden in a carried balance.');
      await load();
    } catch (e) { setNote(describeApiError(e, 'Could not check the bills.')); }
    finally { setBusy(false); }
  };

  const rows = (data?.rows ?? []).filter(r => !propertyName || r.property === propertyName);
  const fees = rows.filter(r => r.fee != null);
  const odd = rows.filter(r => r.unexplained != null);
  const total = fees.reduce((t, r) => t + (r.fee ?? 0), 0);

  return (
    <div className="rounded-xl p-5 mt-6" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-medium text-gray-200">Late fees folded into the next bill</p>
          <p className="text-xs text-gray-500 mt-0.5 max-w-2xl">A bill left unpaid, and the next one carrying in more than it asked, with no fee listed: the difference is a late fee. Each is on the bill that was paid late, so it counts in fees and costs.</p>
        </div>
        <button onClick={() => void rescan()} disabled={busy} className="btn text-xs disabled:opacity-50">{busy ? 'Checking…' : 'Check every bill again'}</button>
      </div>
      {note && <p className="text-xs text-amber-300 mt-2">{note}</p>}
      {!data ? <p className="text-xs text-gray-500 mt-3">Loading…</p>
        : !fees.length && !odd.length ? <p className="text-xs text-gray-500 mt-3">None found{propertyName ? ' at this property' : ''}.</p>
        : (
          <div className="overflow-x-auto mt-3">
            <table className="text-sm w-full min-w-[620px]">
              <thead>
                <tr className="text-left text-gray-500 text-xs">
                  <th className="px-2 py-1.5">Account</th>
                  <th className="px-2 py-1.5">Bill</th>
                  <th className="px-2 py-1.5 text-right">It asked</th>
                  <th className="px-2 py-1.5">Next bill carried in</th>
                  <th className="px-2 py-1.5 text-right">Late fee</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {[...fees, ...odd].map(r => (
                  <tr key={r.statementId}>
                    <td className="px-2 py-1.5">
                      <Link to={`/properties/${r.propertyId}/utilities/${r.accountId}`} className="text-gray-200 hover:text-amber-400">{r.provider}{r.last4 ? ` ··${r.last4}` : ''}</Link>
                      <p className="text-[11px] text-gray-500">{r.property}</p>
                    </td>
                    <td className="px-2 py-1.5 text-gray-300 whitespace-nowrap">{fmtDate(r.statementDate, 'MMM d, yyyy')}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-gray-300">{r.billTotal != null ? fmtMoney(r.billTotal) : '—'}</td>
                    <td className="px-2 py-1.5 text-gray-400 text-xs">
                      {r.nextCarried != null ? fmtMoney(r.nextCarried) : '—'} on {fmtDate(r.nextStatementDate, 'MMM d, yyyy')}
                      {r.nextPaymentsShown ? <span className="text-gray-500"> (after {fmtMoney(r.nextPaymentsShown)} received)</span> : null}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap">
                      {r.fee != null ? <span className="text-amber-400">{fmtMoney(r.fee)}</span>
                        : <span className="text-gray-500" title="Too large to be a late fee — a deposit, a correction or a bill missing in between. Not counted.">{fmtMoney(r.unexplained ?? 0)} not counted</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              {fees.length > 1 && (
                <tfoot>
                  <tr className="text-xs text-gray-400"><td colSpan={4} className="px-2 pt-2 text-right">In all</td><td className="px-2 pt-2 text-right font-mono text-amber-400">{fmtMoney(total)}</td></tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
    </div>
  );
}
