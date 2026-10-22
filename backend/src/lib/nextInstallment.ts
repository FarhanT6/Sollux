/**
 * Statements for account cards: the newest bills that have fallen due, plus
 * the next installment scheduled ahead, not every one. Capital Premium
 * Financing files a policy's whole payment schedule ahead of time, so "the
 * newest few statements" were next year's (Feb to May 2027) and the card
 * said "Due Apr 30" in October.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';

/** Statement filter: not an installment still scheduled ahead. */
export function fallenDue(now = new Date()): Prisma.StatementWhereInput {
  return { OR: [{ isScheduled: false }, { dueDate: null }, { dueDate: { lte: now } }] };
}

/**
 * Adds each account's next scheduled installment (the earliest still ahead)
 * to its statements, newest-first as the cards read them.
 */
export async function withNextInstallment<S extends { statementDate: Date }, A extends { id: string; statements: S[] }>(
  accounts: A[], select?: Prisma.StatementSelect, now = new Date(),
): Promise<A[]> {
  if (!accounts.length) return accounts;
  const next = await db.statement.findMany({
    where: { utilityAccountId: { in: accounts.map(a => a.id) }, isScheduled: true, dueDate: { gt: now } },
    orderBy: [{ utilityAccountId: 'asc' }, { dueDate: 'asc' }],
    distinct: ['utilityAccountId'],
    ...(select ? { select: { ...select, utilityAccountId: true } } : {}),
  }) as unknown as (S & { utilityAccountId: string })[];
  const by = new Map(next.map(s => [s.utilityAccountId, s]));
  return accounts.map(a => {
    const s = by.get(a.id);
    if (!s) return a;
    const { utilityAccountId: _u, ...row } = s as any;
    return { ...a, statements: [...(select && !('utilityAccountId' in select) ? [row] : [s]), ...a.statements] };
  });
}
