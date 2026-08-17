import { useEffect, useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { getLoan, getLoanAmortization, updateLoan, getProperties, extendLoan } from '../api/client';
import type { Loan, Property, LoanType, PrepaymentPenalty, PrepaymentPenaltyTier } from '../types';
import { format, addMonths } from 'date-fns';
import { fmtDate } from '../lib/date';

const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const moneyPrecise = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const pct = (n: number) => `${n.toFixed(2)}%`;

const BALANCE_METHOD_LABELS: Record<string, string> = {
  balance_after: 'From most recent payment record',
  payment_sum: 'Calculated from recorded principal payments',
  theoretical: 'Projected from origination date (no payment history on file)',
  manual: 'Manually entered',
};

const LOAN_TYPES: LoanType[] = ['MORTGAGE','HELOC','AUTO','PERSONAL','STUDENT','INSTALLMENT_PLAN','CREDIT_LINE','SELLER_FINANCING','DSCR','COMMERCIAL','HARD_MONEY','OTHER'];
const LOAN_TYPE_LABELS: Record<string, string> = {
  MORTGAGE: 'Mortgage', HELOC: 'HELOC', AUTO: 'Auto', PERSONAL: 'Personal',
  STUDENT: 'Student', INSTALLMENT_PLAN: 'Installment Plan', CREDIT_LINE: 'Credit Line',
  SELLER_FINANCING: 'Seller Financing', DSCR: 'DSCR', COMMERCIAL: 'Commercial', HARD_MONEY: 'Hard Money', OTHER: 'Other',
};

interface AmortizationResponse {
  balance: { balance: number; asOfDate: string; method: string };
  amortization: {
    isAmortizing: boolean;
    monthlyRate: number;
    computedMonthlyPayment: number;
    negativeAmortization: boolean;
    isInterestOnly: boolean;
    schedule: { paymentNumber: number; date: string; paymentAmount: number; principal: number; interest: number; balance: number }[];
    historicalSchedule: { paymentNumber: number; date: string; paymentAmount: number; principal: number; interest: number; balance: number }[];
    payoffDate: string | null;
    monthsRemaining: number | null;
    totalInterestRemaining: number;
    totalDeferredInterest: number;
    scheduleEndsAt: string | null;
    totalPaidToDate: number;
    totalInterestToDate: number;
  };
}

// ── Prepayment Penalty Calculator ─────────────────────────────────────────────

function calcPrepaymentPenalty(
  penalty: PrepaymentPenalty,
  originationDate: string,
  currentBalance: number
): { inPenaltyPeriod: boolean; currentRate: number | null; penaltyAmount: number | null; penaltyEnds: Date; currentTierEnds: Date | null; monthsElapsed: number } {
  const origin = new Date(originationDate);
  const today = new Date();
  const monthsElapsed = Math.floor(
    (today.getFullYear() - origin.getFullYear()) * 12 + (today.getMonth() - origin.getMonth())
  );
  const penaltyEnds = addMonths(origin, penalty.periodMonths);
  const inPenaltyPeriod = monthsElapsed < penalty.periodMonths;

  if (!inPenaltyPeriod) {
    return { inPenaltyPeriod: false, currentRate: null, penaltyAmount: null, penaltyEnds, currentTierEnds: null, monthsElapsed };
  }

  const activeTier = penalty.tiers.find(t => monthsElapsed >= t.startMonth && monthsElapsed < t.endMonth);
  if (!activeTier) {
    return { inPenaltyPeriod: true, currentRate: null, penaltyAmount: null, penaltyEnds, currentTierEnds: null, monthsElapsed };
  }

  return {
    inPenaltyPeriod: true,
    currentRate: activeTier.rate,
    penaltyAmount: currentBalance * (activeTier.rate / 100),
    penaltyEnds,
    currentTierEnds: addMonths(origin, activeTier.endMonth),
    monthsElapsed,
  };
}

// ── Prepayment Penalty Editor ─────────────────────────────────────────────────

function PenaltyEditor({ value, onChange }: {
  value: PrepaymentPenalty | null;
  onChange: (v: PrepaymentPenalty | null) => void;
}) {
  const enabled = value?.enabled ?? false;

  const toggle = () => {
    if (!enabled) {
      onChange({ enabled: true, periodMonths: 36, tiers: [{ startMonth: 0, endMonth: 24, rate: 3 }, { startMonth: 24, endMonth: 36, rate: 2 }] });
    } else {
      onChange(null);
    }
  };

  const updateField = (field: keyof PrepaymentPenalty, val: any) => {
    if (!value) return;
    onChange({ ...value, [field]: val });
  };

  const updateTier = (i: number, field: keyof PrepaymentPenaltyTier, val: number) => {
    if (!value) return;
    const tiers = [...value.tiers];
    tiers[i] = { ...tiers[i], [field]: val };
    onChange({ ...value, tiers });
  };

  const addTier = () => {
    if (!value) return;
    const last = value.tiers[value.tiers.length - 1];
    const start = last?.endMonth ?? 0;
    onChange({ ...value, tiers: [...value.tiers, { startMonth: start, endMonth: start + 12, rate: 1 }] });
  };

  const removeTier = (i: number) => {
    if (!value) return;
    onChange({ ...value, tiers: value.tiers.filter((_, idx) => idx !== i) });
  };

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 cursor-pointer">
        <div
          onClick={toggle}
          className={`w-9 h-5 rounded-full transition-colors relative cursor-pointer flex-shrink-0 ${enabled ? 'bg-amber-500' : 'bg-white/10'}`}
        >
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${enabled ? 'left-4' : 'left-0.5'}`} />
        </div>
        <span className="text-sm text-gray-300">Prepayment penalty applies</span>
      </label>

      {enabled && value && (
        <div className="space-y-3 pl-3 border-l border-white/10">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Total penalty period (months)</label>
            <input
              type="number" min={1} max={120}
              value={value.periodMonths}
              onChange={e => updateField('periodMonths', parseInt(e.target.value) || 1)}
              className="input-dark w-32 text-sm"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs text-gray-500">Penalty tiers</p>
              <button type="button" onClick={addTier} className="text-xs text-amber-400 hover:text-amber-300">+ Add tier</button>
            </div>
            <div className="space-y-2">
              {value.tiers.map((tier, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="text-gray-500 w-16 flex-shrink-0">Month</span>
                  <input type="number" min={0} value={tier.startMonth}
                    onChange={e => updateTier(i, 'startMonth', parseInt(e.target.value) || 0)}
                    className="input-dark w-16 text-sm text-center" placeholder="0" />
                  <span className="text-gray-600">–</span>
                  <input type="number" min={1} value={tier.endMonth}
                    onChange={e => updateTier(i, 'endMonth', parseInt(e.target.value) || 1)}
                    className="input-dark w-16 text-sm text-center" placeholder="24" />
                  <span className="text-gray-500">→</span>
                  <input type="number" min={0} max={100} step={0.1} value={tier.rate}
                    onChange={e => updateTier(i, 'rate', parseFloat(e.target.value) || 0)}
                    className="input-dark w-16 text-sm text-center" placeholder="3" />
                  <span className="text-gray-500">%</span>
                  {value.tiers.length > 1 && (
                    <button type="button" onClick={() => removeTier(i)} className="text-gray-600 hover:text-red-400 ml-1">✕</button>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-600 mt-1.5">Month ranges are months elapsed since origination date.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Edit Modal ────────────────────────────────────────────────────────────────

function EditModal({ loan, properties, onClose, onSave }: {
  loan: Loan;
  properties: Property[];
  onClose: () => void;
  onSave: (updated: Loan) => void;
}) {
  const [form, setForm] = useState({
    lender: loan.lender,
    loanType: loan.loanType,
    paymentType: loan.paymentType ?? 'PRINCIPAL_AND_INTEREST',
    paymentStructureChangedAt: loan.paymentStructureChangedAt ? loan.paymentStructureChangedAt.slice(0, 10) : '',
    accountNumber: loan.accountNumber ?? '',
    originalAmount: loan.originalAmount != null ? String(loan.originalAmount) : '',
    interestRate: loan.interestRate != null ? String(loan.interestRate) : '',
    rateType: loan.rateType ?? 'FIXED',
    rateIndex: loan.rateIndex ?? 'PRIME',
    rateMargin: loan.rateMargin != null ? String(loan.rateMargin) : '',
    rateAdjustmentMonths: loan.rateAdjustmentMonths != null ? String(loan.rateAdjustmentMonths) : '12',
    monthlyPayment: loan.monthlyPayment != null ? String(loan.monthlyPayment) : '',
    balloonPaymentAmount: loan.balloonPaymentAmount != null ? String(loan.balloonPaymentAmount) : '',
    escrowAmount: loan.escrowAmount != null ? String(loan.escrowAmount) : '',
    currentBalance: loan.currentBalance != null ? String(loan.currentBalance) : '',
    dueDay: loan.dueDay != null ? String(loan.dueDay) : '',
    gracePeriodDays: loan.gracePeriodDays != null ? String(loan.gracePeriodDays) : '',
    originationDate: loan.originationDate ? loan.originationDate.slice(0, 10) : '',
    maturityDate: loan.maturityDate ? loan.maturityDate.slice(0, 10) : '',
    propertyId: loan.propertyId ?? '',
    notes: loan.notes ?? '',
    isPersonal: loan.isPersonal,
    isActive: loan.isActive,
  });
  const [penalty, setPenalty] = useState<PrepaymentPenalty | null>(loan.prepaymentPenaltyJson ?? null);
  const [saving, setSaving] = useState(false);

  function autoCalcBalance() {
    const P = parseFloat(form.originalAmount);
    const r = parseFloat(form.interestRate) / 12 / 100;
    const PMT = parseFloat(form.monthlyPayment);
    const origin = form.originationDate ? new Date(form.originationDate) : null;
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
    setForm(prev => ({ ...prev, currentBalance: String(Math.max(0, Math.round(balance * 100) / 100)) }));
  }

  function autoCalcPayment() {
    const r = parseFloat(form.interestRate) / 12 / 100;
    if (isNaN(r)) return;

    if (form.paymentType === 'INTEREST_ONLY') {
      // Interest-only payment is just this period's interest on whatever
      // balance is currently on file (fall back to the original amount for
      // a brand-new loan with no balance entered yet).
      const balance = parseFloat(form.currentBalance) || parseFloat(form.originalAmount);
      if (isNaN(balance) || balance <= 0) return;
      setForm(prev => ({ ...prev, monthlyPayment: String(Math.round(balance * r * 100) / 100) }));
      return;
    }

    // Standard amortizing payment over the full origination-to-maturity term.
    const P = parseFloat(form.originalAmount);
    const origin = form.originationDate ? new Date(form.originationDate) : null;
    const maturity = form.maturityDate ? new Date(form.maturityDate) : null;
    if (!origin || !maturity || isNaN(P) || P <= 0) return;
    const n = Math.max(1, Math.round(
      (maturity.getFullYear() - origin.getFullYear()) * 12 + (maturity.getMonth() - origin.getMonth())
    ));
    const payment = r > 0
      ? (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
      : P / n;
    setForm(prev => ({ ...prev, monthlyPayment: String(Math.round(payment * 100) / 100) }));
  }

  const f = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [field]: e.target.value }));

  // Switching to Interest Only should immediately reflect the interest-only
  // payment, not leave whatever number was on file from a P&I calculation —
  // that stale-looking number was the bug: the dropdown changed but nothing
  // recalculated until Auto-calc was clicked again.
  function handlePaymentTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    setForm(prev => {
      if (value !== 'INTEREST_ONLY') return { ...prev, paymentType: value };
      const r = parseFloat(prev.interestRate) / 12 / 100;
      const balance = parseFloat(prev.currentBalance) || parseFloat(prev.originalAmount);
      if (isNaN(r) || isNaN(balance) || balance <= 0) return { ...prev, paymentType: value };
      return { ...prev, paymentType: value, monthlyPayment: String(Math.round(balance * r * 100) / 100) };
    });
  }

  async function handleSave() {
    if (!form.lender) return;
    setSaving(true);
    try {
      const payload: any = {
        lender: form.lender,
        loanType: form.loanType,
        paymentType: form.paymentType,
        paymentStructureChangedAt: form.paymentStructureChangedAt || null,
        accountNumber: form.accountNumber || null,
        originalAmount: form.originalAmount ? parseFloat(form.originalAmount) : null,
        interestRate: form.interestRate ? parseFloat(form.interestRate) : null,
        rateType: form.rateType,
        rateIndex: form.rateType === 'VARIABLE' ? form.rateIndex : null,
        rateMargin: form.rateType === 'VARIABLE' && form.rateMargin ? parseFloat(form.rateMargin) : null,
        rateAdjustmentMonths: form.rateType === 'VARIABLE' && form.rateAdjustmentMonths ? parseInt(form.rateAdjustmentMonths, 10) : null,
        monthlyPayment: form.monthlyPayment ? parseFloat(form.monthlyPayment) : null,
        balloonPaymentAmount: form.balloonPaymentAmount ? parseFloat(form.balloonPaymentAmount) : null,
        escrowAmount: form.escrowAmount ? parseFloat(form.escrowAmount) : null,
        currentBalance: form.currentBalance ? parseFloat(form.currentBalance) : null,
        dueDay: form.dueDay ? parseInt(form.dueDay, 10) : null,
        gracePeriodDays: form.gracePeriodDays ? parseInt(form.gracePeriodDays, 10) : null,
        originationDate: form.originationDate || null,
        maturityDate: form.maturityDate || null,
        propertyId: form.propertyId || null,
        notes: form.notes || null,
        isPersonal: form.isPersonal,
        isActive: form.isActive,
        prepaymentPenaltyJson: penalty?.enabled ? penalty : null,
      };
      const updated = await updateLoan(loan.id, payload);
      onSave(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto"
        style={{ background: '#1a1a1a', border: '1px solid rgba(255,255,255,0.1)' }}>
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-white/8"
          style={{ background: '#1a1a1a' }}>
          <h2 className="text-base font-semibold text-white">Edit loan</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none">×</button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Lender + type */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs text-gray-500 mb-1">Lender / name</label>
              <input value={form.lender} onChange={f('lender')} className="input-dark w-full text-sm" placeholder="e.g. Monty James" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Loan type</label>
              <select value={form.loanType} onChange={f('loanType')} className="input-dark w-full text-sm">
                {LOAN_TYPES.map(t => <option key={t} value={t}>{LOAN_TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Payment structure</label>
              <select value={form.paymentType} onChange={handlePaymentTypeChange} className="input-dark w-full text-sm">
                <option value="PRINCIPAL_AND_INTEREST">P+I (Principal & Interest)</option>
                <option value="INTEREST_ONLY">Interest only</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-gray-500 mb-1">Structure changed on</label>
              <input type="date" value={form.paymentStructureChangedAt} onChange={f('paymentStructureChangedAt')} className="input-dark w-full text-sm" />
              <p className="text-xs text-gray-600 mt-1">If this loan converted from P&amp;I to interest-only (or back) at some point, record when — e.g. a loan modification or forbearance.</p>
            </div>
          </div>

          {/* Financials */}
          <div>
            <p className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wide">Financials</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Original loan amount</label>
                <input type="number" value={form.originalAmount} onChange={f('originalAmount')} className="input-dark w-full text-sm" placeholder="150000" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Interest rate (%)</label>
                <input type="number" step="0.001" value={form.interestRate} onChange={f('interestRate')} className="input-dark w-full text-sm" placeholder="10.0"
                  disabled={form.rateType === 'VARIABLE'} title={form.rateType === 'VARIABLE' ? 'Auto-calculated from the index rate + margin below — not editable directly while variable' : undefined} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Rate type</label>
                <select value={form.rateType} onChange={e => setForm(f => ({ ...f, rateType: e.target.value as 'FIXED' | 'VARIABLE' }))} className="input-dark w-full text-sm">
                  <option value="FIXED">Fixed</option>
                  <option value="VARIABLE">Variable (indexed)</option>
                </select>
              </div>
              {form.rateType === 'VARIABLE' && (
                <div className="col-span-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Index</label>
                    <select value={form.rateIndex} onChange={e => setForm(f => ({ ...f, rateIndex: e.target.value }))} className="input-dark w-full text-sm">
                      <option value="PRIME">Prime</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Margin (%)</label>
                    <input type="number" step="0.001" value={form.rateMargin} onChange={f('rateMargin')} className="input-dark w-full text-sm" placeholder="-1.0" />
                    <p className="text-xs text-gray-600 mt-1">e.g. -1.0 = 1% below index</p>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Resets every (months)</label>
                    <input type="number" min={1} value={form.rateAdjustmentMonths} onChange={f('rateAdjustmentMonths')} className="input-dark w-full text-sm" placeholder="12" />
                  </div>
                  <p className="col-span-3 text-xs text-gray-500">
                    Interest rate is recalculated automatically as {form.rateIndex} + margin on each reset anniversary — log {form.rateIndex} rate changes under Settings.
                    {loan.nextRateAdjustment && <> Next reset: <span className="text-gray-300">{fmtDate(loan.nextRateAdjustment, 'MMM d, yyyy')}</span>.</>}
                  </p>
                </div>
              )}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-500">Monthly payment (P&amp;I)</label>
                  <button
                    type="button"
                    onClick={autoCalcPayment}
                    className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
                    title={form.paymentType === 'INTEREST_ONLY'
                      ? 'Calculate from current balance & interest rate'
                      : 'Calculate from original amount, interest rate, origination & maturity dates'}
                  >
                    ⟳ Auto-calc
                  </button>
                </div>
                <input type="number" value={form.monthlyPayment} onChange={f('monthlyPayment')} className="input-dark w-full text-sm" placeholder="1250" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Escrow (taxes/insurance)</label>
                <input type="number" value={form.escrowAmount} onChange={f('escrowAmount')} className="input-dark w-full text-sm" placeholder="On top of P&I" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-500">Current balance</label>
                  <button
                    type="button"
                    onClick={autoCalcBalance}
                    className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
                    title="Calculate from origination date, original amount, interest rate & monthly payment"
                  >
                    ⟳ Auto-calc
                  </button>
                </div>
                <input type="number" value={form.currentBalance} onChange={f('currentBalance')} className="input-dark w-full text-sm" placeholder="148000" />
              </div>
              {form.paymentType === 'INTEREST_ONLY' && (
                <div className="col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">Balloon payment amount</label>
                  <input type="number" value={form.balloonPaymentAmount} onChange={f('balloonPaymentAmount')} className="input-dark w-full text-sm" placeholder="e.g. 426320.12" />
                  <p className="text-xs text-gray-600 mt-1">
                    The actual lump-sum payoff due at maturity, if it's a fixed amount from the note rather than
                    just the projected balance — leave blank to project the payoff from balance + that month's interest.
                  </p>
                </div>
              )}
              {form.monthlyPayment && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Total monthly (P&amp;I + escrow)</p>
                  <p className="text-sm text-white pt-1.5">{money((parseFloat(form.monthlyPayment) || 0) + (parseFloat(form.escrowAmount) || 0))}</p>
                </div>
              )}
            </div>
          </div>

          {/* Dates */}
          <div>
            <p className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wide">Dates &amp; due date</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Origination date</label>
                <input type="date" value={form.originationDate} onChange={f('originationDate')} className="input-dark w-full text-sm" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Maturity date</label>
                <input type="date" value={form.maturityDate} onChange={f('maturityDate')} className="input-dark w-full text-sm" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Due day of month</label>
                <input type="number" min={1} max={31} value={form.dueDay} onChange={f('dueDay')} className="input-dark w-full text-sm" placeholder="1" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Grace period (days)</label>
                <input type="number" min={0} value={form.gracePeriodDays} onChange={f('gracePeriodDays')} className="input-dark w-full text-sm" placeholder="15" />
              </div>
            </div>
          </div>

          {/* Property + account */}
          <div>
            <p className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wide">Details</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 mb-1">Attached property</label>
                <select value={form.propertyId} onChange={f('propertyId')} className="input-dark w-full text-sm">
                  <option value="">— No property —</option>
                  {properties.map(p => (
                    <option key={p.id} value={p.id}>{p.nickname || p.address}{p.city ? `, ${p.city}` : ''}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Account number</label>
                <input value={form.accountNumber} onChange={f('accountNumber')} className="input-dark w-full text-sm" placeholder="Full account number" />
              </div>
              <div className="flex flex-col justify-end gap-2 pb-0.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.isPersonal}
                    onChange={e => setForm(p => ({ ...p, isPersonal: e.target.checked }))}
                    className="rounded border-white/20" />
                  <span className="text-sm text-gray-300">Personal loan</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.isActive}
                    onChange={e => setForm(p => ({ ...p, isActive: e.target.checked }))}
                    className="rounded border-white/20" />
                  <span className="text-sm text-gray-300">Active</span>
                </label>
              </div>
            </div>
            <div className="mt-3">
              <label className="block text-xs text-gray-500 mb-1">Notes</label>
              <textarea value={form.notes} onChange={f('notes')} rows={2} className="input-dark w-full text-sm resize-none" placeholder="VVW loan, ~$150k…" />
            </div>
          </div>

          {/* Prepayment penalty */}
          <div>
            <p className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wide">Prepayment penalty</p>
            <PenaltyEditor value={penalty} onChange={setPenalty} />
          </div>
        </div>

        <div className="sticky bottom-0 flex justify-end gap-2 px-6 py-4 border-t border-white/8"
          style={{ background: '#1a1a1a' }}>
          <button onClick={onClose} className="btn text-sm">Cancel</button>
          <button onClick={handleSave} disabled={saving || !form.lender} className="btn btn-primary text-sm">
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Prepayment Penalty Card ───────────────────────────────────────────────────

function PrepaymentCard({ loan, currentBalance }: { loan: Loan; currentBalance: number }) {
  const penalty = loan.prepaymentPenaltyJson;
  if (!penalty?.enabled || !loan.originationDate) return null;

  const calc = calcPrepaymentPenalty(penalty, loan.originationDate, currentBalance);

  return (
    <div className="card p-4 mb-6">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-medium text-white">Prepayment penalty</p>
        {calc.inPenaltyPeriod
          ? <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.25)' }}>Active</span>
          : <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(16,185,129,0.12)', color: '#34d399', border: '1px solid rgba(16,185,129,0.25)' }}>Expired</span>
        }
      </div>

      {calc.inPenaltyPeriod ? (
        <div className="space-y-4">
          {/* Current penalty amount */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div className="rounded-lg px-3 py-2.5" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
              <p className="text-xs text-gray-500 mb-1">Current penalty rate</p>
              <p className="text-lg font-semibold text-red-400">{calc.currentRate != null ? pct(calc.currentRate) : '—'}</p>
              <p className="text-xs text-gray-600">of outstanding balance</p>
            </div>
            <div className="rounded-lg px-3 py-2.5" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
              <p className="text-xs text-gray-500 mb-1">Penalty if paid today</p>
              <p className="text-lg font-semibold text-red-400">{moneyPrecise(calc.penaltyAmount)}</p>
              <p className="text-xs text-gray-600">on {money(currentBalance)} balance</p>
            </div>
            <div className="rounded-lg px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <p className="text-xs text-gray-500 mb-1">Month {calc.monthsElapsed} of {penalty.periodMonths}</p>
              <p className="text-lg font-semibold text-white">{penalty.periodMonths - calc.monthsElapsed}mo left</p>
              <p className="text-xs text-gray-600">penalty ends {format(calc.penaltyEnds, 'MMM yyyy')}</p>
            </div>
          </div>

          {/* Tier timeline */}
          {penalty.tiers.length > 1 && (
            <div>
              <p className="text-xs text-gray-500 mb-2">Penalty schedule</p>
              <div className="space-y-1.5">
                {penalty.tiers.map((tier, i) => {
                  const tierStart = addMonths(new Date(loan.originationDate!), tier.startMonth);
                  const tierEnd = addMonths(new Date(loan.originationDate!), tier.endMonth);
                  const isActive = calc.monthsElapsed >= tier.startMonth && calc.monthsElapsed < tier.endMonth;
                  const isPast = calc.monthsElapsed >= tier.endMonth;
                  return (
                    <div key={i} className={`flex items-center gap-3 text-xs rounded-lg px-3 py-2 ${isActive ? 'bg-red-500/10 border border-red-500/20' : ''}`}>
                      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isActive ? 'bg-red-400' : isPast ? 'bg-gray-600' : 'bg-gray-500'}`} />
                      <span className={isPast ? 'text-gray-600 line-through' : isActive ? 'text-white font-medium' : 'text-gray-400'}>
                        {format(tierStart, 'MMM yyyy')} – {format(tierEnd, 'MMM yyyy')}
                      </span>
                      <span className={`ml-auto font-mono ${isActive ? 'text-red-400 font-semibold' : isPast ? 'text-gray-600' : 'text-gray-400'}`}>
                        {pct(tier.rate)}
                      </span>
                      {isActive && <span className="text-red-400 text-xs">← now</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Payoff calculator */}
          <PrepayoffCalc loan={loan} currentBalance={currentBalance} penalty={penalty} calc={calc} />
        </div>
      ) : (
        <p className="text-sm text-gray-400">
          The {penalty.periodMonths}-month prepayment penalty period ended{' '}
          <span className="text-white">{format(calc.penaltyEnds, 'MMMM yyyy')}</span>.
          This loan can now be paid off without penalty.
        </p>
      )}
    </div>
  );
}

function PrepayoffCalc({ loan, currentBalance, penalty, calc }: {
  loan: Loan;
  currentBalance: number;
  penalty: PrepaymentPenalty;
  calc: ReturnType<typeof calcPrepaymentPenalty>;
}) {
  const [payoffAmount, setPayoffAmount] = useState(String(Math.round(currentBalance)));
  const balNum = parseFloat(payoffAmount) || currentBalance;

  const activeTier = calc.currentRate != null ? penalty.tiers.find(t =>
    calc.monthsElapsed >= t.startMonth && calc.monthsElapsed < t.endMonth
  ) : null;

  const penaltyOnAmount = activeTier ? balNum * (activeTier.rate / 100) : 0;
  const totalCost = balNum + penaltyOnAmount;

  // When does the next cheaper tier start?
  const nextTier = penalty.tiers.find(t => t.startMonth > calc.monthsElapsed);
  const nextTierDate = nextTier && loan.originationDate
    ? addMonths(new Date(loan.originationDate), nextTier.startMonth)
    : null;

  return (
    <div className="rounded-lg p-4 space-y-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <p className="text-xs font-medium text-gray-300">Payoff calculator</p>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">Payoff amount</label>
          <input
            type="number"
            value={payoffAmount}
            onChange={e => setPayoffAmount(e.target.value)}
            className="input-dark w-full text-sm"
            placeholder={String(Math.round(currentBalance))}
          />
        </div>
        <div className="flex-1">
          <p className="text-xs text-gray-500 mb-1">Penalty ({activeTier ? pct(activeTier.rate) : '—'})</p>
          <p className="text-base font-semibold text-red-400">{moneyPrecise(penaltyOnAmount)}</p>
        </div>
        <div className="flex-1">
          <p className="text-xs text-gray-500 mb-1">Total out of pocket</p>
          <p className="text-base font-semibold text-white">{moneyPrecise(totalCost)}</p>
        </div>
      </div>
      {nextTierDate && activeTier && (
        <p className="text-xs text-gray-500">
          Wait until <span className="text-amber-400">{format(nextTierDate, 'MMMM yyyy')}</span> and the rate drops to{' '}
          <span className="text-amber-400">{pct(nextTier!.rate)}</span>{' '}
          — saving <span className="text-green-400">{moneyPrecise(balNum * ((activeTier.rate - nextTier!.rate) / 100))}</span> in penalty fees.
        </p>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function LoanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [loan, setLoan] = useState<Loan | null>(null);
  const [amort, setAmort] = useState<AmortizationResponse | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [showFullSchedule, setShowFullSchedule] = useState(false);
  const [scheduleView, setScheduleView] = useState<'remaining' | 'past'>('remaining');
  const [chartFullRange, setChartFullRange] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showExtend, setShowExtend] = useState(false);

  const reload = () => {
    if (!id) return Promise.resolve();
    return Promise.all([getLoan(id), getLoanAmortization(id)])
      .then(([l, a]) => { setLoan(l); setAmort(a as AmortizationResponse); });
  };

  useEffect(() => {
    if (!id) return;
    Promise.all([getLoan(id), getLoanAmortization(id), getProperties()])
      .then(([l, a, props]) => { setLoan(l); setAmort(a as AmortizationResponse); setProperties(props); })
      .finally(() => setLoading(false));
  }, [id]);

  const currentBalance = useMemo(() => amort?.balance.balance ?? Number(loan?.currentBalance ?? 0), [amort, loan]);
  const originalAmount = useMemo(() => Number(loan?.originalAmount ?? 0), [loan]);
  const paidOff = useMemo(() => originalAmount > 0 ? Math.max(0, Math.min(100, ((originalAmount - currentBalance) / originalAmount) * 100)) : 0, [originalAmount, currentBalance]);
  // "manual" method with no currentBalance on file means we have nothing to
  // calculate from at all — showing $0 / 100% paid off would be a lie, not a fact.
  const hasBalanceData = amort ? (amort.balance.method !== 'manual' || loan?.currentBalance != null) : true;

  if (loading) return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  if (!loan || !amort) return <div className="p-6 text-gray-500 text-sm">Loan not found</div>;

  const { balance, amortization } = amort;

  // For negative-am/interest-only schedules that end in a real balloon
  // payoff (last row's balance hits 0), the "peak" balance the loan grows
  // to is the row before that — the final row itself is the lump-sum payoff,
  // not another month of growth.
  const lastScheduleRow = amortization.schedule[amortization.schedule.length - 1];
  const reachesBalloonPayoff = lastScheduleRow?.balance === 0 && amortization.schedule.length > 1;
  const peakBalanceRow = reachesBalloonPayoff
    ? amortization.schedule[amortization.schedule.length - 2]
    : lastScheduleRow;

  const history = (loan.loanPayments || [])
    .filter(p => p.balanceAfter != null)
    .slice()
    .reverse()
    .map(p => ({ date: p.date, balance: Number(p.balanceAfter), kind: 'actual' as const }));
  // Plotting the full term of a fresh 30-year loan makes the chart look like
  // a long flat stretch, since early-life balance movement is tiny next to
  // the total. Default to a 10-year window; let the user expand it.
  const CHART_DEFAULT_MONTHS = 120;
  const chartSchedule = chartFullRange ? amortization.schedule : amortization.schedule.slice(0, CHART_DEFAULT_MONTHS);
  const projected = chartSchedule
    .filter((_, i) => i % Math.max(1, Math.floor(chartSchedule.length / 60)) === 0 || i === chartSchedule.length - 1)
    .map(r => ({ date: r.date, balance: r.balance, kind: 'projected' as const }));
  const chartData = [...history, { date: balance.asOfDate, balance: balance.balance, kind: 'actual' as const }, ...projected];

  return (
    <div className="p-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-1">
        <div>
          <Link to="/loans" className="text-xs text-gray-500 hover:text-gray-300">&larr; Loans</Link>
          <h1 className="text-xl font-semibold text-white mt-1">{loan.lender}</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {LOAN_TYPE_LABELS[loan.loanType] ?? loan.loanType}
            {loan.paymentType === 'INTEREST_ONLY' && (
              <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(245,166,35,0.12)', color: '#F5A623' }}>
                Interest only{loan.paymentStructureChangedAt ? ` since ${fmtDate(loan.paymentStructureChangedAt, 'MMM yyyy')}` : ''}
              </span>
            )}
            {loan.accountNumber ? (
              <span> &middot; Acct #{loan.accountNumber}</span>
            ) : loan.accountLast4 ? (
              <span> &middot; &middot;&middot;&middot;{loan.accountLast4}</span>
            ) : null}
            {loan.property && (
              <> &middot; <Link to={`/properties/${loan.property.id}`} className="text-amber-400 hover:text-amber-300">{loan.property.nickname || loan.property.address}</Link></>
            )}
            {(loan as any).utilityAccount && (
              <> &middot; <Link to={`/utilities/${(loan as any).utilityAccount.id}`} className="text-indigo-400 hover:text-indigo-300">
                Linked: {(loan as any).utilityAccount.providerName}
              </Link></>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loan.isPersonal && <span className="pill pill-purple">Personal</span>}
          {!loan.isActive && <span className="pill pill-gray">Closed</span>}
          {loan.maturityDate && (
            <button onClick={() => setShowExtend(true)} className="btn text-sm">Extend</button>
          )}
          <button onClick={() => setShowEdit(true)} className="btn text-sm">Edit</button>
        </div>
      </div>

      {loan.maturityDate && (
        <p className="text-xs text-gray-500 mt-1">
          Maturity: <span className="text-gray-300">{fmtDate(loan.maturityDate, 'MMM d, yyyy')}</span>
          {loan.loanExtensions && loan.loanExtensions.length > 0 && (
            <span> &middot; extended {loan.loanExtensions.length} time{loan.loanExtensions.length > 1 ? 's' : ''}</span>
          )}
        </p>
      )}

      {amortization.negativeAmortization && (
        <div className="mt-4 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">
          The payment on file doesn't cover the monthly interest — unpaid interest is capitalizing into the balance instead of paying it down.
          {reachesBalloonPayoff && lastScheduleRow ? (
            <> Balance grows to <span className="font-medium">{money(peakBalanceRow?.balance ?? 0)}</span> by{' '}
            <span className="font-medium">{fmtDate(peakBalanceRow?.date ?? lastScheduleRow.date, 'MMM yyyy')}</span>, then the{' '}
            <span className="font-medium">{money(lastScheduleRow.paymentAmount)}</span> balloon payment due{' '}
            <span className="font-medium">{fmtDate(lastScheduleRow.date, 'MMM yyyy')}</span> pays it off.</>
          ) : amortization.scheduleEndsAt && (
            <> Projected through <span className="font-medium">{fmtDate(amortization.scheduleEndsAt, 'MMM yyyy')}</span>, that adds up to{' '}
            <span className="font-medium">{moneyPrecise(amortization.totalDeferredInterest)}</span> of deferred interest added to the balance.</>
          )}
        </div>
      )}

      {amortization.isInterestOnly && (
        <div className="mt-4 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2.5">
          Payments aren't reducing principal — this loan is interest-only{loan.paymentStructureChangedAt ? ` as of ${fmtDate(loan.paymentStructureChangedAt, 'MMMM yyyy')}` : ''}.
          {amortization.scheduleEndsAt && (
            <> Balance projected to stay flat at <span className="font-medium">{money(balance.balance)}</span> through{' '}
            <span className="font-medium">{fmtDate(amortization.scheduleEndsAt, 'MMM yyyy')}</span>.</>
          )}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
        <div className="stat-card">
          <p className="text-xs text-gray-500 mb-1">Current balance</p>
          <p className={`text-xl font-semibold ${hasBalanceData ? 'text-red-400' : 'text-gray-500'}`}>
            {hasBalanceData ? money(balance.balance) : '—'}
          </p>
          <p className="text-xs text-gray-600 mt-1">{hasBalanceData ? BALANCE_METHOD_LABELS[balance.method] : 'No balance on file'}</p>
        </div>
        <div className="stat-card">
          <p className="text-xs text-gray-500 mb-1">{loan.escrowAmount ? 'Total monthly (P&I + escrow)' : 'Monthly payment'}</p>
          <p className="text-xl font-semibold text-white">
            {money(Number(loan.monthlyPayment ?? amortization.computedMonthlyPayment) + Number(loan.escrowAmount ?? 0))}
          </p>
          {loan.escrowAmount ? (
            <p className="text-xs text-gray-600 mt-1">{money(Number(loan.monthlyPayment ?? amortization.computedMonthlyPayment))} P&I + {money(Number(loan.escrowAmount))} escrow</p>
          ) : !loan.monthlyPayment ? (
            <p className="text-xs text-gray-600 mt-1">Estimated</p>
          ) : null}
          {loan.dueDay && (
            <p className="text-xs text-gray-600 mt-1">
              Due day {loan.dueDay}{loan.gracePeriodDays ? ` · ${loan.gracePeriodDays}d grace` : ''}
            </p>
          )}
        </div>
        <div className="stat-card">
          <p className="text-xs text-gray-500 mb-1">{amortization.negativeAmortization || amortization.isInterestOnly ? 'Balance trend' : 'Payoff date'}</p>
          {amortization.negativeAmortization ? (
            <>
              <p className="text-xl font-semibold text-red-400">Growing</p>
              {reachesBalloonPayoff && lastScheduleRow ? (
                <p className="text-xs text-gray-600 mt-1">
                  Balloon due {fmtDate(lastScheduleRow.date, 'MMM yyyy')}: {money(lastScheduleRow.paymentAmount)}
                </p>
              ) : amortization.scheduleEndsAt && (
                <p className="text-xs text-gray-600 mt-1">
                  {money(peakBalanceRow?.balance ?? 0)} by {fmtDate(amortization.scheduleEndsAt, 'MMM yyyy')}
                </p>
              )}
            </>
          ) : amortization.isInterestOnly ? (
            <>
              <p className="text-xl font-semibold text-amber-400">Flat</p>
              {amortization.scheduleEndsAt && (
                <p className="text-xs text-gray-600 mt-1">
                  Interest-only through {fmtDate(amortization.scheduleEndsAt, 'MMM yyyy')}
                </p>
              )}
            </>
          ) : (
            <>
              <p className={`text-xl font-semibold ${amortization.payoffDate ? 'text-green-400' : 'text-gray-500'}`}>
                {amortization.payoffDate ? fmtDate(amortization.payoffDate, 'MMM yyyy') : '—'}
              </p>
              {amortization.monthsRemaining && <p className="text-xs text-gray-600 mt-1">{amortization.monthsRemaining} payments left</p>}
            </>
          )}
        </div>
        <div className="stat-card">
          <p className="text-xs text-gray-500 mb-1">
            Interest rate{loan.rateType === 'VARIABLE' && <span className="ml-1 text-amber-400">(variable)</span>}
          </p>
          <p className="text-xl font-semibold text-white">{loan.interestRate != null ? `${loan.interestRate}%` : '—'}</p>
          {loan.rateType === 'VARIABLE' ? (
            <p className="text-xs text-gray-600 mt-1">
              {loan.rateIndex} {loan.rateMargin != null && Number(loan.rateMargin) >= 0 ? '+' : ''}{loan.rateMargin}%
              {loan.nextRateAdjustment && <> · resets {fmtDate(loan.nextRateAdjustment, 'MMM yyyy')}</>}
            </p>
          ) : (
            <p className="text-xs text-gray-600 mt-1">{money(amortization.totalInterestRemaining)} interest remaining</p>
          )}
        </div>
      </div>

      {/* Payoff progress bar */}
      {originalAmount > 0 && !hasBalanceData && (
        <div className="mt-4 mb-6 card p-4 text-xs text-gray-500">
          No current balance on file for this loan yet — enter one (or an origination date + payment history) under Edit to see payoff progress.
        </div>
      )}
      {originalAmount > 0 && hasBalanceData && (
        <div className="mt-4 mb-6 card p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-500">{currentBalance > originalAmount ? 'Balance vs. original' : 'Payoff progress'}</p>
            <p className="text-xs font-semibold text-white">
              {currentBalance > originalAmount ? `${money(currentBalance - originalAmount)} above original` : `${paidOff.toFixed(1)}% paid off`}
            </p>
          </div>
          <div className="w-full h-2.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: currentBalance > originalAmount ? '100%' : `${paidOff}%`,
                background: currentBalance > originalAmount ? '#ef4444' : 'linear-gradient(90deg, #6366f1, #8b5cf6)',
              }}
            />
          </div>
          <div className="flex justify-between mt-1.5 text-xs text-gray-600">
            <span>{money(originalAmount - currentBalance)} paid</span>
            <span>{money(currentBalance)} remaining of {money(originalAmount)}</span>
          </div>
          {amortization.totalInterestRemaining > 0 && (
            <div className="mt-2 pt-2 border-t border-white/6 flex gap-6 text-xs text-gray-500">
              <span>Total interest remaining: <span className="text-gray-300">{money(amortization.totalInterestRemaining)}</span></span>
              {amortization.totalInterestToDate > 0 && <span>Interest paid to date: <span className="text-gray-300">{money(amortization.totalInterestToDate)}</span></span>}
            </div>
          )}
        </div>
      )}

      {/* Prepayment penalty */}
      <PrepaymentCard loan={loan} currentBalance={currentBalance} />

      {/* Extension history */}
      {loan.loanExtensions && loan.loanExtensions.length > 0 && (
        <div className="card p-4 mb-6">
          <p className="text-sm font-medium text-white mb-3">Extension history</p>
          <div className="space-y-2">
            {loan.loanExtensions.map(ext => (
              <div key={ext.id} className="flex items-center justify-between text-xs border-b border-white/5 pb-2 last:border-0 last:pb-0">
                <div className="text-gray-400">
                  <span className="text-white font-medium">+{ext.months} month{ext.months !== 1 ? 's' : ''}</span>
                  {ext.previousMaturityDate && (
                    <> — {fmtDate(ext.previousMaturityDate, 'MMM yyyy')} &rarr; {fmtDate(ext.newMaturityDate, 'MMM yyyy')}</>
                  )}
                  {ext.notes && <span className="text-gray-500"> · {ext.notes}</span>}
                </div>
                <span className="text-gray-600">{fmtDate(ext.extendedAt, 'MMM d, yyyy')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Balance over time chart */}
      {chartData.length > 1 && (
        <div className="card p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-gray-500">Balance over time — actual payments + projected payoff path</p>
            {amortization.schedule.length > CHART_DEFAULT_MONTHS && (
              <button onClick={() => setChartFullRange(v => !v)} className="text-xs text-amber-400 hover:text-amber-300">
                {chartFullRange ? 'Show 10yr window' : `Show full ${Math.ceil(amortization.schedule.length / 12)}yr term`}
              </button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f87171" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#f87171" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="date" tickFormatter={d => fmtDate(d, 'MMM yy')} stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
              <YAxis tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} width={48} />
              <Tooltip
                contentStyle={{ background: '#242424', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                labelFormatter={d => fmtDate(d, 'MMM d, yyyy')}
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
            <div className="flex items-center gap-3">
              <p className="text-sm font-medium text-white">
                {scheduleView === 'past'
                  ? 'Past months (calculated from origination — not actual payment records)'
                  : amortization.negativeAmortization ? 'Projected balance schedule (negative amortization)'
                  : amortization.isInterestOnly ? 'Projected interest-only schedule'
                  : 'Remaining amortization schedule'}
              </p>
              {amortization.historicalSchedule.length > 0 && (
                <div className="flex rounded-lg overflow-hidden border border-white/10 text-xs flex-shrink-0">
                  <button
                    onClick={() => setScheduleView('remaining')}
                    className={`px-2.5 py-1 ${scheduleView === 'remaining' ? 'bg-amber-500/20 text-amber-400' : 'text-gray-500 hover:text-gray-300'}`}
                  >Remaining</button>
                  <button
                    onClick={() => setScheduleView('past')}
                    className={`px-2.5 py-1 ${scheduleView === 'past' ? 'bg-amber-500/20 text-amber-400' : 'text-gray-500 hover:text-gray-300'}`}
                  >Past</button>
                </div>
              )}
            </div>
            {(scheduleView === 'past' ? amortization.historicalSchedule : amortization.schedule).length > 12 && (
              <button onClick={() => setShowFullSchedule(v => !v)} className="text-xs text-amber-400 hover:text-amber-300">
                {showFullSchedule ? 'Show less' : `Show all ${(scheduleView === 'past' ? amortization.historicalSchedule : amortization.schedule).length}`}
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Date</th>
                  <th className="text-right">Payment</th>
                  <th className="text-right">Principal</th>
                  <th className="text-right">Interest</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = scheduleView === 'past' ? amortization.historicalSchedule : amortization.schedule;
                  const visible = showFullSchedule ? rows : (scheduleView === 'past' ? rows.slice(-12) : rows.slice(0, 12));
                  return visible.map(row => (
                    <tr key={row.paymentNumber}>
                      <td className="text-gray-600">{row.paymentNumber}</td>
                      <td>{fmtDate(row.date, 'MMM yyyy')}</td>
                      <td className="text-right font-mono">{moneyPrecise(row.paymentAmount)}</td>
                      <td className={`text-right font-mono ${row.principal < 0 ? 'text-red-400' : 'text-green-400'}`}>
                        {row.principal < 0 ? `+${moneyPrecise(-row.principal)}` : moneyPrecise(row.principal)}
                      </td>
                      <td className="text-right font-mono text-gray-400">{moneyPrecise(row.interest)}</td>
                      <td className="text-right font-mono">{moneyPrecise(row.balance)}</td>
                    </tr>
                  ));
                })()}
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
                    <td>{fmtDate(p.date, 'MMM d, yyyy')}</td>
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

      {/* Edit modal */}
      {showEdit && (
        <EditModal
          loan={loan}
          properties={properties}
          onClose={() => setShowEdit(false)}
          onSave={updated => { setLoan(updated); reload(); }}
        />
      )}

      {/* Extend modal */}
      {showExtend && loan.maturityDate && (
        <ExtendLoanModal
          loan={loan}
          onClose={() => setShowExtend(false)}
          onSave={async () => { setShowExtend(false); await reload(); }}
        />
      )}
    </div>
  );
}

function ExtendLoanModal({ loan, onClose, onSave }: {
  loan: Loan; onClose: () => void; onSave: () => void;
}) {
  const [months, setMonths] = useState('12');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentMaturity = loan.maturityDate ? new Date(loan.maturityDate) : null;
  const monthsNum = parseInt(months, 10);
  const previewDate = currentMaturity && monthsNum > 0
    ? new Date(currentMaturity.getFullYear(), currentMaturity.getMonth() + monthsNum, currentMaturity.getDate())
    : null;

  async function handleSave() {
    if (!monthsNum || monthsNum <= 0) return;
    setSaving(true);
    setError(null);
    try {
      await extendLoan(loan.id, { months: monthsNum, notes: notes || undefined });
      onSave();
    } catch {
      setError('Failed to extend loan. Please try again.');
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl p-6" style={{ background: '#1a1a1a', border: '1px solid rgba(255,255,255,0.1)' }}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-white">Extend loan</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">{error}</div>}

        <p className="text-xs text-gray-500 mb-3">
          Current maturity: <span className="text-gray-300">{currentMaturity ? format(currentMaturity, 'MMM d, yyyy') : '—'}</span>
        </p>

        <label className="block text-xs text-gray-500 mb-1">Extend by</label>
        <div className="flex gap-2 mb-3">
          {[12, 24, 36, 60].map(m => (
            <button key={m} type="button" onClick={() => setMonths(String(m))}
              className={`text-xs px-3 py-1.5 rounded-lg border ${months === String(m) ? 'border-amber-500 text-amber-400' : 'border-white/10 text-gray-400 hover:text-gray-200'}`}>
              {m % 12 === 0 ? `${m / 12}yr` : `${m}mo`}
            </button>
          ))}
          <input type="number" min={1} value={months} onChange={e => setMonths(e.target.value)}
            className="input-dark text-xs w-20 text-center" placeholder="Months" />
        </div>

        {previewDate && (
          <p className="text-xs text-gray-500 mb-3">
            New maturity: <span className="text-emerald-400 font-medium">{format(previewDate, 'MMM d, yyyy')}</span>
          </p>
        )}

        <label className="block text-xs text-gray-500 mb-1">Notes (optional)</label>
        <input value={notes} onChange={e => setNotes(e.target.value)} className="input-dark w-full text-sm mb-4" placeholder="e.g. exercised lender's 2-year extension option" />

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn text-sm">Cancel</button>
          <button onClick={handleSave} disabled={saving || !monthsNum} className="btn-primary text-sm disabled:opacity-50">
            {saving ? 'Extending…' : 'Extend loan'}
          </button>
        </div>
      </div>
    </div>
  );
}
