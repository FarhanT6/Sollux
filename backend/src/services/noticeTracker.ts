/**
 * Shut-off, past-due and cancellation notices, tracked until resolved.
 *
 * A notice used to be folded into the account's newest bill (its date as
 * the bill's penalty date, a line in its alerts) and nothing else: no alert,
 * no countdown, and when the account had no bill yet it was rejected. Now
 * each notice is its own record that:
 *  - is kept even before it is matched to an account;
 *  - alerts the owner the moment it arrives (in Sollux, by email and text);
 *  - is reminded about daily as the cut-off nears or passes;
 *  - closes itself once payments on the account since the notice cover what
 *    it demands, or a reinstatement notice arrives, or the owner marks it.
 */
import { db } from '../config/db';
import type { ExtractedBillData } from './pdfImportService';
import { emailConfigured, smsConfigured, sendAlertEmail, sendAlertSMS } from './notificationService';

const DAY = 24 * 60 * 60 * 1000;
const day = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null);
const money = (n: number | null) => (n == null ? '' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fmt = (d: Date | null) => (d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');

export type NoticeKind = 'DISCONNECTION' | 'CANCELLATION' | 'PAST_DUE';

export function noticeKind(ex: ExtractedBillData, subject = ''): NoticeKind {
  const text = `${subject} ${(ex.alerts ?? []).join(' ')}`;
  if (/cancell?ation|nonrenewal|coverage ends|policy.*(cancel|lapse)/i.test(text) || ex.insurance?.policyNumber) return 'CANCELLATION';
  if (/disconnect|shut.?off|service (will be )?(interrupt|terminat|suspend)|lock.?up|discontinu/i.test(text)) return 'DISCONNECTION';
  return 'PAST_DUE';
}

const isReinstatement = (ex: ExtractedBillData) => (ex.alerts ?? []).some(a => /^Reinstated/i.test(a));

/**
 * Saves the notice (or updates the same one read again) and alerts the owner
 * when it is new. A reinstatement notice closes the open cancellation instead.
 */
export async function recordNotice(userId: string, utilityAccountId: string | null, ex: ExtractedBillData, opts: { subject?: string; pdfS3Key?: string | null; source?: string } = {}) {
  if (isReinstatement(ex)) {
    if (utilityAccountId) {
      await db.serviceNotice.updateMany({
        where: { userId, utilityAccountId, status: 'OPEN', kind: 'CANCELLATION' },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedReason: 'Reinstatement notice received' },
      });
    }
    return null;
  }
  const kind = noticeKind(ex, opts.subject);
  const noticeDate = day(ex.statementDate) ?? new Date();
  const cutoffDate = day(ex.penaltyDate) ?? day(ex.dueDate);
  const amount = [ex.statedTotalDue, ex.previousBalance, ex.amountDue].find((v): v is number => typeof v === 'number' && v > 0) ?? null;
  const last4 = (ex.accountNumber ?? '').replace(/\D/g, '').slice(-4) || null;
  const provider = ex.providerName ?? null;
  const summary = (ex.alerts ?? []).slice(0, 4).join(' · ').slice(0, 500) || null;

  // The same notice read again (both inboxes, a re-import, a second email
  // for one notice): same account (or provider and last four), same cut-off.
  const same = await db.serviceNotice.findFirst({
    where: {
      userId, kind,
      ...(cutoffDate ? { cutoffDate } : { noticeDate }),
      OR: [
        ...(utilityAccountId ? [{ utilityAccountId }] : []),
        ...(last4 ? [{ accountLast4: last4 }] : []),
        ...(!utilityAccountId && !last4 && provider ? [{ provider }] : []),
      ],
    },
  });
  if (same) {
    return db.serviceNotice.update({
      where: { id: same.id },
      data: {
        utilityAccountId: same.utilityAccountId ?? utilityAccountId,
        amountDemanded: amount ?? same.amountDemanded, summary: summary ?? same.summary,
        pdfS3Key: same.pdfS3Key ?? opts.pdfS3Key ?? null,
      },
    });
  }
  const notice = await db.serviceNotice.create({
    data: { userId, utilityAccountId, kind, provider, accountLast4: last4, noticeDate, cutoffDate, amountDemanded: amount, summary, pdfS3Key: opts.pdfS3Key ?? null, source: opts.source ?? null },
  });
  // Already covered by payments made since the notice: nothing to alert about.
  if (await resolveIfPaid(notice.id)) return notice;
  await alertOwner(notice.id, 'new').catch(err => console.warn('[Notices] alert failed:', err instanceof Error ? err.message : err));
  return notice;
}

/** Closes a notice when payments on its account since the notice cover what it demands. */
export async function resolveIfPaid(noticeId: string): Promise<boolean> {
  const n = await db.serviceNotice.findUnique({ where: { id: noticeId } });
  if (!n || n.status !== 'OPEN' || !n.utilityAccountId || n.amountDemanded == null) return false;
  const paid = await db.payment.aggregate({
    where: { utilityAccountId: n.utilityAccountId, status: { in: ['PAID', 'PARTIAL'] }, paymentDate: { gte: new Date(n.noticeDate.getTime() - 2 * DAY) } },
    _sum: { amount: true },
  });
  const total = Number(paid._sum.amount ?? 0);
  if (total + 0.01 < Number(n.amountDemanded)) return false;
  await db.serviceNotice.update({ where: { id: n.id }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedReason: `Paid ${money(total)} since the notice` } });
  await clearNoticeAlert(n.id);
  return true;
}

async function describe(noticeId: string) {
  const n = await db.serviceNotice.findUnique({ where: { id: noticeId } });
  if (!n) return null;
  const acct = n.utilityAccountId ? await db.utilityAccount.findUnique({ where: { id: n.utilityAccountId }, select: { providerName: true, propertyId: true, property: { select: { address: true, nickname: true } } } }) : null;
  const who = acct?.providerName ?? n.provider ?? 'A provider';
  const where = acct ? (acct.property.nickname || acct.property.address) : n.accountLast4 ? `account ending ${n.accountLast4}` : 'an account not yet matched';
  const what = n.kind === 'DISCONNECTION' ? 'disconnection' : n.kind === 'CANCELLATION' ? 'cancellation' : 'past-due notice';
  const days = n.cutoffDate ? Math.ceil((n.cutoffDate.getTime() - Date.now()) / DAY) : null;
  const when = n.cutoffDate ? (days! < 0 ? `was ${fmt(n.cutoffDate)} (${-days!} day${days === -1 ? '' : 's'} ago)` : days === 0 ? 'is today' : `${fmt(n.cutoffDate)} (${days} day${days === 1 ? '' : 's'})`) : 'date not stated';
  const path = acct ? `/properties/${acct.propertyId}/utilities/${n.utilityAccountId}` : '/import';
  return { n, who, where, what, when, days, path, propertyId: acct?.propertyId ?? null };
}

/** In Sollux, by email and by text — unless the owner turned shut-off alerts off. */
async function alertOwner(noticeId: string, reason: 'new' | 'reminder') {
  const d = await describe(noticeId);
  if (!d) return;
  const { n, who, where, what, when, path } = d;
  const headline = `${who} ${where}: ${what} ${when}`;
  const lines = [
    n.amountDemanded != null ? `Amount to pay: ${money(Number(n.amountDemanded))}` : '',
    n.cutoffDate ? `${n.kind === 'CANCELLATION' ? 'Coverage ends' : 'Service cut-off'}: ${when}` : '',
    n.summary ?? '',
    reason === 'reminder' ? 'Sollux will remind you daily until it is paid or marked resolved.' : '',
  ].filter(Boolean);

  // In Sollux: an alert on the property's insights, refreshed rather than repeated.
  if (d.propertyId) {
    const key = `notice:${n.id}`;
    const existing = await db.aIInsight.findFirst({ where: { dedupeKey: key }, select: { id: true } });
    const data = { insightType: 'REMINDER' as const, severity: 'ALERT' as const, title: headline.slice(0, 190), body: lines.join(' '), recommendation: 'Pay it now, or log the payment if it was already made.', isDismissed: false, isRead: false };
    if (existing) await db.aIInsight.update({ where: { id: existing.id }, data });
    else await db.aIInsight.create({ data: { ...data, propertyId: d.propertyId, utilityAccountId: n.utilityAccountId, dedupeKey: key } });
  }

  const user = await db.user.findUnique({ where: { id: n.userId }, select: { email: true, phone: true } });
  const prefs = await db.notificationPreference.findMany({ where: { userId: n.userId, eventType: 'SHUTOFF_NOTICE' } });
  // On unless the owner switched it off: these are the alerts that matter most.
  const wants = (channel: 'EMAIL' | 'SMS') => prefs.find(p => p.channel === channel)?.isEnabled ?? true;
  const subject = `${n.kind === 'DISCONNECTION' ? '⚠ Disconnection' : n.kind === 'CANCELLATION' ? '⚠ Cancellation' : '⚠ Past due'}: ${who}, ${where}`;
  if (user?.email && wants('EMAIL') && emailConfigured()) {
    await sendAlertEmail({ to: user.email, subject, headline, lines, path }).catch(e => console.warn('[Notices] email failed:', e?.message ?? e));
  }
  if (user?.phone && wants('SMS') && smsConfigured()) {
    const body = `Sollux: ${headline}${n.amountDemanded != null ? ` — pay ${money(Number(n.amountDemanded))}` : ''}.`;
    await sendAlertSMS({ to: user.phone, body: body.slice(0, 300) }).catch(e => console.warn('[Notices] SMS failed:', e?.message ?? e));
  }
  await db.serviceNotice.update({ where: { id: n.id }, data: reason === 'new' ? { alertedAt: new Date() } : { lastRemindedAt: new Date() } });
}

/**
 * Daily: close notices that payments now cover; remind about the rest once a
 * day from a week before the cut-off (or straight away if it has no date),
 * and after it has passed.
 */
export async function runNoticeReminders(): Promise<{ resolved: number; reminded: number }> {
  const open = await db.serviceNotice.findMany({ where: { status: 'OPEN' } });
  let resolved = 0, reminded = 0;
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  for (const n of open) {
    if (await resolveIfPaid(n.id)) { resolved++; continue; }
    const due = !n.cutoffDate || n.cutoffDate.getTime() - Date.now() <= 7 * DAY;
    const already = n.lastRemindedAt && n.lastRemindedAt >= startOfDay;
    const justAlerted = n.alertedAt && n.alertedAt >= startOfDay;
    if (due && !already && !justAlerted) {
      await alertOwner(n.id, 'reminder').catch(err => console.warn('[Notices] reminder failed:', err instanceof Error ? err.message : err));
      reminded++;
    }
  }
  return { resolved, reminded };
}

/** Clears the in-Sollux alert for a notice that is closed. */
export async function clearNoticeAlert(noticeId: string) {
  await db.aIInsight.updateMany({ where: { dedupeKey: `notice:${noticeId}` }, data: { isDismissed: true } });
}

/** After a payment is logged on an account: close the notices it now covers. */
export async function resolveAccountNotices(utilityAccountId: string): Promise<void> {
  const open = await db.serviceNotice.findMany({ where: { utilityAccountId, status: 'OPEN' }, select: { id: true } });
  for (const n of open) await resolveIfPaid(n.id);
}
