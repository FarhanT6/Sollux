import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getCreditCards, createCardFromBankAccount, getLoans, getExpenses, type CreditCardT, type CardsSummary } from '../api/client';
import type { Loan } from '../types';
import { PageHeader, EmptyState } from '../components/ui';
import PersonalExpensesPage from './PersonalExpensesPage';
import CardEditor from '../components/cards/CardEditor';
import StatementImport from '../components/cards/StatementImport';
import { fmtMoney } from '../lib/money';
import { fmtDate } from '../lib/date';
import { simulatePayoff, type Strategy } from '../lib/payoff';

/**
 * Personal finance, apart from the rental portfolio: credit cards, personal
 * expenses and personal loans, and an overview across them.
 */

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'cards', label: 'Credit cards' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'loans', label: 'Loans' },
] as const;
type TabKey = typeof TABS[number]['key'];

export const STATUS_PILL: Record<string, { label: string; pill: string }> = {
  PAID_IN_FULL: { label: 'Paid in full', pill: 'pill-green' }, NO_BALANCE: { label: 'No balance', pill: 'pill-green' },
  MINIMUM_MET: { label: 'Minimum paid', pill: 'pill-amber' }, DUE: { label: 'Due', pill: 'pill-gray' }, PAST_DUE: { label: 'Past due', pill: 'pill-red' },
};
export const utilTone = (u: number | null) => (u == null ? 'text-gray-400' : u >= 50 ? 'text-red-400' : u >= 30 ? 'text-amber-400' : 'text-emerald-400');
const monthsUntil = (iso?: string | null) => (iso ? Math.max(0, Math.round((+new Date(iso) - Date.now()) / (30.44 * 86400000))) : null);

function UtilBar({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const color = pct >= 50 ? '#ef4444' : pct >= 30 ? '#f59e0b' : '#10b981';
  return (
    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
      <div className="h-full" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
    </div>
  );
}

function CardsTab({ cards, summary, sources, reload }: { cards: CreditCardT[]; summary: CardsSummary; sources: { id: string; name: string; last4?: string | null }[]; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [budget, setBudget] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const nav = useNavigate();
  const open = cards.filter(c => c.status !== 'CLOSED');

  const payoff = useMemo(() => {
    const debtCards = open.filter(c => c.position.balance > 0).map(c => ({
      id: c.id, name: c.name, balance: c.position.balance, apr: Number(c.purchaseApr ?? c.position.apr ?? 0),
      promoApr: c.position.introActive ? Number(c.introApr ?? 0) : null, promoEndsInMonths: c.position.introActive ? monthsUntil(c.introAprEndDate) : null,
      minimum: c.position.minimumPayment,
    }));
    const minTotal = debtCards.reduce((t, c) => t + c.minimum, 0);
    const b = Number(budget) || Math.ceil(minTotal * 1.5);
    if (!debtCards.length) return null;
    return { b, minTotal, avalanche: simulatePayoff(debtCards, b, 'avalanche'), snowball: simulatePayoff(debtCards, b, 'snowball'), minimumsOnly: simulatePayoff(debtCards, minTotal, 'avalanche') };
  }, [open, budget]);

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap">
        <button onClick={() => { setImporting(true); setAdding(false); }} className="btn btn-primary text-xs">Upload a statement</button>
        <button onClick={() => { setAdding(true); setImporting(false); }} className="btn text-xs">+ Add card by hand</button>
      </div>
      {importing && <StatementImport cards={cards} onDone={async id => { setImporting(false); await reload(); if (id) nav(`/personal/cards/${id}`); }} />}
      {adding && <CardEditor onDone={async c => { setAdding(false); await reload(); if (c) nav(`/personal/cards/${c.id}`); }} />}

      {sources.length > 0 && (
        <div className="card p-3 mb-4 text-xs text-gray-400 flex items-center gap-2 flex-wrap">
          <span>Cards already saved as payment sources:</span>
          {sources.map(s => <button key={s.id} onClick={async () => { await createCardFromBankAccount(s.id); await reload(); }} className="btn text-xs">+ {s.name}{s.last4 ? ` ••${s.last4}` : ''}</button>)}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-5">
        <div className="stat-card"><p className="text-xs text-gray-500">Card debt</p><p className="text-lg font-semibold text-white">{fmtMoney(summary.debt)}</p><p className="text-xs text-gray-500">{summary.cards} open cards</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Utilization</p><p className={`text-lg font-semibold ${utilTone(summary.utilization)}`}>{summary.utilization != null ? `${summary.utilization}%` : '—'}</p><p className="text-xs text-gray-500">of {fmtMoney(summary.limits)}</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Interest / month</p><p className={`text-lg font-semibold ${summary.monthlyInterest > 0 ? 'text-red-400' : 'text-white'}`}>{fmtMoney(summary.monthlyInterest)}</p><p className="text-xs text-gray-500">{fmtMoney(summary.interestYtd)} this year</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Minimums due in 30 days</p><p className="text-lg font-semibold text-white">{fmtMoney(summary.minimumsDue30d)}</p>{summary.pastDue > 0 && <p className="text-xs text-red-400">{summary.pastDue} past due</p>}</div>
        <div className="stat-card"><p className="text-xs text-gray-500">Rewards value</p><p className="text-lg font-semibold text-emerald-400">{fmtMoney(summary.rewardsValue)}</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Annual fees</p><p className="text-lg font-semibold text-white">{fmtMoney(summary.annualFees)}</p>{summary.promosEnding60d > 0 && <p className="text-xs text-amber-400">{summary.promosEnding60d} promo rate ending soon</p>}</div>
      </div>

      {cards.length === 0 ? <EmptyState icon="💳" title="No cards yet" body="Upload a statement and the card sets itself up, with its limit, rates, cycle, rewards and every transaction." />
        : (
          <div className="space-y-2 mb-6">
            {cards.filter(c => showClosed || c.status !== 'CLOSED').map(c => {
              const p = c.position;
              const st = p.statementStatus ? STATUS_PILL[p.statementStatus] : null;
              return (
                <Link key={c.id} to={`/personal/cards/${c.id}`} className="rounded-xl px-5 py-4 flex items-center gap-4 flex-wrap hover:opacity-90" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="w-56">
                    <p className="text-sm font-semibold text-white">{c.name}</p>
                    <p className="text-xs text-gray-500">{[c.network, c.last4 ? `••${c.last4}` : null].filter(Boolean).join(' ')}{c.isBusiness ? ' · business' : ''}{c.status !== 'ACTIVE' ? ` · ${c.status.toLowerCase()}` : ''}</p>
                  </div>
                  <div className="w-44">
                    <p className="text-base font-semibold text-white">{fmtMoney(p.balance)}</p>
                    <p className={`text-xs ${utilTone(p.utilization)}`}>{p.utilization != null ? `${p.utilization}% of ${fmtMoney(p.limit)}` : 'No limit on file'}</p>
                    <UtilBar pct={p.utilization} />
                  </div>
                  <div className="w-40 text-xs">
                    <p className="text-gray-400">{p.apr != null ? `${p.apr}% APR` : 'APR —'}{p.introActive ? <span className="text-emerald-400"> promo</span> : null}</p>
                    {p.promoEndsInDays != null && <p className={p.promoEndsInDays <= 60 ? 'text-amber-400' : 'text-gray-500'}>promo ends in {p.promoEndsInDays}d</p>}
                    {p.monthlyInterest > 0 && <p className="text-red-400">~{fmtMoney(p.monthlyInterest)}/mo interest</p>}
                  </div>
                  <div className="flex-1 text-xs">
                    {p.nextDueDate && <p className="text-gray-300">Due {fmtDate(p.nextDueDate, 'MMM d')}{p.minimumRemaining > 0 ? ` · min ${fmtMoney(p.minimumRemaining)}` : ''}{p.statementRemaining > 0 ? ` · statement ${fmtMoney(p.statementRemaining)}` : ''}</p>}
                    <p className="text-gray-500">{c.autopay !== 'NONE' ? `Autopay: ${c.autopay.replace('_', ' ').toLowerCase()}` : 'No autopay'}</p>
                  </div>
                  <div className="text-right">
                    {st && <span className={`pill ${st.pill}`}>{st.label}</span>}
                    {p.rewardsValue != null && <p className="text-xs text-emerald-500 mt-1">{fmtMoney(p.rewardsValue)} rewards</p>}
                  </div>
                </Link>
              );
            })}
            {cards.some(c => c.status === 'CLOSED') && <button onClick={() => setShowClosed(s => !s)} className="text-xs text-gray-500 hover:text-gray-300">{showClosed ? 'Hide' : 'Show'} closed cards</button>}
          </div>
        )}

      {payoff && (
        <div className="card p-4">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <p className="section-label mb-0">Payoff planner</p>
            <label className="text-xs text-gray-400 flex items-center gap-2">Pay toward cards each month
              <input type="number" step="10" className="input-dark text-sm w-32" value={budget} placeholder={String(payoff.b)} onChange={e => setBudget(e.target.value)} />
            </label>
          </div>
          {payoff.avalanche.shortfall > 0 ? (
            <p className="text-xs text-red-400">That is {fmtMoney(payoff.avalanche.shortfall)} less than the minimums ({fmtMoney(payoff.minTotal)}).</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {([['avalanche', 'Highest rate first', payoff.avalanche], ['snowball', 'Smallest balance first', payoff.snowball], ['min', 'Minimums only', payoff.minimumsOnly]] as [Strategy | 'min', string, ReturnType<typeof simulatePayoff>][]).map(([k, title, r]) => (
                <div key={k} className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <p className="text-xs text-gray-400">{title}{k === 'avalanche' ? ' (least interest)' : ''}</p>
                  <p className="text-base font-semibold text-white mt-1">{r.months == null ? 'Never paid off' : `${Math.floor(r.months / 12) ? `${Math.floor(r.months / 12)}y ` : ''}${r.months % 12}m`}</p>
                  <p className="text-xs text-red-400">{fmtMoney(r.totalInterest)} interest</p>
                  {k !== 'min' && r.months != null && (
                    <ul className="mt-2 space-y-0.5">{[...r.perCard].sort((a, b) => (a.paidOffMonth ?? 999) - (b.paidOffMonth ?? 999)).map(pc => <li key={pc.id} className="text-xs text-gray-500 flex justify-between"><span className="truncate">{pc.name}</span><span>month {pc.paidOffMonth}</span></li>)}</ul>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-600 mt-2">Assumes no new charges, each card's minimum from its latest statement, and a promotional rate until it ends.</p>
        </div>
      )}
    </div>
  );
}

function LoansTab() {
  const [loans, setLoans] = useState<Loan[] | null>(null);
  useEffect(() => { void getLoans({ isPersonal: true }).then(l => setLoans(l as any)); }, []);
  if (loans == null) return <p className="text-sm text-gray-500">Loading…</p>;
  if (!loans.length) return <EmptyState icon="🧾" title="No personal loans" body="Auto loans, student loans and personal loans marked Personal on the Loans tab appear here." />;
  const total = loans.reduce((t, l: any) => t + Number(l.currentBalance ?? 0), 0);
  const monthly = loans.reduce((t, l: any) => t + Number(l.monthlyPayment ?? 0), 0);
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 mb-4 max-w-md">
        <div className="stat-card"><p className="text-xs text-gray-500">Owed</p><p className="text-lg font-semibold text-white">{fmtMoney(total)}</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Monthly payments</p><p className="text-lg font-semibold text-white">{fmtMoney(monthly)}</p></div>
      </div>
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th className="pl-4">Lender</th><th>Type</th><th className="text-right">Balance</th><th className="text-right">Rate</th><th className="text-right">Monthly</th><th className="pr-4"></th></tr></thead>
          <tbody>{loans.map((l: any) => (
            <tr key={l.id}><td className="pl-4 text-white">{l.lender}</td><td className="text-gray-400">{String(l.loanType).replace('_', ' ').toLowerCase()}</td>
              <td className="text-right">{l.currentBalance != null ? fmtMoney(l.currentBalance) : '—'}</td><td className="text-right text-gray-400">{l.interestRate != null ? `${Number(l.interestRate)}%` : '—'}</td>
              <td className="text-right">{l.monthlyPayment != null ? fmtMoney(l.monthlyPayment) : '—'}</td><td className="pr-4 text-right"><Link to={`/loans/${l.id}`} className="text-xs text-gray-500 hover:text-gray-300">Open</Link></td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function OverviewTab({ cards, summary, go }: { cards: CreditCardT[]; summary: CardsSummary; go: (t: TabKey) => void }) {
  const [loans, setLoans] = useState<any[]>([]);
  const [spent, setSpent] = useState<{ month: number; last: number } | null>(null);
  useEffect(() => {
    void getLoans({ isPersonal: true }).then(l => setLoans(l as any));
    void getExpenses({ isPersonal: true } as any).then((ex: any[]) => {
      const now = new Date(); const ym = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
      const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const sum = (k: string) => ex.filter(e => ym(new Date(e.date)) === k).reduce((t, e) => t + Number(e.amount), 0);
      setSpent({ month: sum(ym(now)), last: sum(ym(last)) });
    }).catch(() => {});
  }, []);
  const loanDebt = loans.reduce((t, l) => t + Number(l.currentBalance ?? 0), 0);
  const upcoming = cards.filter(c => c.status !== 'CLOSED' && c.position.nextDueDate && (c.position.minimumRemaining > 0 || c.position.statementRemaining > 0))
    .sort((a, b) => +new Date(a.position.nextDueDate!) - +new Date(b.position.nextDueDate!));
  const alerts = [
    ...cards.filter(c => c.position.statementStatus === 'PAST_DUE').map(c => ({ tone: 'text-red-400', text: `${c.name} is past due — ${fmtMoney(c.position.minimumRemaining)} minimum`, id: c.id })),
    ...cards.filter(c => c.position.promoEndsInDays != null && c.position.promoEndsInDays <= 60).map(c => ({ tone: 'text-amber-400', text: `${c.name}: promotional rate ends in ${c.position.promoEndsInDays} days; ${fmtMoney(c.position.balance)} will start accruing at ${c.purchaseApr ?? '?'}%`, id: c.id })),
    ...cards.filter(c => (c.position.utilization ?? 0) >= 30).map(c => ({ tone: 'text-amber-400', text: `${c.name} is at ${c.position.utilization}% utilization. Below 30% is better for your credit score`, id: c.id })),
    ...cards.filter(c => c.position.nextAnnualFee && (+new Date(c.position.nextAnnualFee) - Date.now()) < 45 * 86400000).map(c => ({ tone: 'text-gray-300', text: `${c.name}: ${fmtMoney(c.annualFee)} annual fee posts ${fmtDate(c.position.nextAnnualFee!, 'MMMM yyyy')}`, id: c.id })),
  ];
  return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <button onClick={() => go('cards')} className="stat-card text-left"><p className="text-xs text-gray-500">Credit card debt</p><p className="text-lg font-semibold text-white">{fmtMoney(summary.debt)}</p><p className={`text-xs ${utilTone(summary.utilization)}`}>{summary.utilization != null ? `${summary.utilization}% utilization` : ''}</p></button>
        <button onClick={() => go('loans')} className="stat-card text-left"><p className="text-xs text-gray-500">Personal loans</p><p className="text-lg font-semibold text-white">{fmtMoney(loanDebt)}</p><p className="text-xs text-gray-500">{loans.length} loans</p></button>
        <div className="stat-card"><p className="text-xs text-gray-500">Total personal debt</p><p className="text-lg font-semibold text-white">{fmtMoney(summary.debt + loanDebt)}</p></div>
        <button onClick={() => go('expenses')} className="stat-card text-left"><p className="text-xs text-gray-500">Personal expenses this month</p><p className="text-lg font-semibold text-white">{spent ? fmtMoney(spent.month) : '—'}</p><p className="text-xs text-gray-500">{spent ? `${fmtMoney(spent.last)} last month` : ''}</p></button>
      </div>
      {alerts.length > 0 && (
        <div className="card p-4 mb-5 space-y-1.5">
          <p className="section-label">Needs attention</p>
          {alerts.map((a, i) => <Link key={i} to={`/personal/cards/${a.id}`} className={`block text-sm ${a.tone} hover:underline`}>{a.text}</Link>)}
        </div>
      )}
      <div className="card p-4">
        <p className="section-label">Card payments coming up</p>
        {upcoming.length === 0 ? <p className="text-sm text-gray-500">Nothing due.</p> : upcoming.map(c => (
          <Link key={c.id} to={`/personal/cards/${c.id}`} className="flex items-center gap-3 text-sm py-1">
            <span className={`w-24 text-xs ${c.position.statementStatus === 'PAST_DUE' ? 'text-red-400' : 'text-gray-300'}`}>{fmtDate(c.position.nextDueDate!, 'MMM d')}</span>
            <span className="flex-1 text-gray-200">{c.name}</span>
            <span className="text-xs text-gray-500 w-40 text-right">{c.autopay !== 'NONE' ? 'autopay on' : 'pay manually'}</span>
            <span className="w-32 text-right text-white">{fmtMoney(c.position.minimumRemaining)} min</span>
            <span className="w-36 text-right text-gray-400">{fmtMoney(c.position.statementRemaining)} statement</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function PersonalPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabKey) || 'overview';
  const [data, setData] = useState<Awaited<ReturnType<typeof getCreditCards>> | null>(null);
  const reload = async () => setData(await getCreditCards());
  useEffect(() => { void reload(); }, []);
  const go = (t: TabKey) => setParams({ tab: t });
  return (
    <div>
      <PageHeader title="Personal" subtitle="Your own money, apart from the rental portfolio: credit cards, expenses and loans" />
      <div className="px-6 pt-4 flex gap-1 flex-wrap">
        {TABS.map(t => (
          <button key={t.key} onClick={() => go(t.key)} className={`text-xs px-3 py-1.5 rounded-lg font-medium ${tab === t.key ? 'bg-gold-500 text-white' : 'text-gray-400 hover:text-gray-200'}`}
            style={tab === t.key ? undefined : { background: 'rgba(255,255,255,0.05)' }}>{t.label}</button>
        ))}
      </div>
      <div className="px-6 py-5">
        {tab === 'expenses' ? <PersonalExpensesPage embedded />
          : tab === 'loans' ? <LoansTab />
          : data == null ? <p className="text-sm text-gray-500">Loading…</p>
          : tab === 'cards' ? <CardsTab cards={data.cards} summary={data.summary} sources={data.paymentSourceCards} reload={reload} />
          : <OverviewTab cards={data.cards} summary={data.summary} go={go} />}
      </div>
    </div>
  );
}
