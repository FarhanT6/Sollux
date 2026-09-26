import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  getCreditCard, getCreditCards, deleteCreditCard, updateCreditCard, deleteCardStatement, cardStatementUrl, getCardTransactions, updateCardTransaction,
  deleteCardTransaction, cardTransactionToExpense, createCardTransaction, createCardPayment, deleteCardPayment, getBankAccounts, getProperties,
  type CreditCardT, type CardTxnT,
} from '../api/client';
import type { Property } from '../types';
import { EXPENSE_CATEGORY_LABELS } from '../types';
import { PageHeader } from '../components/ui';
import CardEditor from '../components/cards/CardEditor';
import StatementImport from '../components/cards/StatementImport';
import { STATUS_PILL, utilTone } from './PersonalPage';
import { fmtMoney } from '../lib/money';
import { fmtDate, todayISO } from '../lib/date';

/**
 * One credit card, in full: its position now, every term, statements,
 * transactions and payments. A charge that was for a property moves into
 * that property's expenses from here.
 */

const TABS = ['overview', 'statements', 'transactions', 'payments'] as const;
type Tab = typeof TABS[number];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TXN_CATEGORIES = ['Groceries', 'Dining', 'Gas', 'Travel', 'Shopping', 'Utilities', 'Home improvement', 'Insurance', 'Medical', 'Subscriptions', 'Entertainment', 'Services', 'Fees & interest', 'Other'];
const pct = (v: unknown) => (v == null || v === '' ? '—' : `${Number(v)}%`);
const m = (v: unknown) => (v == null || v === '' ? '—' : fmtMoney(v as any));
const AUTOPAY: Record<string, string> = { NONE: 'Off', MINIMUM: 'Minimum payment', STATEMENT_BALANCE: 'Statement balance', FULL_BALANCE: 'Full balance', FIXED: 'Fixed amount' };

function Row({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) {
  return <div className="flex justify-between gap-3 py-1 text-sm" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}><span className="text-gray-500">{k}</span><span className={tone ?? 'text-gray-200'}>{v}</span></div>;
}

async function openUrl(get: () => Promise<string>) {
  const w = window.open('', '_blank');
  const url = await get();
  if (w) w.location.href = url; else window.location.href = url;
}

function Transactions({ card, properties }: { card: CreditCardT; properties: Property[] }) {
  const [rows, setRows] = useState<CardTxnT[] | null>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [statementId, setStatementId] = useState('');
  const [moving, setMoving] = useState<{ id: string; propertyId: string; category: string } | null>(null);
  const [adding, setAdding] = useState<{ date: string; description: string; amount: string; category: string } | null>(null);
  async function load() { setRows(await getCardTransactions(card.id, { q: q || undefined, category: category || undefined, statementId: statementId || undefined })); }
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [q, category, statementId, card.id]);
  const charged = (rows ?? []).filter(r => Number(r.amount) > 0).reduce((t, r) => t + Number(r.amount), 0);
  const credited = (rows ?? []).filter(r => Number(r.amount) < 0).reduce((t, r) => t - Number(r.amount), 0);
  const input = 'input-dark text-sm';

  return (
    <div>
      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <input className={`${input} w-56`} placeholder="Search merchant or description" value={q} onChange={e => setQ(e.target.value)} />
        <select className={input} value={category} onChange={e => setCategory(e.target.value)}><option value="">All categories</option>{TXN_CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
        <select className={input} value={statementId} onChange={e => setStatementId(e.target.value)}><option value="">All statements</option>{(card.statements ?? []).map(s => <option key={s.id} value={s.id}>{fmtDate(s.closingDate, 'MMM yyyy')}</option>)}</select>
        <span className="text-xs text-gray-500">{rows?.length ?? 0} shown · {fmtMoney(charged)} charged · {fmtMoney(credited)} credited</span>
        <button onClick={() => setAdding({ date: todayISO(), description: '', amount: '', category: 'Other' })} className="btn text-xs ml-auto">+ Add</button>
      </div>
      {adding && (
        <div className="card p-3 mb-3 flex gap-2 flex-wrap items-end">
          <input type="date" className={input} value={adding.date} onChange={e => setAdding({ ...adding, date: e.target.value })} />
          <input className={`${input} flex-1 min-w-[200px]`} placeholder="Description" value={adding.description} onChange={e => setAdding({ ...adding, description: e.target.value })} />
          <input type="number" step="0.01" className={`${input} w-28`} placeholder="Amount (− credit)" value={adding.amount} onChange={e => setAdding({ ...adding, amount: e.target.value })} />
          <select className={input} value={adding.category} onChange={e => setAdding({ ...adding, category: e.target.value })}>{TXN_CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
          <button onClick={() => setAdding(null)} className="btn text-xs">Cancel</button>
          <button onClick={async () => { if (!adding.description || !adding.amount) return; await createCardTransaction(card.id, { date: adding.date, description: adding.description, amount: Number(adding.amount), category: adding.category }); setAdding(null); await load(); }} className="btn btn-primary text-xs">Save</button>
        </div>
      )}
      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead><tr><th className="pl-4">Date</th><th>Merchant</th><th>Category</th><th className="text-right">Amount</th><th>Property</th><th className="pr-4"></th></tr></thead>
          <tbody>
            {(rows ?? []).map(t => (
              <tr key={t.id}>
                <td className="pl-4 whitespace-nowrap text-gray-400">{fmtDate(t.date, 'MMM d, yyyy')}</td>
                <td><span className="text-gray-200">{t.merchant || t.description}</span>{t.merchant && <span className="block text-xs text-gray-600 truncate max-w-xs">{t.description}</span>}{t.cardholder && <span className="block text-xs text-gray-600">{t.cardholder}</span>}</td>
                <td>
                  <select className="input-dark text-xs" value={t.category ?? ''} onChange={async e => { await updateCardTransaction(t.id, { category: e.target.value || null }); await load(); }}>
                    <option value="">—</option>{TXN_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </td>
                <td className={`text-right whitespace-nowrap ${Number(t.amount) < 0 ? 'text-emerald-400' : 'text-white'}`}>{fmtMoney(t.amount)}{t.kind !== 'PURCHASE' && <span className="block text-xs text-gray-600">{t.kind.replace('_', ' ').toLowerCase()}</span>}</td>
                <td className="text-xs">
                  {t.expenseId ? <span className="pill pill-green">Filed to {properties.find(p => p.id === t.propertyId)?.nickname || properties.find(p => p.id === t.propertyId)?.address || 'property'}</span>
                    : Number(t.amount) > 0 && (moving?.id === t.id ? (
                      <span className="flex gap-1 items-center">
                        <select className="input-dark text-xs" value={moving.propertyId} onChange={e => setMoving({ ...moving, propertyId: e.target.value })}><option value="">Property…</option>{properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}</select>
                        <select className="input-dark text-xs" value={moving.category} onChange={e => setMoving({ ...moving, category: e.target.value })}>{Object.entries(EXPENSE_CATEGORY_LABELS).filter(([k]) => !['AUTO_LOAN', 'AUTO_INSURANCE', 'CREDIT_CARD', 'MEDICAL', 'PHONE', 'STUDENT_LOAN', 'LIFE_INSURANCE', 'SUBSCRIPTIONS'].includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                        <button disabled={!moving.propertyId} onClick={async () => { await cardTransactionToExpense(t.id, { propertyId: moving.propertyId, category: moving.category }); setMoving(null); await load(); }} className="text-amber-400 disabled:opacity-40">✓</button>
                        <button onClick={() => setMoving(null)} className="text-gray-600">✕</button>
                      </span>
                    ) : <button onClick={() => setMoving({ id: t.id, propertyId: '', category: 'REPAIRS_MAINTENANCE' })} className="text-gray-500 hover:text-amber-400">→ property expense</button>)}
                </td>
                <td className="pr-4 text-right"><button onClick={async () => { if (confirm('Delete this transaction?')) { await deleteCardTransaction(t.id); await load(); } }} className="text-xs text-gray-600 hover:text-red-400">✕</button></td>
              </tr>
            ))}
            {rows && rows.length === 0 && <tr><td colSpan={6} className="pl-4 text-sm text-gray-500">No transactions. Upload a statement and they're read in.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function CreditCardPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const [card, setCard] = useState<CreditCardT | null>(null);
  const [cards, setCards] = useState<CreditCardT[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [banks, setBanks] = useState<{ id: string; name: string; last4?: string | null; accountType?: string }[]>([]);
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [paying, setPaying] = useState<{ date: string; amount: string; fromBankAccountId: string; confirmation: string } | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const nav = useNavigate();

  async function load() { setCard(await getCreditCard(id!)); }
  useEffect(() => { void load(); void getCreditCards().then(d => setCards(d.cards)); void getProperties().then(setProperties); void getBankAccounts().then((b: any) => setBanks(b)); }, [id]);
  const spendingCats = useMemo(() => Object.entries(card?.spending?.byCategory ?? {}).sort((a, b) => b[1] - a[1]), [card]);
  const spendingMonths = useMemo(() => Object.entries(card?.spending?.byMonth ?? {}).sort((a, b) => a[0].localeCompare(b[0])).slice(-12), [card]);
  if (!card) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  const p = card.position;
  const st = p.statementStatus ? STATUS_PILL[p.statementStatus] : null;
  const maxMonth = Math.max(1, ...spendingMonths.map(([, v]) => v));
  const catTotal = spendingCats.reduce((t, [, v]) => t + v, 0);

  return (
    <div>
      <PageHeader title={card.name} subtitle={[card.issuer, card.network, card.last4 ? `••${card.last4}` : null, card.cardholderName, card.isBusiness ? 'Business' : null, card.status !== 'ACTIVE' ? card.status.toLowerCase() : null].filter(Boolean).join(' · ')}
        breadcrumb={[{ label: 'Personal', href: '/personal?tab=cards' }, { label: card.name }]}
        action={<div className="flex gap-2"><button onClick={() => { setImporting(true); setEditing(false); }} className="btn btn-primary text-xs">Upload statement</button><button onClick={() => setPaying({ date: todayISO(), amount: p.statementRemaining ? String(p.statementRemaining) : '', fromBankAccountId: card.autopayFromBankAccountId ?? '', confirmation: '' })} className="btn text-xs">Log payment</button><button onClick={() => { setEditing(true); setImporting(false); }} className="btn text-xs">Edit card</button></div>} />
      <div className="px-6 py-5">
        {editing && <CardEditor card={card} onDone={async saved => { setEditing(false); if (saved) await load(); }} />}
        {importing && <StatementImport cards={cards} fixedCardId={card.id} onDone={async () => { setImporting(false); await load(); }} />}
        {paying && (
          <div className="card p-3 mb-4 flex gap-2 items-end flex-wrap">
            <div><span className="text-xs text-gray-500 block mb-1">Paid on</span><input type="date" className="input-dark text-sm" value={paying.date} onChange={e => setPaying({ ...paying, date: e.target.value })} /></div>
            <div><span className="text-xs text-gray-500 block mb-1">Amount</span><input type="number" step="0.01" className="input-dark text-sm w-32" value={paying.amount} onChange={e => setPaying({ ...paying, amount: e.target.value })} /></div>
            <div className="flex gap-1 pb-1">
              {p.minimumRemaining > 0 && <button onClick={() => setPaying({ ...paying, amount: String(p.minimumRemaining) })} className="text-xs px-2 py-1 rounded text-gray-400" style={{ background: 'rgba(255,255,255,0.05)' }}>Minimum {fmtMoney(p.minimumRemaining)}</button>}
              {p.statementRemaining > 0 && <button onClick={() => setPaying({ ...paying, amount: String(p.statementRemaining) })} className="text-xs px-2 py-1 rounded text-gray-400" style={{ background: 'rgba(255,255,255,0.05)' }}>Statement {fmtMoney(p.statementRemaining)}</button>}
              {p.balance > 0 && <button onClick={() => setPaying({ ...paying, amount: String(p.balance) })} className="text-xs px-2 py-1 rounded text-gray-400" style={{ background: 'rgba(255,255,255,0.05)' }}>Balance {fmtMoney(p.balance)}</button>}
            </div>
            <div><span className="text-xs text-gray-500 block mb-1">From</span><select className="input-dark text-sm" value={paying.fromBankAccountId} onChange={e => setPaying({ ...paying, fromBankAccountId: e.target.value })}><option value="">—</option>{banks.filter(b => b.accountType !== 'CREDIT_CARD').map(b => <option key={b.id} value={b.id}>{b.name}{b.last4 ? ` ••${b.last4}` : ''}</option>)}</select></div>
            <input className="input-dark text-sm flex-1 min-w-[140px]" placeholder="Confirmation #" value={paying.confirmation} onChange={e => setPaying({ ...paying, confirmation: e.target.value })} />
            <button onClick={() => setPaying(null)} className="btn text-xs">Cancel</button>
            <button onClick={async () => { if (!(Number(paying.amount) > 0)) return; await createCardPayment(card.id, { date: paying.date, amount: Number(paying.amount), fromBankAccountId: paying.fromBankAccountId || null, confirmation: paying.confirmation || null }); setPaying(null); await load(); }} className="btn btn-primary text-xs">Save payment</button>
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
          <div className="stat-card">
            <p className="text-xs text-gray-500">Balance</p>
            {balance == null
              ? <button onClick={() => setBalance(String(p.balance))} className="text-lg font-semibold text-white hover:underline" title="Update from your card app">{fmtMoney(p.balance)}</button>
              : <span className="flex gap-1"><input type="number" step="0.01" autoFocus className="input-dark text-sm w-28" value={balance} onChange={e => setBalance(e.target.value)} /><button onClick={async () => { await updateCreditCard(card.id, { currentBalance: balance === '' ? null : Number(balance) }); setBalance(null); await load(); }} className="text-amber-400 text-xs">Save</button></span>}
            <p className="text-xs text-gray-600">{p.balanceSource === 'ENTERED' ? `entered ${card.balanceAsOf ? fmtDate(card.balanceAsOf, 'MMM d') : ''}` : p.balanceSource === 'STATEMENT' ? 'from the statement, less payments since' : 'tap to enter'}</p>
          </div>
          <div className="stat-card"><p className="text-xs text-gray-500">Utilization</p><p className={`text-lg font-semibold ${utilTone(p.utilization)}`}>{p.utilization != null ? `${p.utilization}%` : '—'}</p><p className="text-xs text-gray-600">{fmtMoney(p.available)} available of {m(p.limit)}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Next payment</p><p className="text-lg font-semibold text-white">{p.nextDueDate ? fmtDate(p.nextDueDate, 'MMM d') : '—'}</p><p className="text-xs text-gray-600">{p.minimumRemaining > 0 ? `min ${fmtMoney(p.minimumRemaining)} · statement ${fmtMoney(p.statementRemaining)}` : st?.label ?? ''}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Interest</p><p className={`text-lg font-semibold ${p.monthlyInterest > 0 ? 'text-red-400' : 'text-white'}`}>{fmtMoney(p.monthlyInterest)}/mo</p><p className="text-xs text-gray-600">{fmtMoney(p.interestYtd)} this year · {fmtMoney(p.feesYtd)} fees</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Rewards</p><p className="text-lg font-semibold text-emerald-400">{p.rewardsValue != null ? fmtMoney(p.rewardsValue) : '—'}</p><p className="text-xs text-gray-600">{p.rewardsBalance != null ? `${Number(p.rewardsBalance).toLocaleString()} ${card.rewardsType === 'CASHBACK' ? 'cash back' : (card.rewardsType ?? 'points').toLowerCase()}` : ''}</p></div>
        </div>

        <div className="flex gap-1 mb-4">
          {TABS.map(t => <button key={t} onClick={() => setParams({ tab: t })} className={`text-xs px-3 py-1.5 rounded-lg capitalize ${tab === t ? 'text-white' : 'text-gray-500'}`} style={{ background: tab === t ? 'rgba(255,255,255,0.08)' : 'transparent' }}>{t}{t === 'statements' ? ` (${card.statements?.length ?? 0})` : t === 'payments' ? ` (${card.payments?.length ?? 0})` : ''}</button>)}
        </div>

        {tab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="card p-4">
              <p className="section-label">Rates</p>
              <Row k="Purchases" v={pct(card.purchaseApr)} />
              <Row k="Cash advances" v={pct(card.cashAdvanceApr)} />
              <Row k="Balance transfers" v={pct(card.balanceTransferApr)} />
              <Row k="Penalty" v={pct(card.penaltyApr)} />
              <Row k="Promotional" v={card.introApr != null ? `${pct(card.introApr)} on ${(card.introAprType ?? 'purchases').replace('_', ' ').toLowerCase()} until ${card.introAprEndDate ? fmtDate(card.introAprEndDate, 'MMM d, yyyy') : '?'}` : '—'} tone={p.introActive ? 'text-emerald-400' : undefined} />
              <p className="section-label mt-4">Cycle</p>
              <Row k="Statement closes" v={card.statementClosingDay ? `day ${card.statementClosingDay}${p.nextClosingDate ? ` · next ${fmtDate(p.nextClosingDate, 'MMM d')}` : ''}` : '—'} />
              <Row k="Payment due" v={card.paymentDueDay ? `day ${card.paymentDueDay}` : '—'} />
              <Row k="Autopay" v={`${AUTOPAY[card.autopay] ?? card.autopay}${card.autopay === 'FIXED' ? ` ${m(card.autopayAmount)}` : ''}${card.autopayFromName ? ` from ${card.autopayFromName}` : ''}`} tone={card.autopay === 'NONE' ? 'text-amber-400' : undefined} />
              <Row k="Last statement" v={p.latestClosingDate ? <>{fmtDate(p.latestClosingDate, 'MMM d, yyyy')} {st && <span className={`pill ${st.pill} ml-1`}>{st.label}</span>}</> : '—'} />
            </div>
            <div className="card p-4">
              <p className="section-label">Limits & fees</p>
              <Row k="Credit limit" v={m(p.limit)} />
              <Row k="Cash advance limit" v={m(card.cashAdvanceLimit)} />
              <Row k="Annual fee" v={card.annualFee ? `${fmtMoney(card.annualFee)}${card.annualFeeMonth ? ` in ${MONTHS[card.annualFeeMonth - 1]}` : ''}` : '—'} />
              <Row k="Late fee" v={m(card.lateFee)} />
              <Row k="Foreign transactions" v={pct(card.foreignTransactionFee)} />
              <Row k="Balance transfer fee" v={pct(card.balanceTransferFee)} />
              <Row k="Cash advance fee" v={pct(card.cashAdvanceFee)} />
              <p className="section-label mt-4">Rewards</p>
              <Row k="Program" v={card.rewardsProgram ?? '—'} />
              <Row k="Earns" v={card.rewardsEarnRates ?? '—'} />
              <Row k="Worth" v={card.rewardsCentsPerPoint != null ? `${Number(card.rewardsCentsPerPoint)}¢ each` : '—'} />
            </div>
            <div className="card p-4">
              <p className="section-label">Card</p>
              <Row k="Opened" v={card.openedDate ? fmtDate(card.openedDate, 'MMM yyyy') : '—'} />
              <Row k="Expires" v={card.expiration ?? '—'} />
              <Row k="Authorized users" v={(card.authorizedUsers ?? []).length ? (card.authorizedUsers ?? []).map(u => `${u.name}${u.last4 ? ` ••${u.last4}` : ''}`).join(', ') : '—'} />
              <Row k="Customer service" v={card.phone ?? '—'} />
              <Row k="Pay online" v={card.loginUrl ? <a href={card.loginUrl} target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">Open</a> : '—'} />
              {card.notes && <p className="text-xs text-gray-400 mt-2 whitespace-pre-line">{card.notes}</p>}
              <p className="section-label mt-4">Spending, last 12 months</p>
              {spendingCats.length === 0 ? <p className="text-xs text-gray-600">Upload statements to see where the money goes.</p> : (
                <>
                  <div className="flex items-end gap-1 h-16 mb-2">{spendingMonths.map(([k, v]) => <div key={k} title={`${k}: ${fmtMoney(v)}`} className="flex-1 bg-gold-500 rounded-sm" style={{ height: `${Math.max(4, (v / maxMonth) * 100)}%`, opacity: 0.8 }} />)}</div>
                  {spendingCats.slice(0, 8).map(([k, v]) => <Row key={k} k={k} v={<>{fmtMoney(v)} <span className="text-gray-600 text-xs">{catTotal ? Math.round((v / catTotal) * 100) : 0}%</span></>} />)}
                </>
              )}
            </div>
          </div>
        )}

        {tab === 'statements' && (
          <div className="card overflow-x-auto">
            <table className="table-base">
              <thead><tr><th className="pl-4">Closed</th><th>Due</th><th className="text-right">Previous</th><th className="text-right">Payments</th><th className="text-right">Purchases</th><th className="text-right">Fees</th><th className="text-right">Interest</th><th className="text-right">New balance</th><th className="text-right">Minimum</th><th className="text-right">Rewards</th><th className="pr-4"></th></tr></thead>
              <tbody>
                {(card.statements ?? []).map(s => (
                  <tr key={s.id}>
                    <td className="pl-4 whitespace-nowrap text-white">{fmtDate(s.closingDate, 'MMM d, yyyy')}<span className="block text-xs text-gray-600">{s.transactionCount ?? 0} transactions</span></td>
                    <td className="text-gray-400 whitespace-nowrap">{s.dueDate ? fmtDate(s.dueDate, 'MMM d') : '—'}</td>
                    <td className="text-right">{m(s.previousBalance)}</td><td className="text-right text-emerald-400">{m(s.paymentsCredits)}</td><td className="text-right">{m(s.purchases)}</td>
                    <td className={`text-right ${Number(s.feesCharged ?? 0) > 0 ? 'text-red-400' : ''}`}>{m(s.feesCharged)}</td><td className={`text-right ${Number(s.interestCharged ?? 0) > 0 ? 'text-red-400' : ''}`}>{m(s.interestCharged)}</td>
                    <td className="text-right text-white">{fmtMoney(s.newBalance)}</td><td className="text-right">{m(s.minimumPayment)}</td><td className="text-right text-gray-400">{s.rewardsEarned != null ? `+${Number(s.rewardsEarned).toLocaleString()}` : '—'}</td>
                    <td className="pr-4 text-right whitespace-nowrap">
                      {s.hasDocument && <button onClick={() => openUrl(() => cardStatementUrl(s.id))} className="text-xs text-amber-400 hover:text-amber-300 mr-2">📄</button>}
                      <button onClick={() => { setParams({ tab: 'transactions' }); }} className="text-xs text-gray-500 hover:text-gray-300 mr-2">Lines</button>
                      <button onClick={async () => { if (confirm('Delete this statement and the transactions read from it?')) { await deleteCardStatement(s.id); await load(); } }} className="text-xs text-gray-600 hover:text-red-400">✕</button>
                    </td>
                  </tr>
                ))}
                {(card.statements ?? []).length === 0 && <tr><td colSpan={11} className="pl-4 text-sm text-gray-500">No statements yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'transactions' && <Transactions card={card} properties={properties} />}

        {tab === 'payments' && (
          <div className="card overflow-x-auto">
            <table className="table-base">
              <thead><tr><th className="pl-4">Date</th><th className="text-right">Amount</th><th>From</th><th>Confirmation</th><th className="pr-4"></th></tr></thead>
              <tbody>
                {(card.payments ?? []).map(pm => (
                  <tr key={pm.id}><td className="pl-4 text-white">{fmtDate(pm.date, 'MMM d, yyyy')}</td><td className="text-right text-emerald-400">{fmtMoney(pm.amount)}</td><td className="text-gray-400">{pm.fromBankAccountName ?? '—'}</td><td className="text-gray-400">{pm.confirmation ?? '—'}</td>
                    <td className="pr-4 text-right"><button onClick={async () => { await deleteCardPayment(pm.id); await load(); }} className="text-xs text-gray-600 hover:text-red-400">✕</button></td></tr>
                ))}
                {(card.payments ?? []).length === 0 && <tr><td colSpan={5} className="pl-4 text-sm text-gray-500">No payments logged. Use "Log payment" above; each one counts against the statement before it.</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-8 flex justify-between">
          <Link to="/personal?tab=cards" className="text-xs text-gray-500 hover:text-gray-300">← All cards</Link>
          <button onClick={async () => { if (confirm('Delete this card, its statements, transactions and payments? Expenses already filed to properties stay.')) { await deleteCreditCard(card.id); nav('/personal?tab=cards'); } }} className="text-xs text-red-400 hover:text-red-300">Delete card</button>
        </div>
      </div>
    </div>
  );
}
