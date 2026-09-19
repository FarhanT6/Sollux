import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { db } from '../config/db';

/**
 * The nightly auditor's window into the app.
 *
 * A deterministic quality report — no model involved — over what the app has
 * actually done: bills that came in wrong, imports that fell back to text,
 * duplicates, syncs that keep failing, accounts that went silent, payments
 * nobody filed, browser crashes. The auditor (a scheduled GitHub Action
 * running Claude Code) reads it, decides what is a code defect and what is a
 * data chore, and files "Proposed:" issues for the former. The owner turns a
 * proposal into work by relabelling it `claude-build`.
 *
 * Reached with a shared secret rather than a login, because the caller is a
 * job, not a person: `x-audit-token` must equal AUDIT_TOKEN. Returns figures
 * and provider names only — never credentials, never account numbers.
 */
const router = Router();

function tokenOk(given: string | undefined): boolean {
  const expected = process.env.AUDIT_TOKEN;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

router.get('/report', async (req, res, next) => {
  try {
    if (!tokenOk(req.header('x-audit-token'))) return res.status(401).json({ error: 'Unauthorized' });

    const now = new Date();
    const days = (n: number) => new Date(now.getTime() - n * 86400000);
    const num = (v: unknown) => (v == null ? null : Number(v));

    // ── Bills imported in the last 30 days: how well were they read? ─────
    const recent = await db.statement.findMany({
      where: { createdAt: { gte: days(30) }, isDownPayment: false },
      select: {
        id: true, statementDate: true, dueDate: true, billingPeriodStart: true, billingPeriodEnd: true,
        amountDue: true, pastDueCarried: true, penaltiesFees: true, balance: true, isScheduled: true, rawDataJson: true, sourceType: true,
        utilityAccount: { select: { id: true, providerName: true, providerSlug: true, category: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const sample = (rows: any[], n = 8) => rows.slice(0, n);
    const describe = (s: any) => ({
      statementId: s.id, provider: s.utilityAccount.providerName, category: s.utilityAccount.category,
      statementDate: s.statementDate, amountDue: num(s.amountDue), pastDueCarried: num(s.pastDueCarried),
      statedTotalDue: num((s.rawDataJson as any)?.statedTotalDue), extractedBy: (s.rawDataJson as any)?.extractedBy ?? null,
    });
    const textFallback = recent.filter(s => (s.rawDataJson as any)?.extractedBy === 'text');
    const nullAmount = recent.filter(s => s.amountDue == null && !s.isScheduled);
    const identityMismatch = recent.filter(s => {
      const stated = num((s.rawDataJson as any)?.statedTotalDue);
      if (stated == null || s.amountDue == null) return false;
      const deferred = num((s.rawDataJson as any)?.netMetering?.deferred) ?? 0;
      const payable = Number(s.amountDue) - deferred + Number(s.pastDueCarried ?? 0);
      return Math.abs(payable - stated) > 0.05;
    });
    const longPeriod = recent.filter(s => s.billingPeriodStart && s.billingPeriodEnd && !s.isScheduled
      && (new Date(s.billingPeriodEnd).getTime() - new Date(s.billingPeriodStart).getTime()) / 86400000 > 45
      && s.utilityAccount.category !== 'INSURANCE');
    const byDayKey = new Map<string, any[]>();
    for (const s of recent) {
      // Installments filed from one policy document legitimately share its
      // date; they are a schedule, not duplicates of one bill.
      if (s.isScheduled) continue;
      const k = `${s.utilityAccount.id}:${new Date(s.statementDate).toISOString().slice(0, 10)}`;
      byDayKey.set(k, [...(byDayKey.get(k) ?? []), s]);
    }
    const duplicates = [...byDayKey.values()].filter(g => g.length > 1).map(g => g.map(describe));
    const byProvider = new Map<string, { imported: number; textFallback: number; mismatches: number }>();
    for (const s of recent) {
      const k = s.utilityAccount.providerName;
      const row = byProvider.get(k) ?? { imported: 0, textFallback: 0, mismatches: 0 };
      row.imported++;
      if ((s.rawDataJson as any)?.extractedBy === 'text') row.textFallback++;
      if (identityMismatch.includes(s)) row.mismatches++;
      byProvider.set(k, row);
    }

    // ── Syncs that keep failing, by provider ─────────────────────────────
    const failedSyncs = await db.utilityAccount.findMany({
      where: { isActive: true, syncEnabled: true, lastSyncStatus: 'FAILED' },
      select: { providerName: true, providerSlug: true, lastSyncError: true, lastSyncedAt: true },
    });
    const syncByProvider = new Map<string, { failing: number; errors: Set<string> }>();
    for (const a of failedSyncs) {
      const row = syncByProvider.get(a.providerSlug) ?? { failing: 0, errors: new Set<string>() };
      row.failing++;
      if (a.lastSyncError) row.errors.add(a.lastSyncError.slice(0, 160));
      syncByProvider.set(a.providerSlug, row);
    }

    // ── Accounts that went silent ────────────────────────────────────────
    const active = await db.utilityAccount.findMany({
      where: { isActive: true, escrowLoanId: null, billingCadence: { in: ['MONTHLY', 'BIMONTHLY'] } },
      select: {
        id: true, providerName: true, providerSlug: true, category: true, syncEnabled: true, createdAt: true,
        statements: { where: { isScheduled: false }, orderBy: { statementDate: 'desc' }, take: 1, select: { statementDate: true } },
      },
    });
    const silent = active
      .map(a => ({ provider: a.providerName, slug: a.providerSlug, category: a.category, syncEnabled: a.syncEnabled,
        lastBill: a.statements[0]?.statementDate ?? null,
        daysSince: Math.round((now.getTime() - new Date(a.statements[0]?.statementDate ?? a.createdAt).getTime()) / 86400000) }))
      .filter(a => a.daysSince > 60)
      .sort((a, b) => b.daysSince - a.daysSince);

    // ── Payments nobody filed against a bill ─────────────────────────────
    const unlinked = await db.payment.count({ where: { statementId: null, paymentDate: { lte: days(14) }, status: { in: ['PAID', 'PARTIAL'] } } });

    // ── Scheduled installments past their date and still open ────────────
    const scheduledOverdue = await db.statement.count({ where: { isScheduled: true, dueDate: { lt: days(3) }, amountPaid: null, paidOverride: null } });

    // ── Policies and loans with placeholder figures ──────────────────────
    const zeroPremium = await db.insurancePolicy.count({ where: { isActive: true, premiumAmount: 0 } });
    const loans = await db.loan.findMany({ where: { isActive: true }, select: { originalAmount: true, currentBalance: true, originationDate: true } });
    const loanBalanceMissing = loans.filter(l => l.currentBalance == null).length;
    const loanBalanceUntouched = loans.filter(l => l.currentBalance != null && l.originalAmount != null
      && Math.abs(Number(l.currentBalance) - Number(l.originalAmount)) < 0.01
      && l.originationDate && (now.getTime() - new Date(l.originationDate).getTime()) / 86400000 > 45).length;

    // ── Browser crashes this week ────────────────────────────────────────
    const errors = await db.clientError.findMany({ where: { createdAt: { gte: days(7) } }, orderBy: { createdAt: 'desc' }, take: 300 });
    const byMessage = new Map<string, { count: number; lastUrl: string | null; lastAt: Date; stack: string | null }>();
    for (const e of errors) {
      const row = byMessage.get(e.message) ?? { count: 0, lastUrl: e.url, lastAt: e.createdAt, stack: e.stack };
      row.count++;
      byMessage.set(e.message, row);
    }
    const clientErrors = [...byMessage.entries()].map(([message, r]) => ({ message, count: r.count, lastUrl: r.lastUrl, lastAt: r.lastAt, stack: r.stack?.slice(0, 600) ?? null }))
      .sort((a, b) => b.count - a.count).slice(0, 15);

    res.json({
      generatedAt: now,
      window: { importsDays: 30, errorsDays: 7 },
      imports: {
        total: recent.length,
        textFallback: { count: textFallback.length, sample: sample(textFallback).map(describe) },
        nullAmount: { count: nullAmount.length, sample: sample(nullAmount).map(describe) },
        identityMismatch: { count: identityMismatch.length, note: 'amountDue − deferred + pastDueCarried ≠ statedTotalDue', sample: sample(identityMismatch).map(describe) },
        longBillingPeriod: { count: longPeriod.length, note: 'non-insurance bill whose period spans > 45 days', sample: sample(longPeriod).map(describe) },
        duplicates: { count: duplicates.length, sample: sample(duplicates, 5) },
        byProvider: Object.fromEntries(byProvider),
      },
      sync: { failingAccounts: failedSyncs.length, byProvider: Object.fromEntries([...syncByProvider.entries()].map(([k, v]) => [k, { failing: v.failing, errors: [...v.errors].slice(0, 3) }])) },
      silentAccounts: { count: silent.length, sample: sample(silent, 12) },
      unlinkedPaymentsOlderThan14d: unlinked,
      scheduledInstallmentsOverdue: scheduledOverdue,
      placeholders: { zeroPremiumPolicies: zeroPremium, loanBalanceMissing, loanBalanceUntouched },
      clientErrors,
    });
  } catch (err) { next(err); }
});

export default router;
