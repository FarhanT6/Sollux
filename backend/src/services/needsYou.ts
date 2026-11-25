/**
 * "Needs you": everything in Sollux waiting on the owner, in one list, each with where to go —
 * logins a site rejected or that are missing, bills a fetch or email brought that need a look,
 * bills where the owner's own figures and the PDF disagree, loan payments to check, tenant
 * transfers waiting for the owner's word, and bills whose figures still do not add up to what
 * they printed. Replaces warnings scattered across the pages; the Overview shows it first.
 */
import { db } from '../config/db';
import { syncFailureKind } from '../lib/syncFailure';

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const asNum = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const last4 = (n: string | null | undefined) => { const d = String(n ?? '').replace(/\D/g, '').slice(-4); return d ? ` ··${d}` : ''; };

export interface NeedsYouItem { title: string; detail?: string; to: string }
export interface NeedsYouSection { key: 'logins' | 'review' | 'conflicts' | 'loan-payments' | 'transfers' | 'figures' | 'blocked'; title: string; hint: string; count: number; items: NeedsYouItem[] }

export async function needsYou(userId: string): Promise<{ total: number; sections: NeedsYouSection[] }> {
  const sections: NeedsYouSection[] = [];
  const accountLink = (a: { id: string; propertyId: string }) => `/properties/${a.propertyId}/utilities/${a.id}`;

  // Logins: failed syncs the owner fixes (a rejected or missing login), and sites that refuse a robot.
  const failed = await db.utilityAccount.findMany({
    where: { property: { userId }, isActive: true, syncEnabled: true, lastSyncStatus: 'FAILED' },
    select: { id: true, propertyId: true, providerName: true, accountNumber: true, lastSyncError: true, property: { select: { nickname: true, address: true } } },
  });
  const logins = failed.filter(a => syncFailureKind(a.lastSyncError) === 'needs-owner');
  if (logins.length) sections.push({
    key: 'logins', title: 'Logins to fix', hint: 'The website rejected the saved login, or none is on file — update it and Sollux fetches again.', count: logins.length,
    items: logins.map(a => ({ title: `${a.providerName}${last4(a.accountNumber)} · ${a.property.nickname || a.property.address}`, detail: String(a.lastSyncError ?? '').slice(0, 160), to: accountLink(a) })),
  });
  const blocked = failed.filter(a => syncFailureKind(a.lastSyncError) === 'blocked-by-site');

  // Bills a fetch or an email brought that need a look, and those that disagree with the owner's own figures.
  // The same list Import → Bills by email opens with Review: the latest email or portal run with cards waiting.
  const job = await db.driveImportJob.findFirst({
    where: { userId, source: { in: ['email', 'portal'] }, NOT: { needsReviewJson: { equals: [] } } },
    orderBy: { startedAt: 'desc' }, select: { needsReviewJson: true },
  });
  const staged = Array.isArray(job?.needsReviewJson) ? job!.needsReviewJson as any[] : [];
  const conflicts = staged.filter(i => i?.match?.conflict);
  const toReview = staged.filter(i => !i?.match?.conflict);
  const named = (i: any) => `${i?.extracted?.providerName ?? i?.filename ?? 'A bill'}${i?.extracted?.statementDate ? ` · ${String(i.extracted.statementDate).slice(0, 10)}` : ''}`;
  if (toReview.length) sections.push({
    key: 'review', title: 'Bills to look at', hint: "A fetch or an email brought these but couldn't be sure which account they belong to.", count: toReview.length,
    items: toReview.slice(0, 8).map(i => ({ title: named(i), to: '/import' })),
  });
  if (conflicts.length) sections.push({
    key: 'conflicts', title: 'Your figures and the PDF disagree', hint: 'You entered these bills by hand and the statement reads a different amount — choose which is right.', count: conflicts.length,
    items: conflicts.slice(0, 8).map(i => ({ title: named(i), detail: i.match.conflict.ownerAmount != null ? `You: $${Number(i.match.conflict.ownerAmount).toFixed(2)} · statement: $${Number(i.match.conflict.statementAmount).toFixed(2)}` : undefined, to: '/import' })),
  });

  // Loan payments seen in the bank or an email that Sollux could not be sure of.
  const loanPays = await db.outgoingTransaction.findMany({
    where: { userId, matchType: 'LOAN', status: { in: ['SUGGESTED', 'UNMATCHED'] }, date: { gte: new Date(Date.now() - 90 * DAY) } },
    select: { id: true, amount: true, date: true, name: true }, orderBy: { date: 'desc' }, take: 20,
  });
  if (loanPays.length) sections.push({
    key: 'loan-payments', title: 'Loan payments to check', hint: 'Payments that look like a loan payment — confirm the loan and the month.', count: loanPays.length,
    items: loanPays.slice(0, 8).map(t => ({ title: `$${Number(t.amount).toFixed(2)} · ${t.date.toISOString().slice(0, 10)}`, detail: t.name.slice(0, 80), to: '/finances?tab=loans' })),
  });

  // Tenant transfers waiting for the owner: a choice to make (more than the month owed), or a sender not recognised.
  const transfers = await db.incomingTransaction.findMany({
    where: {
      userId, date: { gte: new Date(Date.now() - 60 * DAY) },
      OR: [{ status: 'SUGGESTED' }, { status: 'UNMATCHED', channel: { in: ['ZELLE', 'VENMO', 'CASH_APP', 'PAYPAL'] } }],
    },
    select: { id: true, amount: true, date: true, name: true, status: true, reviewNote: true }, orderBy: { date: 'desc' }, take: 30,
  });
  if (transfers.length) sections.push({
    key: 'transfers', title: 'Tenant payments to confirm', hint: 'Transfers Sollux matched but needs your word on, or from someone it does not recognise.', count: transfers.length,
    items: transfers.slice(0, 8).map(t => ({ title: `$${Number(t.amount).toFixed(2)} · ${t.date.toISOString().slice(0, 10)} · ${String(t.name ?? '').slice(0, 40)}`, detail: t.reviewNote ?? (t.status === 'UNMATCHED' ? 'Sender not recognised' : undefined), to: '/finances?tab=income&view=incoming' })),
  });

  // Bills whose figures still do not add up to what they printed (the nightly check fixes what the bill before can settle).
  const recent = await db.statement.findMany({
    where: { utilityAccount: { property: { userId }, isActive: true }, isScheduled: false, isDownPayment: false, statementDate: { gte: new Date(Date.now() - 120 * DAY) } },
    select: { id: true, statementDate: true, amountDue: true, carriedFee: true, pastDueCarried: true, trueUpDeferred: true, rawDataJson: true, utilityAccount: { select: { id: true, propertyId: true, providerName: true, accountNumber: true } } },
  });
  const withLoggedFees = new Set((await db.payment.findMany({ where: { statementId: { in: recent.map(s => s.id) }, lateFeeAdded: { gt: 0 } }, select: { statementId: true } })).map(p => p.statementId));
  const off = recent.filter(s => {
    const raw = (s.rawDataJson ?? {}) as Record<string, any>;
    const stated = asNum(raw.statedTotalDue);
    if (stated == null || stated <= 0.005 || s.amountDue == null || raw.ownerEditedAt || raw.emailNotice || raw.pageSaved || raw.scheduled || withLoggedFees.has(s.id)) return false;
    const deferred = asNum(raw.netMetering?.deferred) ?? asNum(s.trueUpDeferred) ?? 0;
    return Math.abs(Number(s.amountDue) - Number(s.carriedFee ?? 0) - deferred + Number(s.pastDueCarried ?? 0) - stated) > 0.05;
  });
  if (off.length) sections.push({
    key: 'figures', title: "Bills that don't add up", hint: "The charge plus what was carried isn't what the bill printed. Open the account and use More… → Check figures against the PDFs, or fix the bill.", count: off.length,
    items: off.slice(0, 8).map(s => {
      const raw = (s.rawDataJson ?? {}) as Record<string, any>;
      const read = r2(Number(s.amountDue) - Number(s.carriedFee ?? 0) + Number(s.pastDueCarried ?? 0));
      return { title: `${s.utilityAccount.providerName}${last4(s.utilityAccount.accountNumber)} · ${s.statementDate.toISOString().slice(0, 10)}`, detail: `Read $${read.toFixed(2)} · printed $${Number(raw.statedTotalDue).toFixed(2)}`, to: accountLink(s.utilityAccount) };
    }),
  });

  if (blocked.length) sections.push({
    key: 'blocked', title: "Sites that won't let Sollux sign in", hint: 'These sites turn automated sign-in away (a captcha or bot check). Forward their bill emails or upload the PDFs — or run the connector on your computer.', count: blocked.length,
    items: blocked.map(a => ({ title: `${a.providerName}${last4(a.accountNumber)} · ${a.property.nickname || a.property.address}`, to: accountLink(a) })),
  });

  return { total: sections.filter(s => s.key !== 'blocked').reduce((t, s) => t + s.count, 0), sections };
}
