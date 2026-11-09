/**
 * Property manager statements fetched from email (the inbox agent).
 *
 * A PDF is a manager's statement when it comes from an address a manager
 * profile lists (ReconciliationProfile.emailFrom), or when its own text reads
 * like one: an owner statement / statement of cash flows with rent received
 * and a management fee. It is read like an upload (readManagerStatement:
 * matched to properties, leases and loans; rent already on record and lines
 * already on an earlier statement from the manager left out) and recorded at
 * once: rent for the month each line shows, each loan line as that month's
 * payment, fees and repairs as the property's expenses. Lines that could not
 * be matched to a lease, loan or property are left for the owner to review.
 * The sender is kept on the manager's profile, so the next month's arrives
 * the same way.
 */
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { readManagerStatement, type StatementDraft } from './managerStatement';
import { uploadDocument } from './s3Service';
import { applyManagerStatement, lineItemsFrom } from './managerStatementApply';

/** "Owner Statement", "Statement of Cash Flows", with rent collected and a management fee: from the PDF's own text. */
export function looksLikeManagerStatement(text: string): boolean {
  const t = text.slice(0, 20000);
  const title = /owner'?s?\s+statement|statement\s+of\s+cash\s+flows?|owner\s+(?:distribution|disbursement|draw)|owner\s+packet|monthly\s+owner\s+report|property\s+owner\s+statement/i.test(t);
  const rent = /rent\s+(?:received|collected|income|receipts?)|rents?\s+received|rental\s+income/i.test(t);
  const fee = /(?:property\s+)?management\s+fees?|\bproperty\s+management\b|mgmt\s+fee|leasing\s+fee/i.test(t);
  return (title && (rent || fee)) || (rent && fee && /owner|transfer\s+(?:to|from)\s+owner/i.test(t));
}

/** The address in a From header: "Monty James <monty@example.com>" → "monty@example.com". */
export const senderAddress = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

/** The manager profile whose sending address this is. */
export async function managerForSender(userId: string, from: string) {
  const addr = senderAddress(from);
  if (!addr.includes('@')) return null;
  const profiles = await db.reconciliationProfile.findMany({ where: { userId, emailFrom: { not: null } }, select: { id: true, name: true, emailFrom: true } });
  return profiles.find(p => (p.emailFrom ?? '').toLowerCase().split(/[,\s;]+/).filter(Boolean).includes(addr)) ?? null;
}

const sanitize = (s: string) => s.replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'statement.pdf';

/**
 * Read an emailed statement and save it as a draft to review. Returns what happened, for the inbox log.
 * `ref` (the email's Message-ID and the file name) keeps the same email from being saved twice.
 */
export async function intakeManagerStatement(userId: string, file: Buffer, filename: string, from: string, receivedAt: Date | null, ref: string,
  /** The read and the file store; replaced in tests so no AI call or upload is made. */
  deps: { read?: (userId: string, file: Buffer, name: string, profileId?: string | null) => Promise<StatementDraft>; upload?: (key: string, file: Buffer) => Promise<unknown> } = {}):
  Promise<{ outcome: 'manager'; detail: string; statementId: string | null }> {
  const already = await db.reconciliationStatement.findFirst({ where: { userId, sourceRef: ref }, select: { id: true } });
  if (already) return { outcome: 'manager', detail: 'manager statement already fetched', statementId: already.id };

  // The sender's manager, when known: its remembered choices fill the lines in.
  const sender = await managerForSender(userId, from);
  const draft: StatementDraft = await (deps.read ?? readManagerStatement)(userId, file, filename, sender?.id ?? null);
  const name = draft.manager?.trim() || from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || 'Property manager';
  const addr = senderAddress(from);

  // The manager's profile: the one the statement matched, the sender's, else a new one. It keeps the sender.
  let profile = draft.profileId ? await db.reconciliationProfile.findFirst({ where: { id: draft.profileId, userId } }) : null;
  profile ??= await managerForSender(userId, from).then(p => (p ? db.reconciliationProfile.findUnique({ where: { id: p.id } }) : null));
  if (!profile) {
    const props = [...new Set(draft.lines.map(l => l.propertyId).filter((x): x is string => !!x))];
    profile = await db.reconciliationProfile.create({
      data: { userId, name, propertyId: props.length === 1 ? props[0] : null, managementFeeCategory: 'PROPERTY_MANAGEMENT',
        loanIds: [...new Set(draft.lines.map(l => l.loanId).filter(Boolean))] as unknown as Prisma.InputJsonValue, emailFrom: addr.includes('@') ? addr : null },
    });
  } else if (addr.includes('@') && !(profile.emailFrom ?? '').toLowerCase().split(/[,\s;]+/).includes(addr)) {
    await db.reconciliationProfile.update({ where: { id: profile.id }, data: { emailFrom: [profile.emailFrom, addr].filter(Boolean).join(', ') } });
  }

  const documentKey = `${userId}/reconciliation/uploads/${Date.now()}-${sanitize(filename)}`;
  await (deps.upload ?? uploadDocument)(documentKey, file);
  // Recorded only when every line it records points at its record; the owner settles the rest in the review.
  const lineItems = lineItemsFrom(draft.lines);
  // What records itself; the rest (new, but not matched to a record) waits for the owner.
  const recordable = new Set(lineItems.map((li, i) => (li.include ? i : -1)).filter(i => i >= 0));
  const needsLook = draft.lines.filter((l, i) => !recordable.has(i) && !l.onEarlierStatement && !l.alreadyRecorded && ['RENT', 'LOAN_PAYMENT', 'MANAGEMENT_FEE', 'REPAIR', 'UTILITY', 'OTHER_EXPENSE', 'REIMBURSEMENT'].includes(l.kind)).length;
  const reviewDraft = { ...draft, documentKey, lines: draft.lines.map((l, i) => (recordable.has(i) ? { ...l, include: false, recordedNow: true } : l)) };
  const net = lineItems.reduce((t, li) => t + (li.direction === 'CREDIT' ? li.amount : -li.amount), 0);
  const date = draft.statementDate ?? draft.periodEnd ?? (receivedAt ?? new Date()).toISOString().slice(0, 10);
  const st = await db.reconciliationStatement.create({
    data: {
      userId, profileId: profile.id, statementDate: new Date(`${date}T00:00:00.000Z`), documentS3Key: documentKey,
      lineItems: lineItems as unknown as Prisma.InputJsonValue, netAmount: Math.round(net * 100) / 100,
      notes: `Fetched from email (${from.slice(0, 120)})`, source: 'email', sourceRef: ref, receivedAt,
      draftJson: { ...reviewDraft, needsLook } as unknown as Prisma.InputJsonValue,
    },
  });
  const done = await applyManagerStatement(userId, st.id);
  const earlier = draft.lines.filter(l => l.onEarlierStatement || l.alreadyRecorded).length;
  return {
    outcome: 'manager', statementId: st.id,
    detail: `manager statement from ${profile.name}: recorded ${done.rent} rent, ${done.loanPayments} loan payment${done.loanPayments === 1 ? '' : 's'}, ${done.expenses} cost${done.expenses === 1 ? '' : 's'}; ${earlier} already on file${needsLook ? `; ${needsLook} line${needsLook === 1 ? '' : 's'} to review` : ''}`,
  };
}
