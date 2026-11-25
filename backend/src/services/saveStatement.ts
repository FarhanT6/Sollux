/**
 * One way to save a bill once it is read and matched to its account. Add (routes/import.ts
 * confirm), Drive (routes/drive.ts) and the email and portal intake (services/documentIntake.ts)
 * each kept their own copy of this, and each dropped something the others kept: Drive never
 * stored the arrangement installment, penalty date or aging; intake never stored the solar
 * true-up in the bill's data, never cleared a "paid" the old reading put there, and left a
 * scheduled installment row marked scheduled when the real bill replaced it; Add kept a stale
 * carried figure when a bill printed its total. Most of the misreads that came back after a
 * re-read (#278, a ledger's payments lost) came from one copy doing it differently.
 *
 * What stays with the caller: reading the document, finding the account and the bill already on
 * file (services/billMatch.ts, sameBillByDue), the owner's-figures check (statementConflict.ts),
 * and where the file is stored.
 */
import { Prisma, type Statement } from '@prisma/client';
import { db } from '../config/db';
import type { ExtractedBillData } from './pdfImportService';
import { periodChargeOf, recordConfirmedPayment, syncPaymentPlanFromBill, syncInsurancePolicyFromBill, syncLoanComponentsFromBill, syncTrueUpFromBill } from './pdfImportService';
import { keepOwnerFigures } from './statementConflict';
import { restoreLateFees } from './lateFees';
import { learnProviderWebsite } from './providerWebsite';
import { markEscrowedStatements } from './escrow';
import { reconcileRecent } from './billIdentity';
import { settleCarriedFees } from './carriedFees';

/** What the bill asks in all: its own charges plus what it carried in, else its amount due. */
export function totalDueOf(ex: ExtractedBillData): number | null {
  return (ex.currentCharges != null || ex.previousBalance != null)
    ? (ex.currentCharges ?? 0) + (ex.previousBalance ?? 0)
    : ex.amountDue ?? null;
}

/** The bill's figures as stored on the statement (rawDataJson), the same from every path. */
export function buildRawData(ex: ExtractedBillData, source: string, extractedBy?: 'ai' | 'text' | null) {
  return {
    source,
    // Which reader produced these figures; without it the auditor cannot tell these rows from legacy imports (#241).
    extractedBy: extractedBy ?? null,
    providerName: ex.providerName,
    serviceAddress: ex.serviceAddress,
    accountNumber: ex.accountNumber,
    previousBalance: ex.previousBalance,
    paymentsReceived: ex.paymentsReceived,
    currentCharges: ex.currentCharges,
    totalDue: totalDueOf(ex),
    pastDue: ex.previousBalance != null && ex.previousBalance > 0 ? ex.previousBalance : undefined,
    lateFee: ex.lateFee,
    isPaid: ex.isPaid,
    utilityType: ex.utilityType,
    chargeBreakdown: ex.chargeBreakdown,
    alerts: ex.alerts,
    ratePlan: ex.ratePlan,
    // What the bill states about the account as a whole — its total balance and any payment arrangement.
    statedTotalDue: ex.statedTotalDue ?? null,
    totalAccountBalance: ex.totalAccountBalance ?? null,
    paymentPlan: ex.paymentPlan ?? null,
    paymentPlanAmount: ex.paymentPlanAmount ?? null,
    insurance: ex.insurance ?? null,
    netMetering: ex.netMetering ?? null,
    // The statement's transaction table as printed, a running ledger's payments on their dates, and a
    // loan statement's figures: what the late-fee check and the loan read from the stored bill.
    transactions: ex.transactions ?? null,
    ledgerPayments: ex.ledgerPayments ?? null,
    loanStatement: ex.loanStatement ?? null,
    // Figures read from an email, not a statement; the real statement replaces them when it comes.
    emailNotice: ex.fromEmailBody ? true : undefined,
  };
}

export interface SaveStatementInput {
  accountId: string;
  ex: ExtractedBillData;
  statementDate: Date;
  /** The bill already on file for this period, found by the caller; null for a new one. */
  existing: Statement | null;
  rawData: Record<string, unknown>;
  pdfS3Key: string | null;
  /** The owner's figures stand (the bill agrees with what they typed, or they chose Keep mine). */
  keepOwner?: boolean;
  /** The period the caller settled on (Add infers one from the month); else the bill's own. */
  period?: { start: Date | null; end: Date | null };
  /**
   * 'replace': the file given is this bill's statement (Add, Drive). 'upgrade': only over a stand-in —
   * none on file, an email's figures, or a portal page saved in place of the PDF (email, portal).
   */
  pdf: 'replace' | 'upgrade';
  /** A portal's page saved in place of its PDF (services/pageSaved.ts). */
  pageSaved?: boolean;
  /** Move the bill to the date read now (Add and Drive did; a re-read of a bill on file keeps its date). */
  moveDate?: boolean;
}

/** Files the bill: the owner's figures kept, the bill on file updated, or a new statement; then everything that follows a filing. */
export async function saveStatement(o: SaveStatementInput): Promise<{ id: string; outcome: 'kept-owner' | 'updated' | 'new' }> {
  const { accountId, ex, existing } = o;
  if (existing && o.keepOwner) {
    await keepOwnerFigures(existing, ex, o.rawData, o.pdfS3Key);
    await recordConfirmedPayment(accountId, existing.id, ex);
    await syncPaymentPlanFromBill(accountId, ex);
    await syncInsurancePolicyFromBill(accountId, ex);
    await learnProviderWebsite(accountId, ex);
    await syncLoanComponentsFromBill(accountId, ex);
    return { id: existing.id, outcome: 'kept-owner' };
  }

  // amountDue = this period's charges (an installment billed inside them stays in); balance = all owed.
  const charge = periodChargeOf(ex);
  const totalDue = totalDueOf(ex);
  const balance = ex.totalAccountBalance ?? totalDue ?? charge;
  const paid = ex.isPaid && (totalDue ?? charge) != null ? Math.max((totalDue ?? charge)!, 0) : null;
  // What this bill carried in: positive is arrears, negative a credit; an exact zero says nothing.
  const carried = ex.previousBalance != null && ex.previousBalance !== 0 ? ex.previousBalance : null;
  const nem = ex.netMetering ?? null;
  const start = o.period ? o.period.start : ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : null;
  const end = o.period ? o.period.end : ex.billingPeriodEnd ? new Date(ex.billingPeriodEnd) : null;
  const extra = {
    ...(nem ? { trueUpDeferred: nem.deferred, trueUpBalance: nem.ytdBalance, trueUpDate: nem.trueUpDate ? new Date(nem.trueUpDate) : null } : {}),
    ...(ex.paymentPlanAmount != null ? { paymentPlanAmount: ex.paymentPlanAmount } : {}),
    ...(ex.penaltyDate ? { penaltyDate: new Date(ex.penaltyDate) } : {}),
    ...(ex.amountAfterDueDate != null ? { amountAfterDueDate: ex.amountAfterDueDate } : {}),
    ...(ex.agingBuckets ? { agingBuckets: ex.agingBuckets as Prisma.InputJsonValue } : {}),
  };

  let id: string, outcome: 'updated' | 'new';
  if (existing) {
    // A paid mark the old reading put there — its amount paid in full, no owner override — goes when
    // the re-read charge differs and the bill no longer reads as paid; the payments linked to it say what was paid.
    const stalePaid = !ex.isPaid && existing.paidOverride == null && existing.amountPaid != null && existing.amountDue != null && charge != null
      && Math.abs(Number(existing.amountPaid) - Number(existing.amountDue)) < 0.01 && Math.abs(charge - Number(existing.amountDue)) > 0.01;
    const linkedPaid = stalePaid ? (await db.payment.aggregate({ where: { statementId: existing.id, status: 'PAID' }, _sum: { amount: true } }))._sum.amount : null;
    // Older readings wrote the bill's "payments received" (the bill before's payment) as this bill's amount paid.
    const derivedPaid = ex.paymentsReceived != null && existing.amountPaid != null && Number(existing.amountPaid) === Number(ex.paymentsReceived);
    const raw = (existing.rawDataJson ?? {}) as Record<string, unknown>;
    const pdfOver = o.pdfS3Key && (o.pdf === 'replace' || !existing.pdfS3Key || !existing.billingPeriodStart || (!o.pageSaved && raw.pageSaved));
    await db.statement.update({
      where: { id: existing.id },
      data: {
        ...(o.moveDate ? { statementDate: o.statementDate } : {}),
        dueDate: ex.dueDate ? new Date(ex.dueDate) : existing.dueDate,
        billingPeriodStart: o.period ? start : start ?? existing.billingPeriodStart,
        billingPeriodEnd: o.period ? end : end ?? existing.billingPeriodEnd,
        amountDue: charge ?? existing.amountDue,
        balance: balance ?? existing.balance,
        amountPaid: paid ?? (stalePaid ? (linkedPaid != null && Number(linkedPaid) > 0 ? linkedPaid : null) : derivedPaid ? null : existing.amountPaid),
        // A bill that prints its total says what was carried in, nothing included: a stale carried figure goes (#278).
        pastDueCarried: carried ?? (ex.statedTotalDue != null ? null : existing.pastDueCarried),
        chargesExcludingFees: ex.currentCharges ?? existing.chargesExcludingFees,
        penaltiesFees: ex.lateFee ?? existing.penaltiesFees,
        usageValue: ex.usageValue ?? existing.usageValue,
        usageUnit: ex.usageUnit ?? existing.usageUnit,
        ratePlan: ex.ratePlan ?? existing.ratePlan,
        // A real bill now stands where a scheduled installment was.
        isScheduled: false,
        ...extra,
        rawDataJson: o.rawData as Prisma.InputJsonValue,
        ...(pdfOver ? { pdfS3Key: o.pdfS3Key } : {}),
      },
    });
    // Late fees logged with payments are not on the PDF; put them back.
    await restoreLateFees(existing.id, ex.lateFee ?? undefined);
    id = existing.id; outcome = 'updated';
  } else {
    const created = await db.statement.create({
      data: {
        utilityAccountId: accountId,
        statementDate: o.statementDate,
        dueDate: ex.dueDate ? new Date(ex.dueDate) : null,
        billingPeriodStart: start,
        billingPeriodEnd: end,
        amountDue: charge ?? null,
        balance: balance ?? null,
        amountPaid: paid,
        pastDueCarried: carried,
        chargesExcludingFees: ex.currentCharges ?? null,
        penaltiesFees: ex.lateFee ?? null,
        usageValue: ex.usageValue ?? null,
        usageUnit: ex.usageUnit ?? null,
        ratePlan: ex.ratePlan ?? null,
        pdfS3Key: o.pdfS3Key,
        sourceType: 'MANUAL',
        ...extra,
        rawDataJson: o.rawData as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    id = created.id; outcome = 'new';
  }
  await recordConfirmedPayment(accountId, id, ex);
  await syncPaymentPlanFromBill(accountId, ex);
  await syncInsurancePolicyFromBill(accountId, ex);
  await learnProviderWebsite(accountId, ex);
  await syncLoanComponentsFromBill(accountId, ex);
  await syncTrueUpFromBill(accountId, ex);
  await markEscrowedStatements(accountId);
  await reconcileRecent(accountId).catch(() => {});
  await settleCarriedFees(accountId).catch(() => {});
  return { id, outcome };
}
