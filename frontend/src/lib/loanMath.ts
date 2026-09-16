/**
 * What a loan should stand at today if every scheduled payment had been made,
 * plus whatever the lender says is still owed from missed ones.
 *
 * The amount amortised is what was actually financed: the original amount
 * less any down payment. Payments are counted one per month from the
 * origination date. Payments the borrower has missed are still owed, so the
 * lender's past-due figure is added back — that is how a 60-month, 0% loan
 * of $54,837 at $913.95 with six missed payments lands on the statement's
 * $30,160.35 rather than the schedule's $24,676.65.
 */
export function projectLoanBalance(input: {
  originalAmount: number | string | null | undefined;
  downPayment?: number | string | null;
  interestRate?: number | string | null;
  monthlyPayment: number | string | null | undefined;
  originationDate: string | null | undefined;
  arrears?: number | null;
  today?: Date;
}): number | null {
  const num = (v: number | string | null | undefined) => {
    if (v == null || v === '') return NaN;
    return typeof v === 'number' ? v : parseFloat(v);
  };
  const original = num(input.originalAmount);
  const down = num(input.downPayment);
  const PMT = num(input.monthlyPayment);
  const rate = num(input.interestRate);
  const P = original - (isNaN(down) ? 0 : down);
  const origin = input.originationDate ? input.originationDate.match(/^(\d{4})-(\d{2})/) : null;
  if (!origin || isNaN(P) || isNaN(PMT) || P <= 0 || PMT <= 0) return null;

  const today = input.today ?? new Date();
  const n = Math.max(0, (today.getFullYear() - Number(origin[1])) * 12 + (today.getMonth() + 1 - Number(origin[2])));
  const r = !isNaN(rate) && rate > 0 ? rate / 12 / 100 : 0;
  let balance: number;
  if (r > 0) {
    const factor = Math.pow(1 + r, n);
    balance = P * factor - PMT * (factor - 1) / r;
  } else {
    balance = P - PMT * n;
  }
  balance = Math.max(0, balance) + Math.max(0, input.arrears ?? 0);
  return Math.round(balance * 100) / 100;
}
