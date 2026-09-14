import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getPayPlan, addPendingOutflow, updatePendingOutflow, deletePendingOutflow, recordBankBalance, updateLoan,
} from '../api/client';
import type { PayPlan, PayPlanAccount, PayPlanObligation, PendingOutflowKind } from '../types';
import { PENDING_OUTFLOW_KIND_LABELS } from '../types';
import { PageHeader, StatCard, Skeleton, EmptyState, Pill } from '../components/ui';
import { fmtDate, todayISO } from '../lib/date';
import PaymentsTabs from '../components/PaymentsTabs';

/**
 * The pay planner.
 *
 * Tomorrow is the 15th and there are loan payments to make. This page shows
 * what is due in the window, what each account really has once checks in
 * the mail and scheduled payments are taken off, and which account each
 * payment should come from. It recommends; it does not move money.
 */

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (n: number) =>
  `$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export default function PayPlanPage() {
  const [plan, setPlan] = useState<PayPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(14);
  const [cushion, setCushion] = useState('');
  const [utilities, setUtilities] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [balanceFor, setBalanceFor] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setPlan(await getPayPlan({ days, cushion: cushion ? Number(cushion) : 0, utilities }));
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [days, utilities]);

  const acct = (id: string) => plan?.accounts.find(a => a.id === id);
  const acctLabel = (id: string) => {
    const a = acct(id);
    return a ? `${a.name}${a.last4 ? ` ••${a.last4}` : ''}` : 'account';
  };

  async function markSent(o: PayPlanObligation) {
    // Recording the payment as sent holds the money out of the account until
    // the bank takes it, and drops the loan from the plan for the month.
    const first = o.payFrom[0];
    if (!first) return;
    setBusy(o.key);
    try {
      for (const part of o.payFrom) {
        await addPendingOutflow(part.accountId, {
          amount: part.amount,
          description: `${o.label}${o.detail ? ` — ${o.detail}` : ''}`,
          kind: 'SCHEDULED',
          expectedDate: o.dueDate.slice(0, 10),
          loanId: o.kind === 'LOAN' ? o.id : null,
        });
      }
      await load();
    } finally { setBusy(null); }
  }

  async function setUsual(o: PayPlanObligation, accountId: string) {
    if (o.kind !== 'LOAN') return;
    setBusy(o.key);
    try {
      await updateLoan(o.id, { payFromBankAccountId: accountId } as any);
      await load();
    } finally { setBusy(null); }
  }

  async function clear(id: string) {
    setBusy(id);
    try { await updatePendingOutflow(id, { cleared: true }); await load(); } finally { setBusy(null); }
  }
  async function remove(id: string) {
    if (!window.confirm('Remove this pending item? The money will count as available again.')) return;
    setBusy(id);
    try { await deletePendingOutflow(id); await load(); } finally { setBusy(null); }
  }

  const due = plan?.obligations.filter(o => o.status !== 'SENT') ?? [];
  const sent = plan?.obligations.filter(o => o.status === 'SENT') ?? [];
  const shortCount = due.filter(o => o.status === 'SHORT').length;

  return (
    <div>
      <PageHeader title="Payments" subtitle="What is due, what is free in each account, and where to pay each one from" />
      <PaymentsTabs active="plan" />

      <div className="px-6 py-5">
        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <label className="text-xs text-gray-500">Due within</label>
          <select value={days} onChange={e => setDays(Number(e.target.value))} className="input-dark text-xs">
            {[3, 7, 14, 21, 30, 45].map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
          <label className="text-xs text-gray-500 ml-2">Keep in each account</label>
          <input type="number" placeholder="$0" value={cushion} onChange={e => setCushion(e.target.value)} onBlur={load}
            onKeyDown={e => { if (e.key === 'Enter') load(); }} className="input-dark text-xs w-24" title="A cushion the planner will not touch, per account" />
          <label className="flex items-center gap-1.5 text-xs text-gray-400 ml-2 cursor-pointer">
            <input type="checkbox" checked={utilities} onChange={e => setUtilities(e.target.checked)} className="rounded border-white/20" />
            Include utility bills
          </label>
          <button onClick={load} className="btn text-xs ml-auto">Refresh</button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <StatCard label={`Due in the next ${days} days`} value={money0(plan?.totals.due ?? 0)}
            sub={`${due.length} payment${due.length === 1 ? '' : 's'}${sent.length ? ` · ${sent.length} already sent` : ''}`} />
          <StatCard label="Free across accounts" value={money0(plan?.totals.spendable ?? 0)}
            sub={plan ? `after ${money0(plan.accounts.reduce((s, a) => s + a.pendingTotal, 0))} pending${plan.cushion ? ` and ${money0(plan.cushion)} cushion each` : ''}` : undefined} />
          <StatCard label="Left after paying" value={`${(plan?.totals.afterPlan ?? 0) < 0 ? '-' : ''}${money0(plan?.totals.afterPlan ?? 0)}`}
            sub={(plan?.totals.afterPlan ?? 0) < 0 ? 'Not enough across all accounts' : 'Covered'}
            subColor={(plan?.totals.afterPlan ?? 0) < 0 ? 'red' : 'green'} />
          <StatCard label="Short" value={money0(plan?.totals.short ?? 0)}
            sub={shortCount > 0 ? `${shortCount} payment${shortCount === 1 ? '' : 's'} cannot be covered` : 'Nothing short'}
            subColor={shortCount > 0 ? 'red' : 'green'} />
        </div>

        {plan && plan.warnings.length > 0 && (
          <div className="rounded-xl px-4 py-3 mb-5 text-xs text-amber-300 space-y-0.5"
            style={{ background: 'rgba(245,166,35,0.06)', border: '1px solid rgba(245,166,35,0.25)' }}>
            {plan.warnings.map((w, i) => <p key={i}>· {w}</p>)}
          </div>
        )}

        {loading && !plan ? <Skeleton className="h-40" /> : !plan ? null : (
          <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
            {/* ── Payments to make ─────────────────────────────── */}
            <div className="xl:col-span-3">
              <p className="text-sm font-medium text-white mb-2">Pay these</p>
              {due.length === 0 ? (
                <EmptyState icon="✅" title="Nothing due in this window" body="Widen the window, or check that loans have a monthly payment and due day on file." />
              ) : (
                <div className="space-y-2">
                  {due.map(o => {
                    const overdue = o.daysUntil < 0;
                    const border = o.status === 'SHORT' ? 'rgba(248,113,113,0.4)' : overdue ? 'rgba(245,166,35,0.35)' : 'rgba(255,255,255,0.06)';
                    return (
                      <div key={o.key} className="rounded-xl px-4 py-3" style={{ background: '#161616', border: `1px solid ${border}` }}>
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Link to={o.link} className="text-sm font-semibold text-white hover:text-[#F5A623]">{o.label}</Link>
                              <Pill color={o.kind === 'LOAN' ? 'blue' : 'gray'}>{o.kind === 'LOAN' ? 'Loan' : 'Utility'}</Pill>
                              {o.status === 'SHORT' && <Pill color="red">Short</Pill>}
                            </div>
                            {o.detail && <p className="text-xs text-gray-500">{o.detail}</p>}
                            <p className={`text-xs mt-1 ${overdue ? 'text-red-400' : o.daysUntil <= 3 ? 'text-amber-400' : 'text-gray-400'}`}>
                              {overdue ? `Overdue — was due ${fmtDate(o.dueDate, 'MMM d')}` : o.daysUntil === 0 ? 'Due today' : o.daysUntil === 1 ? 'Due tomorrow' : `Due ${fmtDate(o.dueDate, 'MMM d')} · in ${o.daysUntil} days`}
                            </p>
                            <div className="mt-2">
                              {o.payFrom.length === 0 ? (
                                <p className="text-xs text-red-400">No account has anything free.</p>
                              ) : (
                                <p className="text-xs text-gray-300">
                                  Pay from{' '}
                                  {o.payFrom.map((p, i) => (
                                    <span key={p.accountId}>
                                      {i > 0 && ' + '}
                                      <span className="font-medium text-[#F5A623]">{acctLabel(p.accountId)}</span>
                                      {o.payFrom.length > 1 && <span className="text-gray-500"> ({money(p.amount)})</span>}
                                    </span>
                                  ))}
                                </p>
                              )}
                              {o.reason && <p className="text-xs text-gray-500 mt-0.5">{o.reason}</p>}
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="text-lg font-semibold text-white">{money(o.amount)}</p>
                            {o.payFrom.length > 0 && (
                              <button onClick={() => markSent(o)} disabled={busy === o.key}
                                className="text-xs text-[#F5A623] hover:underline mt-1 disabled:opacity-40"
                                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                                title="Record this as sent: the money is held out of the account until the bank takes it">
                                {busy === o.key ? '…' : 'Mark sent'}
                              </button>
                            )}
                            {o.kind === 'LOAN' && o.payFrom.length === 1 && o.payFrom[0].accountId !== o.preferredAccountId && (
                              <button onClick={() => setUsual(o, o.payFrom[0].accountId)} disabled={busy === o.key}
                                className="block text-xs text-gray-500 hover:text-gray-300 mt-1 ml-auto disabled:opacity-40"
                                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                                title="Always start with this account for this loan">
                                Make this the usual account
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {sent.length > 0 && (
                <div className="mt-5">
                  <p className="text-sm font-medium text-white mb-2">Already sent, not yet cleared</p>
                  <div className="space-y-1.5">
                    {sent.map(o => (
                      <div key={o.key} className="rounded-xl px-4 py-2.5 flex items-center justify-between gap-3 text-xs"
                        style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <div className="min-w-0">
                          <Link to={o.link} className="text-gray-200 font-medium hover:text-[#F5A623]">{o.label}</Link>
                          {o.detail && <span className="text-gray-500"> · {o.detail}</span>}
                          <span className="text-gray-500"> · due {fmtDate(o.dueDate, 'MMM d')}</span>
                        </div>
                        <span className="text-gray-300 font-medium whitespace-nowrap">{money(o.amount)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-gray-600 mt-1.5">Clear each one from its account below once the bank has taken it.</p>
                </div>
              )}
            </div>

            {/* ── Accounts ─────────────────────────────────────── */}
            <div className="xl:col-span-2">
              <p className="text-sm font-medium text-white mb-2">Accounts</p>
              {plan.accounts.length === 0 ? (
                <p className="text-xs text-gray-500">No checking, savings or cash accounts. <Link to="/settings?tab=banking" className="text-[#F5A623] hover:underline">Add one</Link>.</p>
              ) : (
                <div className="space-y-2">
                  {plan.accounts.map(a => (
                    <AccountCard key={a.id} a={a} busy={busy}
                      adding={addingTo === a.id} onToggleAdd={() => setAddingTo(addingTo === a.id ? null : a.id)}
                      settingBalance={balanceFor === a.id} onToggleBalance={() => setBalanceFor(balanceFor === a.id ? null : a.id)}
                      onClear={clear} onRemove={remove}
                      onSaved={async () => { setAddingTo(null); setBalanceFor(null); await load(); }} />
                  ))}
                </div>
              )}
              <p className="text-xs text-gray-600 mt-3">
                Free = latest balance (the bank's available figure when known) − pending items{plan.cushion ? ` − ${money0(plan.cushion)} cushion` : ''}.
                Balances update from Plaid daily, or record one by hand.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AccountCard({ a, busy, adding, onToggleAdd, settingBalance, onToggleBalance, onClear, onRemove, onSaved }: {
  a: PayPlanAccount; busy: string | null;
  adding: boolean; onToggleAdd: () => void;
  settingBalance: boolean; onToggleBalance: () => void;
  onClear: (id: string) => void; onRemove: (id: string) => void; onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({ amount: '', description: '', kind: 'CHECK' as PendingOutflowKind, expectedDate: '' });
  const [bal, setBal] = useState({ balance: '', asOfDate: todayISO() });
  const [saving, setSaving] = useState(false);

  async function saveOutflow() {
    if (!form.amount || !form.description) return;
    setSaving(true);
    try {
      await addPendingOutflow(a.id, { amount: Number(form.amount), description: form.description, kind: form.kind, expectedDate: form.expectedDate || null });
      setForm({ amount: '', description: '', kind: 'CHECK', expectedDate: '' });
      await onSaved();
    } finally { setSaving(false); }
  }
  async function saveBalance() {
    if (!bal.balance) return;
    setSaving(true);
    try {
      await recordBankBalance(a.id, { balance: Number(bal.balance), asOfDate: bal.asOfDate });
      setBal({ balance: '', asOfDate: todayISO() });
      await onSaved();
    } finally { setSaving(false); }
  }

  const base = a.available ?? a.balance;
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: '#161616', border: `1px solid ${a.remaining < 0 ? 'rgba(248,113,113,0.4)' : 'rgba(255,255,255,0.06)'}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate">{a.name}{a.last4 ? <span className="text-gray-500 font-normal"> ••{a.last4}</span> : null}</p>
          <p className="text-xs text-gray-500">
            {[a.bank, a.ownerLabel].filter(Boolean).join(' · ')}
            {a.asOfDate
              ? <span className={a.stale ? 'text-amber-400' : ''}> · balance as of {fmtDate(a.asOfDate, 'MMM d')}{a.stale ? ' (stale)' : ''}</span>
              : <span className="text-red-400"> · no balance on file</span>}
          </p>
        </div>
        <div className="text-right flex-shrink-0">
          <p className={`text-lg font-semibold ${a.remaining < 0 ? 'text-red-400' : 'text-white'}`}>{money(a.remaining)}</p>
          <p className="text-xs text-gray-500">left after plan</p>
        </div>
      </div>

      <div className="mt-2 text-xs text-gray-400 space-y-0.5">
        <div className="flex justify-between"><span>Balance{a.available != null ? ' (available)' : ''}</span><span className="text-gray-200">{money(base)}</span></div>
        {a.pendingTotal > 0 && <div className="flex justify-between"><span>Pending, not yet taken</span><span className="text-amber-400">−{money(a.pendingTotal)}</span></div>}
        {a.cushion > 0 && <div className="flex justify-between"><span>Cushion</span><span className="text-gray-500">−{money(a.cushion)}</span></div>}
        <div className="flex justify-between"><span>Free to pay from</span><span className="text-gray-200 font-medium">{money(a.spendable)}</span></div>
        {a.assigned > 0 && <div className="flex justify-between"><span>This plan uses</span><span className="text-[#F5A623]">−{money(a.assigned)}</span></div>}
      </div>

      {a.pending.length > 0 && (
        <div className="mt-2.5 pt-2 space-y-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {a.pending.map(p => (
            <div key={p.id} className="flex items-center gap-2 text-xs group">
              <span className="text-gray-300 truncate flex-1 min-w-0" title={p.description}>
                {p.description}
                <span className="text-gray-600"> · {PENDING_OUTFLOW_KIND_LABELS[p.kind] ?? p.kind}{p.expectedDate ? ` · ${fmtDate(p.expectedDate, 'MMM d')}` : ''}</span>
              </span>
              <span className="text-amber-400 whitespace-nowrap">{money(p.amount)}</span>
              <button onClick={() => onClear(p.id)} disabled={busy === p.id} title="The bank has taken this; stop holding it out"
                className="text-emerald-400 hover:text-emerald-300 disabled:opacity-40" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>Cleared</button>
              <button onClick={() => onRemove(p.id)} disabled={busy === p.id} title="Remove (was never sent)"
                className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 disabled:opacity-40" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-3 mt-2.5">
        <button onClick={onToggleAdd} className="text-xs text-[#F5A623] hover:underline" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
          {adding ? 'Cancel' : '+ Check or payment sent'}
        </button>
        <button onClick={onToggleBalance} className="text-xs text-gray-500 hover:text-gray-300" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
          {settingBalance ? 'Cancel' : 'Update balance'}
        </button>
      </div>

      {adding && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <input type="number" placeholder="Amount" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} className="input-dark text-xs" />
          <select value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value as PendingOutflowKind }))} className="input-dark text-xs">
            {(Object.keys(PENDING_OUTFLOW_KIND_LABELS) as PendingOutflowKind[]).map(k => <option key={k} value={k}>{PENDING_OUTFLOW_KIND_LABELS[k]}</option>)}
          </select>
          <input placeholder="What it is (e.g. check #1042 to Carrington)" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="input-dark text-xs col-span-2" />
          <input type="date" title="When it should come out" value={form.expectedDate} onChange={e => setForm(f => ({ ...f, expectedDate: e.target.value }))} className="input-dark text-xs" />
          <button onClick={saveOutflow} disabled={saving || !form.amount || !form.description} className="btn btn-primary text-xs">{saving ? '…' : 'Hold it out'}</button>
        </div>
      )}
      {settingBalance && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <input type="number" placeholder="Balance now" value={bal.balance} onChange={e => setBal(b => ({ ...b, balance: e.target.value }))} className="input-dark text-xs" />
          <input type="date" value={bal.asOfDate} onChange={e => setBal(b => ({ ...b, asOfDate: e.target.value }))} className="input-dark text-xs" />
          <button onClick={saveBalance} disabled={saving || !bal.balance} className="btn btn-primary text-xs col-span-2">{saving ? '…' : 'Save balance'}</button>
        </div>
      )}
    </div>
  );
}
