import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { getStatementsSummary, getProperties } from '../api/client';
import type { StatementSummaryRow, Property } from '../types';
import { PageHeader, Modal } from '../components/ui';
import { fmtDate } from '../lib/date';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const dateStr = (d: string | null) => d ? fmtDate(d, 'MMM d, yyyy') : '—';

type Metric = 'penaltiesFees' | 'amountDue' | 'chargesExcludingFees' | 'amountPaid' | 'pastDueCarried' | 'totalDueWithPastDue';
type GroupBy = 'month' | 'year' | 'all';

const METRICS: { key: Metric; label: string }[] = [
  { key: 'amountDue', label: 'Total Due' },
  { key: 'chargesExcludingFees', label: 'Due w/o Penalties & Fees' },
  { key: 'penaltiesFees', label: 'Penalties / Fees' },
  { key: 'pastDueCarried', label: 'Past Due' },
  { key: 'amountPaid', label: 'Paid' },
  { key: 'totalDueWithPastDue', label: 'Total Due w/ Past Due' },
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
function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

interface PeriodCell { total: number; rows: StatementSummaryRow[] }
interface DrillDown { provider: string; periodLabel: string; rows: StatementSummaryRow[] }

export default function FeesSummaryPage({ embedded }: { embedded?: boolean } = {}) {
  const [rows, setRows] = useState<StatementSummaryRow[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [metric, setMetric] = useState<Metric>('penaltiesFees');
  const [groupBy, setGroupBy] = useState<GroupBy>('month');
  const [monthFilter, setMonthFilter] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [drillDown, setDrillDown] = useState<DrillDown | null>(null);

  const effectiveGroupBy: GroupBy = monthFilter ? 'month' : groupBy;

  useEffect(() => {
    getProperties().then(setProperties);
  }, []);

  useEffect(() => {
    setLoading(true);
    getStatementsSummary(propertyId ? { propertyId } : undefined)
      .then(setRows)
      .finally(() => setLoading(false));
  }, [propertyId]);

  const grandTotal = useMemo(() => {
    const relevant = monthFilter
      ? rows.filter(r => periodKey(billingMonthOf(r), 'month') === monthFilter)
      : rows;
    return relevant.reduce((s, r) => s + (r[metric] ?? 0), 0);
  }, [rows, metric, monthFilter]);

  // property -> provider -> period -> { total, rows }
  const grouped = useMemo(() => {
    const byProperty = new Map<string, { label: string; byProvider: Map<string, Map<string, PeriodCell>> }>();
    const periodSet = new Set<string>();

    for (const r of rows) {
      const v = r[metric];
      if (v == null || v === 0) continue;
      const pk = periodKey(billingMonthOf(r), effectiveGroupBy);
      if (monthFilter && pk !== monthFilter) continue;
      periodSet.add(pk);

      if (!byProperty.has(r.propertyId)) byProperty.set(r.propertyId, { label: r.propertyLabel, byProvider: new Map() });
      const propEntry = byProperty.get(r.propertyId)!;
      if (!propEntry.byProvider.has(r.providerName)) propEntry.byProvider.set(r.providerName, new Map());
      const provMap = propEntry.byProvider.get(r.providerName)!;
      if (!provMap.has(pk)) provMap.set(pk, { total: 0, rows: [] });
      const cell = provMap.get(pk)!;
      cell.total += v;
      cell.rows.push(r);
    }

    // Newest first, and one property's columns are its own: a fee some other
    // property paid in 2019 is no reason to show this one a 2019 column.
    const periods = monthFilter ? [monthFilter] : [...periodSet].sort().reverse();
    return { byProperty, periods };
  }, [rows, metric, effectiveGroupBy, monthFilter]);

  return (
    <div>
      {!embedded && (
        <PageHeader title="Fees &amp; Charges Summary" subtitle="Any line item, broken down by utility and rolled up by property — month, year, or overall" />
      )}

      <div className={embedded ? '' : 'p-6 max-w-5xl mx-auto'}>
        <div className="flex flex-wrap items-end gap-3 mb-6">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Line item</label>
            <select value={metric} onChange={e => setMetric(e.target.value as Metric)} className="field-input text-sm">
              {METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>
          <div className={monthFilter ? 'opacity-50 pointer-events-none' : ''}>
            <label className="text-xs text-gray-500 block mb-1">Group by</label>
            <select value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)} className="field-input text-sm">
              <option value="month">Month</option>
              <option value="year">Year</option>
              <option value="all">All time</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Property</label>
            <select value={propertyId} onChange={e => setPropertyId(e.target.value)} className="field-input text-sm">
              <option value="">All properties</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Month filter</label>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setMonthFilter(m => m === currentMonthKey() ? '' : currentMonthKey())}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium"
                style={monthFilter === currentMonthKey()
                  ? { background: '#F5A623', color: '#1a1a1a' }
                  : { background: 'rgba(255,255,255,0.06)', color: '#d1d5db', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                This month
              </button>
              <input
                type="month"
                value={monthFilter}
                onChange={e => setMonthFilter(e.target.value)}
                className="field-input text-sm"
              />
              {monthFilter && (
                <button
                  type="button"
                  onClick={() => setMonthFilter('')}
                  className="text-gray-500 hover:text-gray-300 text-sm px-1"
                  title="Clear month filter"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
          <div className="ml-auto text-right">
            <p className="text-xs text-gray-500">Grand total ({METRICS.find(m => m.key === metric)?.label}){monthFilter ? ` — ${periodLabel(monthFilter, 'month')}` : ''}</p>
            <p className="text-xl font-semibold text-amber-400">{money(grandTotal)}</p>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>
        ) : grouped.byProperty.size === 0 ? (
          <p className="text-sm text-gray-500 py-8 text-center">
            {monthFilter ? `No statements with this line item in ${periodLabel(monthFilter, 'month')}.` : 'No statements with this line item yet.'}
          </p>
        ) : (
          <div className="space-y-8">
            {[...grouped.byProperty.entries()].map(([propId, prop]) => {
              const propertyTotalByPeriod = new Map<string, number>();
              let propertyGrandTotal = 0;
              for (const provMap of prop.byProvider.values()) {
                for (const [pk, cell] of provMap.entries()) {
                  propertyTotalByPeriod.set(pk, (propertyTotalByPeriod.get(pk) ?? 0) + cell.total);
                  propertyGrandTotal += cell.total;
                }
              }
              const periods = grouped.periods.filter(pk => propertyTotalByPeriod.has(pk));
              return (
                <div key={propId} className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
                  <div className="flex items-center justify-between px-4 py-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <p className="text-sm font-semibold text-white">{prop.label}</p>
                    <p className="text-sm font-semibold text-amber-400">{money(propertyGrandTotal)}</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500 text-xs">
                          <th className="px-4 py-2">Provider</th>
                          {periods.map(pk => <th key={pk} className="px-3 py-2 text-right whitespace-nowrap">{periodLabel(pk, effectiveGroupBy)}</th>)}
                          <th className="px-4 py-2 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {[...prop.byProvider.entries()].map(([provider, provMap]) => {
                          const total = [...provMap.values()].reduce((s, c) => s + c.total, 0);
                          return (
                            <tr key={provider}>
                              <td className="px-4 py-2 text-gray-300">{provider}</td>
                              {periods.map(pk => {
                                const cell = provMap.get(pk);
                                return (
                                  <td
                                    key={pk}
                                    className={`px-3 py-2 text-right font-mono text-gray-400 ${cell ? 'cursor-pointer hover:text-amber-400 hover:underline' : ''}`}
                                    onClick={() => cell && setDrillDown({ provider, periodLabel: periodLabel(pk, effectiveGroupBy), rows: cell.rows })}
                                  >
                                    {cell ? money(cell.total) : '—'}
                                  </td>
                                );
                              })}
                              <td className="px-4 py-2 text-right font-mono text-white font-medium">{money(total)}</td>
                            </tr>
                          );
                        })}
                        <tr className="bg-white/5">
                          <td className="px-4 py-2 text-gray-200 font-medium">All utilities</td>
                          {periods.map(pk => (
                            <td key={pk} className="px-3 py-2 text-right font-mono text-gray-300 font-medium">
                              {propertyTotalByPeriod.has(pk) ? money(propertyTotalByPeriod.get(pk)!) : '—'}
                            </td>
                          ))}
                          <td className="px-4 py-2 text-right font-mono text-amber-400 font-semibold">{money(propertyGrandTotal)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
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
