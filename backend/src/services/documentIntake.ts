/**
 * Filing one bill document, wherever it came from — a Google Drive folder,
 * an email attachment. Read it (Claude or the text reader), match it to a
 * utility account, and either file it (a confident match), apply it (a
 * past-due notice or a policy document), or stage it for the owner's review
 * in the Import Bills flow. Moved out of the Drive worker so the inbox agent
 * files email the same way, with the same duplicate rules.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { restoreLateFees } from './lateFees';
import { fileCardStatement } from './cardIntake';
import { fileServiceInvoice, invoiceAmount } from './expenseIntake';
import { compareWithOwner, keepOwnerFigures, ownerEntered } from './statementConflict';
import { markEscrowedStatements } from './escrow';
import { settleInFull, applyPolicyDocument, recordConfirmedPayment, syncPaymentPlanFromBill, syncInsurancePolicyFromBill, syncLoanComponentsFromBill, applyPastDueNotice, parseBill } from './pdfImportService';
import { findOrCreateUtilityAccount } from './utilityAccountResolver';
import { uploadDocument, buildStatementKey } from './s3Service';

const UTILITY_TYPE_TO_CATEGORY: Record<string, string> = {
  electric: 'ELECTRIC', gas: 'GAS', water: 'WATER', sewer: 'SEWER', trash: 'TRASH',
  solar: 'SOLAR', internet: 'INTERNET', phone: 'PHONE', other: 'OTHER',
};

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export type ReviewItem = { filename: string; s3Key: string; extracted: Awaited<ReturnType<typeof parseBill>>['extracted']; match: Awaited<ReturnType<typeof parseBill>>['match'] };
export type IntakeResult =
  | { outcome: 'filed'; utilityAccountId: string }
  | { outcome: 'notice' }
  | { outcome: 'policy' }
  | { outcome: 'review'; reviewItem: ReviewItem }
  | { outcome: 'error'; error: string }
  | { outcome: 'not_a_bill' }
  | { outcome: 'card'; cardId: string; cardName: string; created: boolean }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'expense'; expenseId: string; duplicate: boolean };

export function buildRawData(ex: Awaited<ReturnType<typeof parseBill>>['extracted'], source = 'drive_import') {
  const totalDue = (ex.currentCharges != null || ex.previousBalance != null)
    ? (ex.currentCharges ?? 0) + (ex.previousBalance ?? 0)
    : ex.amountDue;
  return {
    source,
    providerName: ex.providerName,
    serviceAddress: ex.serviceAddress,
    accountNumber: ex.accountNumber,
    previousBalance: ex.previousBalance,
    paymentsReceived: ex.paymentsReceived,
    currentCharges: ex.currentCharges,
    totalDue,
    pastDue: ex.previousBalance != null && ex.previousBalance > 0 ? ex.previousBalance : undefined,
    isPaid: ex.isPaid,
    utilityType: ex.utilityType,
    chargeBreakdown: ex.chargeBreakdown,
    alerts: ex.alerts,
    ratePlan: ex.ratePlan,
    statedTotalDue: ex.statedTotalDue ?? null,
    totalAccountBalance: ex.totalAccountBalance ?? null,
    paymentPlan: ex.paymentPlan ?? null,
    paymentPlanAmount: ex.paymentPlanAmount ?? null,
    insurance: ex.insurance ?? null,
    transactions: ex.transactions ?? null,
  };
}

/**
 * @param batchId groups staged review copies under pending-review/<user>/<batch>/
 * @param source recorded in the statement's raw data ('drive_import', 'email')
 */
export async function intakeBill(buffer: Buffer, filename: string, userId: string, method: 'ai' | 'regex', batchId: string, source = 'drive_import'): Promise<IntakeResult> {
  // parseBill defaults to AI; this path must pass the choice through or
  // every bulk import silently bills per PDF regardless of what was picked.
  const parsed = await parseBill(buffer, filename, userId, method === 'ai' ? 'ai' : 'regex');
  const { extracted: ex, match } = parsed;

  // Correspondence, a legal filing, a transfer receipt: nothing to file or review.
  if (ex.documentKind === 'not_a_bill') return { outcome: 'not_a_bill' };
  // Already paid, or nothing owed yet: nothing to file and nothing to review.
  if (ex.documentKind === 'receipt') return { outcome: 'skipped', reason: 'receipt or subscription charge (already paid)' };
  if (ex.documentKind === 'estimate') return { outcome: 'skipped', reason: 'estimate or quote (nothing owed yet)' };
  // A one-time invoice for work at a property is an expense there, not a
  // utility account. With no property to put it on, the owner picks one.
  if (ex.documentKind === 'service_invoice') {
    if (!invoiceAmount(ex)) return { outcome: 'skipped', reason: 'invoice shows nothing owed' };
    if (match.propertyId) {
      const r = await fileServiceInvoice(userId, match.propertyId, ex, buffer, filename);
      return { outcome: 'expense', expenseId: r.expenseId, duplicate: r.duplicate };
    }
    const pendingKey = `pending-review/${userId}/${batchId}/${sanitizeFilename(filename)}`;
    await uploadDocument(pendingKey, buffer);
    return { outcome: 'review', reviewItem: { filename, s3Key: pendingKey, extracted: ex, match } };
  }

  // A credit card statement goes to its card (Personal → Credit cards),
  // which is created if Sollux does not have it yet.
  if (ex.documentKind === 'credit_card_statement') {
    const r = await fileCardStatement(userId, ex, buffer, filename);
    return { outcome: 'card', cardId: r.cardId, cardName: r.cardName, created: r.created };
  }

  let utilityAccountId = match.utilityAccountId;
  let autoCreated = false;

  // Property matched but this utility doesn't have an account yet — create it
  // using the AI-detected type (electric/water/gas/etc.) and provider name.
  if (!utilityAccountId && match.method === 'property_exists_no_account' && match.propertyId) {
    const acct = await findOrCreateUtilityAccount({
      propertyId: match.propertyId,
      providerName: ex.providerName,
      category: UTILITY_TYPE_TO_CATEGORY[ex.utilityType] || 'OTHER',
      accountNumber: ex.accountNumber,
    });
    utilityAccountId = acct.id;
    autoCreated = true;
    console.log(`[Intake] Auto-created ${ex.utilityType} account ${acct.id} on property ${match.propertyId}`);
  }

  if (utilityAccountId && ex.documentKind === 'past_due_notice') {
    // Not a bill: attach its aging and shut-off date to the newest
    // statement rather than minting a fake month of spending.
    const attached = await applyPastDueNotice(utilityAccountId, ex);
    return attached ? { outcome: 'notice' } : { outcome: 'error', error: `${filename}: past-due notice, but the account has no statement to attach it to` };
  }
  if (utilityAccountId && ex.documentKind === 'policy_document') {
    // Describes the policy and its payment schedule; bills nothing.
    await applyPolicyDocument(utilityAccountId, ex);
    return { outcome: 'policy' };
  }

  if (utilityAccountId && (match.confidence === 'high' || autoCreated)) {
    const acct = await db.utilityAccount.findUnique({
      where: { id: utilityAccountId },
      select: { id: true, propertyId: true, escrowLoanId: true, billingCadence: true },
    });
    if (!acct) throw new Error('account disappeared mid-import');
    // A premium the lender pays from escrow, or billed once a term, is the whole term, once.
    settleInFull(ex, acct);

    const parsedDate = ex.statementDate ? new Date(ex.statementDate) : new Date();
    const statementDate = isNaN(parsedDate.getTime()) ? new Date() : parsedDate;

    // A bill is its billing period, not its issue month — a drifting
    // cycle puts two bills in one month, and the month lookup this
    // used to be treated the second as a duplicate of the first and
    // overwrote it in place. Same rule as /import/confirm and the
    // streaming Drive path: match the period when the bill states
    // one; fall back to the issue month only against rows that carry
    // no real period of their own.
    let existing = null;
    if (ex.billingPeriodStart) {
      const start = new Date(ex.billingPeriodStart);
      const window = 7 * 24 * 60 * 60 * 1000;
      existing = await db.statement.findFirst({
        where: {
          utilityAccountId: acct.id,
          billingPeriodStart: {
            gte: new Date(start.getTime() - window),
            lte: new Date(start.getTime() + window),
          },
        },
      });
    }
    if (!existing) {
      const monthStart = new Date(Date.UTC(statementDate.getUTCFullYear(), statementDate.getUTCMonth(), 1));
      const monthEnd = new Date(Date.UTC(statementDate.getUTCFullYear(), statementDate.getUTCMonth() + 1, 0, 23, 59, 59));
      const DAY = 24 * 60 * 60 * 1000;
      const firstOfMonth = Date.UTC(statementDate.getUTCFullYear(), statementDate.getUTCMonth(), 1);
      existing = await db.statement.findFirst({
        where: {
          utilityAccountId: acct.id,
          statementDate: { gte: monthStart, lte: monthEnd },
          OR: [
            { billingPeriodStart: null },
            { billingPeriodStart: { gte: new Date(firstOfMonth - DAY), lte: new Date(firstOfMonth + DAY) } },
          ],
        },
      });
    }

    // The owner entered this period by hand: a different amount waits for
    // their choice; the same amount keeps their figures and adds the PDF.
    const ownerCheck = existing && ownerEntered(existing) ? await compareWithOwner(acct.id, ex, existing) : null;
    if (ownerCheck?.kind === 'conflict') {
      const pendingKey = `pending-review/${userId}/${batchId}/${sanitizeFilename(filename)}`;
      await uploadDocument(pendingKey, buffer);
      return { outcome: 'review', reviewItem: { filename, s3Key: pendingKey, extracted: ex, match: { ...match, conflict: ownerCheck.conflict } } };
    }

    const key = buildStatementKey(userId, acct.propertyId, acct.id, statementDate, sanitizeFilename(filename));
    const pdfS3Key = await uploadDocument(key, buffer);
    const rawData = buildRawData(ex, source);
    if (existing && ownerCheck?.kind === 'same') {
      await keepOwnerFigures(existing, ex, rawData, pdfS3Key);
      await recordConfirmedPayment(acct.id, existing.id, ex);
      await syncPaymentPlanFromBill(acct.id, ex);
      await syncInsurancePolicyFromBill(acct.id, ex);
      await syncLoanComponentsFromBill(acct.id, ex);
      return { outcome: 'filed', utilityAccountId: acct.id };
    }
    // amountDue = current period charges only; balance = full amount owed.
    const amountDueCurrent = ex.currentCharges ?? ex.amountDue;
    const totalBalance = rawData.totalDue ?? amountDueCurrent;

    if (existing) {
      await db.statement.update({
        where: { id: existing.id },
        data: {
          dueDate: ex.dueDate ? new Date(ex.dueDate) : existing.dueDate,
          billingPeriodStart: ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : existing.billingPeriodStart,
          billingPeriodEnd: ex.billingPeriodEnd ? new Date(ex.billingPeriodEnd) : existing.billingPeriodEnd,
          amountDue: amountDueCurrent ?? existing.amountDue,
          balance: ex.totalAccountBalance ?? totalBalance ?? existing.balance,
          usageValue: ex.usageValue ?? existing.usageValue,
          usageUnit: ex.usageUnit ?? existing.usageUnit,
          ratePlan: ex.ratePlan ?? existing.ratePlan,
          rawDataJson: rawData as Prisma.InputJsonValue,
          ...(pdfS3Key && !existing.pdfS3Key ? { pdfS3Key } : {}),
        },
      });
      // Late fees logged with payments are not on the PDF; put them back.
      await restoreLateFees(existing.id);
      await recordConfirmedPayment(acct.id, existing.id, ex);
      await syncPaymentPlanFromBill(acct.id, ex);
      await syncInsurancePolicyFromBill(acct.id, ex);
      await syncLoanComponentsFromBill(acct.id, ex);
      await markEscrowedStatements(acct.id);
    } else {
      const created = await db.statement.create({
        data: {
          utilityAccountId: acct.id,
          statementDate,
          dueDate: ex.dueDate ? new Date(ex.dueDate) : null,
          billingPeriodStart: ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : null,
          billingPeriodEnd: ex.billingPeriodEnd ? new Date(ex.billingPeriodEnd) : null,
          amountDue: amountDueCurrent ?? null,
          balance: ex.totalAccountBalance ?? totalBalance ?? null,
          amountPaid: ex.isPaid ? (totalBalance ?? amountDueCurrent ?? null) : null,
          usageValue: ex.usageValue ?? null,
          usageUnit: ex.usageUnit ?? null,
          ratePlan: ex.ratePlan ?? null,
          pdfS3Key,
          sourceType: 'MANUAL',
          rawDataJson: rawData as Prisma.InputJsonValue,
        },
      });
    await recordConfirmedPayment(acct.id, created.id, ex);
    await syncPaymentPlanFromBill(acct.id, ex);
    await syncInsurancePolicyFromBill(acct.id, ex);
    await syncLoanComponentsFromBill(acct.id, ex);
    await markEscrowedStatements(acct.id);
  }

    return { outcome: 'filed', utilityAccountId: acct.id };
  } else {
    // Ambiguous — stage the PDF and hand it to the normal Import Bills review flow.
    const pendingKey = `pending-review/${userId}/${batchId}/${sanitizeFilename(filename)}`;
    await uploadDocument(pendingKey, buffer);
    return { outcome: 'review', reviewItem: { filename, s3Key: pendingKey, extracted: ex, match } };
  }
}
