import { useEffect, useState, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  getUtility, syncUtility, deleteUtility, updateUtility, getStatementDownloadUrl,
  getPaymentPlan, createPaymentPlan, updatePaymentPlan, deletePaymentPlan,
  upsertUtilityLoan, deleteUtilityLoan, patchStatement, createStatement, deleteStatement,
  revealUtilityAccountNumber, createPayment, updatePayment, deletePayment,
  getBankAccounts, getCostSettings, updateCostSettings,
} from '../api/client';
import { CATEGORY_LABELS, CATEGORY_COLORS, LOAN_TYPE_LABELS,
  UTILITY_PAYMENT_METHODS, PAYMENT_STATUS_LABELS } from '../types';
import type { BankAccount } from '../types';
import { Pill, Skeleton, EmptyState } from '../components/ui';
import { format, isAfter } from 'date-fns';
import { monthKey, fmtDate, yearOf } from '../lib/date';
import { operatingCost } from '../lib/operatingCost';
import ChargeAnalyticsPanel from '../components/utility/ChargeAnalyticsPanel';

const CATEGORY_ICONS: Record<string, string> = {
  ELECTRIC: '⚡', GAS: '🔥', WATER: '💧', SEWER: '🚿',
  INTERNET: '🌐', PHONE: '📱', TV: '📺', TRASH: '🗑️',
  SOLAR: '☀️', INSURANCE: '🛡️', HOA: '🏘️', TAXES: '🏛️', OTHER: '📄',
};

function fmtMoney(v?: number | string | null) {
  if (v == null) return '—';
  const n = Number(v);
  return isNaN(n) ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

// All statement figures come from the dedicated, editable columns
// (amountDue, amountPaid, pastDueCarried, chargesExcludingFees,
// penaltiesFees) — never from rawDataJson, which is a frozen import-time
// snapshot that user edits can't change. Reading rawDataJson here is what
// made edits appear to "not stick".

// Open balance a statement is asking for: this period's charge plus any
// prior balance carried into it.
function openBalanceOf(s: any): number | null {
  if (!s) return null;
  if (s.amountDue == null && s.pastDueCarried == null) return null;
  return Number(s.amountDue ?? 0) + Number(s.pastDueCarried ?? 0);
}

// Determine if a statement is paid, including reconciliation against payments that
// may not yet have posted on the provider's API. Sums all payments dated on/after
// the statement date; if the sum covers the open balance, treat as paid.
function isStatementPaid(s: any, payments: any[] = []): boolean {
  if (s.amountPaid != null) return true;
  const openBalance = openBalanceOf(s);
  if (openBalance == null) return false;
  if (openBalance <= 0.01) return true;
  const stmtDate = s.statementDate ? new Date(s.statementDate) : null;
  if (!stmtDate) return false;
  const sumSinceStmt = payments
    .filter(p => new Date(p.paymentDate) >= stmtDate)
    .reduce((acc, p) => acc + Number(p.amount ?? 0), 0);
  return sumSinceStmt >= openBalance - 0.01;
}

// Whether an arrears balance was ever cleared, looked up across the WHOLE
// forward chain of later statements — not just the very next one. A past-due
// amount routinely takes more than one billing cycle to clear (e.g. Dec's
// balance still shows up on Jan's bill, but is gone by Feb's). Checking only
// one statement ahead meant Dec would show "Overdue" forever the moment Jan
// didn't fully clear it, even though Feb proves it eventually did.
// `statements` must be sorted newest-first (as the API already returns it).
function computeResolvedByFutureCheckpoint(statements: any[]): Set<string> {
  const resolved = new Set<string>();
  let sawZeroCheckpoint = false;
  // Iterate newest -> oldest; sawZeroCheckpoint tracks whether any statement
  // strictly newer than the current one carried in a zero balance (its
  // pastDueCarried is 0/empty), proving the prior bill was cleared.
  for (const s of statements) {
    if (sawZeroCheckpoint) resolved.add(s.id);
    const carriedIn = Number(s.pastDueCarried ?? 0);
    if (carriedIn === 0) sawZeroCheckpoint = true;
  }
  return resolved;
}

function isEffectivelyPaid(s: any, payments: any[], resolvedByFuture: Set<string>): boolean {
  return isStatementPaid(s, payments) || resolvedByFuture.has(s.id);
}

// Past due carried on a statement reflects an older unpaid balance. Once the
// prior (chronologically older) statement is marked paid in Sollux, that
// carried-forward figure is stale — suppress the past-due display for it.
function isPriorStatementPaid(current: any, all: any[], payments: any[] = [], resolvedByFuture: Set<string> = new Set()): boolean {
  const idx = all.findIndex(x => x.id === current.id);
  if (idx === -1 || idx + 1 >= all.length) return false;
  return isEffectivelyPaid(all[idx + 1], payments, resolvedByFuture);
}

function statementStatus(s: any, payments: any[] = [], newerStmt?: any, isLatest = false, resolvedByFuture: Set<string> = new Set()): { color: 'green' | 'amber' | 'red'; label: string } {
  if (isEffectivelyPaid(s, payments, resolvedByFuture)) return { color: 'green', label: 'Paid' };

  if (!isLatest && newerStmt) {
    // The next bill's carried-in balance tells us whether this one was paid:
    // 0 carried in = this bill was cleared before the next was issued.
    const newerCarriedIn = Number(newerStmt.pastDueCarried ?? 0);
    const thisDue = Number(s.amountDue ?? 0);
    if (newerCarriedIn === 0) return { color: 'green', label: 'Paid' };
    if (thisDue > 0 && newerCarriedIn >= thisDue - 0.01) {
      const pastDueDate = s.dueDate && isAfter(new Date(), new Date(s.dueDate));
      return pastDueDate ? { color: 'red', label: 'Overdue' } : { color: 'amber', label: 'Due' };
    }
    return { color: 'green', label: 'Paid' };
  }

  if (s.dueDate && isAfter(new Date(), new Date(s.dueDate))) return { color: 'red', label: 'Overdue' };
  return { color: 'amber', label: 'Due' };
}

type Tab = 'statements' | 'payments' | 'fees' | 'charges';

// ── Payment Plan Modal ────────────────────────────────────────────────────────
function PaymentPlanModal({
  accountId, existing, onClose, onSave,
}: { accountId: string; existing: any | null; onClose: () => void; onSave: (p: any) => void }) {
  const [total, setTotal] = useState(existing ? String(existing.totalAmount) : '');
  const [monthly, setMonthly] = useState(existing ? String(existing.monthlyAmount) : '');
  const [startDate, setStartDate] = useState(
    existing ? existing.startDate.slice(0, 10) : new Date().toISOString().slice(0, 10)
  );
  const [desc, setDesc] = useState(existing?.description || '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!total || !monthly) return;
    setSaving(true);
    try {
      const plan = await createPaymentPlan(accountId, {
        totalAmount: parseFloat(total),
        monthlyAmount: parseFloat(monthly),
        startDate,
        description: desc || undefined,
      });
      onSave(plan);
      onClose();
    } catch { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="rounded-2xl p-6 w-96 space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.1)' }}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">Payment Plan</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">×</button>
        </div>
        <p className="text-xs text-gray-400">Track a payment arrangement where a fixed monthly installment reduces a total arrears balance.</p>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Total arrears / plan amount ($)</label>
            <input type="number" value={total} onChange={e => setTotal(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm text-white bg-black/30 border border-white/10 focus:outline-none focus:border-amber-500" placeholder="e.g. 2000" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Monthly installment ($)</label>
            <input type="number" value={monthly} onChange={e => setMonthly(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm text-white bg-black/30 border border-white/10 focus:outline-none focus:border-amber-500" placeholder="e.g. 81.36" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Start date</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm text-white bg-black/30 border border-white/10 focus:outline-none focus:border-amber-500" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Description (optional)</label>
            <input type="text" value={desc} onChange={e => setDesc(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm text-white bg-black/30 border border-white/10 focus:outline-none focus:border-amber-500" placeholder="e.g. COVID arrears payment plan" />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm text-gray-400 hover:text-white" style={{ background: 'rgba(255,255,255,0.06)' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !total || !monthly}
            className="flex-1 py-2 rounded-lg text-sm font-medium text-black bg-amber-500 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Loan Card ────────────────────────────────────────────────────────────────

function LoanModal({ accountId, existing, onClose, onSave }: {
  accountId: string; existing: any | null; onClose: () => void; onSave: (l: any) => void;
}) {
  const [lender,          setLender]          = useState(existing?.lender || '');
  const [loanType,        setLoanType]        = useState(existing?.loanType || 'OTHER');
  const [interestRate,    setInterestRate]    = useState(existing?.interestRate != null ? String(existing.interestRate) : '');
  const [originalAmount,  setOriginalAmount]  = useState(existing?.originalAmount != null ? String(existing.originalAmount) : '');
  const [monthlyPayment,  setMonthlyPayment]  = useState(existing?.monthlyPayment != null ? String(existing.monthlyPayment) : '');
  const [currentBalance,  setCurrentBalance]  = useState(existing?.currentBalance != null ? String(existing.currentBalance) : '');
  const [originationDate, setOriginationDate] = useState(existing?.originationDate ? existing.originationDate.slice(0, 10) : '');
  const [maturityDate,    setMaturityDate]    = useState(existing?.maturityDate    ? existing.maturityDate.slice(0, 10)    : '');
  const [accountLast4,    setAccountLast4]    = useState(existing?.accountLast4 || '');
  const [notes,           setNotes]           = useState(existing?.notes || '');
  const [saving,          setSaving]          = useState(false);

  function autoCalcBalance() {
    const P = parseFloat(originalAmount);
    const r = parseFloat(interestRate) / 12 / 100;
    const PMT = parseFloat(monthlyPayment);
    const origin = originationDate ? new Date(originationDate) : null;
    if (!origin || isNaN(P) || isNaN(PMT) || P <= 0 || PMT <= 0) return;
    const today = new Date();
    const n = Math.max(0, Math.floor(
      (today.getFullYear() - origin.getFullYear()) * 12 + (today.getMonth() - origin.getMonth())
    ));
    let balance: number;
    if (!isNaN(r) && r > 0) {
      const factor = Math.pow(1 + r, n);
      balance = P * factor - PMT * (factor - 1) / r;
    } else {
      balance = P - PMT * n;
    }
    setCurrentBalance(String(Math.max(0, Math.round(balance * 100) / 100)));
  }

  async function handleSave() {
    if (!lender) return;
    setSaving(true);
    try {
      const result = await upsertUtilityLoan(accountId, {
        lender, loanType,
        interestRate:    interestRate    ? parseFloat(interestRate)    : null,
        originalAmount:  originalAmount  ? parseFloat(originalAmount)  : null,
        monthlyPayment:  monthlyPayment  ? parseFloat(monthlyPayment)  : null,
        currentBalance:  currentBalance  ? parseFloat(currentBalance)  : null,
        originationDate: originationDate || null,
        maturityDate:    maturityDate    || null,
        accountLast4:    accountLast4    || null,
        notes:           notes           || null,
      });
      onSave(result);
      onClose();
    } catch { setSaving(false); }
  }

  const inputCls = 'w-full rounded-lg px-3 py-2 text-sm text-white bg-black/30 border border-white/10 focus:outline-none focus:border-amber-500';
  const labelCls = 'text-xs text-gray-400 block mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 overflow-y-auto py-8">
      <div className="rounded-2xl p-6 w-full max-w-md space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.1)' }}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">Loan Details</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">×</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>Lender / servicer *</label>
            <input value={lender} onChange={e => setLender(e.target.value)} className={inputCls} placeholder="e.g. Westlake Portfolio Mgmt" />
          </div>
          <div>
            <label className={labelCls}>Loan type</label>
            <select value={loanType} onChange={e => setLoanType(e.target.value)} className={inputCls}>
              {Object.entries(LOAN_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Account last 4</label>
            <input value={accountLast4} onChange={e => setAccountLast4(e.target.value.slice(-4))} className={inputCls} placeholder="9823" maxLength={4} />
          </div>
          <div>
            <label className={labelCls}>Interest rate (%)</label>
            <input type="number" step="0.001" value={interestRate} onChange={e => setInterestRate(e.target.value)} className={inputCls} placeholder="e.g. 6.5" />
          </div>
          <div>
            <label className={labelCls}>Monthly payment ($)</label>
            <input type="number" step="0.01" value={monthlyPayment} onChange={e => setMonthlyPayment(e.target.value)} className={inputCls} placeholder="e.g. 722.49" />
          </div>
          <div>
            <label className={labelCls}>Original loan amount ($)</label>
            <input type="number" step="0.01" value={originalAmount} onChange={e => setOriginalAmount(e.target.value)} className={inputCls} placeholder="e.g. 50000" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={labelCls} style={{ marginBottom: 0 }}>Current balance ($)</label>
              <button type="button" onClick={autoCalcBalance} className="text-xs text-amber-400 hover:text-amber-300 transition-colors">⟳ Auto-calc</button>
            </div>
            <input type="number" step="0.01" value={currentBalance} onChange={e => setCurrentBalance(e.target.value)} className={inputCls} placeholder="e.g. 42000" />
          </div>
          <div>
            <label className={labelCls}>Origination date</label>
            <input type="date" value={originationDate} onChange={e => setOriginationDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Maturity date</label>
            <input type="date" value={maturityDate} onChange={e => setMaturityDate(e.target.value)} className={inputCls} />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Notes (optional)</label>
            <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} placeholder="Solar loan, car financing, etc." />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm text-gray-400 hover:text-white" style={{ background: 'rgba(255,255,255,0.06)' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !lender}
            className="flex-1 py-2 rounded-lg text-sm font-medium text-black bg-amber-500 disabled:opacity-50">
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function LoanCard({ loan, accountId, onUpdate, onDelete }: {
  loan: any; accountId: string; onUpdate: (l: any) => void; onDelete: () => void;
}) {
  const [showEdit, setShowEdit] = useState(false);
  const [removing, setRemoving] = useState(false);

  const monthlyPayment  = loan.monthlyPayment  != null ? Number(loan.monthlyPayment)  : null;
  const originalAmount  = loan.originalAmount  != null ? Number(loan.originalAmount)  : null;
  const currentBalance  = loan.currentBalance  != null ? Number(loan.currentBalance)  : null;
  const interestRate    = loan.interestRate    != null ? Number(loan.interestRate)    : null;
  const originationDate = loan.originationDate ? new Date(loan.originationDate) : null;
  const maturityDate    = loan.maturityDate    ? new Date(loan.maturityDate)    : null;

  // Estimate terms remaining from current balance and monthly payment
  let termsRemaining: number | null = null;
  if (currentBalance != null && monthlyPayment != null && monthlyPayment > 0 && interestRate != null && interestRate > 0) {
    const r = interestRate / 100 / 12;
    termsRemaining = Math.ceil(Math.log(monthlyPayment / (monthlyPayment - r * currentBalance)) / Math.log(1 + r));
  } else if (currentBalance != null && monthlyPayment != null && monthlyPayment > 0) {
    termsRemaining = Math.ceil(currentBalance / monthlyPayment);
  }

  const paidOff = originalAmount != null && currentBalance != null ? originalAmount - currentBalance : null;
  const pct     = originalAmount != null && paidOff != null && originalAmount > 0
    ? Math.min(100, (paidOff / originalAmount) * 100) : null;

  async function handleRemove() {
    if (!confirm('Unlink this loan from the account?')) return;
    setRemoving(true);
    try { await deleteUtilityLoan(accountId); onDelete(); } finally { setRemoving(false); }
  }

  return (
    <>
      {showEdit && <LoanModal accountId={accountId} existing={loan} onClose={() => setShowEdit(false)} onSave={onUpdate} />}
      <div className="rounded-xl px-5 py-4 mb-4" style={{ background: '#1e1e1e', border: '1px solid rgba(99,102,241,0.3)' }}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">🏦 {loan.lender}</span>
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(99,102,241,0.15)', color: '#a5b4fc' }}>
                {LOAN_TYPE_LABELS[loan.loanType] || loan.loanType}
              </span>
            </div>
            {loan.accountLast4 && <p className="text-xs text-gray-500 mt-0.5">····{loan.accountLast4}</p>}
          </div>
          <div className="flex gap-2">
            {loan.id && (
              <Link to={`/loans/${loan.id}`} className="text-xs text-indigo-400 hover:text-indigo-300 px-2 py-1 rounded transition-colors" style={{ background: 'rgba(99,102,241,0.08)' }}>
                Full details →
              </Link>
            )}
            <button onClick={() => setShowEdit(true)} className="text-xs text-gray-500 hover:text-white px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.06)' }}>Edit</button>
            <button onClick={handleRemove} disabled={removing} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded" style={{ background: 'rgba(255,0,0,0.08)' }}>Remove</button>
          </div>
        </div>

        {/* Payoff progress bar */}
        {pct != null && (
          <div className="mb-3">
            <div className="flex justify-between text-xs text-gray-400 mb-1">
              <span>Paid off: {fmtMoney(paidOff)}</span>
              <span>Remaining: <span className="text-indigo-300 font-medium">{fmtMoney(currentBalance)}</span></span>
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
              <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#6366f1,#a5b4fc)' }} />
            </div>
            <div className="flex justify-between text-xs text-gray-600 mt-1">
              <span>{pct.toFixed(1)}% paid off</span>
              {originalAmount != null && <span>of {fmtMoney(originalAmount)}</span>}
            </div>
          </div>
        )}

        {/* Key stats */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          {interestRate    != null && <div><span className="text-gray-500">Interest rate: </span><span className="text-white font-medium">{interestRate.toFixed(3)}%</span></div>}
          {monthlyPayment  != null && <div><span className="text-gray-500">Monthly payment: </span><span className="text-white font-medium">{fmtMoney(monthlyPayment)}</span></div>}
          {termsRemaining  != null && <div><span className="text-gray-500">Terms remaining: </span><span className="text-white font-medium">~{termsRemaining} mo</span></div>}
          {maturityDate    != null && <div><span className="text-gray-500">Maturity: </span><span className="text-white font-medium">{format(maturityDate, 'MMM yyyy')}</span></div>}
          {originationDate != null && <div><span className="text-gray-500">Originated: </span><span className="text-gray-300">{format(originationDate, 'MMM d, yyyy')}</span></div>}
        </div>
        {loan.notes && <p className="text-xs text-gray-500 mt-2 italic">{loan.notes}</p>}
      </div>
    </>
  );
}

// ── Payment Plan Card ─────────────────────────────────────────────────────────
function PaymentPlanCard({
  plan, accountId, onUpdate, onDelete,
}: { plan: any; accountId: string; onUpdate: (p: any) => void; onDelete: () => void }) {
  const [applying, setApplying] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  const total = Number(plan.totalAmount);
  const remaining = Number(plan.remainingBalance);
  const monthly = Number(plan.monthlyAmount);
  const paid = total - remaining;
  const pct = total > 0 ? Math.min(100, (paid / total) * 100) : 0;
  const monthsLeft = monthly > 0 ? Math.ceil(remaining / monthly) : null;
  const isCompleted = plan.status === 'COMPLETED' || remaining <= 0;

  async function handleApplyPayment() {
    setApplying(true);
    try {
      const updated = await updatePaymentPlan(accountId, { applyPayment: monthly });
      onUpdate(updated);
    } finally { setApplying(false); }
  }

  async function handleDelete() {
    if (!confirm('Remove this payment plan?')) return;
    await deletePaymentPlan(accountId);
    onDelete();
  }

  return (
    <>
      {showEdit && (
        <PaymentPlanModal accountId={accountId} existing={plan}
          onClose={() => setShowEdit(false)} onSave={onUpdate} />
      )}
      <div className="rounded-xl px-5 py-4 mb-4" style={{ background: '#1e1e1e', border: '1px solid rgba(245,166,35,0.25)' }}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">📋 Payment Plan</span>
              {isCompleted
                ? <Pill color="green">Completed</Pill>
                : <Pill color="amber">Active</Pill>}
            </div>
            {plan.description && <p className="text-xs text-gray-500 mt-0.5">{plan.description}</p>}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowEdit(true)} className="text-xs text-gray-500 hover:text-white px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.06)' }}>Edit</button>
            <button onClick={handleDelete} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded" style={{ background: 'rgba(255,0,0,0.08)' }}>Remove</button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-3">
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>Paid: {fmtMoney(paid)}</span>
            <span>Remaining: <span className={remaining > 0 ? 'text-amber-400 font-medium' : 'text-emerald-400'}>{fmtMoney(remaining)}</span></span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
            <div className="h-full rounded-full transition-all duration-500"
              style={{ width: `${pct}%`, background: isCompleted ? '#34d399' : '#F5A623' }} />
          </div>
          <div className="flex justify-between text-xs text-gray-600 mt-1">
            <span>{pct.toFixed(0)}% paid off</span>
            <span>of {fmtMoney(total)}</span>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-4 text-xs">
          <div>
            <span className="text-gray-500">Monthly installment: </span>
            <span className="text-white font-medium">{fmtMoney(monthly)}</span>
          </div>
          {monthsLeft != null && !isCompleted && (
            <div>
              <span className="text-gray-500">Est. payoff: </span>
              <span className="text-white font-medium">~{monthsLeft} month{monthsLeft !== 1 ? 's' : ''}</span>
            </div>
          )}
          {plan.startDate && (
            <div>
              <span className="text-gray-500">Started: </span>
              <span className="text-gray-300">{fmtDate(plan.startDate, 'MMM d, yyyy')}</span>
            </div>
          )}
        </div>

        {/* Apply installment button */}
        {!isCompleted && (
          <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between">
            <p className="text-xs text-gray-500">Mark this month's installment ({fmtMoney(monthly)}) as paid</p>
            <button onClick={handleApplyPayment} disabled={applying}
              className="text-xs px-3 py-1.5 rounded-lg font-medium text-black bg-amber-500 hover:bg-amber-400 disabled:opacity-50 transition-colors">
              {applying ? 'Applying…' : '✓ Apply Payment'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export default function UtilityDetailPage() {
  const { propertyId, accountId } = useParams<{ propertyId: string; accountId: string }>();
  const navigate = useNavigate();
  const [account, setAccount] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<Tab>('statements');
  const [search, setSearch] = useState('');
  const [yearFilter, setYearFilter] = useState<string>('all');
  const [plan, setPlan]           = useState<any>(null);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [loan, setLoan]           = useState<any>(null);
  const [showLoanModal, setShowLoanModal] = useState(false);
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);
  const [editingStatement, setEditingStatement] = useState<any | null>(null);
  const [revealedAccountNumber, setRevealedAccountNumber] = useState<string | null>(null);
  const [revealingAccountNumber, setRevealingAccountNumber] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [showPayForm, setShowPayForm] = useState(false);
  const [editPaymentId, setEditPaymentId] = useState<string | null>(null);
  const [savingPayment, setSavingPayment] = useState(false);
  const [payForm, setPayForm] = useState({
    amount: '', paymentDate: new Date().toISOString().slice(0, 10),
    paymentMethod: 'ACH', status: 'PAID', statementId: '',
    confirmationNumber: '', bankAccountId: '', notes: '',
  });

  useEffect(() => {
    if (!accountId) return;
    Promise.all([
      getUtility(accountId).then(a => { setAccount(a); setLoan((a as any).loan ?? null); }),
      getPaymentPlan(accountId).then(setPlan),
      getBankAccounts().then(bs => setBankAccounts(bs.filter(b => b.isActive))).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [accountId]);

  function resetPayForm() {
    setPayForm({
      amount: '', paymentDate: new Date().toISOString().slice(0, 10),
      paymentMethod: 'ACH', status: 'PAID', statementId: '',
      confirmationNumber: '', bankAccountId: '', notes: '',
    });
  }

  function openPaymentEdit(p: any) {
    setPayForm({
      amount: String(p.amount ?? ''),
      paymentDate: (p.paymentDate ?? '').slice(0, 10),
      paymentMethod: p.paymentMethod || 'ACH',
      status: p.status || 'PAID',
      statementId: p.statementId ?? '',
      confirmationNumber: p.confirmationNumber ?? '',
      bankAccountId: p.bankAccountId ?? '',
      notes: p.notes ?? '',
    });
    setEditPaymentId(p.id);
    setShowPayForm(false);
  }

  // Recording a payment can change a statement's paid state server-side, so
  // reload the whole account rather than splicing the payment in locally.
  async function reloadAccount() {
    if (!accountId) return;
    const fresh = await getUtility(accountId);
    setAccount(fresh);
    setLoan((fresh as any).loan ?? null);
  }

  async function savePayment() {
    const amount = parseFloat(payForm.amount);
    if (!payForm.amount || Number.isNaN(amount) || amount <= 0) {
      alert('Enter an amount greater than zero.');
      return;
    }
    setSavingPayment(true);
    try {
      const body = {
        utilityAccountId: accountId,
        amount,
        paymentDate: payForm.paymentDate,
        paymentMethod: payForm.paymentMethod || null,
        status: payForm.status,
        statementId: payForm.statementId || null,
        confirmationNumber: payForm.confirmationNumber || null,
        bankAccountId: payForm.bankAccountId || null,
        notes: payForm.notes || null,
      };
      if (editPaymentId) await updatePayment(editPaymentId, body);
      else await createPayment(body);
      setEditPaymentId(null);
      setShowPayForm(false);
      resetPayForm();
      await reloadAccount();
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Could not save that payment.');
    } finally { setSavingPayment(false); }
  }

  async function removePayment(p: any) {
    const linked = p.statementId ? '\n\nThe statement it was paid against will show unpaid again.' : '';
    if (!confirm(`Delete the ${fmtMoney(p.amount)} payment from ${fmtDate(p.paymentDate)}?${linked}\n\nThis cannot be undone.`)) return;
    setSavingPayment(true);
    try {
      await deletePayment(p.id);
      await reloadAccount();
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Could not delete that payment.');
    } finally { setSavingPayment(false); }
  }

  async function handleMarkPaid(s: any) {
    const isPaid = s.amountPaid != null;
    setMarkingPaid(s.id);
    try {
      const updated = await patchStatement(s.id, { amountPaid: isPaid ? null : Number(s.amountDue ?? 0) });
      setAccount((prev: any) => prev ? {
        ...prev,
        statements: (prev.statements ?? []).map((r: any) => r.id === s.id ? { ...r, amountPaid: updated.amountPaid } : r),
      } : prev);
    } catch { } finally { setMarkingPaid(null); }
  }

  async function toggleAccountNumber() {
    if (!accountId) return;
    if (revealedAccountNumber != null) { setRevealedAccountNumber(null); return; }
    setRevealingAccountNumber(true);
    try {
      const { accountNumber } = await revealUtilityAccountNumber(accountId);
      setRevealedAccountNumber(accountNumber ?? '');
    } finally {
      setRevealingAccountNumber(false);
    }
  }

  async function handleSync() {
    if (!accountId) return;
    setSyncing(true);
    try {
      await syncUtility(accountId);
      const poll = async () => {
        const updated = await getUtility(accountId);
        setAccount(updated);
        if (updated.lastSyncStatus === 'PENDING' || updated.lastSyncStatus === null) {
          setTimeout(poll, 2000);
        } else {
          setSyncing(false);
        }
      };
      setTimeout(poll, 2000);
    } catch { setSyncing(false); }
  }

  async function toggleActive() {
    if (!accountId) return;
    setTogglingActive(true);
    try {
      const updated = await updateUtility(accountId, { isActive: account.isActive === false });
      setAccount((prev: any) => prev ? { ...prev, isActive: updated.isActive, syncEnabled: updated.syncEnabled } : prev);
    } finally {
      setTogglingActive(false);
    }
  }

  async function handleDelete() {
    if (!accountId) return;
    const confirmed = window.confirm(
      `Delete "${account?.providerName}"?\n\nThis will permanently remove the account, all statements, payments, and PDFs. This cannot be undone.`
    );
    if (!confirmed) return;
    setDeleting(true);
    try {
      await deleteUtility(accountId);
      navigate(propertyId ? `/properties/${propertyId}` : '/properties');
    } catch {
      setDeleting(false);
    }
  }

  const statements: any[] = useMemo(() => account?.statements || [], [account]);
  const payments: any[] = useMemo(() => account?.payments || [], [account]);
  // Computed from the FULL statement history (not the filtered/searched
  // view) so status stays correct regardless of year filter or search.
  const resolvedByFuture = useMemo(() => computeResolvedByFutureCheckpoint(statements), [statements]);

  const stmtYears = useMemo(() => {
    const years = new Set(statements.map(s => String(yearOf(s.statementDate))));
    return Array.from(years).sort((a, b) => Number(b) - Number(a));
  }, [statements]);

  const pmtYears = useMemo(() => {
    const years = new Set(payments.map(p => new Date(p.paymentDate).getFullYear().toString()));
    return Array.from(years).sort((a, b) => Number(b) - Number(a));
  }, [payments]);

  const years = tab === 'statements' ? stmtYears : pmtYears;

  const filteredStatements = useMemo(() => statements.filter(s => {
    const date = new Date(s.statementDate);
    if (yearFilter !== 'all' && date.getFullYear().toString() !== yearFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!format(date, 'MMMM yyyy').toLowerCase().includes(q) && !String(s.amountDue || '').includes(q)) return false;
    }
    return true;
  }), [statements, yearFilter, search]);

  const filteredPayments = useMemo(() => payments.filter(p => {
    const date = new Date(p.paymentDate);
    if (yearFilter !== 'all' && date.getFullYear().toString() !== yearFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const dateStr = format(date, 'MMMM yyyy').toLowerCase();
      if (!dateStr.includes(q) && !(p.confirmationNumber || '').toLowerCase().includes(q) && !String(p.amount || '').includes(q)) return false;
    }
    return true;
  }), [payments, yearFilter, search]);

  // Fees/penalties aggregated across all statements — sourced from the
  // editable penaltiesFees column so it matches what Edit shows and writes.
  const feesData = useMemo(() => statements.map(s => {
    const penalties = s.penaltiesFees != null ? Number(s.penaltiesFees) : null;
    if (penalties == null || penalties === 0) return null;
    return { id: s.id, date: s.statementDate, penalties, total: penalties };
  }).filter(Boolean), [statements]);

  const totalFees = feesData.reduce((s, r: any) => s + (r?.total || 0), 0);
  const totalPenalties = totalFees;

  // Whether penalties and arrears installments count as operating cost is an
  // account setting, since it changes reported figures everywhere.
  const [costOptions, setCostOptions] = useState<{ includePenalties: boolean; includePaymentPlan: boolean }>(
    { includePenalties: false, includePaymentPlan: false }
  );
  useEffect(() => {
    getCostSettings()
      .then(s => setCostOptions({
        includePenalties: !!s.includePenaltiesInOperating,
        includePaymentPlan: !!s.includePaymentPlanInOperating,
      }))
      .catch(() => {});
  }, []);

  const currentYear = new Date().getFullYear();
  const thisYear = statements.filter(s => yearOf(s.statementDate) === currentYear);
  // Two figures, because they answer different questions: what the property
  // cost to run, and what had to be paid. An arrears installment and a late
  // fee are cash out but not operating cost — see lib/operatingCost.ts.
  const ytdOperating = thisYear.reduce((sum, s) => sum + operatingCost(s, costOptions), 0);
  const ytdBilled = thisYear.reduce((sum, s) => sum + Number(s.amountDue ?? 0), 0);
  const ytdExcluded = ytdBilled - ytdOperating;
  const ytdTotal = ytdOperating;
  const latestAmt = statements[0]?.amountDue != null ? Number(statements[0].amountDue) : null;
  const prevAmt = statements[1]?.amountDue != null ? Number(statements[1].amountDue) : null;
  const momPct = latestAmt != null && prevAmt != null && prevAmt !== 0
    ? ((latestAmt - prevAmt) / prevAmt) * 100 : null;
  const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0);

  // Past due from latest statement — all from the dedicated, editable columns
  // so edits show up here immediately.
  const latestStmt = statements[0];
  // If the prior (older) statement is paid, the balance carried into this one
  // is stale — suppress it. See isPriorStatementPaid.
  const priorToLatestPaid = latestStmt ? isPriorStatementPaid(latestStmt, statements, payments) : false;
  const latestPastDue = (!priorToLatestPaid && latestStmt?.pastDueCarried != null)
    ? Number(latestStmt.pastDueCarried)
    : null;
  const latestChargesExclFees = latestStmt?.chargesExcludingFees != null ? Number(latestStmt.chargesExcludingFees) : null;
  const latestOwed = openBalanceOf(latestStmt);
  // Reconcile the displayed current balance against recent payments. If the user paid
  // a bill but the provider's API hasn't reflected it yet, we still want $0 here.
  const isLatestPaid = latestStmt ? isStatementPaid(latestStmt, payments) : false;
  const latestTotalDue = isLatestPaid
    ? 0
    : (priorToLatestPaid && latestChargesExclFees != null)
      ? latestChargesExclFees
      : latestOwed;

  if (loading) return <div className="p-6 space-y-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  if (!account) return <div className="p-6 text-gray-400">Account not found</div>;

  const color = (CATEGORY_COLORS as Record<string, string>)[account.category] || '#888';
  const icon = CATEGORY_ICONS[account.category as string] || '📄';
  const property = account.property;
  const propertyLabel = property?.nickname || property?.address || 'Property';

  return (
    <div>
      {showPlanModal && (
        <PaymentPlanModal accountId={accountId!} existing={plan}
          onClose={() => setShowPlanModal(false)}
          onSave={p => { setPlan(p); setShowPlanModal(false); }} />
      )}
      {showLoanModal && (
        <LoanModal accountId={accountId!} existing={loan}
          onClose={() => setShowLoanModal(false)}
          onSave={l => { setLoan(l); setShowLoanModal(false); }} />
      )}

      {/* Header */}
      <div className="px-6 py-4 sticky top-0 z-10 flex items-center justify-between"
        style={{ background: '#1e1e1e', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
            <Link to="/properties" className="hover:text-gray-300 transition-colors">Properties</Link>
            <span>›</span>
            <Link to={`/properties/${propertyId}`} className="hover:text-gray-300 transition-colors">{propertyLabel}</Link>
            <span>›</span>
            <span className="text-gray-300">{account.providerName}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm"
              style={{ background: `${color}22`, border: `1px solid ${color}44` }}>
              {icon}
            </div>
            <h1 className="text-base font-semibold text-white">{account.providerName}</h1>
            <span className="text-xs text-gray-500">{(CATEGORY_LABELS as Record<string, string>)[account.category]}</span>
            {account.isActive === false && (
              <span className="text-xs px-1.5 py-0.5 rounded-full text-gray-400 border border-white/10 bg-white/5">Inactive</span>
            )}
            {account.accountNumber && (
              <span className="flex items-center gap-1">
                <span className="font-mono text-xs text-gray-600">
                  {revealedAccountNumber != null ? revealedAccountNumber : account.accountNumber}
                </span>
                <button
                  onClick={toggleAccountNumber}
                  disabled={revealingAccountNumber}
                  title={revealedAccountNumber != null ? 'Hide account number' : 'Show full account number'}
                  className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40"
                >
                  {revealingAccountNumber ? '…' : revealedAccountNumber != null ? '🙈' : '👁'}
                </button>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleSync} disabled={syncing || deleting} className="btn btn-primary text-xs">
            {syncing ? 'Syncing…' : 'Sync ↻'}
          </button>
          <button
            onClick={toggleActive}
            disabled={togglingActive}
            title={account.isActive === false ? 'Reactivate this account' : 'Mark inactive — keeps all history, pauses syncing'}
            className={`text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40 ${
              account.isActive === false
                ? 'text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10'
                : 'text-gray-400 hover:text-white hover:bg-white/10'
            }`}
          >
            {togglingActive ? '…' : account.isActive === false ? 'Reactivate' : 'Deactivate'}
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting || syncing}
            className="text-xs px-3 py-1.5 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-40"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="px-6 py-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        {[
          {
            label: 'Current balance',
            value: fmtMoney(isLatestPaid ? 0 : (latestTotalDue ?? latestAmt)),
            sub: isLatestPaid
              ? <span className="text-emerald-400">Paid</span>
              : (latestPastDue && latestPastDue > 0
                ? <span className="text-red-400">{fmtMoney(latestPastDue)} past due</span>
                : undefined),
          },
          {
            label: 'Month over month',
            value: momPct != null ? `${momPct > 0 ? '↑' : '↓'} ${Math.abs(momPct).toFixed(1)}%` : '—',
            color: momPct != null ? (momPct > 0 ? 'text-red-400' : 'text-emerald-400') : 'text-white',
          },
          {
            label: `YTD ${currentYear} operating`,
            value: fmtMoney(ytdTotal || null),
            sub: ytdExcluded > 0
              ? <span className="text-gray-500" title="Penalties and arrears installments are not operating cost">
                  {fmtMoney(ytdBilled)} billed
                </span>
              : undefined,
          },
          { label: 'Total paid', value: fmtMoney(totalPaid || null), sub: `${payments.length} payments` },
          {
            label: 'Total fees & penalties',
            value: fmtMoney(totalFees || null),
            color: totalFees > 0 ? 'text-orange-400' : 'text-white',
            sub: totalFees > 0 ? `across ${feesData.length} bills` : undefined,
          },
        ].map(({ label, value, color: c, sub }) => (
          <div key={label} className="rounded-xl px-4 py-3" style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-xs text-gray-500 mb-1">{label}</p>
            <p className={`text-lg font-semibold ${c || 'text-white'}`}>{value}</p>
            {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
          </div>
        ))}
      </div>

      <div className="px-6 pt-4">
        {/* Payment Plan section */}
        {/* Loan Details */}
        {loan ? (
          <LoanCard loan={loan} accountId={accountId!}
            onUpdate={setLoan} onDelete={() => setLoan(null)} />
        ) : (
          <button
            onClick={() => setShowLoanModal(true)}
            className="w-full mb-4 py-2.5 rounded-xl text-xs text-gray-500 hover:text-gray-300 transition-colors text-left px-4"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)' }}
          >
            + Add loan details (interest rate, term, maturity date, etc.)
          </button>
        )}

        {/* Payment Plan */}
        {plan ? (
          <PaymentPlanCard plan={plan} accountId={accountId!}
            onUpdate={setPlan} onDelete={() => setPlan(null)} />
        ) : (
          <button
            onClick={() => setShowPlanModal(true)}
            className="w-full mb-4 py-2.5 rounded-xl text-xs text-gray-500 hover:text-gray-300 transition-colors text-left px-4"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)' }}
          >
            + Add payment plan (for arrears / installment arrangements)
          </button>
        )}

        {/* Tabs + search */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-1">
            {([
              ['statements', `Statements (${statements.length})`],
              ['payments',   `Payments (${payments.length})`],
              ['fees',       `Fees & Penalties${feesData.length > 0 ? ` (${feesData.length})` : ''}`],
              ['charges',    'Charge breakdown'],
            ] as [Tab, string][]).map(([t, label]) => (
              <button key={t} onClick={() => { setTab(t); setYearFilter('all'); setSearch(''); }}
                className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  tab === t ? 'bg-[#F5A623] text-black' : 'text-gray-400 hover:text-white'
                }`}
                style={tab !== t ? { background: 'rgba(255,255,255,0.06)' } : {}}>
                {label}
              </button>
            ))}
          </div>
          {tab !== 'fees' && tab !== 'charges' && (
            <div className="flex items-center gap-2">
              <input type="text"
                placeholder={tab === 'statements' ? 'Search by month, amount…' : 'Search by date, confirmation…'}
                value={search} onChange={e => setSearch(e.target.value)}
                className="text-xs px-3 py-1.5 rounded-lg text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', width: 220 }}
              />
              <select value={yearFilter} onChange={e => setYearFilter(e.target.value)}
                className="text-xs px-3 py-1.5 rounded-lg text-gray-300 focus:outline-none"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <option value="all">All years</option>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              {tab === 'statements' && (
                <button onClick={() => setEditingStatement({})} className="btn text-xs">+ Add statement</button>
              )}
            </div>
          )}
        </div>

        {editingStatement !== null && accountId && (
          <StatementModal
            accountId={accountId}
            statement={editingStatement}
            onClose={() => setEditingStatement(null)}
            onSaved={() => { setEditingStatement(null); getUtility(accountId).then(a => { setAccount(a); setLoan((a as any).loan ?? null); }); }}
          />
        )}

        {/* ── Statements ───────────────────────────────────── */}
        {tab === 'statements' && (
          filteredStatements.length === 0
            ? <EmptyState icon="📄" title="No statements" body={search || yearFilter !== 'all' ? 'No statements match your filter.' : 'Sync this account to pull statement history.'} />
            : (
              <div className="space-y-2 pb-8">
                {filteredStatements.map((s, idx) => {
                  // filteredStatements sorted DESC; [idx-1] is more recent; idx===0 is latest
                  const isLatest = idx === 0 && yearFilter === 'all' && !search;
                  const { color: sc, label: sl } = statementStatus(s, payments, filteredStatements[idx - 1], isLatest, resolvedByFuture);
                  // Everything from the dedicated, editable columns — no
                  // rawDataJson fallback, so edits always show up.
                  const pastDue  = s.pastDueCarried != null ? Number(s.pastDueCarried) : null;
                  const totalDue = openBalanceOf(s);
                  const isPaid = isEffectivelyPaid(s, payments, resolvedByFuture);
                  const priorPaid = isPriorStatementPaid(s, statements, payments, resolvedByFuture);
                  return (
                    <div key={s.id} className="rounded-xl px-5 py-4 flex items-center gap-4"
                      style={{
                        background: '#1e1e1e',
                        border: isLatest ? '1px solid rgba(245,166,35,0.3)' : '1px solid rgba(255,255,255,0.06)',
                      }}>
                      {/* Month */}
                      <div className="w-20 flex-shrink-0">
                        {/* Labelled by the period billed, not the day the bill
                            was issued. An IID bill issued 1 June covers late
                            April to late May — calling that row "Jun 2026"
                            makes May look absent and double-counts June. */}
                        <p className="text-sm font-semibold text-white">
                          {fmtDate(s.billingPeriodEnd || s.statementDate, 'MMM yyyy')}
                        </p>
                        {s.billingPeriodEnd && monthKey(s.billingPeriodEnd) !== monthKey(s.statementDate) && (
                          <p className="text-xs text-gray-600">billed {fmtDate(s.statementDate, 'MMM d')}</p>
                        )}
                        {isLatest && <p className="text-xs text-amber-500 mt-0.5">Latest</p>}
                      </div>

                      {/* Billing period + flags */}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-500">
                          {s.billingPeriodStart && s.billingPeriodEnd
                            ? `${fmtDate(s.billingPeriodStart, 'MMM d')} – ${fmtDate(s.billingPeriodEnd, 'MMM d, yyyy')}`
                            : 'Billing period —'}
                        </p>
                        {pastDue != null && pastDue > 0 && !priorPaid && (
                          <p className="text-xs text-red-400 mt-0.5">⚠ Past due: {fmtMoney(pastDue)}</p>
                        )}
                        {(pastDue ?? 0) > 0 && priorPaid && (
                          <p className="text-xs text-green-500 mt-0.5">✓ Prior balance paid</p>
                        )}
                        {s.usageValue && (
                          <p className="text-xs text-gray-600 mt-0.5">{s.usageValue} {s.usageUnit}</p>
                        )}
                        {/* What made up the total. Extraction has always captured
                            this, but nothing displayed it, so a water bill that
                            splits water from sewer showed only the sum. */}
                        {(() => {
                          const breakdown = (s.rawDataJson as any)?.chargeBreakdown as Record<string, number> | undefined;
                          if (!breakdown || Object.keys(breakdown).length === 0) return null;
                          return (
                            <details className="mt-1">
                              <summary className="text-xs text-gray-600 cursor-pointer hover:text-gray-400 select-none">
                                {Object.keys(breakdown).length} charge{Object.keys(breakdown).length === 1 ? '' : 's'}
                              </summary>
                              <div className="mt-1 space-y-0.5">
                                {Object.entries(breakdown).map(([label, amount]) => (
                                  <div key={label} className="flex justify-between gap-4 text-xs max-w-xs">
                                    <span className="text-gray-500 truncate">{label}</span>
                                    {/* A credit is a negative line and reads as one. */}
                                    <span className={Number(amount) < 0 ? 'text-green-500' : 'text-gray-400'}>
                                      {fmtMoney(Number(amount))}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </details>
                          );
                        })()}
                      </div>

                      {/* Due date */}
                      <div className="text-right flex-shrink-0 w-24">
                        {s.dueDate && (
                          <p className="text-xs text-gray-500">Due {fmtDate(s.dueDate, 'MMM d')}</p>
                        )}
                      </div>

                      {/* Amount column.
                       *  - Paid statement (balance/totalDue is 0): show the actual bill amount
                       *    that was paid (amountDue) — the user wants history of what was billed.
                       *  - Unpaid statement: show the current open balance. If it equals the
                       *    bill amount, no sub-line. If it's larger (past-due rolled in),
                       *    show "Bill: $X" so the per-period charge is still visible. */}
                      <div className="text-right flex-shrink-0 w-28">
                        {(() => {
                          // A paid statement shows the bill amount (what was billed);
                          // an unpaid one shows the open balance owed.
                          const isFullyPaid = isPaid || (totalDue === 0 && Number(s.amountDue ?? 0) > 0);
                          const amt = Number(s.amountDue ?? 0);
                          const owed = totalDue ?? amt;
                          const primary = isFullyPaid ? amt : owed;
                          const showBillSubline = !isFullyPaid && owed > amt && amt > 0;
                          return (
                            <>
                              <p className="text-base font-semibold text-white">{fmtMoney(primary)}</p>
                              {showBillSubline && (
                                <p className="text-xs text-gray-500">Bill: {fmtMoney(amt)}</p>
                              )}
                            </>
                          );
                        })()}
                      </div>

                      <div className="flex-shrink-0 w-20 text-right">
                        <Pill color={sc}>{sl}</Pill>
                      </div>

                      <div className="flex-shrink-0 flex items-center gap-1.5">
                        {!isPaid && (
                          <button
                            onClick={() => handleMarkPaid(s)}
                            disabled={markingPaid === s.id}
                            title="Mark as paid"
                            className="text-xs px-2 py-1 rounded transition-colors disabled:opacity-30 text-gray-500 hover:text-green-400"
                            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
                          >
                            {markingPaid === s.id ? '…' : '✓ Mark paid'}
                          </button>
                        )}
                        {s.pdfS3Key && (
                          <button
                            onClick={async () => {
                              try {
                                const res = await getStatementDownloadUrl(s.id);
                                window.open(res.url, '_blank', 'noopener,noreferrer');
                              } catch { alert('Could not open PDF.'); }
                            }}
                            className="text-xs px-2 py-1 rounded transition-colors hover:opacity-80"
                            style={{ background: 'rgba(245,166,35,0.12)', border: '1px solid rgba(245,166,35,0.3)', color: '#F5A623' }}
                          >
                            📄 PDF
                          </button>
                        )}
                        <button
                          onClick={() => setEditingStatement(s)}
                          title="Edit statement"
                          className="text-xs px-2 py-1 rounded transition-colors text-gray-500 hover:text-white"
                          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
        )}

        {/* ── Payments ─────────────────────────────────────── */}
        {tab === 'payments' && (
          <div className="mb-3 flex justify-end">
            <button onClick={() => { setEditPaymentId(null); resetPayForm(); setShowPayForm(v => !v); }}
              className="btn btn-primary text-xs">
              {showPayForm ? 'Cancel' : '+ Log payment'}
            </button>
          </div>
        )}

        {tab === 'payments' && (showPayForm || editPaymentId) && (
          <div className="rounded-xl px-5 py-4 mb-3" style={{ background: '#1e1e1e', border: '1px solid rgba(245,166,35,0.25)' }}>
            <p className="text-xs font-medium text-gray-300 mb-2">
              {editPaymentId ? 'Edit payment' : 'Log a payment toward this account'}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              <input type="number" value={payForm.amount} onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
                placeholder="Amount *" className="input-dark text-xs" />
              <input type="date" value={payForm.paymentDate} onChange={e => setPayForm(f => ({ ...f, paymentDate: e.target.value }))}
                className="input-dark text-xs" />
              <select value={payForm.paymentMethod} onChange={e => setPayForm(f => ({ ...f, paymentMethod: e.target.value }))}
                className="input-dark text-xs">
                {UTILITY_PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <select value={payForm.status} onChange={e => setPayForm(f => ({ ...f, status: e.target.value }))}
                className="input-dark text-xs">
                {['PAID', 'PENDING', 'PARTIAL', 'FAILED'].map(st => (
                  <option key={st} value={st}>{PAYMENT_STATUS_LABELS[st]}</option>
                ))}
              </select>

              {/* Linking to a statement is what marks that bill paid. */}
              <select value={payForm.statementId} onChange={e => setPayForm(f => ({ ...f, statementId: e.target.value }))}
                className="input-dark text-xs sm:col-span-2">
                <option value="">— Not against a specific bill —</option>
                {statements.slice(0, 36).map((st: any) => (
                  <option key={st.id} value={st.id}>
                    {fmtDate(st.statementDate, 'MMM yyyy')} — {fmtMoney(st.amountDue)} due
                  </option>
                ))}
              </select>
              <select value={payForm.bankAccountId} onChange={e => setPayForm(f => ({ ...f, bankAccountId: e.target.value }))}
                className="input-dark text-xs">
                <option value="">— Paid from which account? —</option>
                {bankAccounts.map(b => (
                  <option key={b.id} value={b.id}>{[b.name, b.last4 ? `••${b.last4}` : null].filter(Boolean).join(' ')}</option>
                ))}
              </select>
              <input value={payForm.confirmationNumber} onChange={e => setPayForm(f => ({ ...f, confirmationNumber: e.target.value }))}
                placeholder="Confirmation #" className="input-dark text-xs" />
              <input value={payForm.notes} onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Notes" className="input-dark text-xs sm:col-span-2 lg:col-span-4" />
            </div>
            <div className="flex justify-end gap-3 mt-2">
              <button onClick={() => { setEditPaymentId(null); setShowPayForm(false); }}
                className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
              <button onClick={savePayment} disabled={savingPayment || !payForm.amount}
                className="btn btn-primary text-xs disabled:opacity-40">
                {savingPayment ? '…' : editPaymentId ? 'Save changes' : 'Log payment'}
              </button>
            </div>
          </div>
        )}

        {tab === 'payments' && (
          filteredPayments.length === 0
            ? <EmptyState icon="💳" title="No payments" body={search || yearFilter !== 'all' ? 'No payments match your filter.' : 'Nothing recorded yet — use "Log payment" above.'} />
            : (
              <div className="space-y-2 pb-8">
                {filteredPayments.map(p => (
                  <div key={p.id} className="rounded-xl px-5 py-4 flex items-center gap-4"
                    style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="w-28 flex-shrink-0">
                      <p className="text-sm font-semibold text-white">{fmtDate(p.paymentDate, 'MMM d, yyyy')}</p>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-300">{p.paymentMethod || 'Payment'}</p>
                      {p.bankAccount && (
                        <p className="text-xs text-gray-500">from {p.bankAccount.name}{p.bankAccount.last4 ? ` ••${p.bankAccount.last4}` : ''}</p>
                      )}
                      {p.statement && (
                        <p className="text-xs text-gray-500">toward {fmtDate(p.statement.statementDate, 'MMM yyyy')} bill</p>
                      )}
                      {p.confirmationNumber && (
                        <p className="font-mono text-xs text-gray-500 mt-0.5">Conf# {p.confirmationNumber}</p>
                      )}
                      {p.notes && <p className="text-xs text-gray-600 mt-0.5">{p.notes}</p>}
                    </div>
                    <div className="text-right flex-shrink-0 w-24">
                      <p className="text-base font-semibold text-white">{fmtMoney(p.amount)}</p>
                    </div>
                    <div className="flex-shrink-0 w-20 text-right">
                      <Pill color={p.status === 'PAID' ? 'green' : p.status === 'PENDING' ? 'amber' : 'red'}>{p.status}</Pill>
                    </div>
                    <div className="flex-shrink-0 flex gap-2 text-xs">
                      <button onClick={() => openPaymentEdit(p)} className="text-gray-500 hover:text-amber-400">Edit</button>
                      <button onClick={() => removePayment(p)} disabled={savingPayment}
                        className="text-gray-600 hover:text-red-400 disabled:opacity-40">✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )
        )}

        {/* ── Charge breakdown ─────────────────────────────── */}
        {tab === 'charges' && <ChargeAnalyticsPanel accountId={account.id} />}

        {/* ── Fees & Penalties ─────────────────────────────── */}
        {tab === 'fees' && (
          feesData.length === 0
            ? <EmptyState icon="🧾" title="No fees or penalties" body="No fees, penalties, or adjustments found across your statements." />
            : (
              <div className="space-y-4 pb-8">
                {/* Summary cards */}
                <div className="grid grid-cols-2 gap-3 mb-2">
                  {[
                    { label: 'Total penalties / fees', value: fmtMoney(totalPenalties), color: totalPenalties > 0 ? 'text-red-400' : 'text-gray-400' },
                    { label: 'Across', value: `${feesData.length} bills`, color: 'text-amber-400' },
                  ].map(({ label, value, color: c }) => (
                    <div key={label} className="rounded-xl px-4 py-3" style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <p className="text-xs text-gray-500 mb-1">{label}</p>
                      <p className={`text-lg font-semibold ${c}`}>{value}</p>
                    </div>
                  ))}
                </div>

                {/* What counts as operating cost. Both are cash out; neither is
                    the cost of running the property, so both are excluded by
                    default and can be folded back in here. */}
                <div className="rounded-xl px-4 py-3 space-y-2"
                  style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <p className="text-xs text-gray-400">Count towards operating cost</p>
                  {([
                    ['includePenalties', 'includePenaltiesInOperating', 'Penalties and late fees'],
                    ['includePaymentPlan', 'includePaymentPlanInOperating', 'Payment plan installments (arrears repayment)'],
                  ] as const).map(([key, apiKey, label]) => (
                    <label key={key} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={costOptions[key]}
                        onChange={async e => {
                          const next = { ...costOptions, [key]: e.target.checked };
                          setCostOptions(next);
                          // Persisted per account: this changes reported
                          // figures, so it must not differ between browsers.
                          try { await updateCostSettings({ [apiKey]: e.target.checked }); }
                          catch { setCostOptions(costOptions); }
                        }}
                      />
                      {label}
                    </label>
                  ))}
                  <p className="text-xs text-gray-600">
                    Off by default — both are money paid, but neither is what the property
                    cost to run this month.
                  </p>
                </div>

                {/* Per-statement breakdown */}
                {(feesData as any[]).map((r: any) => (
                  <div key={r.id} className="rounded-xl px-5 py-4"
                    style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm font-semibold text-white">{fmtDate(r.date, 'MMMM yyyy')}</p>
                      <p className="text-sm font-semibold text-orange-400">{fmtMoney(r.total)}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">Penalties / fees</span>
                        <span className="text-xs font-medium text-red-400">{fmtMoney(Number(r.penalties))}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
        )}
      </div>
    </div>
  );
}

// ─── Add / edit statement (manual entry) ─────────────────────────────────────

function StatementModal({ accountId, statement, onClose, onSaved }: {
  accountId: string; statement: any; onClose: () => void; onSaved: () => void;
}) {
  const isEdit = !!statement?.id;
  const [statementDate, setStatementDate] = useState(statement?.statementDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(statement?.dueDate?.slice(0, 10) ?? '');
  const [amountDue, setAmountDue] = useState(statement?.amountDue != null ? String(statement.amountDue) : '');
  const [amountPaid, setAmountPaid] = useState(statement?.amountPaid != null ? String(statement.amountPaid) : '');
  const [chargesExcludingFees, setChargesExcludingFees] = useState(statement?.chargesExcludingFees != null ? String(statement.chargesExcludingFees) : '');
  const [penaltiesFees, setPenaltiesFees] = useState(statement?.penaltiesFees != null ? String(statement.penaltiesFees) : '');
  const [pastDueCarried, setPastDueCarried] = useState(statement?.pastDueCarried != null ? String(statement.pastDueCarried) : '');
  const [notes, setNotes] = useState(statement?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const num = (v: string) => v.trim() === '' ? null : parseFloat(v);

  // A bad import leaves rows that have to come off — a duplicate, or one whose
  // figures were read wrong. The endpoint has always existed and the statement
  // history panel uses it; this page simply never offered it, so the only way
  // to remove a statement was to delete the whole account with every other
  // statement, payment and PDF on it.
  async function handleDelete() {
    if (!confirm(
      `Delete this statement?\n\n` +
      `${statementDate}${amountDue ? ` · $${amountDue}` : ''}\n\n` +
      'The stored PDF goes with it. This cannot be undone.'
    )) return;
    setDeleting(true);
    setError('');
    try {
      await deleteStatement(statement.id);
      onSaved();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to delete statement');
      setDeleting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      if (isEdit) {
        await patchStatement(statement.id, {
          statementDate, dueDate: dueDate || null,
          amountDue: num(amountDue), amountPaid: num(amountPaid),
          chargesExcludingFees: num(chargesExcludingFees),
          penaltiesFees: num(penaltiesFees), pastDueCarried: num(pastDueCarried),
          notes: notes || null,
        });
      } else {
        await createStatement({
          utilityAccountId: accountId, statementDate, dueDate: dueDate || null,
          amountDue: num(amountDue), amountPaid: num(amountPaid),
          chargesExcludingFees: num(chargesExcludingFees),
          penaltiesFees: num(penaltiesFees), pastDueCarried: num(pastDueCarried),
          notes: notes || null,
        });
      }
      onSaved();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to save statement');
    } finally {
      setSaving(false);
    }
  }

  const fieldCls = 'w-full rounded-lg px-3 py-2 text-sm text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl p-6 space-y-3" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">{isEdit ? 'Edit statement' : 'Add statement'}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Statement date</label>
            <input type="date" className={fieldCls} value={statementDate} onChange={e => setStatementDate(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Due date</label>
            <input type="date" className={fieldCls} value={dueDate} onChange={e => setDueDate(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Total due <span className="text-gray-500">(this period, w/ fees)</span></label>
            <input type="number" step="0.01" className={fieldCls} value={amountDue} onChange={e => setAmountDue(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Paid</label>
            <input type="number" step="0.01" className={fieldCls} value={amountPaid} onChange={e => setAmountPaid(e.target.value)} placeholder="0.00" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Due w/o penalties &amp; fees</label>
            <input type="number" step="0.01" className={fieldCls} value={chargesExcludingFees} onChange={e => setChargesExcludingFees(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Penalties / fees</label>
            <input type="number" step="0.01" className={fieldCls} value={penaltiesFees} onChange={e => setPenaltiesFees(e.target.value)} placeholder="0.00" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Past due <span className="text-gray-500">(prior periods)</span></label>
            <input type="number" step="0.01" className={fieldCls} value={pastDueCarried} onChange={e => setPastDueCarried(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Total due w/ past due</label>
            <div className={`${fieldCls} flex items-center text-gray-300`}>
              {num(amountDue) != null || num(pastDueCarried) != null
                ? `$${((num(amountDue) ?? 0) + (num(pastDueCarried) ?? 0)).toFixed(2)}`
                : '—'}
            </div>
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Comments</label>
          <input className={fieldCls} value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Waste container swap, lock replacement" />
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center gap-2 pt-1">
          {isEdit && (
            <button
              onClick={handleDelete}
              disabled={deleting || saving}
              className="text-xs px-2 py-1 rounded text-red-400 hover:text-red-300 disabled:opacity-50"
              style={{ background: 'rgba(255,0,0,0.08)' }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="btn text-xs">Cancel</button>
          <button onClick={handleSave} disabled={saving || deleting} className="btn btn-primary text-xs disabled:opacity-50">
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Add statement'}
          </button>
        </div>
      </div>
    </div>
  );
}
