import { useCallback, useEffect, useMemo, useState } from 'react';
import { getFinanceOverview, type FinanceOverview, type OverviewMonth, type CostType } from '../api/client';
import { fmtMoney } from '../lib/money';
import { todayISO } from '../lib/date';
import { describeApiError } from '../lib/apiError';

/**
 * Finances → Overview: what replaced the P&L, cash flow and budget pages.
 * One table, a column per month: rent, the operating costs by type, NOI,
 * the loans, cash flow — each actual with what was expected under it. The
 * expectation is automatic (backend lib/financeOverview.ts): the rent roll,
 * each bill's usual amount, the loan and policy schedules, tax as billed.
 * Costs count in the month due, or — switched — in the month paid. Months
 * still to come show the expectation alone: that is the budget ahead.
 */

const OPERATING: { key: CostType; label: string }[] = [
  { key: 'UTILITIES', label: 'Utilities' }, { key: 'INSURANCE', label: 'Insurance' }, { key: 'PROPERTY_TAX', label: 'Property tax' },
  { key: 'HOA', label: 'HOA' }, { key: 'MAINTENANCE', label: 'Maintenance & repairs' }, { key: 'MANAGEMENT', label: 'Management' }, { key: 'OTHER', label: 'Other' },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Basis = 'charged' | 'paid';
interface Fig { actual: number; expected: number }
interface Row { key: string; label: string; kind: 'income' | 'cost' | 'total'; strong?: boolean; per: (m: OverviewMonth) => Fig }

const k0 = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;

function rows(basis: Basis, present: Set<CostType>): Row[] {
  const cost = (m: OverviewMonth, t: CostType): Fig => ({ actual: m.types[t]?.[basis] ?? 0, expected: m.types[t]?.expected ?? 0 });
  const operating = (m: OverviewMonth): Fig => OPERATING.reduce((s, t) => { const c = cost(m, t.key); return { actual: s.actual + c.actual, expected: s.expected + c.expected }; }, { actual: 0, expected: 0 });
  const rent = (m: OverviewMonth): Fig => ({ actual: m.rent.received, expected: m.rent.expected });
  const noi = (m: OverviewMonth): Fig => { const r = rent(m), o = operating(m); return { actual: r.actual - o.actual, expected: r.expected - o.expected }; };
  const debt = (m: OverviewMonth) => cost(m, 'DEBT_SERVICE');
  const out: Row[] = [
    { key: 'rent', label: 'Rent', kind: 'income', strong: true, per: rent },
    ...OPERATING.filter(t => present.has(t.key)).map(t => ({ key: t.key, label: t.label, kind: 'cost' as const, per: (m: OverviewMonth) => cost(m, t.key) })),
    { key: 'operating', label: 'Operating costs', kind: 'cost', strong: true, per: operating },
    { key: 'noi', label: 'NOI', kind: 'total', strong: true, per: noi },
    { key: 'debt', label: 'Loans', kind: 'cost', per: debt },
    { key: 'cash', label: 'Cash flow', kind: 'total', strong: true, per: m => { const a = noi(m), d = debt(m); return { actual: a.actual - d.actual, expected: a.expected - d.expected }; } },
  ];
  if (present.has('CAPITAL')) out.push({ key: 'capital', label: 'Capital improvements', kind: 'cost', per: m => cost(m, 'CAPITAL') });
  return out;
}

/** Green when it went the good way by more than 5%, red the bad way; otherwise plain. */
function tone(row: Row, f: Fig): string {
  if (!f.expected && !f.actual) return 'text-gray-600';
  const better = row.kind === 'cost' ? f.actual < f.expected : f.actual > f.expected;
  const off = Math.abs(f.actual - f.expected) > Math.max(25, Math.abs(f.expected) * 0.05);
  if (!off) return 'text-gray-100';
  return better ? 'text-emerald-400' : 'text-red-400';
}

export default function FinanceOverviewPage() {
  const thisYear = Number(todayISO().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [pid, setPid] = useState('all');
  const [basis, setBasis] = useState<Basis>('charged');
  const [data, setData] = useState<FinanceOverview | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setData(await getFinanceOverview(year)); setError(''); }
    catch (e) { setError(describeApiError(e, 'Could not load the overview.')); }
  }, [year]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const thisMonth = todayISO().slice(0, 7);
  const shown = useMemo(() => (data?.properties ?? []).filter(p => pid === 'all' || p.id === pid), [data, pid]);

  // The months of the chosen properties added together.
  const sum = (props: typeof shown): Record<string, OverviewMonth> => {
    const out: Record<string, OverviewMonth> = {};
    for (const m of data?.months ?? []) {
      const f: OverviewMonth = { rent: { expected: 0, received: 0 }, types: {} };
      for (const p of props) {
        const pm = p.months[m]; if (!pm) continue;
        f.rent.expected += pm.rent.expected; f.rent.received += pm.rent.received;
        for (const [t, c] of Object.entries(pm.types) as [CostType, { expected: number; charged: number; paid: number }][]) {
          const x = (f.types[t] ??= { expected: 0, charged: 0, paid: 0 });
          x.expected += c.expected; x.charged += c.charged; x.paid += c.paid;
        }
      }
      out[m] = f;
    }
    return out;
  };
  const totals = useMemo(() => sum(shown), [shown, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const present = useMemo(() => {
    const s = new Set<CostType>();
    for (const f of Object.values(totals)) for (const [t, c] of Object.entries(f.types)) if (c && (c.expected || c.charged || c.paid)) s.add(t as CostType);
    return s;
  }, [totals]);
  const table = rows(basis, present);

  // Months that have happened (the whole year for a past one): actuals count only there.
  const past = (m: string) => m <= thisMonth;
  const ytd = (row: Row, months: Record<string, OverviewMonth>): Fig =>
    Object.entries(months).filter(([m]) => past(m)).reduce((s, [, f]) => { const v = row.per(f); return { actual: s.actual + v.actual, expected: s.expected + v.expected }; }, { actual: 0, expected: 0 });
  const yearExpected = (row: Row, months: Record<string, OverviewMonth>) => Object.values(months).reduce((s, f) => s + row.per(f).expected, 0);
  const ytdLabel = year < thisYear ? `${year}` : year > thisYear ? '—' : 'Year to date';

  const byKey = Object.fromEntries(table.map(r => [r.key, r]));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="inline-flex items-center rounded-lg" style={{ background: 'rgba(255,255,255,0.05)' }}>
          <button className="px-2.5 py-1.5 text-gray-400 hover:text-white" onClick={() => setYear(y => y - 1)} aria-label="Previous year">‹</button>
          <span className="text-sm font-semibold tabular-nums px-1">{year}</span>
          <button className="px-2.5 py-1.5 text-gray-400 hover:text-white" onClick={() => setYear(y => y + 1)} aria-label="Next year">›</button>
        </div>
        <select className="input-dark text-sm" value={pid} onChange={e => setPid(e.target.value)}>
          <option value="all">All properties</option>
          {(data?.properties ?? []).filter(p => !p.sold).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="inline-flex rounded-lg p-0.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
          {(['charged', 'paid'] as const).map(b => (
            <button key={b} onClick={() => setBasis(b)}
              className={`text-xs px-3 py-1.5 rounded-md ${basis === b ? 'bg-white/10 text-white font-medium' : 'text-gray-400 hover:text-gray-200'}`}>
              {b === 'charged' ? 'Costs by month due' : 'Costs by month paid'}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-500 ml-auto">Each figure: actual, with expected under it</span>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
      {!data && !error && <p className="text-sm text-gray-500">Loading…</p>}

      {data && year <= thisYear && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
          {(['rent', 'operating', 'noi', 'debt', 'cash'] as const).map(k => {
            const r = byKey[k]; const f = ytd(r, totals);
            return (
              <div key={k} className="rounded-xl px-4 py-3" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-xs text-gray-500">{r.label} · {ytdLabel}</p>
                <p className={`text-xl font-semibold tabular-nums mt-0.5 ${tone(r, f)}`}>{fmtMoney(f.actual)}</p>
                <p className="text-[11px] text-gray-500 tabular-nums">expected {fmtMoney(f.expected)}</p>
              </div>
            );
          })}
        </div>
      )}

      {data && (
        <section className="rounded-xl overflow-hidden mb-6" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="overflow-x-auto">
            <table className="text-xs w-full table-fixed whitespace-nowrap" style={{ minWidth: 1240 }}>
              <colgroup><col style={{ width: 170 }} />{data.months.map(m => <col key={m} />)}<col style={{ width: 96 }} /><col style={{ width: 96 }} /></colgroup>
              <thead>
                <tr className="text-gray-500">
                  <th className="text-left font-medium px-3 py-2 sticky left-0 z-10" style={{ background: '#1e1e1e' }}>{pid === 'all' ? 'All properties' : shown[0]?.name}</th>
                  {data.months.map((m, i) => <th key={m} className="text-right font-medium px-2 py-2" style={m === thisMonth ? { color: '#F5A623' } : undefined}>{MONTHS[i]}</th>)}
                  <th className="text-right font-medium px-2 py-2">{ytdLabel}</th>
                  <th className="text-right font-medium px-3 py-2">Year budget</th>
                </tr>
              </thead>
              <tbody>
                {table.map(r => {
                  const y = ytd(r, totals);
                  return (
                    <tr key={r.key} className={`border-t ${r.strong ? 'border-white/10' : 'border-white/5'}`}>
                      <td className={`px-3 py-2 sticky left-0 z-10 ${r.strong ? 'text-white font-semibold' : 'text-gray-300 pl-6'}`} style={{ background: '#1e1e1e' }}>{r.label}</td>
                      {data.months.map(m => {
                        const f = r.per(totals[m]);
                        return (
                          <td key={m} className="px-2 py-1.5 text-right tabular-nums align-top">
                            {past(m)
                              ? <><div className={`${tone(r, f)} ${r.strong ? 'font-semibold' : ''}`}>{f.actual || f.expected ? k0(f.actual) : '·'}</div><div className="text-[10px] text-gray-600">{f.expected ? k0(f.expected) : ''}</div></>
                              : <div className="text-gray-500 italic">{f.expected ? k0(f.expected) : '·'}</div>}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1.5 text-right tabular-nums align-top">
                        <div className={`${tone(r, y)} font-semibold`}>{k0(y.actual)}</div>
                        <div className="text-[10px] text-gray-600">{k0(y.expected)}</div>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums align-top text-gray-400">{k0(yearExpected(r, totals))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2 text-[11px] text-gray-500 border-t border-white/5">
            Expected is automatic: the rent roll, each bill's same month last year (or its recent average), loan and policy schedules, tax as billed, logged costs at last year's monthly average. Months ahead show the expectation alone.
          </p>
        </section>
      )}

      {data && pid === 'all' && shown.length > 1 && (
        <section className="rounded-xl overflow-hidden" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="px-4 py-3 border-b border-white/5 font-semibold text-white">By property · {ytdLabel}</div>
          <div className="overflow-x-auto">
            <table className="text-xs w-full whitespace-nowrap" style={{ minWidth: 760 }}>
              <thead>
                <tr className="text-gray-500">
                  <th className="text-left font-medium px-3 py-2">Property</th>
                  {(['rent', 'operating', 'noi', 'debt', 'cash'] as const).map(k => <th key={k} className="text-right font-medium px-3 py-2">{byKey[k].label}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.filter(p => !p.sold).map(p => {
                  const months = sum([p]);
                  return (
                    <tr key={p.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                      <td className="px-3 py-2"><button onClick={() => setPid(p.id)} className="text-gray-100 hover:text-amber-400 font-medium text-left">{p.name}</button></td>
                      {(['rent', 'operating', 'noi', 'debt', 'cash'] as const).map(k => {
                        const f = ytd(byKey[k], months);
                        return (
                          <td key={k} className="px-3 py-1.5 text-right tabular-nums">
                            <div className={tone(byKey[k], f)}>{k0(f.actual)}</div>
                            <div className="text-[10px] text-gray-600">{k0(f.expected)}</div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
