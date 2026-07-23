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
  schedule: AmortizationRow[];    // forward-looking, from current balance to payoff
  payoffDate: string | null;
  monthsRemaining: number | null;
  totalInterestRemaining: number;
  totalPaidToDate: number;
  totalInterestToDate: number;
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

  // 3. Theoretical schedule from origination to today.
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

  // 4. Nothing to compute from — fall back to whatever was manually entered.
  return { balance: loan.currentBalance ?? 0, asOfDate: iso(new Date()), method: 'manual' };
}

function computeMonthlyPayment(principal: number, monthlyRate: number, termMonths: number): number {
  if (monthlyRate === 0) return principal / termMonths;
  const factor = Math.pow(1 + monthlyRate, termMonths);
  return (principal * monthlyRate * factor) / (factor - 1);
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
      schedule: [],
      payoffDate: null,
      monthsRemaining: null,
      totalInterestRemaining: 0,
      totalPaidToDate,
      totalInterestToDate,
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
  const negativeAmortization = payment <= firstMonthInterest;

  const schedule: AmortizationRow[] = [];
  let balance = balanceResult.balance;
  const startDate = new Date(balanceResult.asOfDate);
  let totalInterestRemaining = 0;

  // Cap at 600 rows (50 years) as a hard safety limit against runaway loops
  // when a payment doesn't cover interest.
  for (let i = 1; i <= 600 && balance > 0.01; i++) {
    const interest = balance * monthlyRate;
    let principal = payment - interest;
    let paymentAmount = payment;

    if (negativeAmortization) {
      // Balance would never reach zero — stop projecting and let the
      // caller flag it instead of looping forever.
      break;
    }

    if (principal >= balance) {
      principal = balance;
      paymentAmount = balance + interest;
    }

    balance = Math.max(0, balance - principal);
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

  return {
    isAmortizing: true,
    monthlyRate,
    computedMonthlyPayment: Math.round(payment * 100) / 100,
    negativeAmortization,
    schedule,
    payoffDate: negativeAmortization ? null : (last?.date ?? null),
    monthsRemaining: negativeAmortization ? null : schedule.length,
    totalInterestRemaining: Math.round(totalInterestRemaining * 100) / 100,
    totalPaidToDate,
    totalInterestToDate,
  };
}
