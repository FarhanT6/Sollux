/**
 * Recording a manager's statement: each line it records becomes the owner's
 * record — rent a RentPayment for the month of the line's date, a loan line a
 * LoanPayment for that month (paid by the manager out of the rent), a fee or
 * repair the property's expense. Used by Record on the page and by statements
 * fetched from email, which are recorded on their own.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';

interface Item {
  type: 'RENT' | 'LOAN_PAYMENT' | 'EXPENSE' | 'OTHER'; targetId?: string | null; description?: string | null;
  amount: number; direction: 'CREDIT' | 'DEBIT'; date?: string | null; category?: string | null; propertyId?: string | null; include?: boolean;
}

export async function applyManagerStatement(userId: string, statementId: string) {
  const statement = await db.reconciliationStatement.findFirst({ where: { id: statementId, userId } });
  if (!statement) throw Object.assign(new Error('Statement not found'), { status: 404 });
  if (statement.status === 'APPLIED') throw Object.assign(new Error('Statement has already been applied'), { status: 400 });
  const profile = await db.reconciliationProfile.findFirst({ where: { id: statement.profileId, userId } });
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 });

  const lineItems = statement.lineItems as unknown as Item[];
  const periodDate = new Date(Date.UTC(statement.statementDate.getUTCFullYear(), statement.statementDate.getUTCMonth(), 1));
  const monthOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const rentPaymentIds: string[] = [], loanPaymentIds: string[] = [], expenseIds: string[] = [];

  await db.$transaction(async tx => {
    for (const item of lineItems) {
      if (item.include === false) continue;
      const itemDate = item.date ? new Date(`${item.date.slice(0, 10)}T00:00:00.000Z`) : statement.statementDate;
      const note = `Reconciled via ${profile.name} statement (${item.description ?? ''})`.trim();
      if (item.type === 'RENT' && item.targetId) {
        const p = await tx.rentPayment.create({
          data: { leaseId: item.targetId, periodDate: item.date ? monthOf(itemDate) : periodDate, amount: item.amount, paidDate: itemDate, method: 'OTHER', notes: note },
        });
        rentPaymentIds.push(p.id);
      } else if (item.type === 'LOAN_PAYMENT' && item.targetId) {
        // Paid for the month the statement shows it; the manager took it out of the rent.
        const p = await tx.loanPayment.create({
          data: { loanId: item.targetId, date: itemDate, periodDate: monthOf(itemDate), amount: item.amount, status: 'PAID', method: 'DEDUCTED', notes: note },
        });
        loanPaymentIds.push(p.id);
      } else if (item.type === 'EXPENSE' && (item.propertyId ?? profile.propertyId)) {
        const e = await tx.expense.create({
          data: {
            userId, propertyId: (item.propertyId ?? profile.propertyId)!, category: (item.category ?? profile.managementFeeCategory ?? 'PROPERTY_MANAGEMENT') as any,
            amount: item.amount, date: itemDate, vendor: profile.name, description: item.description || undefined, isCapEx: false, isPersonal: false,
          },
        });
        expenseIds.push(e.id);
      }
    }
    await tx.reconciliationStatement.update({
      where: { id: statement.id },
      data: { status: 'APPLIED', appliedAt: new Date(), createdRecordIds: { rentPaymentIds, loanPaymentIds, expenseIds } as unknown as Prisma.InputJsonValue },
    });
  });
  return { rent: rentPaymentIds.length, loanPayments: loanPaymentIds.length, expenses: expenseIds.length };
}
