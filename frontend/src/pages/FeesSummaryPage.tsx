import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { getStatementsSummary, getProperties } from '../api/client';
import type { StatementSummaryRow, Property } from '../types';
import { PageHeader, Modal } from '../components/ui';
import { fmtDate, todayISO } from '../lib/date';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const dateStr = (d: string | null) => d ? fmtDate(d, 'MMM d, yyyy') : '—';

type Metric = 'penaltiesFees' | 'amountDue' | 'chargesExcludingFees' | 'amountPaid' | 'pastDueCarried' | 'totalDueWithPastDue';
type GroupBy = 'month' | 'year' | 'all';
type Period = 'month' | 'year' | '12m' | 'all' | 'pick';

const METRICS: { key: Metric; label: string }[] = [
  { key: 'penaltiesFees', label: 'Late fees & penalties' },
  { key: 'pastDueCarried', label: 'Past due carried' },
  { key: 'amountDue', label: 'Total charged' },
  { key: 'chargesExcludingFees', label: 'Charged without fees' },
  { key: 'amountPaid', label: 'Paid' },
  { key: 'totalDueWithPastDue', label: 'Charged with past due' },
];
const PERIODS: { key: Period; label: string }[] = [
  { key: 'month', label: 'This month' },
  { key: 'year', label: 'This year' },
  { key: '12m', label: 'Last 12 months' },
  { key: 'all', label: 'All time' },
];

const BREAKDOWN_FIELDS: { key: Metric; label: string }[] = [
  { key: 'amountDue', label: 'Amount Due' },
  { key: 'chargesExcludingFees', label: 'Charges (excl. fees)' },
  { key: 'penaltiesFees', label: 'Penalties / Fees' },
  { key: 'pastDueCarried', label: 'Past Due' },
  { key: 'amountPaid', label: 'Paid' },
  { key: 'totalDueWithPastDue', label: 'Total Due w/ Past Due' },
];

/**
 * A bill belongs to the month its billing period ended, not the month it was
 * issued — an SDG&E bill for July is issued in August, and filing it under
 * August left July empty here while the property page had it in July. Only
 * a bill that states no period falls back to its issue date. A UTC date-only
 * value is read in UTC so a period ending 31 July does not slip into June.
 */
function billingMonthOf(r: { statementDate: string; billingPeriodEnd?: string | null }): string {
  return r.billingPeriodEnd || r.statementDate;
}
function periodKey(dateStr: string, groupBy: GroupBy): string {
  const d = new Date(dateStr);
  if (dateStr.length === 10 || /T00:00:00(?:\.000)?Z$/.test(dateStr)) {
    if (groupBy === 'all') return 'all';
    if (groupBy === 'year') return String(d.getUTCFullYear());
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (groupBy === 'all') return 'all';
  if (groupBy === 'year') return String(d.getFullYear());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function periodLabel(key: string, groupBy: GroupBy): string {
  if (groupBy === 'all') return 'All time';
  if (groupBy === 'year') return key;
  const [y, m] = key.split('-').map(Number);
  return format(new Date(y, m - 1, 1), 'MMM yyyy');
}
const thisMonthKey = () => todayISO().slice(0, 7);
const shiftMonth = (ym: string, by: number) => {
  const [y, m] = ym.split('-').map(Number); const t = y * 12 + m - 1 + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

interface PeriodCell { total: number; rows: StatementSummaryRow[] }
interface DrillDown { provider: string; periodLabel: string; rows: StatementSummaryRow[] }

/**
 * Fees (and any other bill line) across the portfolio: the total for the
 * period at the top, then each property's share and the companies charging
 * the most, then each property's breakdown by company, folded. The period
 * picks the columns — months for a month or a year, years for all time.
 */
export default function FeesSummaryPage({ embedded }: { embedded?: boolean } = {}) {
  const [rows, setRows] = useState<StatementSummaryRow[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [metric, setMetric] = useState<Metric>('penaltiesFees');
  const [period, setPeriod] = useState<Period>('year');
  const [picked, setPicked] = useState(thisMonthKey());
  const [propertyId, setPropertyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [drillDown, setDrillDown] = useState<DrillDown | null>(null);

  useEffect(() => { getProperties().then(setProperties); }, []);
  useEffect(() => {
    setLoading(true);
    getStatementsSummary(propertyId ? { propertyId } : undefined).then(setRows).finally(() => setLoading(false));
  }, [propertyId]);

  // Which months count, and what the columns are.
  const now = thisMonthKey();
  const groupBy: GroupBy = period === 'all' ? 'year' : 'month';
  const inPeriod = (ym: string) =>
    period === 'month' ? ym === now
    : period === 'pick' ? ym === picked
    : period === 'year' ? ym.slice(0, 4) === now.slice(0, 4) && ym <= now
    : period === '12m' ? ym > shiftMonth(now, -12) && ym <= now
    : true;
  const periodName = period === 'pick' ? periodLabel(picked, 'month') : PERIODS.find(p => p.key === period)!.label.toLowerCase();
  const metricLabel = METRICS.find(m => m.key === metric)!.label;

  // property -> provider -> column -> { total, rows }
  const data = useMemo(() => {
    const byProperty = new Map<string, { label: string; total: number; byProvider: Map<string, Map<string, PeriodCell>> }>();
    const byCompany = new Map<string, number>();
    const periodSet = new Set<string>();
    let total = 0;
    for (const r of rows) {
      const v = r[metric];
      if (v == null || v === 0) continue;
      const ym = periodKey(billingMonthOf(r), 'month');
      if (!inPeriod(ym)) continue;
      const pk = groupBy === 'year' ? ym.slice(0, 4) : ym;
      periodSet.add(pk);
      total += v;
      byCompany.set(r.providerName, (byCompany.get(r.providerName) ?? 0) + v);
      if (!byProperty.has(r.propertyId)) byProperty.set(r.propertyId, { label: r.propertyLabel, total: 0, byProvider: new Map() });
      const prop = byProperty.get(r.propertyId)!;
      prop.total += v;
      if (!prop.byProvider.has(r.providerName)) prop.byProvider.set(r.providerName, new Map());
      const provMap = prop.byProvider.get(r.providerName)!;
      if (!provMap.has(pk)) provMap.set(pk, { total: 0, rows: [] });
      const cell = provMap.get(pk)!;
      cell.total += v; cell.rows.push(r);
    }
    const props = [...byProperty.entries()].sort((a, b) => b[1].total - a[1].total);
    const companies = [...byCompany.entries()].sort((a, b) => b[1] - a[1]);
    return { props, companies, total, periods: [...periodSet].sort().reverse() };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, metric, period, picked]);

  const chip = (on: boolean) => `px-3 py-1.5 rounded-md text-xs transition-colors ${on ? 'bg-white/10 text-white font-medium' : 'text-gray-400 hover:text-gray-200'}`;

  return (
    <div>
      {!embedded && (
        <PageHeader title="Fees &amp; Charges Summary" subtitle="Late fees and any other bill line, across every property" />
      )}

      <div className={embedded ? '' : 'p-6 max-w-5xl mx-auto'}>
        {/* Filters: what, when, where */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <select value={metric} onChange={e => setMetric(e.target.value as Metric)} className="input-dark text-sm" aria-label="Show">
            {METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <div className="inline-flex rounded-lg p-0.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
            {PERIODS.map(p => <button key={p.key} onClick={() => setPeriod(p.key)} className={chip(period === p.key)}>{p.label}</button>)}
            <label className={`${chip(period === 'pick')} flex items-center gap-1 cursor-pointer`}>
              <input type="month" value={picked} onChange={e => { setPicked(e.target.value); setPeriod('pick'); }} className="bg-transparent text-xs outline-none w-[7.5rem]" aria-label="Pick a month" />
            </label>
          </div>
          <select value={propertyId} onChange={e => setPropertyId(e.target.value)} className="input-dark text-sm" aria-label="Property">
            <option value="">All properties</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
          </select>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>
        ) : data.props.length === 0 ? (
          <p className="text-sm text-gray-500 py-8 text-center">No {metricLabel.toLowerCase()} {period === 'all' ? 'on record' : `for ${periodName}`}.</p>
        ) : (
          <>
            {/* The total, where it came from, and who charged it */}
            <div className="rounded-xl p-5 mb-6 grid gap-6 md:grid-cols-[1fr_1fr]" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.07)' }}>
              <div>
                <p className="text-xs text-gray-500">{metricLabel} · {propertyId ? 'this property' : 'all properties'} · {periodName}</p>
                <p className="text-3xl font-semibold text-amber-400 tabular-nums mt-1">{money(data.total)}</p>
                <p className="text-xs text-gray-500 mt-1 mb-4">{data.props.length} propert{data.props.length === 1 ? 'y' : 'ies'} · {data.companies.length} compan{data.companies.length === 1 ? 'y' : 'ies'}</p>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-white/5">
                    {data.props.map(([pid, p]) => (
                      <tr key={pid}>
                        <td className="py-1.5"><a href={`#fees-${pid}`} className="text-gray-300 hover:text-amber-400">{p.label}</a></td>
                        <td className="py-1.5 w-1/3"><div className="h-1.5 rounded-full bg-amber-500/60" style={{ width: `${Math.max(3, (p.total / data.props[0][1].total) * 100)}%` }} /></td>
                        <td className="py-1.5 text-right font-mono text-gray-200 whitespace-nowrap pl-3">{money(p.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-2">Charged most by</p>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-white/5">
                    {data.companies.slice(0, 8).map(([name, v]) => (
                      <tr key={name}><td className="py-1.5 text-gray-300">{name}</td><td className="py-1.5 text-right font-mono text-gray-200">{money(v)}</td></tr>
                    ))}
                  </tbody>
                </table>
                {data.companies.length > 8 && <p className="text-xs text-gray-600 mt-1">and {data.companies.length - 8} more</p>}
              </div>
            </div>

            {/* Each property, by company, folded */}
            <div className="space-y-3">
              {data.props.map(([propId, prop]) => {
                const totals = new Map<string, number>();
                for (const provMap of prop.byProvider.values()) for (const [pk, c] of provMap) totals.set(pk, (totals.get(pk) ?? 0) + c.total);
                const periods = data.periods.filter(pk => totals.has(pk));
                const providers = [...prop.byProvider.entries()].map(([n, m]) => [n, m, [...m.values()].reduce((s, c) => s + c.total, 0)] as const).sort((a, b) => b[2] - a[2]);
                return (
                  <details key={propId} id={`fees-${propId}`} open={!!propertyId} className="rounded-xl overflow-hidden group" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
                    <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none" style={{ background: 'rgba(255,255,255,0.04)' }}>
                      <span className="text-sm font-semibold text-white"><span className="text-gray-600 text-xs mr-2 inline-block group-open:rotate-90 transition-transform">▶</span>{prop.label}</span>
                      <span className="text-sm font-semibold text-amber-400">{money(prop.total)}</span>
                    </summary>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-gray-500 text-xs">
                            <th className="px-4 py-2">Company</th>
                            {periods.length > 1 && periods.map(pk => <th key={pk} className="px-3 py-2 text-right whitespace-nowrap">{periodLabel(pk, groupBy)}</th>)}
                            <th className="px-4 py-2 text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                          {providers.map(([provider, provMap, total]) => (
                            <tr key={provider}>
                              <td className="px-4 py-2 text-gray-300">{provider}</td>
                              {periods.length > 1 && periods.map(pk => {
                                const cell = provMap.get(pk);
                                return (
                                  <td key={pk} className={`px-3 py-2 text-right font-mono text-gray-400 ${cell ? 'cursor-pointer hover:text-amber-400 hover:underline' : ''}`}
                                    onClick={() => cell && setDrillDown({ provider, periodLabel: periodLabel(pk, groupBy), rows: cell.rows })}>
                                    {cell ? money(cell.total) : '—'}
                                  </td>
                                );
                              })}
                              <td className="px-4 py-2 text-right font-mono text-white font-medium cursor-pointer hover:text-amber-400"
                                onClick={() => setDrillDown({ provider, periodLabel: periodName, rows: [...provMap.values()].flatMap(c => c.rows) })}>{money(total)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                );
              })}
            </div>
          </>
        )}
      </div>

      {drillDown && (
        <Modal title={`${drillDown.provider} — ${drillDown.periodLabel}`} onClose={() => setDrillDown(null)}>
          <div className="overflow-x-auto -mx-1">
            <table className="text-sm min-w-[560px]">
              <thead>
                <tr className="text-left text-gray-500 text-xs">
                  <th className="px-2 py-1.5">Billing period</th>
                  <th className="px-2 py-1.5">Statement date</th>
                  <th className="px-2 py-1.5">Due date</th>
                  {BREAKDOWN_FIELDS.map(f => <th key={f.key} className="px-2 py-1.5 text-right whitespace-nowrap">{f.label}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {drillDown.rows.map(r => (
                  <tr key={r.id}>
                    <td className="px-2 py-1.5 text-gray-300 whitespace-nowrap">{r.billingPeriodStart && r.billingPeriodEnd ? `${dateStr(r.billingPeriodStart)} – ${dateStr(r.billingPeriodEnd)}` : '—'}</td>
                    <td className="px-2 py-1.5 text-gray-300 whitespace-nowrap">{dateStr(r.statementDate)}</td>
                    <td className="px-2 py-1.5 text-gray-300 whitespace-nowrap">{dateStr(r.dueDate)}</td>
                    {BREAKDOWN_FIELDS.map(f => (
                      <td key={f.key} className="px-2 py-1.5 text-right font-mono text-gray-400 whitespace-nowrap">
                        {r[f.key] != null ? money(r[f.key] as number) : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {drillDown.rows.some(r => r.notes) && (
            <div className="mt-3 space-y-1">
              {drillDown.rows.filter(r => r.notes).map(r => (
                <p key={r.id} className="text-xs text-gray-500">{dateStr(r.statementDate)}: {r.notes}</p>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
