/**
 * Credit card statements that arrive with the bills (email, Drive, upload).
 *
 * They are not utility bills: they go to Personal → Credit cards, on the card
 * whose last four digits they print. A card Sollux does not have yet is
 * created from the statement. Matching to a utility account used to leave
 * them in review forever ("No match found"): Home Depot, Lowe's, PayPal
 * Credit and Citi statements.
 *
 * Everything comes from the same read as any bill (ExtractedBillData.creditCard);
 * no second Claude call.
 */
import { db } from '../config/db';
import { uploadDocument } from './s3Service';
import type { ExtractedBillData } from './pdfImportService';

export interface CardIntakeResult { cardId: string; cardName: string; created: boolean; statementId: string | null }

const day = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sanitize = (s: string) => s.replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'statement.pdf';

export async function fileCardStatement(userId: string, ex: ExtractedBillData, pdf: Buffer | null, filename: string): Promise<CardIntakeResult> {
  const cc = ex.creditCard ?? {};
  const last4 = (cc.last4 ?? ex.accountNumber ?? '').replace(/\D/g, '').slice(-4) || null;
  const issuer = cc.issuer ?? ex.providerName ?? null;
  const name = cc.cardName ?? issuer ?? 'Credit card';

  // The card: by its last four, else the only card from this issuer.
  let card = last4 ? await db.creditCard.findFirst({ where: { userId, last4 } }) : null;
  if (!card && !last4 && issuer) {
    const same = await db.creditCard.findMany({ where: { userId, issuer: { contains: issuer.split(/\s+/)[0], mode: 'insensitive' } } });
    if (same.length === 1) card = same[0];
  }
  let created = false;
  if (!card) {
    card = await db.creditCard.create({
      data: { userId, name: last4 ? `${name} ••${last4}` : name, issuer, network: cc.network ?? null, last4, cardholderName: cc.cardholderName ?? null, notes: `Created from the ${ex.statementDate ?? ''} statement "${filename}".`.trim() },
    });
    created = true;
  }

  const closing = day(cc.closingDate ?? ex.billingPeriodEnd ?? ex.statementDate);
  // A statement read before card statements were recognised (the owner
  // marked it on the review card) has only the bill fields.
  const newBalance = num(cc.newBalance) ?? num(ex.statedTotalDue) ?? (ex.creditCard ? null : num(ex.amountDue));
  const due = day(cc.dueDate ?? ex.dueDate);
  let statementId: string | null = null;

  if (closing && newBalance != null) {
    const documents: { key: string; name: string }[] = [];
    if (pdf) {
      const key = `${userId}/credit-cards/${card.id}/${closing.toISOString().slice(0, 10)}_${sanitize(filename)}`;
      await uploadDocument(key, pdf);
      documents.push({ key, name: filename });
    }
    const fields = {
      periodStart: day(cc.periodStart ?? ex.billingPeriodStart), dueDate: due,
      previousBalance: num(cc.previousBalance), paymentsCredits: num(cc.paymentsCredits), purchases: num(cc.purchases),
      feesCharged: num(cc.feesCharged), interestCharged: num(cc.interestCharged), newBalance,
      minimumPayment: num(cc.minimumPayment), creditLimit: num(cc.creditLimit), availableCredit: num(cc.availableCredit), purchaseApr: num(cc.purchaseApr),
    };
    const st = await db.cardStatement.upsert({
      where: { cardId_closingDate: { cardId: card.id, closingDate: closing } },
      create: { cardId: card.id, closingDate: closing, ...fields, ...(documents.length ? { documents } : {}) },
      update: { ...fields, ...(documents.length ? { documents } : {}) },
    });
    statementId = st.id;
    // The newest statement sets the card's cycle and terms; an older one only fills blanks.
    const newest = await db.cardStatement.findFirst({ where: { cardId: card.id }, orderBy: { closingDate: 'desc' }, select: { id: true } });
    const isNewest = newest?.id === st.id;
    const fill = (k: 'creditLimit' | 'purchaseApr', v: number | null) => (v == null ? {} : isNewest || card![k] == null ? { [k]: v } : {});
    await db.creditCard.update({
      where: { id: card.id },
      data: {
        ...fill('creditLimit', fields.creditLimit), ...fill('purchaseApr', fields.purchaseApr),
        ...(isNewest ? { statementClosingDay: closing.getUTCDate(), ...(due ? { paymentDueDay: due.getUTCDate() } : {}) } : {}),
        ...(isNewest && card.balanceAsOf && card.balanceAsOf < closing ? { currentBalance: null, balanceAsOf: null } : {}),
      },
    });
  } else if (due) {
    // A payment-due alert with no statement behind it: the due day is still worth keeping.
    await db.creditCard.update({ where: { id: card.id }, data: { paymentDueDay: card.paymentDueDay ?? due.getUTCDate() } });
  }

  return { cardId: card.id, cardName: card.name, created, statementId };
}
