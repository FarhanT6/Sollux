// Loan amortization engine — auto-calculates current balance from actual
// payment history (not just a manually-typed number), then projects the
// remaining schedule forward to payoff.
//
// Balance is derived with a fallback chain, most authoritative first:
//   1. balanceAfter on the most recent payment (reflects real-world extras,
//      refinances, escrow adjustments — whatever actually happened)
//   2. originalAmount minus the sum of recorded principal payments
//   3. theoretical schedule computed from originationDate to today (only
//      when there's no payment history to work from at all)

export interface LoanInput {
  originalAmount: number | null;
  interestRate: number | null;   // annual %, e.g. 6.5
  originationDate: Date | null;
  maturityDate: Date | null;
  monthlyPayment: number | null;
  currentBalance: number | null; // manually-entered fallback/seed value
  loanType: string;
  paymentType?: string | null;   // 'INTEREST_ONLY' forces principal to 0 in the forward projection
  balloonPaymentAmount?: number | null; // final lump-sum payoff at maturityDate, when it differs from monthlyPayment
}

export interface PaymentInput {
  date: Date;
  amount: number;
  principal: number | null;
  interest: number | null;
  balanceAfter: number | null;
}

export interface BalanceResult {
  balance: number;
  asOfDate: string; // YYYY-MM-DD
  method: 'balance_after' | 'payment_sum' | 'theoretical' | 'manual';
}

export interface AmortizationRow {
  paymentNumber: number;
  date: string;       // YYYY-MM-DD
  paymentAmount: number;
  principal: number;
  interest: number;
  balance: number;
}

export interface AmortizationResult {
  isAmortizing: boolean;          // false for HELOC/CREDIT_LINE — no fixed schedule
  monthlyRate: number;
  computedMonthlyPayment: number; // theoretical P&I payment, whether or not one is on file
  negativeAmortization: boolean;  // true if the payment on file doesn't cover interest
  isInterestOnly: boolean;        // true when projecting a flat balance under an interest-only payment structure
  schedule: AmortizationRow[];    // forward-looking, from current balance to payoff
  payoffDate: string | null;
  monthsRemaining: number | null;
  totalInterestRemaining: number;
  totalDeferredInterest: number;  // unpaid interest capitalized into the balance (negative amortization only)
  scheduleEndsAt: string | null;  // last projected date — payoff date, or projection horizon if negatively amortizing
  totalPaidToDate: number;
  totalInterestToDate: number;
  historicalSchedule: AmortizationRow[]; // origination date through the current-balance date, calculated (not actual payment records)
}

const REVOLVING_TYPES = new Set(['HELOC', 'CREDIT_LINE']);

function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function calculateCurrentBalance(loan: LoanInput, payments: PaymentInput[]): BalanceResult {
  const sorted = [...payments].sort((a, b) => b.date.getTime() - a.date.getTime());

  // 1. Most recent payment's recorded balanceAfter — most authoritative.
  const withBalance = sorted.find(p => p.balanceAfter != null);
  if (withBalance) {
    return { balance: withBalance.balanceAfter!, asOfDate: iso(withBalance.date), method: 'balance_after' };
  }

  // 2. Sum of recorded principal payments, subtracted from the original amount.
  if (loan.originalAmount != null && sorted.some(p => p.principal != null)) {
    const totalPrincipalPaid = sorted.reduce((sum, p) => sum + (p.principal || 0), 0);
    const balance = Math.max(0, loan.originalAmount - totalPrincipalPaid);
    return { balance, asOfDate: iso(sorted[0].date), method: 'payment_sum' };
  }

  // 3. An explicitly entered current balance — trust it over a generic
  // projection. The user (or the Auto-calc button, seeded from the same
  // inputs) may know about extra payments, refinances, or other real-world
  // events a theoretical schedule can't see.
  if (loan.currentBalance != null) {
    return { balance: loan.currentBalance, asOfDate: iso(new Date()), method: 'manual' };
  }

  // 4. Last resort: theoretical schedule from origination to today, only
  // when there's nothing else — not even a manually entered balance.
  if (loan.originalAmount != null && loan.interestRate != null && loan.originationDate) {
    const monthlyRate = loan.interestRate / 100 / 12;
    const today = new Date();
    const elapsed = Math.max(0, monthsBetween(loan.originationDate, today));

    const termMonths = loan.maturityDate ? monthsBetween(loan.originationDate, loan.maturityDate) : null;
    const payment = loan.monthlyPayment ?? (termMonths ? computeMonthlyPayment(loan.originalAmount, monthlyRate, termMonths) : null);

    if (payment) {
      let balance = loan.originalAmount;
      for (let i = 0; i < elapsed && balance > 0; i++) {
        const interest = balance * monthlyRate;
        const principal = Math.min(balance, payment - interest);
        balance = Math.max(0, balance - principal);
      }
      return { balance: Math.round(balance * 100) / 100, asOfDate: iso(today), method: 'theoretical' };
    }
  }

  // 5. Nothing on file at all.
  return { balance: 0, asOfDate: iso(new Date()), method: 'manual' };
}

function computeMonthlyPayment(principal: number, monthlyRate: number, termMonths: number): number {
  if (monthlyRate === 0) return principal / termMonths;
  const factor = Math.pow(1 + monthlyRate, termMonths);
  return (principal * monthlyRate * factor) / (factor - 1);
}

// Reconstructs the schedule from origination through the current-balance
// date, assuming a constant payment/rate the whole way — this is a
// calculated view, not the actual recorded payment history (see the
// Payment History table for that), useful for seeing where a given past
// month's payment split between principal and interest.
function buildHistoricalSchedule(loan: LoanInput, balanceResult: BalanceResult, monthlyRate: number): AmortizationRow[] {
  if (!loan.originationDate || loan.originalAmount == null) return [];
  const asOfDate = new Date(balanceResult.asOfDate);
  const totalMonths = monthsBetween(loan.originationDate, asOfDate);
  if (totalMonths <= 0) return [];

  let payment = loan.monthlyPayment ?? null;
  if (!payment && loan.maturityDate) {
    const termMonths = Math.max(1, monthsBetween(loan.originationDate, loan.maturityDate));
    payment = computeMonthlyPayment(loan.originalAmount, monthlyRate, termMonths);
  }
  if (!payment) payment = computeMonthlyPayment(loan.originalAmount, monthlyRate, 360);

  const rows: AmortizationRow[] = [];
  let balance = loan.originalAmount;
  for (let i = 1; i <= totalMonths && i <= 600; i++) {
    const interest = balance * monthlyRate;
    let principal = payment - interest;
    let paymentAmount = payment;
    if (principal >= balance) {
      principal = balance;
      paymentAmount = balance + interest;
    }
    balance = Math.max(0, balance - Math.max(0, principal));

    rows.push({
      paymentNumber: i,
      date: iso(addMonths(loan.originationDate, i)),
      paymentAmount: Math.round(paymentAmount * 100) / 100,
      principal: Math.round(principal * 100) / 100,
      interest: Math.round(interest * 100) / 100,
      balance: Math.round(balance * 100) / 100,
    });

    if (balance <= 0.01) break;
  }

  return rows;
}

export function buildAmortizationSchedule(
  loan: LoanInput,
  balanceResult: BalanceResult,
  payments: PaymentInput[]
): AmortizationResult {
  const isAmortizing = !REVOLVING_TYPES.has(loan.loanType) && loan.interestRate != null && balanceResult.balance > 0;
  const monthlyRate = (loan.interestRate ?? 0) / 100 / 12;

  const totalPaidToDate = payments.reduce((s, p) => s + p.amount, 0);
  const totalInterestToDate = payments.reduce((s, p) => s + (p.interest || 0), 0);

  if (!isAmortizing) {
    return {
      isAmortizing: false,
      monthlyRate,
      computedMonthlyPayment: loan.monthlyPayment ?? 0,
      negativeAmortization: false,
      isInterestOnly: false,
      schedule: [],
      payoffDate: null,
      monthsRemaining: null,
      totalInterestRemaining: 0,
      totalDeferredInterest: 0,
      scheduleEndsAt: null,
      totalPaidToDate,
      totalInterestToDate,
      historicalSchedule: [],
    };
  }

  // Figure out the payment to project with: use what's on file, or derive one
  // from whatever term remains to the stated maturity date.
  let payment = loan.monthlyPayment ?? null;
  if (!payment && loan.maturityDate) {
    const remainingMonths = Math.max(1, monthsBetween(new Date(balanceResult.asOfDate), loan.maturityDate));
    payment = computeMonthlyPayment(balanceResult.balance, monthlyRate, remainingMonths);
  }
  if (!payment) {
    // No payment and no maturity date to derive one from — amortize over a
    // conservative 30-year assumption just so something projects.
    payment = computeMonthlyPayment(balanceResult.balance, monthlyRate, 360);
  }

  const firstMonthInterest = balanceResult.balance * monthlyRate;
  // Half-cent epsilon so a payment that exactly covers interest (common for
  // interest-only loans, or a payment back-solved from the same balance/rate)
  // doesn't get misclassified as negative amortization by floating-point noise.
  const negativeAmortization = payment < firstMonthInterest - 0.005;

  // An explicit interest-only payment structure forces principal to 0 each
  // period (flat balance) regardless of what number happens to be on file —
  // unless the loan is genuinely underwater (negative amortization above
  // takes priority, since that's a real shortfall, not an intentional structure).
  const isInterestOnly = !negativeAmortization && loan.paymentType === 'INTEREST_ONLY';

  // Negative-amortization and interest-only balances don't naturally reach
  // zero, so there's no organic stopping point. Project to the stated
  // maturity date if there is one (most ARMs/HELOCs/IO periods recast or
  // mature on a known date); otherwise fall back to a 10-year horizon —
  // long enough to show the trend, short enough not to imply decades of
  // unchecked projection as if it were a real forecast.
  const startDate = new Date(balanceResult.asOfDate);
  const flatHorizonMonths = (negativeAmortization || isInterestOnly)
    ? Math.min(600, Math.max(1, loan.maturityDate ? monthsBetween(startDate, loan.maturityDate) : 120))
    : null;

  // Negative-am/interest-only loans with a stated maturity date end in a
  // real balloon payoff, not another regular payment — the note's final
  // installment is a distinct lump sum (principal + that month's interest),
  // not just another $X recurring payment. Without this the projection
  // would keep compounding past the maturity date's true payoff amount.
  const isBalloonMaturity = (negativeAmortization || isInterestOnly) && loan.maturityDate != null;

  const schedule: AmortizationRow[] = [];
  let balance = balanceResult.balance;
  let totalInterestRemaining = 0;
  let totalDeferredInterest = 0;

  // Cap at 600 rows (50 years) as a hard safety limit against runaway loops.
  for (let i = 1; i <= 600 && (flatHorizonMonths != null ? i <= flatHorizonMonths : balance > 0.01); i++) {
    const interest = balance * monthlyRate;
    const isFinalBalloonRow = isBalloonMaturity && i === flatHorizonMonths;
    let principal = isFinalBalloonRow ? balance : isInterestOnly ? 0 : payment - interest;
    let paymentAmount = isFinalBalloonRow
      ? (loan.balloonPaymentAmount ?? balance + interest)
      : isInterestOnly ? interest : payment;

    if (!negativeAmortization && !isInterestOnly && principal >= balance) {
      principal = balance;
      paymentAmount = balance + interest;
    }

    if (!isFinalBalloonRow && principal < 0) totalDeferredInterest += -principal;

    balance = isFinalBalloonRow ? 0 : Math.max(0, balance - principal);
    totalInterestRemaining += interest;

    schedule.push({
      paymentNumber: i,
      date: iso(addMonths(startDate, i)),
      paymentAmount: Math.round(paymentAmount * 100) / 100,
      principal: Math.round(principal * 100) / 100,
      interest: Math.round(interest * 100) / 100,
      balance: Math.round(balance * 100) / 100,
    });
  }

  const last = schedule[schedule.length - 1];
  const reachedPayoff = last != null && last.balance === 0;

  return {
    isAmortizing: true,
    monthlyRate,
    computedMonthlyPayment: Math.round(payment * 100) / 100,
    negativeAmortization,
    isInterestOnly,
    schedule,
    payoffDate: reachedPayoff ? last!.date : null,
    monthsRemaining: reachedPayoff ? schedule.length : null,
    totalInterestRemaining: Math.round(totalInterestRemaining * 100) / 100,
    totalDeferredInterest: Math.round(totalDeferredInterest * 100) / 100,
    scheduleEndsAt: last?.date ?? null,
    historicalSchedule: buildHistoricalSchedule(loan, balanceResult, monthlyRate),
    totalPaidToDate,
    totalInterestToDate,
  };
}
