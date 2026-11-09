import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CardHealthT, CardInsightT, CreditSnapshotT } from '../../api/client';
import { fmtMoney } from '../../lib/money';
import { fmtDate } from '../../lib/date';

/**
 * Credit health: the snapshot (the parts of a credit score Sollux can see —
 * payment history and utilization — and what the cards cost), the insights
 * with what to say when calling the issuer, and one card's payment history
 * and costs. Used on Personal → Credit cards, a card's History tab and Insights.
 */

const BAND: Record<string, [string, string]> = {
  GOOD: ['Good', 'text-emerald-400'], FAIR: ['Fair — late payments this year', 'text-amber-400'], POOR: ['Poor — a late is on the credit report', 'text-red-400'], UNKNOWN: ['Not enough history yet', 'text-gray-400'],
  EXCELLENT: ['Excellent (under 10%)', 'text-emerald-400'], HIGH: ['High (30–50%)', 'text-amber-400'], VERY_HIGH: ['Very high (over 50%)', 'text-red-400'],
};
const UTIL_GOOD: [string, string] = ['Good (under 30%)', 'text-emerald-400'];

export function CreditSnapshot({ s }: { s: CreditSnapshotT }) {
  const ph = BAND[s.paymentHistory], ut = s.utilizationBand === 'GOOD' ? UTIL_GOOD : BAND[s.utilizationBand];
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <p className="text-sm font-semibold text-white">Credit health</p>
        <p className="text-xs text-gray-500">What your records show about the two biggest parts of a credit score. Sollux can't see the score itself.</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
        <div><p className="text-xs text-gray-500">Payment history (12 mo)</p><p className={`text-sm font-medium ${ph[1]}`}>{ph[0]}</p><p className="text-xs text-gray-500">{s.onTime12} on time · {s.late12} late{s.late12 ? ` · ${s.reported12 ? `${s.reported12} reported` : 'none reported'}` : ''}</p></div>
        <div><p className="text-xs text-gray-500">Utilization</p><p className={`text-sm font-medium ${ut[1]}`}>{s.utilization != null ? `${s.utilization}% · ` : ''}{ut[0]}</p><p className="text-xs text-gray-500">{fmtMoney(s.debt)} of {fmtMoney(s.limits)}{s.cardsOver30 ? ` · ${s.cardsOver30} card${s.cardsOver30 === 1 ? '' : 's'} over 30%` : ''}</p></div>
        <div><p className="text-xs text-gray-500">Past due now</p><p className={`text-sm font-medium ${s.cardsPastDue ? 'text-red-400' : 'text-emerald-400'}`}>{s.cardsPastDue ? `${s.cardsPastDue} card${s.cardsPastDue === 1 ? '' : 's'}` : 'None'}</p></div>
        <div><p className="text-xs text-gray-500">Fees & interest (12 mo)</p><p className={`text-sm font-medium ${s.feesAndInterest12 > 0 ? 'text-red-400' : 'text-white'}`}>{fmtMoney(s.feesAndInterest12)}</p><p className="text-xs text-gray-500">after refunds</p></div>
      </div>
    </div>
  );
}

const SEV: Record<CardInsightT['severity'], string> = { ALERT: 'border-l-red-500', WARNING: 'border-l-amber-500', INFO: 'border-l-white/10' };

export function CardInsightList({ items, title = 'What to do', showCard = true, empty = 'Nothing needs a hand on your cards right now.', collapsible = false, storageKey }: {
  items: CardInsightT[]; title?: string; showCard?: boolean; empty?: string;
  /** Folded to its title line until opened (the choice is remembered under storageKey). */
  collapsible?: boolean; storageKey?: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [shown, setShown] = useState(() => { if (!collapsible) return true; try { return !!storageKey && localStorage.getItem(storageKey) === '1'; } catch { return false; } });
  const toggle = () => setShown(v => { try { if (storageKey) localStorage.setItem(storageKey, v ? '0' : '1'); } catch { /* not kept */ } return !v; });
  // The biggest single idea, not a sum: they overlap (paying the interest off and a balance transfer save the same money).
  const top = Math.max(0, ...items.map(i => i.perYear ?? 0));
  const alerts = items.filter(i => i.severity === 'ALERT').length;
  return (
    <section>
      {collapsible ? (
        <button onClick={toggle} className="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left hover:bg-white/[0.02]" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }} aria-expanded={shown}>
          <span className="text-gray-500 text-xs w-3">{shown ? '▾' : '▸'}</span>
          <span className="text-sm font-semibold text-white">{title}</span>
          <span className="text-xs text-gray-500 flex-1">{items.length} idea{items.length === 1 ? '' : 's'}{alerts ? <span className="text-red-400"> · {alerts} urgent</span> : null}</span>
          {top > 0 && <span className="text-sm font-semibold text-emerald-400 tabular-nums"><span className="text-xs text-gray-500 font-normal">biggest </span>{fmtMoney(top)}<span className="text-xs text-gray-500 font-normal"> a year</span></span>}
        </button>
      ) : <p className="text-sm font-semibold text-white mb-2">{title}</p>}
      {shown && (!items.length ? <p className="text-sm text-gray-500">{empty}</p> : (
        <div className={`rounded-xl divide-y divide-white/5 ${collapsible ? 'mt-2' : ''}`} style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
          {items.map((i, n) => (
            <div key={n} className={`px-4 py-3 flex gap-4 items-start border-l-2 ${SEV[i.severity]}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  {showCard && i.cardId ? <Link to={`/personal/cards/${i.cardId}`} className="text-sm font-medium text-gray-100 hover:text-amber-400">{i.title}</Link> : <span className="text-sm font-medium text-gray-100">{i.title}</span>}
                </div>
                <p className="text-xs text-gray-400 mt-1">{i.detail}</p>
                <p className="text-xs text-amber-400/90 mt-0.5">{i.action}</p>
                {i.script && (
                  <button onClick={() => setOpen(open === n ? null : n)} className="text-xs text-gray-500 hover:text-gray-300 mt-1">{open === n ? 'Hide what to say ▾' : 'What to say on the call ▸'}</button>
                )}
                {i.script && open === n && <p className="text-xs text-gray-300 mt-1 p-2 rounded" style={{ background: 'rgba(255,255,255,0.04)' }}>{i.script}</p>}
              </div>
              {i.perYear != null && i.perYear > 0 && (
                <div className="text-right shrink-0"><p className="text-sm font-semibold text-emerald-400 tabular-nums">{fmtMoney(i.perYear)}</p><p className="text-xs text-gray-500">a year</p></div>
              )}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

const STATUS: Record<string, [string, string]> = {
  ON_TIME: ['On time', 'pill-green'], LATE: ['Late', 'pill-amber'], PAST_DUE: ['Past due', 'pill-red'], DUE: ['Due', 'pill-gray'],
  NOT_LOGGED: ['No payment logged', 'pill-gray'], NONE_DUE: ['Nothing due', 'pill-gray'],
};

/** A row of filter chips, each with its count. */
function Chips<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; count?: number }[] }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map(o => (
        <button key={o.id} onClick={() => onChange(o.id)} className={`text-xs px-2.5 py-1 rounded-lg ${value === o.id ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
          style={{ background: value === o.id ? 'rgba(255,255,255,0.08)' : 'transparent' }}>
          {o.label}{o.count != null ? <span className="text-gray-500 ml-1">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * One card's history: a period (the last 12 months, a year, or everything on
 * file) sets the totals at the top and every list below — the statements and
 * how each was paid, the late fees and whether they were given back, and what
 * the card cost month by month — each list with its own filter.
 */
export function CardHistory({ h, insights }: { h: CardHealthT; insights: CardInsightT[] }) {
  const m = (v: number) => (v ? fmtMoney(v) : '—');
  const today = isoDay(Date.now());
  const since12 = isoDay(Date.now() - 365 * DAY);
  const years = useMemo(() => [...new Set([...h.costs.map(c => c.month.slice(0, 4)), ...h.history.map(r => (r.dueDate ?? r.closingDate).slice(0, 4))])].sort().reverse(), [h]);
  const [period, setPeriod] = useState<string>('12m');
  const [view, setView] = useState<'statements' | 'fees' | 'costs'>('statements');
  const [statusF, setStatusF] = useState<'all' | 'late' | 'on_time' | 'reported' | 'fee'>('all');
  const [feeF, setFeeF] = useState<'all' | 'open' | 'waived'>('all');

  const inDay = (d: string | null) => !!d && (period === 'all' || (period === '12m' ? d > since12 && d <= today : d.startsWith(period)));
  const inMonth = (mo: string) => period === 'all' || (period === '12m' ? mo >= since12.slice(0, 7) && mo <= today.slice(0, 7) : mo.startsWith(period));
  const rows = h.history.filter(r => inDay(r.dueDate ?? r.closingDate));
  const costs = h.costs.filter(c => inMonth(c.month));
  const fees = h.lateEvents.filter(e => inDay(e.date));
  const returned = h.returned.filter(r => inDay(r.paidOn));
  const sum = (k: 'interest' | 'lateFees' | 'otherFees' | 'refunds') => costs.reduce((t, c) => t + c[k], 0);
  const t = { interest: sum('interest'), lateFees: sum('lateFees'), otherFees: sum('otherFees'), refunds: sum('refunds') };
  const net = t.interest + t.lateFees + t.otherFees - t.refunds;
  const settled = rows.filter(r => (r.dueDate ?? '') <= today);
  const onTime = settled.filter(r => r.status === 'ON_TIME' || r.status === 'NOT_LOGGED').length;
  const late = settled.filter(r => r.status === 'LATE' || r.status === 'PAST_DUE');
  const reported = rows.filter(r => r.reported);
  const worst = Math.max(0, ...late.map(r => r.daysLate ?? 0));
  const periodLabel = period === '12m' ? 'last 12 months' : period === 'all' ? 'all on file' : period;

  const shownRows = rows.filter(r => statusF === 'all' ? true
    : statusF === 'late' ? r.status === 'LATE' || r.status === 'PAST_DUE'
    : statusF === 'on_time' ? r.status === 'ON_TIME' || r.status === 'NOT_LOGGED'
    : statusF === 'reported' ? !!r.reported : r.lateFee > 0);
  const shownFees = fees.filter(e => feeF === 'all' ? true : feeF === 'waived' ? e.waived : !e.waived);

  return (
    <div className="space-y-4">
      {h.daysPastDue > 0 && (
        <div className="card p-3 text-sm" style={{ borderColor: 'rgba(239,68,68,0.4)' }}>
          <span className="text-red-400 font-medium">{h.daysPastDue} days past due.</span>{' '}
          <span className="text-gray-300">{h.daysUntil30 ? `In ${h.daysUntil30} day${h.daysUntil30 === 1 ? '' : 's'} it is 30 days past due; still unpaid on the statement date after that, it is reported to the credit bureaus as 30 days late.` : 'Over 30 days past due: still unpaid on the next statement date, it is reported to the credit bureaus.'}</span>
        </div>
      )}

      <Chips value={period} onChange={setPeriod} options={[{ id: '12m', label: 'Last 12 months' }, ...years.map(y => ({ id: y, label: y })), { id: 'all', label: 'All on file' }]} />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="stat-card"><p className="text-xs text-gray-500">Payments</p><p className="text-lg font-semibold text-white">{onTime} on time</p><p className={`text-xs ${late.length ? 'text-amber-400' : 'text-gray-500'}`}>{late.length} late{worst ? ` · worst ${worst} days` : ''}{period === '12m' && h.onTimeStreak ? ` · ${h.onTimeStreak} in a row` : ''}</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Credit report</p><p className={`text-lg font-semibold ${reported.length ? 'text-red-400' : 'text-emerald-400'}`}>{reported.length ? `${reported.length} reported` : 'Nothing reported'}</p><p className="text-xs text-gray-500">a late counts at 30+ days past due on a statement date</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Interest</p><p className={`text-lg font-semibold ${t.interest ? 'text-red-400' : 'text-white'}`}>{fmtMoney(t.interest)}</p><p className="text-xs text-gray-500">{periodLabel}</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Fees</p><p className={`text-lg font-semibold ${t.lateFees + t.otherFees ? 'text-red-400' : 'text-white'}`}>{fmtMoney(t.lateFees + t.otherFees)}</p><p className="text-xs text-gray-500">{fmtMoney(t.lateFees)} late · {fmtMoney(t.otherFees)} other</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Refunded</p><p className="text-lg font-semibold text-emerald-400">{fmtMoney(t.refunds)}</p><p className="text-xs text-gray-500">{fees.filter(e => e.waived).length} of {fees.length} late fees waived</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Net cost</p><p className={`text-lg font-semibold ${net > 0 ? 'text-red-400' : 'text-white'}`}>{fmtMoney(net)}</p><p className="text-xs text-gray-500">interest + fees − refunds</p></div>
      </div>

      {insights.length > 0 && <CardInsightList items={insights} showCard={false} title="Save money on this card" collapsible storageKey="card-save-money-open" />}

      <div className="flex items-center gap-3 flex-wrap pt-1">
        <Chips value={view} onChange={setView} options={[
          { id: 'statements', label: 'Statements', count: rows.length },
          { id: 'fees', label: 'Late fees', count: fees.length + returned.length },
          { id: 'costs', label: 'Cost by month', count: costs.length },
        ]} />
      </div>

      {view === 'statements' && (
        <section className="space-y-2">
          <Chips value={statusF} onChange={setStatusF} options={[
            { id: 'all', label: 'All', count: rows.length },
            { id: 'late', label: 'Late', count: rows.filter(r => r.status === 'LATE' || r.status === 'PAST_DUE').length },
            { id: 'on_time', label: 'On time', count: rows.filter(r => r.status === 'ON_TIME' || r.status === 'NOT_LOGGED').length },
            { id: 'reported', label: 'Reported', count: reported.length },
            { id: 'fee', label: 'Late fee charged', count: rows.filter(r => r.lateFee > 0).length },
          ]} />
          <div className="card overflow-x-auto">
            <table className="table-base">
              <thead><tr><th className="pl-4">Statement</th><th>Due</th><th className="text-right">Minimum</th><th>Paid</th><th>Status</th><th className="pr-4">Credit report</th></tr></thead>
              <tbody>
                {shownRows.map(r => (
                  <tr key={r.statementId}>
                    <td className="pl-4 whitespace-nowrap text-white">{fmtDate(r.closingDate, 'MMM d, yyyy')}</td>
                    <td className="text-gray-400 whitespace-nowrap">{r.dueDate ? fmtDate(r.dueDate, 'MMM d') : '—'}</td>
                    <td className="text-right">{fmtMoney(r.minimum)}</td>
                    <td className="text-gray-400 whitespace-nowrap">{r.paidOn ? fmtDate(r.paidOn, 'MMM d') : '—'}{r.lateFee > 0 && (r.lateFeeWaivedOn
                      ? <span className="block text-xs"><span className="text-gray-500 line-through">{fmtMoney(r.lateFee)} late fee</span> <span className="text-emerald-400">waived {fmtDate(r.lateFeeWaivedOn, 'MMM d')}</span></span>
                      : <span className="block text-xs text-red-400">{fmtMoney(r.lateFee)} late fee</span>)}</td>
                    <td><span className={`pill ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}{r.daysLate ? ` · ${r.daysLate} day${r.daysLate === 1 ? '' : 's'}` : ''}</span>{r.note && <span className="block text-xs text-gray-600 max-w-xs">{r.note}</span>}</td>
                    <td className="pr-4 text-xs">{r.reported
                      ? <span className="text-red-400" title={r.pastDueAtStatement ? `${r.pastDueAtStatement.days} days past due on the ${fmtDate(r.pastDueAtStatement.date, 'MMM d')} statement` : undefined}>Reported {r.reported} days late</span>
                      : r.status === 'LATE' || r.status === 'PAST_DUE'
                        ? <span className="text-gray-500">{r.pastDueAtStatement ? `${r.pastDueAtStatement.days} day${r.pastDueAtStatement.days === 1 ? '' : 's'} past due on the ${fmtDate(r.pastDueAtStatement.date, 'MMM d')} statement` : r.status === 'LATE' ? 'Paid before the next statement' : 'Not past due on a statement date yet'} — not reported</span>
                        : <span className="text-gray-600">—</span>}</td>
                  </tr>
                ))}
                {!shownRows.length && <tr><td colSpan={6} className="pl-4 text-sm text-gray-500">{rows.length ? 'None match this filter.' : `No statements in ${periodLabel}.`}</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {view === 'fees' && (
        <section className="space-y-2">
          <Chips value={feeF} onChange={setFeeF} options={[
            { id: 'all', label: 'All', count: fees.length },
            { id: 'open', label: 'Not refunded', count: fees.filter(e => !e.waived).length },
            { id: 'waived', label: 'Waived', count: fees.filter(e => e.waived).length },
          ]} />
          <div className="card overflow-x-auto">
            <table className="table-base">
              <thead><tr><th className="pl-4">Charged</th><th>For the due date</th><th className="text-right">Fee</th><th className="pr-4">Refund</th></tr></thead>
              <tbody>
                {shownFees.map((e, i) => (
                  <tr key={i}>
                    <td className="pl-4 whitespace-nowrap text-white">{fmtDate(e.date, 'MMM d, yyyy')}</td>
                    <td className="text-gray-400 whitespace-nowrap">{e.forDueDate ? fmtDate(e.forDueDate, 'MMM d, yyyy') : 'a statement not on file'}</td>
                    <td className="text-right">{fmtMoney(e.fee)}</td>
                    <td className="pr-4 text-xs">{e.waived ? <span className="text-emerald-400">Waived — credited back {fmtDate(e.waivedOn!, 'MMM d, yyyy')}</span> : <span className="text-red-400">Not refunded — you can call and ask</span>}</td>
                  </tr>
                ))}
                {!shownFees.length && <tr><td colSpan={4} className="pl-4 text-sm text-gray-500">{fees.length ? 'None match this filter.' : `No late fees in ${periodLabel}.`}</td></tr>}
              </tbody>
            </table>
          </div>
          {returned.length > 0 && (
            <div className="card p-3 space-y-1 text-xs">
              <p className="text-gray-400 font-medium">Returned payments</p>
              {returned.map((r, i) => <p key={i} className="text-red-400/90">{fmtMoney(r.amount)} paid {fmtDate(r.paidOn, 'MMM d, yyyy')} came back on {fmtDate(r.returnedOn, 'MMM d')}.</p>)}
            </div>
          )}
        </section>
      )}

      {view === 'costs' && (
        <section>
          <div className="card overflow-x-auto">
            <table className="table-base">
              <thead><tr><th className="pl-4">Statement month</th><th className="text-right">Interest</th><th className="text-right">Late fees</th><th className="text-right">Other fees</th><th className="text-right">Refunded</th><th className="text-right pr-4">Net</th></tr></thead>
              <tbody>
                {costs.length > 0 && (
                  <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                    <td className="pl-4 text-gray-300 font-medium">{period === '12m' ? 'Last 12 months' : period === 'all' ? 'All on file' : `All of ${period}`}</td>
                    <td className="text-right font-medium">{fmtMoney(t.interest)}</td><td className="text-right font-medium">{fmtMoney(t.lateFees)}</td><td className="text-right font-medium">{fmtMoney(t.otherFees)}</td>
                    <td className="text-right text-emerald-400 font-medium">{t.refunds ? `−${fmtMoney(t.refunds)}` : '—'}</td><td className="text-right pr-4 text-white font-semibold">{fmtMoney(net)}</td>
                  </tr>
                )}
                {costs.map(c => (
                  <tr key={c.month}>
                    <td className="pl-4 text-white">{fmtDate(`${c.month}-01`, 'MMM yyyy')}</td>
                    <td className="text-right">{m(c.interest)}</td><td className="text-right">{m(c.lateFees)}</td><td className="text-right">{m(c.otherFees)}</td>
                    <td className="text-right text-emerald-400">{c.refunds ? `−${fmtMoney(c.refunds)}` : '—'}</td>
                    <td className="text-right pr-4 text-white">{fmtMoney(c.interest + c.lateFees + c.otherFees - c.refunds)}</td>
                  </tr>
                ))}
                {!costs.length && <tr><td colSpan={6} className="pl-4 text-sm text-gray-500">No statements in {periodLabel}.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
