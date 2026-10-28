import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getBillsSheet, getLoanTrackerYear, getStatementDownloadUrl, patchStatement, markStatementUnpaid, createPayment, createLoanPayment,
  type BillsSheet, type BillsSheetAccount, type BillsSheetStatement, type LoanTrackerYear, type LoanTrackerStatus,
} from '../api/client';
import { PageHeader } from '../components/ui';
import { fmtMoney } from '../lib/money';
import { fmtDate, monthKey, todayISO } from '../lib/date';
import { computePaidMap, computeResolvedByFutureCheckpoint, openBalanceOf, deferredOf, isUpcoming } from '../lib/paidState';
import { openUrl } from '../lib/native';
import { describeApiError } from '../lib/apiError';

/**
 * Bills: the owner's spreadsheet, kept by Sollux. One table per property, a
 * row per account (company, account, due day, link, notes) and a column per
 * month, each cell the bill due that month — green paid, red overdue, amber
 * still to pay. A click on a cell marks it paid or unpaid, opens the PDF or
 * the account. Loans sit under their property the same way. Paid state is
 * the account page's own rule (lib/paidState.ts), so the two always agree.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CATEGORY: Record<string, string> = {
  ELECTRIC: 'Electric', GAS: 'Gas', WATER: 'Water', SEWER: 'Sewer', TRASH: 'Trash', SOLAR: 'Solar', INTERNET: 'Internet', PHONE: 'Phone',
  INSURANCE: 'Insurance', HOA: 'HOA', TAXES: 'Taxes', LOAN: 'Loan', CREDIT_CARD: 'Card', OTHER: 'Other',
};

type State = 'paid' | 'overdue' | 'due' | 'upcoming';
interface Bill { s: BillsSheetStatement; account: BillsSheetAccount; propertyId: string; amount: number; state: State }

const STATE_STYLE: Record<State, { color: string; bg: string; label: string }> = {
  paid: { color: '#34c759', bg: 'rgba(52,199,89,0.10)', label: 'Paid' },
  overdue: { color: '#ff6b6b', bg: 'rgba(255,107,107,0.14)', label: 'Overdue' },
  due: { color: '#F5A623', bg: 'rgba(245,166,35,0.12)', label: 'To pay' },
  upcoming: { color: '#9ca3af', bg: 'rgba(255,255,255,0.04)', label: 'Scheduled' },
};
const LOAN_STATE: Record<LoanTrackerStatus, State | null> = { paid: 'paid', partial: 'due', upcoming: 'upcoming', due: 'due', late: 'overdue', none: null };

/** The month a bill belongs to: the month it is due, or the month it was issued when it has no due date. */
const billMonth = (s: BillsSheetStatement) => monthKey(s.dueDate ?? s.statementDate);
/** What the bill charged for its own period (no arrears carried in, no deferred true-up). */
const chargeOf = (s: BillsSheetStatement) => Number(s.amountDue ?? 0) - deferredOf(s);

function billsOf(account: BillsSheetAccount, propertyId: string): Bill[] {
  const resolved = computeResolvedByFutureCheckpoint(account.statements);
  const paid = computePaidMap(account.statements, account.payments, resolved);
  const today = todayISO();
  return account.statements.filter(s => !s.isDownPayment).map(s => {
    const isPaid = paid.get(s.id) ?? false;
    const state: State = isPaid ? 'paid' : isUpcoming(s) ? 'upcoming' : s.dueDate && s.dueDate < today ? 'overdue' : 'due';
    return { s, account, propertyId, amount: chargeOf(s), state };
  });
}

export default function BillsPage() {
  const [year, setYear] = useState(() => Number(todayISO().slice(0, 4)));
  const [sheet, setSheet] = useState<BillsSheet | null>(null);
  const [loans, setLoans] = useState<LoanTrackerYear | null>(null);
  const [error, setError] = useState('');
  const [pid, setPid] = useState('all');
  const [query, setQuery] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const [cell, setCell] = useState<{ bills: Bill[]; month: string } | null>(null);
  const [loanCell, setLoanCell] = useState<{ row: LoanTrackerYear['rows'][number]; month: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, l] = await Promise.all([getBillsSheet(), getLoanTrackerYear(year, todayISO()).catch(() => null)]);
      setSheet(b); setLoans(l); setError('');
    } catch (e) { setError(describeApiError(e, 'Could not load the bills.')); }
  }, [year]);
  useEffect(() => { void load(); }, [load]);

  // Where the table is wider than the screen (a phone), open each property on this month, not January.
  useEffect(() => {
    document.querySelectorAll<HTMLElement>('[data-bills-scroll]').forEach(el => {
      const th = el.querySelector<HTMLElement>('th[data-current]');
      if (th && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, th.offsetLeft + th.offsetWidth * 2 - el.clientWidth);
    });
  }, [sheet, loans, pid, query, openOnly]);

  const months = useMemo(() => MONTHS.map((_, i) => `${year}-${String(i + 1).padStart(2, '0')}`), [year]);
  const thisMonth = todayISO().slice(0, 7);

  // Every bill, worked out once.
  const bills = useMemo(() => {
    const out = new Map<string, Bill[]>();
    for (const p of sheet?.properties ?? []) for (const a of p.accounts) out.set(a.id, billsOf(a, p.id));
    return out;
  }, [sheet]);

  const q = query.trim().toLowerCase();
  const matches = (a: BillsSheetAccount, propName: string) =>
    !q || [a.providerName, a.last4, a.notes, a.serves, CATEGORY[a.category], propName].some(x => x && String(x).toLowerCase().includes(q));
  const hasOpen = (list: Bill[]) => list.some(b => b.state === 'overdue' || b.state === 'due');

  const properties = (sheet?.properties ?? []).filter(p => pid === 'all' || p.id === pid).map(p => {
    const accounts = p.accounts.filter(a => matches(a, p.name) && (!openOnly || hasOpen(bills.get(a.id) ?? [])));
    const loanRows = (loans?.rows ?? []).filter(r => r.propertyId === p.id && !r.utilityAccountId
      && (!q || [r.lender, p.name, 'loan'].some(x => x.toLowerCase().includes(q)))
      && (!openOnly || r.cells.some(c => c.status === 'late' || c.status === 'due' || c.status === 'partial')));
    return { ...p, accounts, loanRows };
  }).filter(p => p.accounts.length || p.loanRows.length);

  // What is open across everything shown, for the line at the top.
  const totals = useMemo(() => {
    let overdue = 0, overdueN = 0, toPay = 0, toPayN = 0, paidYear = 0;
    for (const list of bills.values()) for (const b of list) {
      if (b.state === 'overdue') { overdue += Number(openBalanceOf(b.s) ?? b.amount); overdueN++; }
      if (b.state === 'due') { toPay += b.amount; toPayN++; }
      if (b.state === 'paid' && billMonth(b.s)?.startsWith(String(year))) paidYear += b.amount;
    }
    // Loans billed on their own (not through a utility account), for the year shown.
    for (const r of loans?.rows ?? []) {
      if (r.utilityAccountId) continue;
      for (const c of r.cells) {
        const left = Math.max(0, c.expected - c.paid);
        if (c.status === 'late') { overdue += left; overdueN++; }
        if (c.status === 'due' || c.status === 'partial') { toPay += left; toPayN++; }
        paidYear += c.paid;
      }
    }
    return { overdue, overdueN, toPay, toPayN, paidYear };
  }, [bills, loans, year]);

  return (
    <div>
      <PageHeader title="Bills" subtitle="Every account and loan, month by month — what is paid, what is due, what is late" />
      <div className="px-4 md:px-8 pb-10">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="inline-flex items-center rounded-lg" style={{ background: 'rgba(255,255,255,0.05)' }}>
            <button className="px-2.5 py-1.5 text-gray-400 hover:text-white" onClick={() => setYear(y => y - 1)} aria-label="Previous year">‹</button>
            <span className="text-sm font-semibold tabular-nums px-1">{year}</span>
            <button className="px-2.5 py-1.5 text-gray-400 hover:text-white" onClick={() => setYear(y => y + 1)} aria-label="Next year">›</button>
          </div>
          <select className="input-dark text-sm" value={pid} onChange={e => setPid(e.target.value)}>
            <option value="all">All properties</option>
            {(sheet?.properties ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="input-dark text-sm w-48" placeholder="Search company, account, note" value={query} onChange={e => setQuery(e.target.value)} />
          <label className="text-sm text-gray-400 flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} /> Unpaid only
          </label>
          <div className="ml-auto flex flex-wrap gap-3 text-xs">
            <span style={{ color: STATE_STYLE.overdue.color }}>Overdue {fmtMoney(totals.overdue)} · {totals.overdueN}</span>
            <span style={{ color: STATE_STYLE.due.color }}>To pay {fmtMoney(totals.toPay)} · {totals.toPayN}</span>
            <span className="text-gray-400">Paid in {year} {fmtMoney(totals.paidYear)}</span>
          </div>
        </div>

        {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
        {!sheet && !error && <p className="text-sm text-gray-500">Loading…</p>}
        {sheet && !properties.length && <p className="text-sm text-gray-500">Nothing matches.</p>}

        <div className="space-y-6">
          {properties.map(p => (
            <section key={p.id} className="rounded-xl overflow-hidden" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="px-4 py-3 flex items-baseline gap-2 border-b border-white/5">
                <Link to={`/properties/${p.id}`} className="font-semibold text-white hover:text-amber-400">{p.name}</Link>
                {p.name !== p.address && <span className="text-xs text-gray-500">{p.address}, {p.city}</span>}
              </div>
              <div className="overflow-x-auto" data-bills-scroll>
                <table className="text-xs w-full table-fixed" style={{ minWidth: 1040 }}>
                  <colgroup><col style={{ width: 220 }} /><col style={{ width: 44 }} />{months.map(m => <col key={m} />)}</colgroup>
                  <thead>
                    <tr className="text-gray-500">
                      <th className="text-left font-medium px-3 py-2 sticky left-0 z-10" style={{ background: '#1e1e1e' }}>Company</th>
                      <th className="text-left font-medium px-2 py-2">Due</th>
                      {months.map((m, i) => (
                        <th key={m} data-current={m === thisMonth || undefined} className="text-right font-medium px-2 py-2" style={m === thisMonth ? { color: '#F5A623' } : undefined}>{MONTHS[i]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {p.accounts.map(a => {
                      const list = bills.get(a.id) ?? [];
                      const days = list.map(b => b.s.dueDate?.slice(8, 10)).filter(Boolean);
                      const dueDay = days[0] ? String(Number(days[0])) : '—';
                      return (
                        <tr key={a.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                          <td className="px-3 py-2 sticky left-0 z-10" style={{ background: '#1e1e1e' }}>
                            <Link to={`/properties/${p.id}/utilities/${a.id}`} className="text-gray-100 hover:text-amber-400 font-medium">{a.providerName}</Link>
                            <div className="text-gray-500 flex gap-1.5 items-center">
                              <span>{CATEGORY[a.category] ?? a.category}</span>
                              {a.last4 && <span>••{a.last4}</span>}
                              {a.serves && <span className="truncate max-w-[80px]">{a.serves}</span>}
                              {a.website && <button onClick={() => void openUrl(a.website!)} className="text-amber-400/80 hover:text-amber-300" title={a.website}>Pay ↗</button>}
                            </div>
                            {a.notes && <div className="text-gray-500 truncate" title={a.notes}>{a.notes}</div>}
                          </td>
                          <td className="px-2 py-2 text-gray-400 tabular-nums">{dueDay}</td>
                          {months.map(m => {
                            const inMonth = list.filter(b => billMonth(b.s) === m);
                            return <td key={m} className="px-1 py-1 text-right"><Cell bills={inMonth} onClick={() => inMonth.length && setCell({ bills: inMonth, month: m })} /></td>;
                          })}
                        </tr>
                      );
                    })}
                    {p.loanRows.map(r => (
                      <tr key={r.loanId} className="border-t border-white/5 hover:bg-white/[0.02]">
                        <td className="px-3 py-2 sticky left-0 z-10" style={{ background: '#1e1e1e' }}>
                          <Link to={`/loans/${r.loanId}`} className="text-gray-100 hover:text-amber-400 font-medium">{r.lender}</Link>
                          <div className="text-gray-500 flex gap-1.5 items-center">
                            <span>Loan</span>
                            {r.paymentUrl && <button onClick={() => void openUrl(r.paymentUrl!)} className="text-amber-400/80 hover:text-amber-300">Pay ↗</button>}
                          </div>
                          {r.paymentInstructions && <div className="text-gray-500 truncate" title={r.paymentInstructions}>{r.paymentInstructions}</div>}
                        </td>
                        <td className="px-2 py-2 text-gray-400 tabular-nums">{r.dueDay ?? '—'}</td>
                        {months.map(m => {
                          const c = r.cells.find(x => x.month === m);
                          const state = c ? LOAN_STATE[c.status] : null;
                          return (
                            <td key={m} className="px-1 py-1 text-right">
                              {c && state ? (
                                <button onClick={() => setLoanCell({ row: r, month: m })} className="w-full rounded px-1.5 py-1 tabular-nums text-right"
                                  style={{ color: STATE_STYLE[state].color, background: STATE_STYLE[state].bg }}>
                                  {fmtShort(c.paid > 0 ? c.paid : c.expected)}
                                </button>
                              ) : <span className="text-gray-700">·</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      </div>

      {cell && <BillPanel bills={cell.bills} month={cell.month} onClose={() => setCell(null)} onChanged={() => { setCell(null); void load(); }} />}
      {loanCell && <LoanPanel row={loanCell.row} month={loanCell.month} onClose={() => setLoanCell(null)} onChanged={() => { setLoanCell(null); void load(); }} />}
    </div>
  );
}

const fmtShort = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: n < 1000 ? 2 : 0, maximumFractionDigits: n < 1000 ? 2 : 0 })}`;

function Cell({ bills, onClick }: { bills: Bill[]; onClick: () => void }) {
  if (!bills.length) return <span className="text-gray-700 px-1.5">·</span>;
  // The worst state shows when a month holds more than one bill.
  const order: State[] = ['overdue', 'due', 'upcoming', 'paid'];
  const state = order.find(st => bills.some(b => b.state === st))!;
  const amount = bills.reduce((t, b) => t + b.amount, 0);
  return (
    <button onClick={onClick} className="w-full rounded px-1.5 py-1 tabular-nums text-right"
      style={{ color: STATE_STYLE[state].color, background: STATE_STYLE[state].bg }}
      title={`${STATE_STYLE[state].label}${bills.length > 1 ? ` · ${bills.length} bills` : ''}`}>
      {fmtShort(amount)}{bills.length > 1 ? '*' : ''}
    </button>
  );
}

function Panel({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-5" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="font-semibold text-white">{title}</p>
            {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function BillPanel({ bills, month, onClose, onChanged }: { bills: Bill[]; month: string; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const a = bills[0].account;

  async function markPaid(b: Bill) {
    // The account page's Mark paid: a payment for the bill's open balance, dated today and tied to the bill.
    setBusy(b.s.id); setErr('');
    try {
      if (b.s.paidOverride) await patchStatement(b.s.id, { paidOverride: null });
      const amount = Number(openBalanceOf(b.s) ?? b.amount);
      if (amount > 0) {
        await createPayment({
          utilityAccountId: a.id, amount, paymentDate: todayISO(), paymentMethod: null, status: 'PAID', statementId: b.s.id,
          confirmationNumber: null, bankAccountId: null, notes: `Marked paid from Bills. [marked-paid:${b.s.id}]`,
        });
      } else {
        await patchStatement(b.s.id, { paidOverride: 'PAID' });
      }
      onChanged();
    } catch (e) { setErr(describeApiError(e, 'Could not mark it paid.')); }
    finally { setBusy(''); }
  }
  async function markUnpaid(b: Bill) {
    setBusy(b.s.id); setErr('');
    try { await markStatementUnpaid(b.s.id); onChanged(); }
    catch (e) { setErr(describeApiError(e, 'Could not mark it unpaid.')); }
    finally { setBusy(''); }
  }
  async function openPdf(b: Bill) {
    try { const r = await getStatementDownloadUrl(b.s.id); window.open(r.url, '_blank', 'noopener,noreferrer'); }
    catch { setErr('Could not open the PDF.'); }
  }

  const [y, m] = month.split('-');
  return (
    <Panel title={`${a.providerName}${a.last4 ? ` ••${a.last4}` : ''}`} subtitle={`${MONTHS[Number(m) - 1]} ${y}`} onClose={onClose}>
      <div className="space-y-3">
        {bills.map(b => {
          const open = openBalanceOf(b.s);
          const carried = Number(b.s.pastDueCarried ?? 0);
          return (
            <div key={b.s.id} className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="flex items-baseline justify-between">
                <span className="text-lg font-semibold tabular-nums text-white">{fmtMoney(b.amount)}</span>
                <span className="text-xs font-medium" style={{ color: STATE_STYLE[b.state].color }}>{STATE_STYLE[b.state].label}</span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                Issued {fmtDate(b.s.statementDate)}{b.s.dueDate ? ` · due ${fmtDate(b.s.dueDate)}` : ''}
                {carried > 0.01 ? ` · ${fmtMoney(carried)} carried in (${fmtMoney(open)} total)` : ''}
                {Number(b.s.trueUpDeferred ?? 0) > 0 ? ` · ${fmtMoney(b.s.trueUpDeferred)} deferred to true-up` : ''}
              </p>
              <div className="flex flex-wrap gap-2 mt-2.5">
                {b.state === 'paid'
                  ? <button disabled={!!busy} onClick={() => void markUnpaid(b)} className="btn-ghost text-xs">Mark unpaid</button>
                  : <button disabled={!!busy} onClick={() => void markPaid(b)} className="btn-primary text-xs">{busy === b.s.id ? 'Saving…' : `Mark paid${open && open > 0 ? ` · ${fmtMoney(open)}` : ''}`}</button>}
                {b.s.hasPdf && <button onClick={() => void openPdf(b)} className="btn-ghost text-xs">Open PDF</button>}
              </div>
            </div>
          );
        })}
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex gap-3 text-xs pt-1">
          <Link to={`/properties/${bills[0].propertyId}/utilities/${a.id}`} className="text-amber-400 hover:text-amber-300">Open account →</Link>
          {a.website && <button onClick={() => void openUrl(a.website!)} className="text-gray-400 hover:text-white">Pay online ↗</button>}
        </div>
      </div>
    </Panel>
  );
}

function LoanPanel({ row, month, onClose, onChanged }: { row: LoanTrackerYear['rows'][number]; month: string; onClose: () => void; onChanged: () => void }) {
  const c = row.cells.find(x => x.month === month)!;
  const state = LOAN_STATE[c.status] ?? 'upcoming';
  const left = Math.max(0, Number((c.expected - c.paid).toFixed(2)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function record() {
    setBusy(true); setErr('');
    try {
      await createLoanPayment(row.loanId, { date: todayISO(), amount: left, billAmount: c.expected || undefined, status: 'PAID', periodMonth: month, notes: 'Recorded from Bills.' });
      onChanged();
    } catch (e) { setErr(describeApiError(e, 'Could not record the payment.')); }
    finally { setBusy(false); }
  }
  const [y, m] = month.split('-');
  return (
    <Panel title={row.lender} subtitle={`${MONTHS[Number(m) - 1]} ${y} · ${row.property}`} onClose={onClose}>
      <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
        <div className="flex items-baseline justify-between">
          <span className="text-lg font-semibold tabular-nums text-white">{fmtMoney(c.expected)}</span>
          <span className="text-xs font-medium" style={{ color: STATE_STYLE[state].color }}>{c.status === 'late' ? 'Late' : c.status === 'partial' ? 'Part paid' : c.status === 'due' ? 'In grace' : STATE_STYLE[state].label}</span>
        </div>
        <p className="text-xs text-gray-500 mt-0.5">Paid {fmtMoney(c.paid)}{row.dueDay ? ` · due the ${row.dueDay}${ordinal(row.dueDay)}` : ''}{row.payFrom ? ` · from ${row.payFrom}` : ''}</p>
        <div className="flex flex-wrap gap-2 mt-2.5">
          {left > 0 && <button disabled={busy} onClick={() => void record()} className="btn-primary text-xs">{busy ? 'Saving…' : `Record payment · ${fmtMoney(left)}`}</button>}
        </div>
      </div>
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
      <div className="flex gap-3 text-xs pt-3">
        <Link to={`/loans/${row.loanId}`} className="text-amber-400 hover:text-amber-300">Open loan →</Link>
        {row.paymentUrl && <button onClick={() => void openUrl(row.paymentUrl!)} className="text-gray-400 hover:text-white">Pay online ↗</button>}
      </div>
    </Panel>
  );
}

const ordinal = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
