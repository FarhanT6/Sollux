// Reconstructs a monthly LoanPayment history from each loan's origination
// date up to today, so "interest paid to date" on the Loans page has real
// numbers to sum instead of $0. This is an ESTIMATE, not verified real
// payment history — every inserted row is tagged in its notes field so it
// can always be told apart from a manually logged payment later.
//
// Safety rules:
//   - Only loans with ZERO existing LoanPayment rows are touched. A loan
//     with any real payment history (even one row) is skipped entirely —
//     this script never edits or duplicates existing records.
//   - Requires originalAmount, interestRate, originationDate, and
//     monthlyPayment on file; loans missing any of those are skipped.
//   - HELOC/CREDIT_LINE are skipped (revolving, no fixed schedule).
//   - The final backfilled month is adjusted (a "plug") so the running
//     balance lands exactly on the loan's real currentBalance on file,
//     since a pure theoretical projection from origination terms will
//     rarely match a real-world balance to the penny.
//
// Usage:
//   cd backend
//   DATABASE_URL=<neon url> npx tsx scripts/backfill-loan-payments.ts          # dry run, prints a plan
//   DATABASE_URL=<neon url> DRY_RUN=false npx tsx scripts/backfill-loan-payments.ts   # actually writes

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN !== 'false';
const BACKFILL_TAG = 'Backfilled estimate from origination date — not a verified transaction.';
const REVOLVING_TYPES = new Set(['HELOC', 'CREDIT_LINE']);

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}
function monthsBetween(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

async function main() {
  const loans = await db.loan.findMany({ include: { _count: { select: { loanPayments: true } } } });
  console.log(`${loans.length} total loans. DRY_RUN=${DRY_RUN}`);

  let backfilled = 0, skippedHasHistory = 0, skippedMissingData = 0, skippedRevolving = 0;

  for (const loan of loans) {
    if (loan._count.loanPayments > 0) { skippedHasHistory++; continue; }
    if (REVOLVING_TYPES.has(loan.loanType)) { skippedRevolving++; continue; }
    if (loan.originalAmount == null || loan.interestRate == null || loan.originationDate == null || loan.monthlyPayment == null || loan.currentBalance == null) {
      skippedMissingData++;
      continue;
    }

    const originalAmount = Number(loan.originalAmount);
    const monthlyRate = Number(loan.interestRate) / 100 / 12;
    const payment = Number(loan.monthlyPayment);
    const targetBalance = Number(loan.currentBalance);
    const isInterestOnly = loan.paymentType === 'INTEREST_ONLY';

    const today = new Date();
    const elapsed = Math.max(0, monthsBetween(loan.originationDate, today));
    if (elapsed === 0) { console.log(`- ${loan.lender}: originated this month or later, nothing to backfill.`); continue; }

    const rows: { date: Date; amount: number; principal: number; interest: number; balanceAfter: number }[] = [];
    let balance = originalAmount;
    for (let i = 1; i <= elapsed; i++) {
      const interest = balance * monthlyRate;
      let principal = isInterestOnly ? 0 : payment - interest; // negative here IS negative amortization — matches buildAmortizationSchedule
      balance = Math.max(0, balance - principal);
      rows.push({ date: addMonths(loan.originationDate, i), amount: isInterestOnly ? interest : payment, principal, interest, balanceAfter: balance });
      if (balance <= 0) break;
    }

    // Plug the last row so the reconstructed history lands exactly on the
    // real current balance instead of wherever the theoretical formula
    // happens to end up.
    const last = rows[rows.length - 1];
    if (last) {
      const diff = last.balanceAfter - targetBalance; // positive = theoretical balance too high, needs more principal applied
      last.principal += diff;
      last.amount += diff;
      last.balanceAfter = targetBalance;
    }

    console.log(`- ${loan.lender} (${loan.loanType}): ${rows.length} months, ${originalAmount.toFixed(2)} -> ${targetBalance.toFixed(2)}`);
    backfilled++;

    if (!DRY_RUN) {
      await db.loanPayment.createMany({
        data: rows.map(r => ({
          loanId: loan.id,
          date: r.date,
          amount: Math.round(r.amount * 100) / 100,
          status: 'PAID',
          principal: Math.round(r.principal * 100) / 100,
          interest: Math.round(r.interest * 100) / 100,
          balanceAfter: Math.round(r.balanceAfter * 100) / 100,
          notes: BACKFILL_TAG,
        })),
      });
    }
  }

  console.log(`\n${DRY_RUN ? 'Would backfill' : 'Backfilled'} ${backfilled} loans.`);
  console.log(`Skipped: ${skippedHasHistory} already have payment history, ${skippedRevolving} revolving (HELOC/credit line), ${skippedMissingData} missing required fields.`);
  if (DRY_RUN) console.log('\nThis was a dry run — nothing was written. Re-run with DRY_RUN=false to commit.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
