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

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/**
 * A view over the analytics: which months count. Filtering happens here on
 * the client because every view is a subset of the same fetched history —
 * all months, the trailing twelve, one calendar year, or one month of every
 * year (every January, to compare winters across years).
 */
type RangeFilter =
  | { kind: 'all' }
  | { kind: 't12' }
  | { kind: 'ytd' }
  | { kind: 'year'; year: string }
  | { kind: 'monthOfYear'; month: number };  // 1-12

function monthMatches(month: string, f: RangeFilter, latestMonth: string): boolean {
  switch (f.kind) {
    case 'all': return true;
    case 'ytd': return month.startsWith(String(new Date().getFullYear()));
    case 'year': return month.startsWith(f.year);
    case 'monthOfYear': return Number(month.slice(5, 7)) === f.month;
    case 't12': {
      // Twelve months back from the newest month on the account, not from
      // today: an account whose last bill is three months old still has a
      // meaningful trailing twelve.
      const [y, m] = latestMonth.split('-').map(Number);
      const startY = m === 12 ? y : y - 1;
      const startM = m === 12 ? 1 : m + 1;
      const floor = `${startY}-${String(startM).padStart(2, '0')}`;
      return month >= floor && month <= latestMonth;
    }
  }
}

const BUCKET_LABEL: Record<string, string> = {
  current: 'Current', days30: '30 days', days60: '60 days', days90plus: '90+ days',
};

export default function ChargeAnalyticsPanel({ accountId }: { accountId: string }) {
  const [data, setData] = useState<ChargeAnalytics | null>(null);
  const [aging, setAging] = useState<AgingReconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<RangeFilter>({ kind: 'all' });

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

  // The filtered view. Totals, averages and latest are recomputed over the
  // months in view, so "Average" under a January-only filter means the
  // average January, not the all-time average with a January label.
  const allMonths = data ? [...new Set(data.lines.flatMap(l => l.months.map(m => m.month)))].sort() : [];
  const latestMonth = allMonths[allMonths.length - 1] ?? '';
  const years = [...new Set(allMonths.map(m => m.slice(0, 4)))].sort().reverse();

  const view = data ? data.lines
    .map(line => {
      const months = line.months.filter(m => monthMatches(m.month, filter, latestMonth));
      if (months.length === 0) return null;
      const total = months.reduce((t, m) => t + m.amount, 0);
      const latest = months[0];
      const first = months[months.length - 1];
      const changePercent = months.length > 1 && first.amount !== 0
        ? ((latest.amount - first.amount) / first.amount) * 100
        : null;
      return { ...line, months, total, average: total / months.length, latest: latest.amount, changePercent };
    })
    .filter((l): l is NonNullable<typeof l> => l !== null)
    .sort((a, b) => b.total - a.total) : [];

  const viewTotal = view.reduce((t, l) => t + l.total, 0);
  const viewMonths = new Set(view.flatMap(l => l.months.map(m => m.month))).size;
  // What the account was punished with, as opposed to what it bought — late
  // fees, contamination charges and their kin, summed over the same view.
  const viewFees = view.filter(l => l.isFee).reduce((t, l) => t + l.total, 0);

  if (!data || data.lines.length === 0) {
    return (
      <EmptyState
        icon="🧾"
        title="No itemised charges yet"
        body="Bills on this account have not been imported with a charge breakdown. Re-import them to see where the money goes."
      />
    );
  }

  const filterKey =
    filter.kind === 'year' ? `year:${filter.year}` :
    filter.kind === 'monthOfYear' ? `month:${filter.month}` : filter.kind;

  return (
    <div className="space-y-5 pb-8">
      {/* Range: every view is a subset of the same fetched history */}
      <div className="flex items-center gap-2 flex-wrap">
        {([['all', 'All'], ['t12', 'T-12'], ['ytd', 'YTD']] as const).map(([k, label]) => (
          <button key={k}
            onClick={() => setFilter({ kind: k })}
            className="text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={filter.kind === k
              ? { background: '#F5A623', color: '#000', fontWeight: 600 }
              : { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', color: '#9ca3af' }}
          >
            {label}
          </button>
        ))}
        <select
          value={filter.kind === 'year' ? filter.year : ''}
          onChange={e => e.target.value && setFilter({ kind: 'year', year: e.target.value })}
          className="text-xs px-2 py-1.5 rounded-lg focus:outline-none"
          style={filter.kind === 'year'
            ? { background: '#F5A623', color: '#000', fontWeight: 600 }
            : { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', color: '#9ca3af' }}
        >
          <option value="">Year…</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select
          value={filter.kind === 'monthOfYear' ? String(filter.month) : ''}
          onChange={e => e.target.value && setFilter({ kind: 'monthOfYear', month: Number(e.target.value) })}
          className="text-xs px-2 py-1.5 rounded-lg focus:outline-none"
          title="One month of every year — compare the same season across years"
          style={filter.kind === 'monthOfYear'
            ? { background: '#F5A623', color: '#000', fontWeight: 600 }
            : { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', color: '#9ca3af' }}
        >
          <option value="">Every…</option>
          {MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>Every {name}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: filter.kind === 'all' ? 'Year to date' : 'Total in view', value: money(filter.kind === 'all' ? data.yearToDate : viewTotal) },
          { label: 'Months covered', value: String(filter.kind === 'all' ? data.monthsCovered : viewMonths) },
          { label: 'Distinct charges', value: String(view.length) },
          { label: 'Fees & penalties', value: money(viewFees) },
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

        {view.length === 0 && (
          <p className="text-xs text-gray-500 py-3">No charges in this range.</p>
        )}
        {view.map(line => (
          <div key={filterKey + line.label} className="border-t border-white/5">
            <button
              onClick={() => setExpanded(expanded === line.label ? null : line.label)}
              className="w-full flex items-baseline justify-between py-2 text-xs text-left"
              style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            >
              <span className="min-w-0 pr-3">
                <span className="text-gray-200">{line.label}</span>
                {line.isFee && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(245,166,35,0.12)', border: '1px solid rgba(245,166,35,0.3)', color: '#F5A623' }}>
                    fee
                  </span>
                )}
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
