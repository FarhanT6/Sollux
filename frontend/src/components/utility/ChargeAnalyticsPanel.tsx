import { useEffect, useState } from 'react';
import {
  getChargeAnalytics, getAgingReconciliation,
  type ChargeAnalytics, type AgingReconciliation,
} from '../../api/client';
import { Skeleton, EmptyState } from '../ui';
import { fmtDate } from '../../lib/date';

/**
 * Where the money on this account actually goes.
 *
 * A Republic bill is a waste container, a recycle container, an organics cart,
 * a recycling service and an AB939 fee — reported as one total, none of that is
 * visible. The breakdown has always been extracted; this is the first thing to
 * aggregate it across months.
 */

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const BUCKET_LABEL: Record<string, string> = {
  current: 'Current', days30: '30 days', days60: '60 days', days90plus: '90+ days',
};

export default function ChargeAnalyticsPanel({ accountId }: { accountId: string }) {
  const [data, setData] = useState<ChargeAnalytics | null>(null);
  const [aging, setAging] = useState<AgingReconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    // Independent: the aging check failing should not hide the charges.
    Promise.allSettled([getChargeAnalytics(accountId), getAgingReconciliation(accountId)])
      .then(([c, a]) => {
        if (c.status === 'fulfilled') setData(c.value);
        if (a.status === 'fulfilled') setAging(a.value);
      })
      .finally(() => setLoading(false));
  }, [accountId]);

  if (loading) return <Skeleton />;
  if (!data || data.lines.length === 0) {
    return (
      <EmptyState
        icon="🧾"
        title="No itemised charges yet"
        body="Bills on this account have not been imported with a charge breakdown. Re-import them to see where the money goes."
      />
    );
  }

  return (
    <div className="space-y-5 pb-8">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {[
          { label: 'Year to date', value: money(data.yearToDate) },
          { label: 'Months covered', value: String(data.monthsCovered) },
          { label: 'Distinct charges', value: String(data.lines.length) },
        ].map(s => (
          <div key={s.label} className="rounded-xl px-4 py-3"
            style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-xs text-gray-500 mb-1">{s.label}</p>
            <p className="text-lg font-semibold text-white">{s.value}</p>
          </div>
        ))}
      </div>

      {data.notable.length > 0 && (
        <div className="rounded-xl px-4 py-3" style={{ background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.25)' }}>
          {data.notable.map((n, i) => (
            <p key={i} className="text-xs text-amber-300">· {n}</p>
          ))}
        </div>
      )}

      <div className="rounded-xl px-4 py-3" style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-baseline justify-between text-xs text-gray-400 pb-2">
          <span>Charge</span>
          <span className="flex gap-5">
            <span className="w-20 text-right">Latest</span>
            <span className="w-20 text-right">Average</span>
            <span className="w-24 text-right">Total</span>
          </span>
        </div>

        {data.lines.map(line => (
          <div key={line.label} className="border-t border-white/5">
            <button
              onClick={() => setExpanded(expanded === line.label ? null : line.label)}
              className="w-full flex items-baseline justify-between py-2 text-xs text-left"
              style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            >
              <span className="min-w-0 pr-3">
                <span className="text-gray-200">{line.label}</span>
                {line.changePercent != null && Math.abs(line.changePercent) >= 5 && (
                  <span className={line.changePercent > 0 ? 'text-red-400 ml-2' : 'text-emerald-400 ml-2'}>
                    {line.changePercent > 0 ? '↑' : '↓'} {Math.abs(line.changePercent).toFixed(0)}%
                  </span>
                )}
                <span className="text-gray-600 ml-2">{line.months.length} bill{line.months.length === 1 ? '' : 's'}</span>
              </span>
              <span className="flex gap-5 flex-shrink-0">
                <span className="w-20 text-right text-gray-200">{line.latest != null ? money(line.latest) : '—'}</span>
                <span className="w-20 text-right text-gray-500">{money(line.average)}</span>
                <span className="w-24 text-right text-gray-300">{money(line.total)}</span>
              </span>
            </button>

            {expanded === line.label && (
              <div className="pb-2 pl-3">
                {line.months.map(m => (
                  <div key={m.month} className="flex items-baseline justify-between text-xs py-0.5">
                    <span className="text-gray-600">{fmtDate(m.month + '-01', 'MMM yyyy')}</span>
                    <span className="text-gray-400">{money(m.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {aging && (
        <div className="rounded-xl px-4 py-3" style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-xs text-gray-400 mb-2">
            Arrears aging
            {aging.reportedAsOf && (
              <span className="text-gray-600"> · provider’s figures as of {fmtDate(aging.reportedAsOf, 'MMM d, yyyy')}</span>
            )}
          </p>

          {aging.reported && (
            <div className="flex items-baseline justify-between text-xs text-gray-500 pb-1">
              <span>Bucket</span>
              <span className="flex gap-5">
                <span className="w-20 text-right">Provider</span>
                <span className="w-20 text-right">On file</span>
              </span>
            </div>
          )}
          {aging.differences.map(d => (
            <div key={d.bucket} className="flex items-baseline justify-between text-xs py-1 border-t border-white/5">
              <span className="text-gray-300">{BUCKET_LABEL[d.bucket] ?? d.bucket}</span>
              <span className="flex gap-5">
                <span className="w-20 text-right text-gray-200">{money(d.reported)}</span>
                <span className={`w-20 text-right ${Math.abs(d.difference) >= 1 ? 'text-amber-400' : 'text-gray-500'}`}>
                  {money(d.derived)}
                </span>
              </span>
            </div>
          ))}

          <div className="mt-2 space-y-0.5">
            {aging.findings.map((f, i) => (
              <p key={i} className="text-xs text-gray-500">· {f}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
