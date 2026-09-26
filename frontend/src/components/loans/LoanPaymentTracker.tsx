import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getLoanTrackerMonth, getLoanTrackerYear, createLoanPayment,
  type LoanTrackerMonth, type LoanTrackerYear, type LoanTrackerRow, type LoanTrackerStatus,
} from '../../api/client';
import type { LoanPaymentMethod } from '../../types';
import { fmtMoney } from '../../lib/money';
import { fmtDate, todayISO, thisMonthISO } from '../../lib/date';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, methodsShort } from '../../lib/loanPayment';
import { describeApiError } from '../../lib/apiError';

const MORTGAGE_TYPES = ['MORTGAGE', 'HELOC', 'SELLER_FINANCING', 'DSCR', 'COMMERCIAL', 'HARD_MONEY'];
const STATUSES: (LoanTrackerStatus | 'all')[] = ['all', 'late', 'due', 'upcoming', 'partial', 'paid'];
const STATUS_LABEL: Record<LoanTrackerStatus, string> = { paid: 'paid', partial: 'partial', upcoming: 'not due yet', due: 'in grace', late: 'late', none: '—' };
const STATUS_CLS: Record<LoanTrackerStatus, string> = {
  paid: 'bg-emerald-900/40 text-emerald-500',
  partial: 'bg-amber-900/50 text-amber-500',
  upcoming: 'bg-white/5 text-gray-400',
  due: 'bg-amber-900/50 text-amber-400',
  late: 'bg-red-900/50 text-red-500',
  none: 'text-gray-600',
};
const CELL_BG: Record<LoanTrackerStatus, string> = {
  paid: 'rgba(16,185,129,0.18)', partial: 'rgba(245,166,35,0.18)', upcoming: 'transparent', due: 'rgba(245,166,35,0.10)', late: 'rgba(239,68,68,0.18)', none: 'transparent',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const money0 = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/**
 * Loan payments month by month — the loans' side of rent collection: what
 * each loan is owed this month, what went out toward it, when it is due and
 * whether it is paid, in its grace period or late. With no `month` given it
 * carries its own month picker and a twelve-month view.
 */
export default function LoanPaymentTracker({ month: fixedMonth }: { month?: string }) {
  const [month, setMonth] = useState(fixedMonth ?? thisMonthISO());
  const [view, setView] = useState<'month' | 'year'>('month');
  const [data, setData] = useState<LoanTrackerMonth | null>(null);
  const [yearData, setYearData] = useState<LoanTrackerYear | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [group, setGroup] = useState<'all' | 'mortgages' | 'other'>('all');
  const [propertyFilter, setPropertyFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<LoanTrackerStatus | 'all'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [logRow, setLogRow] = useState<LoanTrackerRow | null>(null);

  useEffect(() => { if (fixedMonth) setMonth(fixedMonth); }, [fixedMonth]);
  const year = Number(month.slice(0, 4));

  const load = useCallback(() => {
    setErr(null);
    if (view === 'year') getLoanTrackerYear(year, todayISO()).then(setYearData).catch(e => setErr(describeApiError(e, 'Could not load the tracker.')));
    else getLoanTrackerMonth(month, todayISO()).then(setData).catch(e => setErr(describeApiError(e, 'Could not load the tracker.')));
  }, [view, month, year]);
  useEffect(() => { load(); }, [load]);

  const inGroup = (r: { loanType: string; isPersonal: boolean }) =>
    group === 'all' || (group === 'mortgages' ? MORTGAGE_TYPES.includes(r.loanType) && !r.isPersonal : !MORTGAGE_TYPES.includes(r.loanType) || r.isPersonal);

  const properties = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of (view === 'year' ? yearData?.rows : data?.rows) ?? []) seen.set(r.propertyId ?? r.property, r.property);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [data, yearData, view]);

  const rows = useMemo(() => (data?.rows ?? [])
    .filter(inGroup)
    .filter(r => propertyFilter === 'all' || (r.propertyId ?? r.property) === propertyFilter)
    .filter(r => statusFilter === 'all' || r.status === statusFilter)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.lender.localeCompare(b.lender)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [data, group, propertyFilter, statusFilter]);

  const t = rows.reduce((s, r) => ({ expected: s.expected + r.expected, paid: s.paid + r.paid, remaining: s.remaining + r.remaining, late: s.late + (r.status === 'late' ? r.remaining : 0) }), { expected: 0, paid: 0, remaining: 0, late: 0 });
  const counts = (data?.rows ?? []).filter(inGroup).reduce((m, r) => m.set(r.status, (m.get(r.status) ?? 0) + 1), new Map<string, number>());
  const pct = t.expected > 0 ? Math.min(100, Math.round((t.paid / t.expected) * 100)) : 0;
  const shift = (d: number) => { const [y, m] = month.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1 + d, 1)); setMonth(x.toISOString().slice(0, 7)); };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {!fixedMonth && (
          <>
            <div className="flex rounded-lg overflow-hidden border border-white/10">
              {(['month', 'year'] as const).map(v => (
                <button key={v} onClick={() => setView(v)} className={`text-xs px-3 py-1.5 ${view === v ? 'bg-amber-500/20 text-amber-300' : 'text-gray-400 hover:text-gray-200'}`}>{v === 'month' ? 'Month' : 'Year'}</button>
              ))}
            </div>
            {view === 'month' ? (
              <div className="flex items-center gap-1">
                <button onClick={() => shift(-1)} className="btn text-xs px-2">‹</button>
                <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} className="input-dark text-xs" />
                <button onClick={() => shift(1)} className="btn text-xs px-2">›</button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <button onClick={() => setMonth(`${year - 1}${month.slice(4)}`)} className="btn text-xs px-2">‹</button>
                <span className="text-sm text-white px-2">{year}</span>
                <button onClick={() => setMonth(`${year + 1}${month.slice(4)}`)} className="btn text-xs px-2">›</button>
              </div>
            )}
          </>
        )}
        <select value={group} onChange={e => setGroup(e.target.value as typeof group)} className="input-dark text-xs">
          <option value="all">All loans</option>
          <option value="mortgages">Mortgages</option>
          <option value="other">Personal & other</option>
        </select>
        <select value={propertyFilter} onChange={e => setPropertyFilter(e.target.value)} className="input-dark text-xs">
          <option value="all">All properties</option>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {view === 'month' && (
          <div className="flex gap-1 flex-wrap">
            {STATUSES.map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`text-xs px-2.5 py-1 rounded-full border ${statusFilter === s ? 'border-amber-500 text-amber-400' : 'border-white/10 text-gray-400 hover:text-gray-200'}`}>
                {s === 'all' ? 'all' : STATUS_LABEL[s]}{s !== 'all' && counts.get(s) ? ` ${counts.get(s)}` : ''}
              </button>
            ))}
          </div>
        )}
      </div>

      {err && <p className="text-xs text-red-400 mb-3">{err}</p>}

      {view === 'month' && data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            {[['Owed this month', t.expected, 'text-white'], ['Paid', t.paid, 'text-emerald-500'], ['Still to pay', t.remaining, 'text-amber-500'], ['Late', t.late, t.late > 0 ? 'text-red-500' : 'text-gray-500']].map(([l, v, c]) => (
              <div key={l as string} className="rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <p className="text-xs text-gray-400 mb-0.5">{l}</p>
                <p className={`text-base font-semibold ${c}`}>{money0(v as number)}</p>
              </div>
            ))}
          </div>
          <div className="h-2 rounded-full bg-white/5 overflow-hidden mb-3"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-white/5">
                  <th className="text-left pb-2">Lender</th>
                  <th className="text-left pb-2">Property</th>
                  <th className="text-left pb-2">Due</th>
                  <th className="text-right pb-2">Owed</th>
                  <th className="text-right pb-2">Paid</th>
                  <th className="text-right pb-2">Remaining</th>
                  <th className="text-left pb-2 pl-3">How</th>
                  <th className="text-left pb-2 pl-3">Status</th>
                  <th className="text-right pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <Fragment key={r.loanId}>
                    <tr className="border-b border-white/5 hover:bg-white/2">
                      <td className="py-2 text-white font-medium">
                        <button onClick={() => setOpen(o => (o === r.loanId ? null : r.loanId))} className="hover:text-amber-400 text-left">
                          {r.lender} <span className="text-gray-600 text-xs">{open === r.loanId ? '▴' : '▾'}</span>
                        </button>
                      </td>
                      <td className="py-2 text-gray-400">{r.property}</td>
                      <td className="py-2 text-gray-300 whitespace-nowrap">
                        {fmtDate(r.dueDate, 'MMM d')}
                        {r.gracePeriodDays ? <span className="text-gray-600 text-xs"> · late after {fmtDate(r.graceEnds, 'MMM d')}</span> : null}
                      </td>
                      <td className="py-2 text-right text-gray-300">{fmtMoney(r.expected)}</td>
                      <td className="py-2 text-right text-emerald-500">{r.paid > 0 ? fmtMoney(r.paid) : '—'}</td>
                      <td className="py-2 text-right text-amber-500">{r.remaining > 0 ? fmtMoney(r.remaining) : '—'}</td>
                      <td className="py-2 pl-3 text-xs text-gray-400">{methodsShort(r.paymentMethods) || '—'}</td>
                      <td className="py-2 pl-3"><span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_CLS[r.status]}`}>{STATUS_LABEL[r.status]}</span></td>
                      <td className="py-2 text-right">
                        {r.status !== 'paid' && r.status !== 'none' && <button onClick={() => setLogRow(r)} className="text-xs text-amber-400 hover:text-amber-300 whitespace-nowrap">Log payment</button>}
                      </td>
                    </tr>
                    {open === r.loanId && (
                      <tr className="border-b border-white/5">
                        <td colSpan={9} className="py-3 px-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
                          <div className="grid md:grid-cols-2 gap-4 text-xs">
                            <div>
                              <p className="text-gray-500 mb-1">Paid toward {fmtDate(`${month}-01`, 'MMMM yyyy')}</p>
                              {r.payments.length ? r.payments.map(p => (
                                <div key={p.id} className="flex gap-3 py-0.5">
                                  <span className="text-gray-400 w-20">{fmtDate(p.date, 'MMM d')}</span>
                                  <span className="text-emerald-500 w-24 text-right">{fmtMoney(p.amount)}</span>
                                  <span className="text-gray-500">{[p.method ? PAYMENT_METHOD_LABELS[p.method as LoanPaymentMethod] ?? p.method : null, p.lateFee ? `incl. ${fmtMoney(p.lateFee)} late fee` : null, p.confirmationNumber ? `#${p.confirmationNumber}` : null, p.notes].filter(Boolean).join(' · ')}</span>
                                </div>
                              )) : <p className="text-gray-500">Nothing logged for this month.</p>}
                              {r.lastPayment && <p className="text-gray-600 mt-2">Last payment on record: {fmtMoney(r.lastPayment.amount)} on {fmtDate(r.lastPayment.date)}</p>}
                            </div>
                            <div className="space-y-1">
                              {r.paymentMethods.length > 0 && <p><span className="text-gray-500">How: </span><span className="text-gray-300">{r.paymentMethods.map(m => PAYMENT_METHOD_LABELS[m as LoanPaymentMethod] ?? m).join(', ')}</span></p>}
                              {r.paymentInstructions && <p className="text-gray-300">{r.paymentInstructions}</p>}
                              {r.payFrom && <p><span className="text-gray-500">From: </span><span className="text-gray-300">{r.payFrom}</span></p>}
                              {r.mailingAddress && <p><span className="text-gray-500">Mail to: </span><span className="text-gray-300">{r.mailingAddress}</span></p>}
                              {r.paymentUrl && <p><a href={r.paymentUrl} target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">Open payment site ↗</a></p>}
                              <p><Link to={`/loans/${r.loanId}`} className="text-amber-400 hover:underline">Loan details →</Link></p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-sm font-semibold text-white border-t border-white/10">
                  <td colSpan={3} className="pt-2">Total · {rows.length} loan{rows.length === 1 ? '' : 's'}</td>
                  <td className="pt-2 text-right">{fmtMoney(t.expected)}</td>
                  <td className="pt-2 text-right text-emerald-500">{fmtMoney(t.paid)}</td>
                  <td className="pt-2 text-right text-amber-500">{t.remaining > 0 ? fmtMoney(t.remaining) : '✓'}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
            {rows.length === 0 && <p className="text-center text-gray-500 py-8">No loans match the current filters.</p>}
          </div>
        </>
      )}

      {view === 'year' && yearData && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 uppercase tracking-wider border-b border-white/5">
                <th className="text-left pb-2 pr-2">Lender</th>
                <th className="text-right pb-2 pr-2">Monthly</th>
                {MONTHS.map((m, i) => <th key={m} className="text-center pb-2 px-1"><button onClick={() => { setMonth(yearData.months[i]); setView('month'); }} className="hover:text-amber-400">{m}</button></th>)}
                <th className="text-right pb-2 pl-2">Paid {yearData.year}</th>
              </tr>
            </thead>
            <tbody>
              {yearData.rows.filter(inGroup).filter(r => propertyFilter === 'all' || (r.propertyId ?? r.property) === propertyFilter).map(r => (
                <tr key={r.loanId} className="border-b border-white/5">
                  <td className="py-1.5 pr-2">
                    <Link to={`/loans/${r.loanId}`} className="text-white hover:text-amber-400">{r.lender}</Link>
                    <div className="text-gray-600">{r.property}{r.lateMonths ? <span className="text-red-500"> · {r.lateMonths} late</span> : null}</div>
                  </td>
                  <td className="py-1.5 pr-2 text-right text-gray-300">{money0(r.expected)}</td>
                  {r.cells.map(c => (
                    <td key={c.month} className="py-1.5 px-0.5 text-center">
                      <button onClick={() => { setMonth(c.month); setView('month'); }} title={`${c.month}: ${STATUS_LABEL[c.status]}${c.paid ? ` · ${fmtMoney(c.paid)} paid` : ''}`}
                        className="w-full rounded px-1 py-1" style={{ background: CELL_BG[c.status] }}>
                        {c.status === 'paid' ? <span className="text-emerald-400">✓</span>
                          : c.status === 'partial' ? <span className="text-amber-400">{money0(c.paid)}</span>
                          : c.status === 'late' ? <span className="text-red-400">✕</span>
                          : c.status === 'due' ? <span className="text-amber-400">•</span>
                          : <span className="text-gray-700">·</span>}
                      </button>
                    </td>
                  ))}
                  <td className="py-1.5 pl-2 text-right text-emerald-500">{r.paidYear ? money0(r.paidYear) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-600 mt-2">✓ paid · amount = partly paid · • in grace period · ✕ late · click a month to open it</p>
        </div>
      )}

      {logRow && (
        <LogLoanPaymentModal row={logRow} month={month} onClose={() => setLogRow(null)} onSaved={() => { setLogRow(null); load(); }} />
      )}
    </div>
  );
}

function LogLoanPaymentModal({ row, month, onClose, onSaved }: { row: LoanTrackerRow; month: string; onClose: () => void; onSaved: () => void }) {
  const firstMethod = (row.paymentMethods.find(m => m !== 'AUTOPAY') ?? row.paymentMethods[0] ?? '') as LoanPaymentMethod | '';
  const [amount, setAmount] = useState(String(row.remaining || row.expected || ''));
  const [date, setDate] = useState(todayISO());
  const [period, setPeriod] = useState(month);
  const [method, setMethod] = useState<LoanPaymentMethod | ''>(row.paymentMethods.includes('AUTOPAY') ? 'AUTOPAY' : firstMethod);
  const [lateFee, setLateFee] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const amt = parseFloat(amount);
    if (!(amt > 0)) { setErr('Enter the amount paid.'); return; }
    setSaving(true); setErr(null);
    try {
      await createLoanPayment(row.loanId, {
        date, amount: amt, billAmount: row.expected || undefined, status: 'PAID', periodMonth: period, method: method || null,
        lateFee: lateFee ? parseFloat(lateFee) : undefined, confirmationNumber: confirmation || undefined, notes: notes || undefined,
      });
      onSaved();
    } catch (e) { setErr(describeApiError(e, 'Could not log the payment.')); }
    finally { setSaving(false); }
  }

  const input = 'input-dark w-full text-sm';
  const label = 'block text-xs text-gray-500 mb-1';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="card p-5 w-full max-w-md space-y-3" onClick={e => e.stopPropagation()}>
        <div>
          <p className="text-sm font-semibold text-white">Log payment — {row.lender}</p>
          <p className="text-xs text-gray-500">{row.property} · {fmtMoney(row.expected)} due {fmtDate(row.dueDate)}</p>
        </div>
        {(row.paymentInstructions || row.mailingAddress) && (
          <p className="text-xs text-gray-400 rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.04)' }}>
            {[row.paymentInstructions, row.mailingAddress ? `Mail to ${row.mailingAddress}` : null].filter(Boolean).join(' · ')}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div><span className={label}>Amount paid</span><input type="number" step="0.01" className={input} value={amount} onChange={e => setAmount(e.target.value)} /></div>
          <div><span className={label}>Date paid</span><input type="date" className={input} value={date} onChange={e => setDate(e.target.value)} /></div>
          <div><span className={label}>Month it covers</span><input type="month" className={input} value={period} onChange={e => setPeriod(e.target.value)} /></div>
          <div>
            <span className={label}>How</span>
            <select className={input} value={method} onChange={e => setMethod(e.target.value as LoanPaymentMethod | '')}>
              <option value="">—</option>
              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
            </select>
          </div>
          <div><span className={label}>Late fee included</span><input type="number" step="0.01" className={input} value={lateFee} onChange={e => setLateFee(e.target.value)} placeholder="0.00" /></div>
          <div><span className={label}>Check # / confirmation</span><input className={input} value={confirmation} onChange={e => setConfirmation(e.target.value)} /></div>
          <div className="col-span-2"><span className={label}>Notes</span><input className={input} value={notes} onChange={e => setNotes(e.target.value)} /></div>
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn text-xs">Cancel</button>
          <button onClick={save} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : 'Log payment'}</button>
        </div>
      </div>
    </div>
  );
}
