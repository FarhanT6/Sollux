import { useEffect, useState } from 'react';
import { getPortfolioPnL, getMonthlyPnL, getProperties } from '../api/client';
import type { PropertyPnL, MonthlyPnL, Property } from '../types';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = (a: number, b: number) => b === 0 ? '—' : `${Math.round((a / b) * 100)}%`;

// ─── Charts ────────────────────────────────────────────────────────────────────

function MonthlyChart({ data }: { data: MonthlyPnL[] }) {
  if (!data.length) return null;
  const W = 700, H = 180;
  const PAD = { top: 20, right: 20, bottom: 32, left: 64 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  // Compute per-month total expenses for grouped bars
  const rows = data.map(m => ({
    ...m,
    totalExp: m.operatingExpenses + m.insuranceExpense + m.propertyTaxExpense + m.debtService,
  }));

  const maxVal = Math.max(...rows.flatMap(r => [r.rentalIncome, r.totalExp]), 1);
  const cashFlowAbs = Math.max(...rows.map(r => Math.abs(r.cashFlow)), 1);

  const colW = cW / rows.length;
  const barW = colW * 0.28;

  const scaleY = (v: number) => PAD.top + cH - (v / maxVal) * cH;

  // Y-axis tick values
  const ticks = [0, maxVal * 0.25, maxVal * 0.5, maxVal * 0.75, maxVal];

  return (
    <div className="card p-4 mb-5">
      <p className="text-xs text-gray-500 mb-3 flex items-center gap-4">
        <span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 2, background: '#10b981', display: 'inline-block' }} />Income</span>
        <span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 2, background: '#ef4444', display: 'inline-block' }} />Expenses</span>
        <span className="flex items-center gap-1.5"><span style={{ width: 20, height: 2, background: '#f59e0b', display: 'inline-block' }} />Cash flow</span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" style={{ height: H }}>
        {/* Y-axis grid + labels */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={scaleY(t)} y2={scaleY(t)}
              stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
            <text x={PAD.left - 6} y={scaleY(t)} textAnchor="end" dominantBaseline="middle"
              fill="#4b5563" fontSize="9">
              {t === 0 ? '$0' : `${Math.round(t / 1000)}k`}
            </text>
          </g>
        ))}

        {/* Bars */}
        {rows.map((r, i) => {
          const cx = PAD.left + colW * i + colW / 2;
          const incH = (r.rentalIncome / maxVal) * cH;
          const expH = (r.totalExp / maxVal) * cH;
          return (
            <g key={r.month}>
              {/* Income bar */}
              <rect x={cx - barW - 1} y={scaleY(r.rentalIncome)} width={barW} height={incH}
                fill="#10b981" opacity="0.75" rx="1.5" />
              {/* Expense bar */}
              <rect x={cx + 1} y={scaleY(r.totalExp)} width={barW} height={expH}
                fill="#ef4444" opacity="0.65" rx="1.5" />
              {/* Month label */}
              <text x={cx} y={H - 4} textAnchor="middle" fill="#6b7280" fontSize="10">{r.label}</text>
            </g>
          );
        })}

        {/* Cash flow line */}
        {(() => {
          const zeroY = PAD.top + cH;
          const lineY = (v: number) => zeroY - ((v / cashFlowAbs) * cH * 0.35);
          const pts = rows.map((r, i) => {
            const cx = PAD.left + colW * i + colW / 2;
            return `${cx},${lineY(r.cashFlow)}`;
          }).join(' ');
          return (
            <g>
              <polyline points={pts} fill="none" stroke="#f59e0b" strokeWidth="1.8"
                strokeLinejoin="round" strokeLinecap="round" />
              {rows.map((r, i) => {
                const cx = PAD.left + colW * i + colW / 2;
                return (
                  <circle key={i} cx={cx} cy={lineY(r.cashFlow)} r="3"
                    fill={r.cashFlow >= 0 ? '#10b981' : '#ef4444'} />
                );
              })}
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

function PortfolioChart({ data }: { data: PropertyPnL[] }) {
  if (!data.length) return null;
  const maxIncome = Math.max(...data.map(d => d.rentalIncome), 1);

  return (
    <div className="card p-4 mb-5">
      <p className="text-xs font-medium text-gray-400 mb-3">Income vs. cash flow by property</p>
      <div className="space-y-2">
        {[...data].sort((a, b) => b.rentalIncome - a.rentalIncome).slice(0, 15).map(p => (
          <div key={p.propertyId} className="flex items-center gap-3">
            <p className="text-xs text-gray-500 w-32 flex-shrink-0 truncate">{p.propertyName.split(',')[0]}</p>
            <div className="flex-1 relative h-5">
              {/* income bar */}
              <div className="absolute inset-y-0 left-0 rounded flex items-center"
                style={{ width: `${(p.rentalIncome / maxIncome) * 100}%`, background: 'rgba(16,185,129,0.25)' }}>
                <div className="h-full rounded" style={{ width: '100%', background: 'rgba(16,185,129,0.5)' }} />
              </div>
              {/* cash flow marker */}
              {p.rentalIncome > 0 && (
                <div className="absolute top-0 h-full w-0.5 rounded"
                  style={{
                    left: `${Math.min(100, Math.max(0, (p.cashFlow / maxIncome) * 100))}%`,
                    background: p.cashFlow >= 0 ? '#10b981' : '#ef4444',
                  }} />
              )}
            </div>
            <p className="text-xs font-medium w-20 text-right flex-shrink-0"
              style={{ color: p.cashFlow >= 0 ? '#10b981' : '#ef4444' }}>
              {money(p.cashFlow)}
            </p>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-600 mt-3">Bar = income, marker line = cash flow</p>
    </div>
  );
}

const CURRENT_YEAR = new Date().getFullYear();

export default function PnLPage({ embedded }: { embedded?: boolean } = {}) {
  const [year, setYear] = useState(CURRENT_YEAR);
  const [properties, setProperties] = useState<Property[]>([]);
  const [byProp, setByProp] = useState<PropertyPnL[]>([]);
  const [totals, setTotals] = useState<Omit<PropertyPnL, 'propertyId' | 'propertyName'> | null>(null);
  const [monthly, setMonthly] = useState<MonthlyPnL[]>([]);
  const [tab, setTab] = useState<'portfolio' | 'monthly'>('portfolio');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProperties().then(setProperties);
  }, []);

  useEffect(() => {
    setLoading(true);
    const start = new Date(Date.UTC(year, 0, 1)).toISOString();
    const end = new Date(Date.UTC(year + 1, 0, 1)).toISOString();
    Promise.all([
      getPortfolioPnL({ start, end }),
      getMonthlyPnL({ year }),
    ]).then(([portfolio, mon]) => {
      setByProp(portfolio.byProperty);
      setTotals(portfolio.totals);
      setMonthly(mon);
    }).finally(() => setLoading(false));
  }, [year]);

  return (
    <div className={embedded ? '' : 'p-6'}>
      {!embedded && (
        <div className="mb-2">
          <h1 className="text-xl font-semibold text-white">P&L</h1>
          <p className="text-sm text-gray-400 mt-0.5">Net operating income and cash flow</p>
        </div>
      )}
      <div className="flex items-center gap-3 mb-6">
        <select value={year} onChange={e => setYear(Number(e.target.value))} className="input-dark text-sm">
          {[CURRENT_YEAR + 1, CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2].map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
          {(['portfolio', 'monthly'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="text-xs px-3 py-1.5 transition-colors"
              style={{ background: tab === t ? 'rgba(245,166,35,0.15)' : 'transparent', color: tab === t ? '#F5A623' : '#9CA3AF' }}
            >
              {t === 'portfolio' ? 'By property' : 'Monthly'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm">Computing…</div>
      ) : tab === 'portfolio' ? (
        <>
          {/* Portfolio chart */}
          {byProp.length > 0 && <PortfolioChart data={byProp} />}

          {/* Totals */}
          {totals && (
            <div className="grid grid-cols-4 gap-4 mb-6">
              {[
                { label: 'Rental income', value: totals.rentalIncome, color: '#10b981' },
                { label: 'Operating expenses', value: totals.operatingExpenses + totals.insuranceExpense + totals.propertyTaxExpense, color: '#ef4444' },
                { label: 'NOI', value: totals.noi, color: '#F5A623' },
                { label: 'Cash flow', value: totals.cashFlow, color: totals.cashFlow >= 0 ? '#10b981' : '#ef4444' },
              ].map(stat => (
                <div key={stat.label} className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <p className="text-xs text-gray-400 mb-1">{stat.label}</p>
                  <p className="text-xl font-semibold" style={{ color: stat.color }}>{money(stat.value)}</p>
                </div>
              ))}
            </div>
          )}

          {/* By property table */}
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
            <table className="w-full text-sm">
              <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
                <tr className="text-left text-gray-400 text-xs">
                  <th className="px-4 py-3">Property</th>
                  <th className="px-4 py-3 text-right">Income</th>
                  <th className="px-4 py-3 text-right">OpEx</th>
                  <th className="px-4 py-3 text-right">Insurance</th>
                  <th className="px-4 py-3 text-right">Tax</th>
                  <th className="px-4 py-3 text-right">NOI</th>
                  <th className="px-4 py-3 text-right">Debt svc</th>
                  <th className="px-4 py-3 text-right">Cash flow</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {byProp.map(p => (
                  <tr key={p.propertyId} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3 text-white font-medium text-xs">{p.propertyName}</td>
                    <td className="px-4 py-3 text-right text-gray-300 text-xs">{money(p.rentalIncome)}</td>
                    <td className="px-4 py-3 text-right text-gray-400 text-xs">{money(p.operatingExpenses)}</td>
                    <td className="px-4 py-3 text-right text-gray-400 text-xs">{money(p.insuranceExpense)}</td>
                    <td className="px-4 py-3 text-right text-gray-400 text-xs">{money(p.propertyTaxExpense)}</td>
                    <td className="px-4 py-3 text-right font-medium text-xs" style={{ color: p.noi >= 0 ? '#F5A623' : '#ef4444' }}>{money(p.noi)}</td>
                    <td className="px-4 py-3 text-right text-gray-400 text-xs">{money(p.debtService)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-xs" style={{ color: p.cashFlow >= 0 ? '#10b981' : '#ef4444' }}>{money(p.cashFlow)}</td>
                  </tr>
                ))}
                {totals && (
                  <tr style={{ background: 'rgba(245,166,35,0.06)' }}>
                    <td className="px-4 py-3 font-semibold text-white text-xs">Total</td>
                    <td className="px-4 py-3 text-right font-semibold text-white text-xs">{money(totals.rentalIncome)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-white text-xs">{money(totals.operatingExpenses)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-white text-xs">{money(totals.insuranceExpense)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-white text-xs">{money(totals.propertyTaxExpense)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-xs" style={{ color: '#F5A623' }}>{money(totals.noi)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-white text-xs">{money(totals.debtService)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-xs" style={{ color: totals.cashFlow >= 0 ? '#10b981' : '#ef4444' }}>{money(totals.cashFlow)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        /* Monthly view */
        <>
        <MonthlyChart data={monthly} />
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
              <tr className="text-left text-gray-400 text-xs">
                <th className="px-4 py-3">Month</th>
                <th className="px-4 py-3 text-right">Income</th>
                <th className="px-4 py-3 text-right">OpEx</th>
                <th className="px-4 py-3 text-right">NOI</th>
                <th className="px-4 py-3 text-right">Debt svc</th>
                <th className="px-4 py-3 text-right">Cash flow</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {monthly.map(m => (
                <tr key={m.month} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3 text-white text-xs">{m.label} {year}</td>
                  <td className="px-4 py-3 text-right text-gray-300 text-xs">{money(m.rentalIncome)}</td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">{money(m.operatingExpenses + m.insuranceExpense + m.propertyTaxExpense)}</td>
                  <td className="px-4 py-3 text-right font-medium text-xs" style={{ color: m.noi >= 0 ? '#F5A623' : '#ef4444' }}>{money(m.noi)}</td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">{money(m.debtService)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-xs" style={{ color: m.cashFlow >= 0 ? '#10b981' : '#ef4444' }}>{money(m.cashFlow)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}
