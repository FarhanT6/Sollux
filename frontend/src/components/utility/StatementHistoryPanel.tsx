import { useEffect, useState } from 'react';
import { format, isAfter } from 'date-fns';
import { getStatements } from '../../api/client';
import type { Statement } from '../../types';
import { Skeleton, Pill } from '../ui';

interface Props {
  utilityAccountId: string;
}

function fmtMoney(v?: number | null) {
  return v != null ? `$${Number(v).toFixed(2)}` : '—';
}

function statusPill(s: Statement): { color: 'green' | 'amber' | 'red'; label: string } {
  if ((s.amountPaid ?? 0) > 0) return { color: 'green', label: 'Paid' };
  // isPaid flag set by scraper when no "Pay" button is found (i.e. invoice is settled)
  if ((s.rawDataJson as any)?.isPaid === true) return { color: 'green', label: 'Paid' };
  if (s.dueDate && isAfter(new Date(), new Date(s.dueDate))) return { color: 'red', label: 'Overdue' };
  return { color: 'amber', label: 'Due' };
}

export default function StatementHistoryPanel({ utilityAccountId }: Props) {
  const [rows, setRows] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getStatements({ utilityAccountId })
      .then(data => setRows([...data].sort((a, b) => b.statementDate.localeCompare(a.statementDate))))
      .finally(() => setLoading(false));
  }, [utilityAccountId]);

  // ── Mini stats ──────────────────────────────────────────
  const latest = rows[0];
  const prev = rows[1];
  const latestAmt = latest?.amountDue ?? null;
  const prevAmt = prev?.amountDue ?? null;

  let momLabel = '—';
  let momColor: 'green' | 'red' | undefined;
  if (latestAmt != null && prevAmt != null && prevAmt !== 0) {
    const pct = ((latestAmt - prevAmt) / prevAmt) * 100;
    const arrow = pct < 0 ? '↓' : '↑';
    momLabel = `${arrow} ${Math.abs(pct).toFixed(1)}%  (${fmtMoney(latestAmt - prevAmt)})`;
    momColor = pct < 0 ? 'green' : 'red';
  }

  const currentYear = new Date().getFullYear();
  const ytd = rows
    .filter(r => new Date(r.statementDate).getFullYear() === currentYear)
    .reduce((sum, r) => sum + (r.amountDue ?? 0), 0);

  return (
    <div className="mt-2 rounded-xl p-4" style={{ background: '#242424', border: '1px solid rgba(255,255,255,0.06)' }}>

      {/* Mini stat row */}
      {/* Show past due warning if latest statement has a past due balance */}
      {(() => {
        const latestPastDue = latest?.rawDataJson?.pastDue as number | undefined;
        return latestPastDue && latestPastDue > 0 ? (
          <div className="mb-3 px-3 py-2 rounded-lg flex items-center gap-2 text-xs"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
            <span className="text-red-400 font-medium">⚠ Past due balance:</span>
            <span className="text-red-300 font-semibold">{fmtMoney(latestPastDue)}</span>
            <span className="text-gray-500">included in total balance</span>
          </div>
        ) : null;
      })()}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {[
          { label: 'Latest bill', value: fmtMoney(latestAmt) },
          { label: 'MoM change', value: momLabel, color: momColor },
          { label: `YTD ${currentYear}`, value: fmtMoney(ytd || null) },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-lg px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <p className="text-xs text-gray-500 mb-0.5">{label}</p>
            <p className={`text-sm font-semibold ${color === 'green' ? 'text-emerald-400' : color === 'red' ? 'text-red-400' : 'text-white'}`}>
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-500 py-4 text-center">
          No statement history yet — sync this account to pull data.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {['Statement', 'Billing period', 'Amount due', 'Past due', 'Balance', 'Status'].map(h => (
                  <th key={h} className="text-left text-gray-500 font-medium pb-2 pr-4 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s, idx) => {
                const pastDue = s.rawDataJson?.pastDue as number | undefined;
                const { color, label } = statusPill(s);
                const isFirst = idx === 0;
                return (
                  <tr
                    key={s.id}
                    className="transition-colors"
                    style={{
                      borderLeft: isFirst ? '3px solid #F5A623' : '3px solid transparent',
                      background: 'transparent',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="py-2 pr-4 text-gray-300 whitespace-nowrap pl-2">
                      {format(new Date(s.statementDate), 'MMM yyyy')}
                    </td>
                    <td className="py-2 pr-4 text-gray-400 whitespace-nowrap">
                      {s.billingPeriodStart && s.billingPeriodEnd
                        ? `${format(new Date(s.billingPeriodStart), 'MMM d')} – ${format(new Date(s.billingPeriodEnd), 'MMM d')}`
                        : '—'}
                    </td>
                    <td className="py-2 pr-4 font-semibold text-white whitespace-nowrap">
                      {fmtMoney(s.amountDue)}
                    </td>
                    <td className={`py-2 pr-4 whitespace-nowrap ${pastDue && pastDue > 0 ? 'text-red-400 font-medium' : 'text-gray-500'}`}>
                      {pastDue && pastDue > 0
                        ? <span title="Includes unpaid amounts from prior months">{fmtMoney(pastDue)}</span>
                        : '—'}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {/* Balance = current charges + any rolled-over past due */}
                      <span className={s.balance && s.balance > (s.amountDue ?? 0) ? 'text-amber-400' : 'text-gray-400'}>
                        {fmtMoney(s.balance ?? s.amountDue)}
                      </span>
                    </td>
                    <td className="py-2">
                      <Pill color={color}>{label}</Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
