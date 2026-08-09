import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { getStatementsSummary, getProperties } from '../api/client';
import type { StatementSummaryRow, Property } from '../types';
import { PageHeader } from '../components/ui';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

type Metric = 'penaltiesFees' | 'amountDue' | 'amountPaid' | 'pastDueCarried';
type GroupBy = 'month' | 'year' | 'all';

const METRICS: { key: Metric; label: string }[] = [
  { key: 'penaltiesFees', label: 'Penalties / Fees' },
  { key: 'amountDue', label: 'Amount Due' },
  { key: 'amountPaid', label: 'Amount Paid' },
  { key: 'pastDueCarried', label: 'Past Due Carried' },
];

function periodKey(dateStr: string, groupBy: GroupBy): string {
  const d = new Date(dateStr);
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

export default function FeesSummaryPage({ embedded }: { embedded?: boolean } = {}) {
  const [rows, setRows] = useState<StatementSummaryRow[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [metric, setMetric] = useState<Metric>('penaltiesFees');
  const [groupBy, setGroupBy] = useState<GroupBy>('month');
  const [propertyId, setPropertyId] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProperties().then(setProperties);
  }, []);

  useEffect(() => {
    setLoading(true);
    getStatementsSummary(propertyId ? { propertyId } : undefined)
      .then(setRows)
      .finally(() => setLoading(false));
  }, [propertyId]);

  const grandTotal = useMemo(() => rows.reduce((s, r) => s + (r[metric] ?? 0), 0), [rows, metric]);

  // property -> provider -> period -> total
  const grouped = useMemo(() => {
    const byProperty = new Map<string, { label: string; byProvider: Map<string, Map<string, number>> }>();
    const periodSet = new Set<string>();

    for (const r of rows) {
      const v = r[metric];
      if (v == null || v === 0) continue;
      const pk = periodKey(r.statementDate, groupBy);
      periodSet.add(pk);

      if (!byProperty.has(r.propertyId)) byProperty.set(r.propertyId, { label: r.propertyLabel, byProvider: new Map() });
      const propEntry = byProperty.get(r.propertyId)!;
      if (!propEntry.byProvider.has(r.providerName)) propEntry.byProvider.set(r.providerName, new Map());
      const provMap = propEntry.byProvider.get(r.providerName)!;
      provMap.set(pk, (provMap.get(pk) ?? 0) + v);
    }

    const periods = [...periodSet].sort();
    return { byProperty, periods };
  }, [rows, metric, groupBy]);

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
          <div>
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
          <div className="ml-auto text-right">
            <p className="text-xs text-gray-500">Grand total ({METRICS.find(m => m.key === metric)?.label})</p>
            <p className="text-xl font-semibold text-amber-400">{money(grandTotal)}</p>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>
        ) : grouped.byProperty.size === 0 ? (
          <p className="text-sm text-gray-500 py-8 text-center">No statements with this line item yet.</p>
        ) : (
          <div className="space-y-8">
            {[...grouped.byProperty.entries()].map(([propId, prop]) => {
              const propertyTotalByPeriod = new Map<string, number>();
              let propertyGrandTotal = 0;
              for (const provMap of prop.byProvider.values()) {
                for (const [pk, v] of provMap.entries()) {
                  propertyTotalByPeriod.set(pk, (propertyTotalByPeriod.get(pk) ?? 0) + v);
                  propertyGrandTotal += v;
                }
              }
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
                          {grouped.periods.map(pk => <th key={pk} className="px-3 py-2 text-right whitespace-nowrap">{periodLabel(pk, groupBy)}</th>)}
                          <th className="px-4 py-2 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {[...prop.byProvider.entries()].map(([provider, provMap]) => {
                          const total = [...provMap.values()].reduce((s, v) => s + v, 0);
                          return (
                            <tr key={provider}>
                              <td className="px-4 py-2 text-gray-300">{provider}</td>
                              {grouped.periods.map(pk => (
                                <td key={pk} className="px-3 py-2 text-right font-mono text-gray-400">
                                  {provMap.has(pk) ? money(provMap.get(pk)!) : '—'}
                                </td>
                              ))}
                              <td className="px-4 py-2 text-right font-mono text-white font-medium">{money(total)}</td>
                            </tr>
                          );
                        })}
                        <tr className="bg-white/5">
                          <td className="px-4 py-2 text-gray-200 font-medium">All utilities</td>
                          {grouped.periods.map(pk => (
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
    </div>
  );
}
