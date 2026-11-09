import { useMemo, useState } from 'react';
import type { CardPaymentT, CardStatementT } from '../../api/client';
import { fmtMoney } from '../../lib/money';
import { fmtDate } from '../../lib/date';

/**
 * A card's payments, with an overview first: for a period (the last 12 months,
 * a year, or everything on file) what was paid, how much of it the interest
 * and fees took, how the balance moved, and month by month paid against
 * interest and fees. Below it the payments themselves, by year.
 */
const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const n = (v: unknown) => Number(v ?? 0) || 0;

export default function CardPayments({ payments, statements, onDelete }: {
  payments: CardPaymentT[]; statements: CardStatementT[]; onDelete: (id: string) => void;
}) {
  const today = isoDay(Date.now());
  const since12 = isoDay(Date.now() - 365 * DAY);
  const years = useMemo(() => [...new Set([...payments.map(p => p.date.slice(0, 4)), ...statements.map(s => s.closingDate.slice(0, 4))])].sort().reverse(), [payments, statements]);
  const [period, setPeriod] = useState('12m');
  const inDay = (d: string) => period === 'all' || (period === '12m' ? d.slice(0, 10) > since12 && d.slice(0, 10) <= today : d.startsWith(period));

  const pays = payments.filter(p => inDay(p.date));
  const sts = statements.filter(s => !(s as { fromEmail?: boolean }).fromEmail && inDay(s.closingDate)).sort((a, b) => a.closingDate.localeCompare(b.closingDate));
  const paid = pays.reduce((t, p) => t + n(p.amount), 0);
  const returned = pays.filter(p => n(p.amount) < 0).reduce((t, p) => t - n(p.amount), 0);
  const count = pays.filter(p => n(p.amount) > 0).length;
  const interest = sts.reduce((t, s) => t + n(s.interestCharged), 0);
  const fees = sts.reduce((t, s) => t + n(s.feesCharged), 0);
  const toBalance = paid - interest - fees;
  // The balance over the period: before its first statement, and at its last.
  const first = sts[0], last = sts[sts.length - 1];
  const startBal = first ? (first.previousBalance != null ? n(first.previousBalance) : n(first.newBalance)) : null;
  const endBal = last ? n(last.newBalance) : null;

  // Month by month: paid, and the interest and fees charged on that month's statement.
  const months = useMemo(() => {
    const by = new Map<string, { paid: number; cost: number }>();
    for (const p of pays) { const k = p.date.slice(0, 7); const r = by.get(k) ?? { paid: 0, cost: 0 }; r.paid += n(p.amount); by.set(k, r); }
    for (const s of sts) { const k = s.closingDate.slice(0, 7); const r = by.get(k) ?? { paid: 0, cost: 0 }; r.cost += n(s.interestCharged) + n(s.feesCharged); by.set(k, r); }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-24);
  }, [pays, sts]);
  const top = Math.max(1, ...months.map(([, v]) => Math.max(v.paid, v.cost)));

  // The list, newest first, by year.
  const byYear = useMemo(() => {
    const g = new Map<string, CardPaymentT[]>();
    for (const p of [...pays].sort((a, b) => b.date.localeCompare(a.date))) { const y = p.date.slice(0, 4); g.set(y, [...(g.get(y) ?? []), p]); }
    return [...g.entries()];
  }, [pays]);

  return (
    <div className="space-y-4">
      <div className="flex gap-1 flex-wrap">
        {[{ id: '12m', label: 'Last 12 months' }, ...years.map(y => ({ id: y, label: y })), { id: 'all', label: 'All on file' }].map(o => (
          <button key={o.id} onClick={() => setPeriod(o.id)} className={`text-xs px-2.5 py-1 rounded-lg ${period === o.id ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`} style={{ background: period === o.id ? 'rgba(255,255,255,0.08)' : 'transparent' }}>{o.label}</button>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="stat-card"><p className="text-xs text-gray-500">Paid</p><p className="text-lg font-semibold text-emerald-400">{fmtMoney(paid)}</p><p className="text-xs text-gray-500">{count} payment{count === 1 ? '' : 's'}{count ? ` · ${fmtMoney(paid / count)} average` : ''}{returned ? ` · ${fmtMoney(returned)} returned` : ''}</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Interest & fees charged</p><p className={`text-lg font-semibold ${interest + fees ? 'text-red-400' : 'text-white'}`}>{fmtMoney(interest + fees)}</p><p className="text-xs text-gray-500">{paid > 0 ? `${Math.round(((interest + fees) / paid) * 100)}% of what was paid` : `${fmtMoney(interest)} interest · ${fmtMoney(fees)} fees`}</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Went to the balance</p><p className={`text-lg font-semibold ${toBalance > 0 ? 'text-white' : 'text-amber-400'}`}>{fmtMoney(toBalance)}</p><p className="text-xs text-gray-500">paid less interest and fees</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Balance</p><p className="text-lg font-semibold text-white">{endBal != null ? fmtMoney(endBal) : '—'}</p><p className="text-xs text-gray-500">{startBal != null && endBal != null ? `${endBal <= startBal ? 'down' : 'up'} ${fmtMoney(Math.abs(endBal - startBal))} from ${fmtMoney(startBal)}` : 'no statements in this period'}</p></div>
      </div>

      {months.length > 0 && (
        <div className="card p-4">
          <div className="flex items-center gap-4 text-xs text-gray-500 mb-3">
            <span className="text-sm font-semibold text-white mr-auto">Month by month</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500/80" /> Paid</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-400/80" /> Interest & fees</span>
          </div>
          <div className="flex items-end gap-1 h-28">
            {months.map(([k, v]) => (
              <div key={k} className="flex-1 flex items-end gap-px h-full min-w-0" title={`${fmtDate(`${k}-01`, 'MMM yyyy')}: paid ${fmtMoney(v.paid)} · interest & fees ${fmtMoney(v.cost)}`}>
                <div className="flex-1 rounded-sm bg-emerald-500/80" style={{ height: `${Math.max(v.paid > 0 ? 3 : 0, (v.paid / top) * 100)}%` }} />
                <div className="flex-1 rounded-sm bg-red-400/80" style={{ height: `${Math.max(v.cost > 0 ? 3 : 0, (v.cost / top) * 100)}%` }} />
              </div>
            ))}
          </div>
          <div className="flex gap-1 mt-1 text-[10px] text-gray-600">
            {months.map(([k], i) => <div key={k} className="flex-1 text-center min-w-0 truncate">{i % Math.ceil(months.length / 8) === 0 ? fmtDate(`${k}-01`, months.length > 12 ? 'MMM yy' : 'MMM') : ''}</div>)}
          </div>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th className="pl-4">Date</th><th className="text-right">Amount</th><th>From</th><th>Confirmation</th><th className="pr-4"></th></tr></thead>
          <tbody>
            {byYear.map(([y, rows]) => [
              <tr key={`y-${y}`} style={{ background: 'rgba(255,255,255,0.03)' }}>
                <td className="pl-4 text-gray-300 font-medium">{y}</td>
                <td className="text-right text-gray-300 font-medium">{fmtMoney(rows.reduce((t, p) => t + n(p.amount), 0))}</td>
                <td colSpan={3} className="text-xs text-gray-500">{rows.filter(p => n(p.amount) > 0).length} payment{rows.filter(p => n(p.amount) > 0).length === 1 ? '' : 's'}</td>
              </tr>,
              ...rows.map(pm => (
                <tr key={pm.id}>
                  <td className="pl-4 text-white">{fmtDate(pm.date, 'MMM d, yyyy')}</td>
                  <td className={`text-right ${n(pm.amount) < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{fmtMoney(pm.amount)}{n(pm.amount) < 0 && <span className="block text-xs">returned</span>}</td>
                  <td className="text-gray-400">{pm.fromBankAccountName ?? (pm.method === 'On statement' ? <span className="text-xs text-gray-500" title={pm.notes ?? ''}>On the statement — log it to add the bank account</span> : '—')}{pm.postedStatementId && pm.method !== 'On statement' && <span className="block text-xs text-gray-600">✓ on its statement</span>}</td>
                  <td className="text-gray-400">{pm.confirmation ?? '—'}</td>
                  <td className="pr-4 text-right"><button onClick={() => onDelete(pm.id)} className="text-xs text-gray-600 hover:text-red-400">✕</button></td>
                </tr>
              )),
            ])}
            {!pays.length && <tr><td colSpan={5} className="pl-4 text-sm text-gray-500">{payments.length ? 'No payments in this period.' : 'No payments logged. Use "Log payment" above; each one counts against the statement before it.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
