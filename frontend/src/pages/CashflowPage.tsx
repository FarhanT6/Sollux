import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getCashflow, getProperties, type CashflowReport, type CashflowMonth } from '../api/client';
import type { Property } from '../types';
import { PageHeader } from '../components/ui';

/**
 * The two spreadsheet tabs, rebuilt on what the app already records: rent
 * received against the loans, and rent received against the loans and the
 * utilities. Every cell is one property in one month, red when the money
 * out exceeded the money in, and opens to show the payments and bills
 * behind it.
 */

type View = 'loans' | 'all';

const money = (n: number, signed = false) => {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (n < 0) return `-$${abs}`;
  return `${signed && n > 0 ? '+' : ''}$${abs}`;
};
const monthLabel = (ym: string) => new Date(`${ym}-15T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
const monthLong = (ym: string) => new Date(`${ym}-15T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const netColor = (n: number) => (n > 0.5 ? 'text-emerald-400' : n < -0.5 ? 'text-red-400' : 'text-gray-500');

export default function CashflowPage({ embedded }: { embedded?: boolean } = {}) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [propertyId, setPropertyId] = useState('');
  const [view, setView] = useState<View>('loans');
  const [properties, setProperties] = useState<Property[]>([]);
  const [report, setReport] = useState<CashflowReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<{ propertyId: string; month: string } | null>(null);

  useEffect(() => { getProperties().then(setProperties).catch(() => {}); }, []);
  useEffect(() => {
    setLoading(true); setOpen(null);
    getCashflow({ year, propertyId: propertyId || undefined }).then(setReport).finally(() => setLoading(false));
  }, [year, propertyId]);

  const net = (m: { netAfterLoans: number; netAfterAll: number }) => (view === 'loans' ? m.netAfterLoans : m.netAfterAll);
  const rows = useMemo(() => (report?.byProperty ?? []).filter(p => p.totals.rent !== 0 || p.totals.loans !== 0 || p.totals.utilities !== 0), [report]);
  const years = useMemo(() => { const y = now.getFullYear(); return [y, y - 1, y - 2, y - 3]; }, [now]);

  const opened = open && report ? report.byProperty.find(p => p.propertyId === open.propertyId)?.months.find(m => m.month === open.month) : null;
  const openedName = open && report ? report.byProperty.find(p => p.propertyId === open.propertyId)?.propertyName : '';

  return (
    <div>
      {!embedded && <PageHeader title="Cash Flow" subtitle="Rent received against the loans, and against the loans and utilities" />}
      <div className={embedded ? '' : 'p-6 max-w-6xl mx-auto'}>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
            {([['loans', 'Rent vs loans'], ['all', 'Rent vs loans + utilities']] as [View, string][]).map(([k, label]) => (
              <button key={k} onClick={() => setView(k)} className={`px-3 py-1.5 text-xs ${view === k ? 'bg-amber-500/20 text-amber-300' : 'text-gray-400 hover:text-gray-200'}`}>{label}</button>
            ))}
          </div>
          <select value={year} onChange={e => setYear(+e.target.value)} className="input-dark text-sm">
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <select value={propertyId} onChange={e => setPropertyId(e.target.value)} className="input-dark text-sm">
            <option value="">All properties</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
          </select>
          <p className="text-xs text-gray-500 ml-auto">
            Rent is what was logged as received. A loan month with nothing logged uses the scheduled payment, marked <span className="text-gray-400">~</span>.
          </p>
        </div>

        {report && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <Stat label="Rent received" value={money(report.totals.rent)} sub={`of ${money(report.totals.rentExpected)} on the roll`} color="text-emerald-400" />
            <Stat label="Loan payments" value={money(report.totals.loans)} color="text-red-400" />
            {view === 'all' && <Stat label="Utility bills" value={money(report.totals.utilities)} color="text-red-400" />}
            <Stat
              label={view === 'loans' ? 'Net after loans' : 'Net after loans + utilities'}
              value={money(view === 'loans' ? report.totals.netAfterLoans : report.totals.netAfterAll, true)}
              color={netColor(view === 'loans' ? report.totals.netAfterLoans : report.totals.netAfterAll)}
              sub={`${report.months.length} month${report.months.length === 1 ? '' : 's'} · ${year}`}
            />
          </div>
        )}

        {loading ? (
          <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>
        ) : !report || rows.length === 0 ? (
          <p className="text-sm text-gray-500 py-8 text-center">Nothing recorded for {year}. Log rent, loan payments and bills and they show up here.</p>
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500">
                    <th className="px-3 py-2 text-left sticky left-0" style={{ background: '#151515' }}>Property</th>
                    {report.months.map(m => <th key={m} className="px-2 py-2 text-right whitespace-nowrap">{monthLabel(m)}</th>)}
                    <th className="px-3 py-2 text-right whitespace-nowrap">YTD</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {rows.map(p => (
                    <Fragment key={p.propertyId}>
                      <tr className="hover:bg-white/[0.02]">
                        <td className="px-3 py-2 sticky left-0 whitespace-nowrap" style={{ background: '#151515' }}>
                          <Link to={`/portfolio/${p.propertyId}`} className="text-white hover:text-amber-400">{p.propertyName}</Link>
                        </td>
                        {p.months.map(m => {
                          const v = net(m);
                          const isOpen = open?.propertyId === p.propertyId && open.month === m.month;
                          return (
                            <td key={m.month} className="px-1 py-1 text-right">
                              <button
                                onClick={() => setOpen(isOpen ? null : { propertyId: p.propertyId, month: m.month })}
                                className={`w-full text-right px-1.5 py-1 rounded font-mono ${netColor(v)} ${isOpen ? 'bg-white/10' : 'hover:bg-white/5'}`}
                                title={`Rent ${money(m.rent)} · Loans ${money(m.loans)}${view === 'all' ? ` · Utilities ${money(m.utilities)}` : ''}`}
                              >
                                {money(v, true)}{m.loansScheduled && m.loans > 0 ? <span className="text-gray-600">~</span> : ''}
                              </button>
                            </td>
                          );
                        })}
                        <td className={`px-3 py-2 text-right font-mono font-semibold ${netColor(net(p.totals))}`}>{money(net(p.totals), true)}</td>
                      </tr>
                      {open?.propertyId === p.propertyId && opened && (
                        <tr>
                          <td colSpan={report.months.length + 2} className="px-3 py-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
                            <MonthDetail name={openedName ?? ''} m={opened} view={view} onClose={() => setOpen(null)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-white/5">
                    <td className="px-3 py-2 sticky left-0 text-gray-200 font-medium" style={{ background: '#1c1c1c' }}>All properties</td>
                    {report.totals.byMonth.map(m => (
                      <td key={m.month} className={`px-2 py-2 text-right font-mono font-medium ${netColor(net(m))}`}>{money(net(m), true)}</td>
                    ))}
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${netColor(net(report.totals))}`}>{money(net(report.totals), true)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-xl font-semibold ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

function MonthDetail({ name, m, view, onClose }: { name: string; m: CashflowMonth; view: View; onClose: () => void }) {
  const col = 'min-w-[220px] flex-1';
  const line = (label: string, amount: number, note?: string | null, muted = false) => (
    <div className={`flex items-baseline justify-between gap-3 py-0.5 ${muted ? 'text-gray-500' : 'text-gray-300'}`}>
      <span className="truncate">{label}{note ? <span className="text-gray-600"> · {note}</span> : null}</span>
      <span className="font-mono whitespace-nowrap">{money(amount)}</span>
    </div>
  );
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-white font-medium">{name} · {monthLong(m.month)}</p>
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
      </div>
      <div className="flex flex-wrap gap-6">
        <div className={col}>
          <p className="section-label mb-1">Rent received <span className="text-emerald-400 font-mono">{money(m.rent)}</span> <span className="text-gray-600">of {money(m.rentExpected)}</span></p>
          {m.detail.rent.length === 0 ? <p className="text-gray-600">Nothing logged</p> : m.detail.rent.map((r, i) => <Fragment key={i}>{line(`${r.unit ? `${r.unit} · ` : ''}${r.tenant}`, r.amount, `paid ${r.paidDate}`)}</Fragment>)}
        </div>
        <div className={col}>
          <p className="section-label mb-1">Loans <span className="text-red-400 font-mono">{money(m.loans)}</span></p>
          {m.detail.loans.length === 0 ? <p className="text-gray-600">No loans</p> : m.detail.loans.map((l, i) => <Fragment key={i}>{line(l.lender, l.amount, l.scheduled ? 'scheduled, not logged' : l.date, l.scheduled)}</Fragment>)}
        </div>
        {view === 'all' && (
          <div className={col}>
            <p className="section-label mb-1">Utilities <span className="text-red-400 font-mono">{money(m.utilities)}</span></p>
            {m.detail.utilities.length === 0 ? <p className="text-gray-600">No bills for this month</p> : m.detail.utilities.map((u, i) => <Fragment key={i}>{line(u.provider, u.amount, u.period)}</Fragment>)}
          </div>
        )}
        <div className="min-w-[160px]">
          <p className="section-label mb-1">Net</p>
          <p className={`text-lg font-semibold font-mono ${netColor(view === 'loans' ? m.netAfterLoans : m.netAfterAll)}`}>{money(view === 'loans' ? m.netAfterLoans : m.netAfterAll, true)}</p>
          <p className="text-gray-600">{view === 'loans' ? 'rent − loans' : 'rent − loans − utilities'}</p>
        </div>
      </div>
    </div>
  );
}
