import { useState } from 'react';
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
  GOOD: ['Good', 'text-emerald-400'], FAIR: ['Fair — late payments this year', 'text-amber-400'], POOR: ['Poor — a payment ran 30+ days late', 'text-red-400'], UNKNOWN: ['Not enough history yet', 'text-gray-400'],
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
        <div><p className="text-xs text-gray-500">Payment history (12 mo)</p><p className={`text-sm font-medium ${ph[1]}`}>{ph[0]}</p><p className="text-xs text-gray-500">{s.onTime12} on time · {s.late12} late{s.worstDaysLate12 ? ` · worst ${s.worstDaysLate12} days` : ''}</p></div>
        <div><p className="text-xs text-gray-500">Utilization</p><p className={`text-sm font-medium ${ut[1]}`}>{s.utilization != null ? `${s.utilization}% · ` : ''}{ut[0]}</p><p className="text-xs text-gray-500">{fmtMoney(s.debt)} of {fmtMoney(s.limits)}{s.cardsOver30 ? ` · ${s.cardsOver30} card${s.cardsOver30 === 1 ? '' : 's'} over 30%` : ''}</p></div>
        <div><p className="text-xs text-gray-500">Past due now</p><p className={`text-sm font-medium ${s.cardsPastDue ? 'text-red-400' : 'text-emerald-400'}`}>{s.cardsPastDue ? `${s.cardsPastDue} card${s.cardsPastDue === 1 ? '' : 's'}` : 'None'}</p></div>
        <div><p className="text-xs text-gray-500">Fees & interest (12 mo)</p><p className={`text-sm font-medium ${s.feesAndInterest12 > 0 ? 'text-red-400' : 'text-white'}`}>{fmtMoney(s.feesAndInterest12)}</p><p className="text-xs text-gray-500">after refunds</p></div>
      </div>
    </div>
  );
}

const SEV: Record<CardInsightT['severity'], string> = { ALERT: 'border-l-red-500', WARNING: 'border-l-amber-500', INFO: 'border-l-white/10' };

export function CardInsightList({ items, title = 'What to do', showCard = true, empty = 'Nothing needs a hand on your cards right now.' }: { items: CardInsightT[]; title?: string; showCard?: boolean; empty?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section>
      <p className="text-sm font-semibold text-white mb-2">{title}</p>
      {!items.length ? <p className="text-sm text-gray-500">{empty}</p> : (
        <div className="rounded-xl divide-y divide-white/5" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
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
      )}
    </section>
  );
}

const STATUS: Record<string, [string, string]> = {
  ON_TIME: ['On time', 'pill-green'], LATE: ['Late', 'pill-amber'], PAST_DUE: ['Past due', 'pill-red'], DUE: ['Due', 'pill-gray'],
  NOT_LOGGED: ['No payment logged', 'pill-gray'], NONE_DUE: ['Nothing due', 'pill-gray'],
};

/** One card's payment history and what it has cost. */
export function CardHistory({ h, insights }: { h: CardHealthT; insights: CardInsightT[] }) {
  const m = (v: number) => (v ? fmtMoney(v) : '—');
  return (
    <div className="space-y-5">
      {h.daysPastDue > 0 && (
        <div className="card p-3 text-sm" style={{ borderColor: 'rgba(239,68,68,0.4)' }}>
          <span className="text-red-400 font-medium">{h.daysPastDue} days past due.</span>{' '}
          <span className="text-gray-300">{h.daysUntil30 ? `In ${h.daysUntil30} day${h.daysUntil30 === 1 ? '' : 's'} it is 30 days past due; still unpaid on the statement date after that, it is reported to the credit bureaus as 30 days late.` : 'Over 30 days past due: still unpaid on the next statement date, it is reported to the credit bureaus.'}</span>
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="stat-card"><p className="text-xs text-gray-500">On time (12 mo)</p><p className="text-lg font-semibold text-white">{h.last12.onTime}</p><p className="text-xs text-gray-500">{h.onTimeStreak} in a row</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Late (12 mo)</p><p className={`text-lg font-semibold ${h.last12.late ? 'text-amber-400' : 'text-white'}`}>{h.last12.late}</p>{h.last12.worstDaysLate > 0 && <p className="text-xs text-gray-500">worst {h.last12.worstDaysLate} days</p>}</div>
        <div className="stat-card"><p className="text-xs text-gray-500">Interest (12 mo)</p><p className={`text-lg font-semibold ${h.last12.interest ? 'text-red-400' : 'text-white'}`}>{fmtMoney(h.last12.interest)}</p><p className="text-xs text-gray-500">{fmtMoney(h.allTime.interest)} on file</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Fees (12 mo)</p><p className={`text-lg font-semibold ${h.last12.lateFees + h.last12.otherFees ? 'text-red-400' : 'text-white'}`}>{fmtMoney(h.last12.lateFees + h.last12.otherFees)}</p><p className="text-xs text-gray-500">{fmtMoney(h.last12.lateFees)} late fees</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Refunded (12 mo)</p><p className="text-lg font-semibold text-emerald-400">{fmtMoney(h.last12.refunds)}</p><p className="text-xs text-gray-500">net cost {fmtMoney(h.last12.net)}</p></div>
      </div>

      {insights.length > 0 && <CardInsightList items={insights} showCard={false} title="Save money on this card" />}

      <section>
        <p className="text-sm font-semibold text-white mb-2">Payment history</p>
        <div className="card overflow-x-auto">
          <table className="table-base">
            <thead><tr><th className="pl-4">Statement</th><th>Due</th><th className="text-right">Minimum</th><th>Paid</th><th>Status</th><th className="pr-4">Credit report</th></tr></thead>
            <tbody>
              {h.history.map(r => (
                <tr key={r.statementId}>
                  <td className="pl-4 whitespace-nowrap text-white">{fmtDate(r.closingDate, 'MMM d, yyyy')}</td>
                  <td className="text-gray-400 whitespace-nowrap">{r.dueDate ? fmtDate(r.dueDate, 'MMM d') : '—'}</td>
                  <td className="text-right">{fmtMoney(r.minimum)}</td>
                  <td className="text-gray-400 whitespace-nowrap">{r.paidOn ? fmtDate(r.paidOn, 'MMM d') : '—'}{r.lateFee > 0 && (r.lateFeeWaivedOn
                    ? <span className="block text-xs"><span className="text-gray-500 line-through">{fmtMoney(r.lateFee)} late fee</span> <span className="text-emerald-400">waived {fmtDate(r.lateFeeWaivedOn, 'MMM d')}</span></span>
                    : <span className="block text-xs text-red-400">{fmtMoney(r.lateFee)} late fee</span>)}</td>
                  <td><span className={`pill ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}{r.daysLate ? ` · ${r.daysLate} days` : ''}</span>{r.lateFeeWaivedOn && <span className="pill pill-green ml-1">Fee waived</span>}{r.note && <span className="block text-xs text-gray-600 max-w-xs">{r.note}</span>}</td>
                  <td className="pr-4 text-xs">{r.reported
                    ? <span className="text-red-400" title={r.pastDueAtStatement ? `${r.pastDueAtStatement.days} days past due on the ${fmtDate(r.pastDueAtStatement.date, 'MMM d')} statement` : undefined}>Reported {r.reported} days late</span>
                    : r.status === 'LATE' || r.status === 'PAST_DUE'
                      ? <span className="text-gray-500">{r.pastDueAtStatement ? `${r.pastDueAtStatement.days} day${r.pastDueAtStatement.days === 1 ? '' : 's'} past due on the ${fmtDate(r.pastDueAtStatement.date, 'MMM d')} statement` : r.status === 'LATE' ? 'Paid before the next statement' : 'Not past due on a statement date yet'} — not reported</span>
                      : <span className="text-gray-600">—</span>}</td>
                </tr>
              ))}
              {!h.history.length && <tr><td colSpan={6} className="pl-4 text-sm text-gray-500">No statements yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {(h.lateEvents.length > 0 || h.returned.length > 0) && (
          <div className="mt-2 space-y-1 text-xs text-gray-400">
            {h.lateEvents.map((e, i) => <p key={i}>Late fee {fmtMoney(e.fee)} charged {fmtDate(e.date, 'MMM d, yyyy')}{e.forDueDate ? ` for the ${fmtDate(e.forDueDate, 'MMM d')} due date` : ' (for a statement not on file)'}{e.waived ? <span className="text-emerald-400"> — waived (credited back {fmtDate(e.waivedOn!, 'MMM d, yyyy')})</span> : <span className="text-red-400"> — not refunded; you can call and ask</span>}.</p>)}
            {h.returned.map((r, i) => <p key={i} className="text-red-400/90">Payment of {fmtMoney(r.amount)} on {fmtDate(r.paidOn, 'MMM d, yyyy')} was returned on {fmtDate(r.returnedOn, 'MMM d')}.</p>)}
          </div>
        )}
      </section>

      <section>
        <p className="text-sm font-semibold text-white mb-2">What this card has cost</p>
        <div className="card overflow-x-auto">
          <table className="table-base">
            <thead><tr><th className="pl-4">Statement month</th><th className="text-right">Interest</th><th className="text-right">Late fees</th><th className="text-right">Other fees</th><th className="text-right">Refunded</th><th className="text-right pr-4">Net</th></tr></thead>
            <tbody>
              {h.costs.map(c => (
                <tr key={c.month}>
                  <td className="pl-4 text-white">{fmtDate(`${c.month}-01`, 'MMM yyyy')}</td>
                  <td className="text-right">{m(c.interest)}</td><td className="text-right">{m(c.lateFees)}</td><td className="text-right">{m(c.otherFees)}</td>
                  <td className="text-right text-emerald-400">{c.refunds ? `−${fmtMoney(c.refunds)}` : '—'}</td>
                  <td className="text-right pr-4 text-white">{fmtMoney(c.interest + c.lateFees + c.otherFees - c.refunds)}</td>
                </tr>
              ))}
              {h.costs.length > 0 && (
                <tr className="border-t border-white/10">
                  <td className="pl-4 text-gray-400">All on file</td>
                  <td className="text-right">{fmtMoney(h.allTime.interest)}</td><td className="text-right">{fmtMoney(h.allTime.lateFees)}</td><td className="text-right">{fmtMoney(h.allTime.otherFees)}</td>
                  <td className="text-right text-emerald-400">−{fmtMoney(h.allTime.refunds)}</td><td className="text-right pr-4 text-white font-medium">{fmtMoney(h.allTime.net)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
