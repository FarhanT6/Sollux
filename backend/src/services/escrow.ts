import { db } from '../config/db';

/**
 * An account the lender pays from escrow (home insurance, property tax on a
 * mortgage with an impound account). Its bills are kept for the record but
 * nothing is owed on them here — the money leaves inside the mortgage
 * payment — so every bill on it reads as paid, and anything that adds up
 * what is owed or spent leaves the account out (the mortgage carries it).
 *
 * Called after the flag is set and after each import, so bills that arrive
 * later are covered too.
 */
export async function markEscrowedStatements(utilityAccountId: string): Promise<void> {
  const account = await db.utilityAccount.findUnique({ where: { id: utilityAccountId }, select: { escrowLoanId: true } });
  if (!account?.escrowLoanId) return;
  await db.statement.updateMany({
    where: { utilityAccountId, paidOverride: null },
    data: { paidOverride: 'PAID' },
  });
}

/** The reverse, when escrow is switched off: bills nobody actually paid open again. */
export async function unmarkEscrowedStatements(utilityAccountId: string): Promise<void> {
  await db.statement.updateMany({
    where: { utilityAccountId, paidOverride: 'PAID', amountPaid: null, payments: { none: { status: { in: ['PAID', 'PARTIAL'] } } } },
    data: { paidOverride: null },
  });
}
