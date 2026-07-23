import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { getLoan, getLoanAmortization } from '../api/client';
import type { Loan } from '../types';
import { format } from 'date-fns';

const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const moneyPrecise = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

const BALANCE_METHOD_LABELS: Record<string, string> = {
  balance_after: 'From most recent payment record',
  payment_sum: 'Calculated from recorded principal payments',
  theoretical: 'Projected from origination date (no payment history on file)',
  manual: 'Manually entered — no calculation basis available',
};

interface AmortizationResponse {
  balance: { balance: number; asOfDate: string; method: string };
  amortization: {
    isAmortizing: boolean;
    monthlyRate: number;
    computedMonthlyPayment: number;
    negativeAmortization: boolean;
    schedule: { paymentNumber: number; date: string; paymentAmount: number; principal: number; interest: number; balance: number }[];
    payoffDate: string | null;
    monthsRemaining: number | null;
    totalInterestRemaining: number;
    totalPaidToDate: number;
    totalInterestToDate: number;
  };
}

export default function LoanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [loan, setLoan] = useState<Loan | null>(null);
  const [amort, setAmort] = useState<AmortizationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [showFullSchedule, setShowFullSchedule] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([getLoan(id), getLoanAmortization(id)])
      .then(([l, a]) => { setLoan(l); setAmort(a as AmortizationResponse); })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  if (!loan || !amort) return <div className="p-6 text-gray-500 text-sm">Loan not found</div>;

  const { balance, amortization } = amort;

  // Build chart data: past payments (actual) + forward projection (schedule).
  const history = (loan.loanPayments || [])
    .filter(p => p.balanceAfter != null)
    .slice()
    .reverse()
    .map(p => ({ date: p.date, balance: Number(p.balanceAfter), kind: 'actual' as const }));
  const projected = amortization.schedule
    .filter((_, i) => i % Math.max(1, Math.floor(amortization.schedule.length / 60)) === 0 || i === amortization.schedule.length - 1)
    .map(r => ({ date: r.date, balance: r.balance, kind: 'projected' as const }));
  const chartData = [...history, { date: balance.asOfDate, balance: balance.balance, kind: 'actual' as const }, ...projected];

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-1">
        <div>
          <Link to="/loans" className="text-xs text-gray-500 hover:text-gray-300">&larr; Loans</Link>
          <h1 className="text-xl font-semibold text-white mt-1">{loan.lender}</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {loan.loanType.replace('_', ' ')}
            {loan.accountLast4 && <span> &middot; &middot;&middot;&middot;{loan.accountLast4}</span>}
            {loan.property && (
              <> &middot; <Link to={`/properties/${loan.property.id}`} className="text-amber-400 hover:text-amber-300">{loan.property.nickname || loan.property.address}</Link></>
            )}
          </p>
        </div>
        <div className="flex gap-1.5">
          {loan.isPersonal && <span className="pill pill-purple">Personal</span>}
          {!loan.isActive && <span className="pill pill-gray">Closed</span>}
        </div>
      </div>

      {amortization.negativeAmortization && (
        <div className="mt-4 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">
          The payment on file doesn't cover the monthly interest — this loan's balance will grow, not shrink, at the current payment amount. No payoff date can be projected until the payment increases.
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mt-5 mb-6">
        <div className="stat-card">
          <p className="text-xs text-gray-500 mb-1">Current balance</p>
          <p className="text-xl font-semibold text-red-400">{money(balance.balance)}</p>
          <p className="text-xs text-gray-600 mt-1">{BALANCE_METHOD_LABELS[balance.method]}</p>
        </div>
        <div className="stat-card">
          <p className="text-xs text-gray-500 mb-1">Monthly payment</p>
          <p className="text-xl font-semibold text-white">{money(loan.monthlyPayment ?? amortization.computedMonthlyPayment)}</p>
          {!loan.monthlyPayment && <p className="text-xs text-gray-600 mt-1">Estimated (none on file)</p>}
        </div>
        <div className="stat-card">
          <p className="text-xs text-gray-500 mb-1">Payoff date</p>
          <p className={`text-xl font-semibold ${amortization.payoffDate ? 'text-green-400' : 'text-gray-500'}`}>
            {amortization.payoffDate ? format(new Date(amortization.payoffDate), 'MMM yyyy') : '—'}
          </p>
          {amortization.monthsRemaining && <p className="text-xs text-gray-600 mt-1">{amortization.monthsRemaining} payments left</p>}
        </div>
        <div className="stat-card">
          <p className="text-xs text-gray-500 mb-1">Interest rate</p>
          <p className="text-xl font-semibold text-white">{loan.interestRate != null ? `${loan.interestRate}%` : '—'}</p>
          <p className="text-xs text-gray-600 mt-1">{money(amortization.totalInterestRemaining)} interest remaining</p>
        </div>
      </div>

      {/* Balance over time chart */}
      {chartData.length > 1 && (
        <div className="card p-4 mb-6">
          <p className="text-xs text-gray-500 mb-3">Balance over time, including the projected payoff path at current terms</p>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f87171" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#f87171" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={d => format(new Date(d), 'MMM yy')}
                stroke="#6b7280"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                minTickGap={40}
              />
              <YAxis
                tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
                stroke="#6b7280"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <Tooltip
                contentStyle={{ background: '#242424', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                labelFormatter={d => format(new Date(d), 'MMM d, yyyy')}
                formatter={(v: number) => [moneyPrecise(v), 'Balance']}
              />
              <Area type="monotone" dataKey="balance" stroke="#f87171" strokeWidth={2} fill="url(#balanceFill)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Amortization schedule */}
      {amortization.isAmortizing && amortization.schedule.length > 0 && (
        <div className="card p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-white">Remaining amortization schedule</p>
            {amortization.schedule.length > 12 && (
              <button onClick={() => setShowFullSchedule(v => !v)} className="text-xs text-amber-400 hover:text-amber-300">
                {showFullSchedule ? 'Show less' : `Show all ${amortization.schedule.length}`}
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="text-right">Payment</th>
                  <th className="text-right">Principal</th>
                  <th className="text-right">Interest</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {(showFullSchedule ? amortization.schedule : amortization.schedule.slice(0, 12)).map(row => (
                  <tr key={row.paymentNumber}>
                    <td>{format(new Date(row.date), 'MMM yyyy')}</td>
                    <td className="text-right font-mono">{moneyPrecise(row.paymentAmount)}</td>
                    <td className="text-right font-mono text-green-400">{moneyPrecise(row.principal)}</td>
                    <td className="text-right font-mono text-gray-400">{moneyPrecise(row.interest)}</td>
                    <td className="text-right font-mono">{moneyPrecise(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Payment history */}
      <div className="card p-4">
        <p className="text-sm font-medium text-white mb-3">Payment history</p>
        {(!loan.loanPayments || loan.loanPayments.length === 0) ? (
          <p className="text-xs text-gray-600 py-4 text-center">No payments recorded yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Principal</th>
                  <th className="text-right">Interest</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {loan.loanPayments.map(p => (
                  <tr key={p.id}>
                    <td>{format(new Date(p.date), 'MMM d, yyyy')}</td>
                    <td className="text-right font-mono">{moneyPrecise(p.amount)}</td>
                    <td className="text-right font-mono text-green-400">{p.principal != null ? moneyPrecise(p.principal) : '—'}</td>
                    <td className="text-right font-mono text-gray-400">{p.interest != null ? moneyPrecise(p.interest) : '—'}</td>
                    <td>
                      <span className={`pill ${p.status === 'PAID' ? 'pill-green' : p.status === 'PAST_DUE' ? 'pill-red' : 'pill-amber'}`}>
                        {p.status.replace('_', ' ')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
