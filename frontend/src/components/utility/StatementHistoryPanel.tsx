import { useEffect, useState } from 'react';
import { format, isAfter } from 'date-fns';
import { getStatements, deleteStatement, patchStatement } from '../../api/client';
import type { Statement } from '../../types';
import { Skeleton, Pill } from '../ui';
import { fmtDate, yearOf } from '../../lib/date';

interface Props {
  utilityAccountId: string;
}

function fmtMoney(v?: number | null) {
  return v != null ? `$${Number(v).toFixed(2)}` : '—';
}

function rowIsPaid(s: Statement): boolean {
  return Number(s.amountPaid ?? 0) > 0 || (s.rawDataJson as any)?.isPaid === true;
}

// "Past due" on a statement is a frozen snapshot of what the provider printed
// on that bill. Once the prior (chronologically older) statement is marked
// paid in Sollux, that snapshot is stale — suppress the past-due display.
function isPriorRowPaid(idx: number, rows: Statement[]): boolean {
  const prior = rows[idx + 1];
  return prior ? rowIsPaid(prior) : false;
}

function statusPill(s: Statement, newerStmt?: Statement, isLatest = false): { color: 'green' | 'amber' | 'red'; label: string } {
  // Manual overrides always win
  if (Number(s.amountPaid ?? 0) > 0) return { color: 'green', label: 'Paid' };
  if ((s.rawDataJson as any)?.isPaid === true) return { color: 'green', label: 'Paid' };

  if (!isLatest && newerStmt) {
    // Use next bill's previousBalance to determine if this bill was paid.
    // $0 prev balance on the next bill = this one was paid in full.
    // prev balance ≈ this amount = rolled over unpaid.
    const newerPrevBal = Number((newerStmt.rawDataJson as any)?.previousBalance ?? 0);
    const thisDue = Number(s.amountDue ?? 0);
    if (newerPrevBal === 0) return { color: 'green', label: 'Paid' };
    if (thisDue > 0 && newerPrevBal >= thisDue - 0.01) {
      // Unpaid and rolled over — past due date = Overdue, otherwise Due
      const pastDueDate = s.dueDate && isAfter(new Date(), new Date(s.dueDate));
      return pastDueDate ? { color: 'red', label: 'Overdue' } : { color: 'amber', label: 'Due' };
    }
    return { color: 'green', label: 'Paid' };
  }

  if ((s.rawDataJson as any)?.isPastDue === true) return { color: 'red', label: 'Overdue' };
  if (s.dueDate && isAfter(new Date(), new Date(s.dueDate))) return { color: 'red', label: 'Overdue' };
  return { color: 'amber', label: 'Due' };
}

export default function StatementHistoryPanel({ utilityAccountId }: Props) {
  const [rows, setRows] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);

  useEffect(() => {
    getStatements({ utilityAccountId })
      .then(data => setRows([...data].sort((a, b) => b.statementDate.localeCompare(a.statementDate))))
      .finally(() => setLoading(false));
  }, [utilityAccountId]);

  async function handleDelete(id: string) {
    if (!confirm('Delete this statement? The next sync will re-download a fresh copy.')) return;
    setDeleting(id);
    try {
      await deleteStatement(id);
      setRows(prev => prev.filter(r => r.id !== id));
    } catch {
      alert('Failed to delete statement. Please try again.');
    } finally {
      setDeleting(null);
    }
  }

  async function handleMarkPaid(s: Statement) {
    const isPaid = Number(s.amountPaid ?? 0) > 0;
    setMarkingPaid(s.id);
    try {
      const updated = await patchStatement(s.id, { amountPaid: isPaid ? null : Number(s.amountDue ?? 0) });
      setRows(prev => prev.map(r => r.id === s.id ? { ...r, amountPaid: updated.amountPaid } : r));
    } catch {
      // silently fail — status will just not update
    } finally {
      setMarkingPaid(null);
    }
  }

  // ── Mini stats ──────────────────────────────────────────
  const latest = rows[0];
  const prev = rows[1];
  const latestAmt = latest?.amountDue != null ? Number(latest.amountDue) : null;
  const prevAmt = prev?.amountDue != null ? Number(prev.amountDue) : null;

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
    .filter(r => yearOf(r.statementDate) === currentYear)
    .reduce((sum, r) => sum + Number(r.amountDue ?? 0), 0);

  return (
    <div className="mt-2 rounded-xl p-4" style={{ background: '#242424', border: '1px solid rgba(255,255,255,0.06)' }}>

      {/* Mini stat row */}
      {/* Show past due warning if latest statement has a past due balance */}
      {(() => {
        const latestPastDue = latest?.rawDataJson?.pastDue as number | undefined;
        const priorPaid = isPriorRowPaid(0, rows);
        return latestPastDue && latestPastDue > 0 && !priorPaid ? (
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
                {['Statement', 'Billing period', 'Amount due', 'Past due', 'Balance', 'Status', ''].map(h => (
                  <th key={h} className="text-left text-gray-500 font-medium pb-2 pr-4 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s, idx) => {
                const rawPastDue = s.rawDataJson?.pastDue as number | undefined;
                const priorPaid = isPriorRowPaid(idx, rows);
                const pastDue = priorPaid ? undefined : rawPastDue;
                const isFirst = idx === 0;
                // rows sorted DESC: rows[idx-1] is the more recent statement
                const { color, label } = statusPill(s, rows[idx - 1], isFirst);
                const isPaid = rowIsPaid(s);
                return (
                  <tr
                    key={s.id}
                    className="group transition-colors"
                    style={{
                      borderLeft: isFirst ? '3px solid #F5A623' : '3px solid transparent',
                      background: 'transparent',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="py-2 pr-4 text-gray-300 whitespace-nowrap pl-2">
                      {fmtDate(s.statementDate, 'MMM yyyy')}
                    </td>
                    <td className="py-2 pr-4 text-gray-400 whitespace-nowrap">
                      {s.billingPeriodStart && s.billingPeriodEnd
                        ? `${fmtDate(s.billingPeriodStart, 'MMM d')} – ${fmtDate(s.billingPeriodEnd, 'MMM d')}`
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
                    <td className="py-2 pl-2">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {!isPaid && (
                          <button
                            onClick={() => handleMarkPaid(s)}
                            disabled={markingPaid === s.id}
                            title="Mark as paid"
                            className="text-xs px-1.5 py-0.5 rounded transition-colors disabled:opacity-30 text-gray-500 hover:text-green-400"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}
                          >
                            {markingPaid === s.id ? '…' : '✓ Paid'}
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(s.id)}
                          disabled={deleting === s.id}
                          title="Delete statement"
                          className="text-gray-600 hover:text-red-400 disabled:opacity-30"
                          style={{ fontSize: '14px', lineHeight: 1, padding: '2px 4px', background: 'none', border: 'none', cursor: 'pointer' }}
                        >
                          {deleting === s.id ? '…' : '✕'}
                        </button>
                      </div>
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
