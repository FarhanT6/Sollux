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
import { isEmailPrintout } from './emailPrintouts';
import { uploadDocument } from './s3Service';
import { refreshCardCycle, syncStatementPayments } from './cardPayments';
import type { ExtractedBillData } from './pdfImportService';

export interface CardIntakeResult { cardId: string; cardName: string; created: boolean; statementId: string | null }

const day = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sanitize = (s: string) => s.replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'statement.pdf';

/** A card's name for matching: "PayPal Credit (Synchrony Bank)" and "PayPal Credit" are one. */
export const cardNameKey = (n: string) => n.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[•·]+\s*\d{3,4}/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The card a statement belongs to: by its last four; else, for a statement
 * that prints none (PayPal Credit, Apple Card), the card of the same name,
 * else the only card from this issuer.
 */
export async function findCardFor(userId: string, w: { last4: string | null; cardName: string | null; issuer: string | null }) {
  if (w.last4) return db.creditCard.findFirst({ where: { userId, last4: w.last4 } });
  const all = await db.creditCard.findMany({ where: { userId, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'asc' } });
  const want = cardNameKey(w.cardName ?? '');
  const byName = want ? all.filter(c => !c.last4 && (cardNameKey(c.name) === want || cardNameKey(c.name).startsWith(want) || want.startsWith(cardNameKey(c.name)) || cardNameKey(c.name).endsWith(` ${want}`))) : [];
  const first = w.issuer?.split(/\s+/)[0]?.toLowerCase();
  const sameIssuer = first ? all.filter(c => (c.issuer ?? '').toLowerCase().includes(first)) : [];
  return byName[0] ?? (sameIssuer.length === 1 ? sameIssuer[0] : null);
}

export async function fileCardStatement(userId: string, ex: ExtractedBillData, pdf: Buffer | null, filename: string,
  /** The card it was fetched for (its website login): filed there unless it prints another card's last four. */
  opts: { cardId?: string } = {}): Promise<CardIntakeResult> {
  const cc = ex.creditCard ?? {};
  const last4 = (cc.last4 ?? ex.accountNumber ?? '').replace(/\D/g, '').slice(-4) || null;
  const issuer = cc.issuer ?? ex.providerName ?? null;
  const name = cc.cardName ?? issuer ?? 'Credit card';

  // The card: by its last four; else, for a statement that prints none (PayPal
  // Credit), the card of the same name, else the only card from this issuer. An
  // issuer with several cards (Synchrony: PayPal Credit and two Lowe's cards) made
  // a new card for every PayPal Credit statement.
  let card = opts.cardId ? await db.creditCard.findFirst({ where: { id: opts.cardId, userId } }) : null;
  // One issuer login can show two cards: a statement printing the other's last four is the other's.
  if (card && last4 && card.last4 && card.last4 !== last4) card = null;
  card ??= await findCardFor(userId, { last4, cardName: cc.cardName ?? null, issuer });
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

  // A "your statement is ready" email printed to PDF is not the statement: its
  // figures are kept (balance, minimum, due date), the printout is not, and the
  // statement itself replaces it when it comes in.
  const fromEmail = !!ex.fromEmailBody || (pdf ? await isEmailPrintout(pdf) : false);
  if (fromEmail) pdf = null;
  const DAY = 86_400_000;
  const near = (d: Date) => ({ gte: new Date(d.getTime() - 6 * DAY), lte: new Date(d.getTime() + 6 * DAY) });

  if (closing && newBalance != null && fromEmail
      && await db.cardStatement.findFirst({ where: { cardId: card.id, fromEmail: false, closingDate: near(closing) }, select: { id: true } })) {
    // The statement for this cycle is already on file: the email adds nothing.
  } else if (closing && newBalance != null) {
    // The real statement: the email's stand-in for this cycle goes.
    if (!fromEmail) await db.cardStatement.deleteMany({ where: { cardId: card.id, fromEmail: true, closingDate: near(closing), NOT: { closingDate: closing } } });
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
      // Read from the statement's text: the rest of what it prints.
      ...(cc.transactions ? {
        cashAdvanceApr: num(cc.cashAdvanceApr), daysInCycle: num(cc.daysInCycle) != null ? Math.trunc(num(cc.daysInCycle)!) : null,
        minPayoffMonths: num(cc.minPayoffMonths) != null ? Math.trunc(num(cc.minPayoffMonths)!) : null, minPayoffTotal: num(cc.minPayoffTotal),
        pastDueAmount: num(cc.pastDueAmount), feesYtd: num(cc.feesYtd), interestYtd: num(cc.interestYtd), rewardsEarned: num(cc.rewardsEarned),
        promotions: (cc.promotions ?? undefined) as any,
      } : {}),
    };
    const st = await db.cardStatement.upsert({
      where: { cardId_closingDate: { cardId: card.id, closingDate: closing } },
      create: { cardId: card.id, closingDate: closing, ...fields, fromEmail, ...(documents.length ? { documents } : {}) },
      // An email does not overwrite the statement's own figures.
      update: fromEmail ? {} : { ...fields, fromEmail: false, ...(documents.length ? { documents } : {}) },
    });
    statementId = st.id;
    // Its lines, as the card page's upload keeps them: re-reading a statement replaces them, a line moved to a property's expenses stays.
    if (!fromEmail && Array.isArray(cc.transactions)) {
      await db.cardTransaction.deleteMany({ where: { statementId: st.id, expenseId: null } });
      const kept = await db.cardTransaction.findMany({ where: { statementId: st.id }, select: { date: true, amount: true, description: true } });
      const seen = new Set(kept.map(t => `${t.date.toISOString().slice(0, 10)}|${Number(t.amount).toFixed(2)}|${t.description}`));
      const rows = cc.transactions.filter(t => !seen.has(`${t.date}|${t.amount.toFixed(2)}|${t.description}`)).map(t => ({
        cardId: card!.id, statementId: st.id, date: new Date(`${t.date}T00:00:00Z`), postDate: t.postDate ? new Date(`${t.postDate}T00:00:00Z`) : null,
        description: t.description, merchant: t.merchant, amount: t.amount, kind: t.kind, category: t.category, reference: t.reference ?? null, isBusiness: card!.isBusiness,
      }));
      if (rows.length) await db.cardTransaction.createMany({ data: rows });
      await syncStatementPayments(st.id);
    }
    // The newest statement sets the card's cycle and terms; an older one only fills blanks.
    const newest = await db.cardStatement.findFirst({ where: { cardId: card.id }, orderBy: { closingDate: 'desc' }, select: { id: true } });
    const isNewest = newest?.id === st.id;
    const fill = (k: 'creditLimit' | 'purchaseApr', v: number | null) => (v == null ? {} : isNewest || card![k] == null ? { [k]: v } : {});
    await db.creditCard.update({
      where: { id: card.id },
      data: {
        ...fill('creditLimit', fields.creditLimit), ...fill('purchaseApr', fields.purchaseApr),
        // The card's terms the statement prints: the newest statement sets them, an older one fills blanks.
        ...Object.fromEntries(Object.entries(cc.terms ?? {}).filter(([k, v]) => v != null && (isNewest || (card as any)[k] == null))
          .map(([k, v]) => [k, k === 'introAprEndDate' ? new Date(`${v}T00:00:00Z`) : v])),
        ...(isNewest && card.balanceAsOf && card.balanceAsOf < closing ? { currentBalance: null, balanceAsOf: null } : {}),
        // An email's date is not a closing date: only its due day is kept, when none is known.
        ...(fromEmail && due && card.paymentDueDay == null ? { paymentDueDay: due.getUTCDate() } : {}),
      },
    });
    await refreshCardCycle(card.id);
  } else if (due) {
    // A payment-due alert with no statement behind it: the due day is still worth keeping.
    await db.creditCard.update({ where: { id: card.id }, data: { paymentDueDay: card.paymentDueDay ?? due.getUTCDate() } });
  }

  return { cardId: card.id, cardName: card.name, created, statementId };
}

/**
 * Two cards that are one account (a statement with no last four filed as a
 * new card): everything on `fromId` moves to `intoId` — statements (one
 * already on file for the same closing date is kept, the copy dropped),
 * transactions and payments (exact repeats dropped) — anything `intoId` is
 * missing is filled in from it, and `fromId` is removed.
 */
export async function mergeCards(userId: string, fromId: string, intoId: string): Promise<{ statements: number; transactions: number; payments: number }> {
  const [from, into] = await Promise.all([
    db.creditCard.findFirst({ where: { id: fromId, userId }, include: { statements: true, transactions: true, payments: true } }),
    db.creditCard.findFirst({ where: { id: intoId, userId }, include: { statements: true, transactions: true, payments: true } }),
  ]);
  if (!from || !into || from.id === into.id) throw Object.assign(new Error('Card not found'), { status: 404 });
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const moved = { statements: 0, transactions: 0, payments: 0 };
  await db.$transaction(async tx => {
    for (const st of from.statements) {
      const twin = into.statements.find(x => dayKey(x.closingDate) === dayKey(st.closingDate));
      if (twin) {
        await tx.cardTransaction.updateMany({ where: { statementId: st.id }, data: { statementId: twin.id } });
        await tx.cardPayment.updateMany({ where: { statementId: st.id }, data: { statementId: twin.id } });
        await tx.cardStatement.delete({ where: { id: st.id } });
      } else {
        await tx.cardStatement.update({ where: { id: st.id }, data: { cardId: into.id } });
        moved.statements++;
      }
    }
    const txKey = (t: { date: Date; amount: unknown; description: string }) => `${dayKey(t.date)}|${Number(t.amount).toFixed(2)}|${t.description.trim().toLowerCase()}`;
    const haveTx = new Set(into.transactions.map(txKey));
    for (const t of from.transactions) {
      if (haveTx.has(txKey(t))) await tx.cardTransaction.delete({ where: { id: t.id } });
      else { await tx.cardTransaction.update({ where: { id: t.id }, data: { cardId: into.id } }); moved.transactions++; }
    }
    const payKey = (p: { date: Date; amount: unknown }) => `${dayKey(p.date)}|${Number(p.amount).toFixed(2)}`;
    const havePay = new Set(into.payments.map(payKey));
    for (const p of from.payments) {
      if (havePay.has(payKey(p))) await tx.cardPayment.delete({ where: { id: p.id } });
      else { await tx.cardPayment.update({ where: { id: p.id }, data: { cardId: into.id } }); moved.payments++; }
    }
    // What the kept card is missing, from the other.
    const fill: Record<string, unknown> = {};
    for (const k of ['last4', 'network', 'issuer', 'cardholderName', 'creditLimit', 'purchaseApr', 'statementClosingDay', 'paymentDueDay', 'memberId', 'bankAccountId', 'loginUrl', 'phone'] as const) {
      if ((into as any)[k] == null && (from as any)[k] != null) fill[k] = (from as any)[k];
    }
    if (Object.keys(fill).length) await tx.creditCard.update({ where: { id: into.id }, data: fill as any });
    // The website login goes with the kept card when it has none of its own.
    if (!(await tx.cardLogin.findUnique({ where: { cardId: into.id }, select: { cardId: true } }))) {
      await tx.cardLogin.updateMany({ where: { cardId: from.id }, data: { cardId: into.id } });
    }
    await tx.creditCard.delete({ where: { id: from.id } });
  });
  return moved;
}
