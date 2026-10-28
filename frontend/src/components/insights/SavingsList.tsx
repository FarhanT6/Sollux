import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSavings, type Saving } from '../../api/client';
import { fmtMoney } from '../../lib/money';

/**
 * Where you can save: findings worked out from the owner's own bills and
 * payments (backend lib/savings.ts) — late fees, card fees, bills up on last
 * year, an insurance premium that rose, internet at a property with no
 * tenant, two of one service, a high-rate loan — each with what it is worth
 * a year and the one thing to do.
 */
const KIND_LABEL: Record<Saving['kind'], string> = {
  LATE_FEES: 'Late fees', CARD_FEES: 'Card fees', RISING_BILL: 'Bill going up', INSURANCE_UP: 'Insurance',
  IDLE_SERVICE: 'No tenant', DUPLICATE_SERVICE: 'Duplicate', HIGH_RATE_LOAN: 'Loan rate',
};

export default function SavingsList() {
  const [data, setData] = useState<{ savings: Saving[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { getSavings().then(setData).catch(() => setFailed(true)); }, []);
  if (failed) return null;
  if (!data) return <div className="card p-5 mb-6 text-sm text-gray-500">Looking for savings…</div>;

  const list = showAll ? data.savings : data.savings.slice(0, 6);
  return (
    <section className="card p-5 mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <p className="text-base font-semibold text-white">Where you can save</p>
        {data.total > 0 && <p className="text-sm text-emerald-400 tabular-nums">about {fmtMoney(data.total)} a year</p>}
      </div>
      <p className="text-xs text-gray-500 mb-4">Worked out from your own bills and payments. Each one says what it is worth a year and what to do.</p>
      {!data.savings.length ? (
        <p className="text-sm text-gray-400">Nothing stands out right now: no late fees or card fees in the last year, no bill well up on last year, no service billing at an empty property.</p>
      ) : (
        <div className="divide-y divide-white/5">
          {list.map((s, i) => (
            <div key={i} className="py-3 flex gap-4 items-start">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 text-gray-400">{KIND_LABEL[s.kind]}</span>
                  {s.link ? <Link to={s.link} className="text-sm font-medium text-gray-100 hover:text-amber-400">{s.title}</Link> : <span className="text-sm font-medium text-gray-100">{s.title}</span>}
                  {s.propertyName && <span className="text-xs text-gray-500">{s.propertyName}</span>}
                </div>
                <p className="text-xs text-gray-400 mt-1">{s.detail}</p>
                <p className="text-xs text-amber-400/90 mt-0.5">{s.action}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-semibold text-emerald-400 tabular-nums">{fmtMoney(s.perYear)}</p>
                <p className="text-[11px] text-gray-500">{s.kind === 'HIGH_RATE_LOAN' ? 'a year per point' : 'a year'}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      {data.savings.length > 6 && (
        <button onClick={() => setShowAll(v => !v)} className="text-xs text-gray-400 hover:text-white mt-2">{showAll ? 'Show fewer' : `Show all ${data.savings.length}`}</button>
      )}
    </section>
  );
}
