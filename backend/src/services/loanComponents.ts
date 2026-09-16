import { db } from '../config/db';

/**
 * The loans a servicer bills together under one account, rolled up.
 *
 * A federal student-loan statement lists each loan (Group AA Direct
 * Subsidized, Group BB Direct Unsubsidized) with its own principal, rate and
 * payment, and asks for one combined payment. The parent Loan is what the
 * rest of Sollux reads (pay planner, portfolio, amortisation), so once an
 * account has components its figures are their totals:
 *
 *  - originalAmount, monthlyPayment: the sums
 *  - currentBalance: outstanding principal plus any unpaid accrued interest
 *  - interestRate: weighted by outstanding balance (a 6.39% / 4.99% pair does
 *    not average to the midpoint)
 *  - originationDate: the earliest disbursement; maturityDate: the latest payoff
 *
 * An account with no components keeps whatever was entered on it.
 */
export async function syncLoanFromComponents(loanId: string): Promise<void> {
  const parts = await db.loanComponent.findMany({ where: { loanId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  if (parts.length === 0) return;

  const num = (v: unknown) => (v == null ? null : Number(v));
  const sum = (vals: (number | null)[]) => {
    const present = vals.filter((v): v is number => v != null);
    return present.length ? Number(present.reduce((a, b) => a + b, 0).toFixed(2)) : null;
  };

  const originals = parts.map(p => num(p.originalAmount));
  const balances = parts.map(p => num(p.currentBalance));
  const accrued = parts.map(p => num(p.accruedInterest));
  const payments = parts.map(p => num(p.monthlyPayment));

  const originalAmount = sum(originals);
  const principal = sum(balances);
  const interestOwed = sum(accrued);
  const currentBalance = principal == null && interestOwed == null ? null : Number(((principal ?? 0) + (interestOwed ?? 0)).toFixed(2));
  const monthlyPayment = sum(payments);

  // Weight each rate by its balance; fall back to original principal, then
  // to a plain mean, so a rate still rolls up while balances are unknown.
  const rated = parts.map((p, i) => ({ rate: num(p.interestRate), weight: balances[i] ?? originals[i] ?? 1 }))
    .filter((x): x is { rate: number; weight: number } => x.rate != null);
  const totalWeight = rated.reduce((a, x) => a + x.weight, 0);
  const interestRate = rated.length === 0 ? null
    : totalWeight > 0 ? Number((rated.reduce((a, x) => a + x.rate * x.weight, 0) / totalWeight).toFixed(3))
    : Number((rated.reduce((a, x) => a + x.rate, 0) / rated.length).toFixed(3));

  const origins = parts.map(p => p.originationDate).filter((d): d is Date => d != null);
  const maturities = parts.map(p => p.maturityDate).filter((d): d is Date => d != null);
  const originationDate = origins.length ? new Date(Math.min(...origins.map(d => d.getTime()))) : undefined;
  const maturityDate = maturities.length ? new Date(Math.max(...maturities.map(d => d.getTime()))) : undefined;

  await db.loan.update({
    where: { id: loanId },
    data: {
      ...(originalAmount != null ? { originalAmount } : {}),
      ...(currentBalance != null ? { currentBalance, ...(currentBalance <= 0.005 ? { isActive: false } : { isActive: true }) } : {}),
      ...(monthlyPayment != null ? { monthlyPayment } : {}),
      ...(interestRate != null ? { interestRate } : {}),
      ...(originationDate ? { originationDate } : {}),
      ...(maturityDate ? { maturityDate } : {}),
    },
  });
}

/** Decimal fields as numbers, the way the loan itself is serialised. */
export function serializeLoanComponent(c: any) {
  const out = { ...c };
  for (const f of ['originalAmount', 'currentBalance', 'interestRate', 'monthlyPayment', 'accruedInterest'] as const) {
    if (out[f] != null) out[f] = Number(out[f]);
  }
  return out;
}
