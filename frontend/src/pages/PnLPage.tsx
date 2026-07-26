import { useEffect, useState } from 'react';
import { getPortfolioPnL, getMonthlyPnL, getProperties } from '../api/client';
import type { PropertyPnL, MonthlyPnL, Property } from '../types';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = (a: number, b: number) => b === 0 ? '—' : `${Math.round((a / b) * 100)}%`;

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
          {/* Totals */}
          {totals && (
            <div className="grid grid-cols-4 gap-4 mb-6">
              {[
                { label: 'Rental income', value: totals.rentalIncome, color: '#5DCAA5' },
                { label: 'Operating expenses', value: totals.operatingExpenses + totals.insuranceExpense + totals.propertyTaxExpense, color: '#F0997B' },
                { label: 'NOI', value: totals.noi, color: '#F5A623' },
                { label: 'Cash flow', value: totals.cashFlow, color: totals.cashFlow >= 0 ? '#5DCAA5' : '#E24B4A' },
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
                    <td className="px-4 py-3 text-right font-medium text-xs" style={{ color: p.noi >= 0 ? '#F5A623' : '#E24B4A' }}>{money(p.noi)}</td>
                    <td className="px-4 py-3 text-right text-gray-400 text-xs">{money(p.debtService)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-xs" style={{ color: p.cashFlow >= 0 ? '#5DCAA5' : '#E24B4A' }}>{money(p.cashFlow)}</td>
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
                    <td className="px-4 py-3 text-right font-semibold text-xs" style={{ color: totals.cashFlow >= 0 ? '#5DCAA5' : '#E24B4A' }}>{money(totals.cashFlow)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        /* Monthly view */
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
                  <td className="px-4 py-3 text-right font-medium text-xs" style={{ color: m.noi >= 0 ? '#F5A623' : '#E24B4A' }}>{money(m.noi)}</td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">{money(m.debtService)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-xs" style={{ color: m.cashFlow >= 0 ? '#5DCAA5' : '#E24B4A' }}>{money(m.cashFlow)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
