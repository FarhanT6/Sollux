/**
 * Check statements against their PDFs: every utility account's newest
 * statements are read again from the stored PDF, with the current reader
 * and nothing saved (parseBill is read only), and what the PDF says is set
 * against what Sollux stores and shows — the period's charge, the past due
 * carried in, the total, the due date and the payments the bill says it
 * received. Each disagreement is listed with what each side says; most are
 * fixed by re-reading that one statement for real (fixStatement), which is
 * the same path as the account's Re-read statements.
 *
 * Runs in the background, one PDF at a time; the last run's findings are
 * kept in app_settings (`statement-audit:<userId>`) so the Bills page can
 * show them after a reload.
 */
import { db } from '../config/db';
import { withAiContext } from '../ai/meter';
import { downloadDocument } from './s3Service';
import { parseBill, periodChargeOf, type ExtractedBillData } from './pdfImportService';
import { intakeBill } from './documentIntake';

export type AuditField = 'charge' | 'pastDue' | 'total' | 'dueDate' | 'payments' | 'unreadable';

export interface AuditFinding {
  accountId: string;
  propertyId: string;
  provider: string;
  property: string;
  last4: string | null;
  statementId: string;
  statementDate: string;     // YYYY-MM-DD
  field: AuditField;
  /** What Sollux has (a number, a YYYY-MM-DD date, or null for nothing). */
  stored: number | string | null;
  /** What the PDF says. */
  read: number | string | null;
  /** The owner changed this statement's figures by hand. */
  ownerEdited: boolean;
  /** A re-read of the statement would change what Sollux has. */
  fixable: boolean;
  note?: string;
}

export interface AuditRun {
  startedAt: string;
  finishedAt: string | null;
  accounts: number;
  total: number;             // statements to check
  checked: number;
  failed: number;
  perAccount: number;
  findings: AuditFinding[];
  fixed: string[];           // statement ids fixed since the run
}

const key = (userId: string) => `statement-audit:${userId}`;
const running = new Set<string>();
// The run in progress, so a Fix made while it runs lands in what it saves.
const live = new Map<string, AuditRun>();
const money = (v: unknown): number | null => (v == null ? null : Number(Number(v).toFixed(2)));
const day = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  if (typeof d === 'string') return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
  return d.toISOString().slice(0, 10);
};
const differs = (a: number | null, b: number | null, tol = 0.01) => Math.abs((a ?? 0) - (b ?? 0)) > tol;

export const isAuditing = (userId: string) => running.has(userId);

export async function lastAudit(userId: string): Promise<(AuditRun & { running: boolean }) | null> {
  const row = await db.appSetting.findUnique({ where: { key: key(userId) } });
  if (!row) return null;
  try { return { ...(JSON.parse(row.value) as AuditRun), running: running.has(userId) }; } catch { return null; }
}

async function save(userId: string, run: AuditRun) {
  const value = JSON.stringify(run);
  await db.appSetting.upsert({ where: { key: key(userId) }, create: { key: key(userId), value }, update: { value } });
}

type StoredStatement = {
  id: string; statementDate: Date; dueDate: Date | null; amountDue: unknown; pastDueCarried: unknown;
  trueUpDeferred: unknown; rawDataJson: unknown;
};

/**
 * What the PDF says against what is stored, field by field. Pure: the
 * payments the account logged in the bill's window are passed in.
 */
export function compareStatement(s: StoredStatement, ex: ExtractedBillData, loggedInWindow: number | null): Omit<AuditFinding, 'accountId' | 'propertyId' | 'provider' | 'property' | 'last4'>[] {
  const raw = (s.rawDataJson && typeof s.rawDataJson === 'object' ? s.rawDataJson : {}) as Record<string, unknown>;
  const ownerEdited = !!raw.ownerEditedAt;
  const base = { statementId: s.id, statementDate: day(s.statementDate)!, ownerEdited };
  const out: Omit<AuditFinding, 'accountId' | 'propertyId' | 'provider' | 'property' | 'last4'>[] = [];

  const storedCharge = money(s.amountDue);
  const readCharge = money(periodChargeOf(ex));
  const storedPast = money(s.pastDueCarried) ?? 0;
  // What a re-read stores as carried: the previous balance when the bill
  // prints one, nothing when it states a total without one.
  const readPast = ex.previousBalance != null && ex.previousBalance !== 0 ? money(ex.previousBalance)! : 0;
  const chargeOff = readCharge != null && differs(storedCharge, readCharge);
  const pastOff = (ex.previousBalance != null || ex.statedTotalDue != null) && differs(storedPast, readPast);
  if (chargeOff) out.push({ ...base, field: 'charge', stored: storedCharge, read: readCharge, fixable: !ownerEdited });
  if (pastOff) out.push({ ...base, field: 'pastDue', stored: storedPast, read: readPast, fixable: !ownerEdited });

  // The total Sollux shows is amountDue − trueUpDeferred + pastDueCarried.
  // Only worth a line of its own when the parts agree and the sum does not:
  // the reader's figures don't add up to what the bill prints.
  const printedTotal = money(ex.statedTotalDue);
  if (printedTotal != null && !chargeOff && !pastOff && storedCharge != null) {
    const shown = money(storedCharge - Number(s.trueUpDeferred ?? 0) + storedPast)!;
    if (differs(shown, printedTotal)) {
      out.push({ ...base, field: 'total', stored: shown, read: printedTotal, fixable: false,
        note: 'The bill\'s charge and past due match, but they don\'t add up to the total it prints — a fee or credit is being missed.' });
    }
  }

  const readDue = day(ex.dueDate);
  if (readDue && readDue !== day(s.dueDate)) out.push({ ...base, field: 'dueDate', stored: day(s.dueDate), read: readDue, fixable: !ownerEdited });

  const printedPaid = ex.paymentsReceived != null ? money(Math.abs(ex.paymentsReceived)) : null;
  if (printedPaid != null && loggedInWindow != null && differs(loggedInWindow, printedPaid, 0.5)) {
    out.push({ ...base, field: 'payments', stored: money(loggedInWindow), read: printedPaid, fixable: false,
      note: loggedInWindow > printedPaid + 0.5
        ? 'More is logged between this bill and the one before than the bill says it received — a payment may be logged twice, or posted after the bill was printed.'
        : 'The bill says it received more than is logged between this bill and the one before — a payment may be missing.' });
  }
  return out;
}

/** Starts a check of every account's newest statements; returns how many PDFs it will read, or null if one is running. */
export async function startStatementAudit(userId: string, opts: { perAccount?: number; accountIds?: string[] } = {}): Promise<number | null> {
  if (running.has(userId)) return null;
  const perAccount = Math.min(Math.max(opts.perAccount ?? 3, 1), 24);
  const accounts = await db.utilityAccount.findMany({
    where: { property: { userId }, isActive: true, ...(opts.accountIds?.length ? { id: { in: opts.accountIds } } : {}) },
    select: { id: true, propertyId: true, providerName: true, accountNumber: true, property: { select: { nickname: true, address: true } } },
  });
  const jobs: { acct: typeof accounts[number]; s: StoredStatement & { pdfS3Key: string } }[] = [];
  for (const acct of accounts) {
    const rows = await db.statement.findMany({
      where: { utilityAccountId: acct.id, pdfS3Key: { not: null } },
      select: { id: true, statementDate: true, dueDate: true, amountDue: true, pastDueCarried: true, trueUpDeferred: true, rawDataJson: true, pdfS3Key: true },
      orderBy: { statementDate: 'desc' },
      take: perAccount * 2,
    });
    // An email printout is not a statement.
    for (const r of rows.filter(r => (r.rawDataJson as any)?.source !== 'email').slice(0, perAccount)) jobs.push({ acct, s: r as any });
  }
  const run: AuditRun = {
    startedAt: new Date().toISOString(), finishedAt: null, accounts: new Set(jobs.map(j => j.acct.id)).size,
    total: jobs.length, checked: 0, failed: 0, perAccount, findings: [], fixed: [],
  };
  running.add(userId);
  live.set(userId, run);
  await save(userId, run);

  void (async () => {
    try {
      for (const { acct, s } of jobs) {
        const who = {
          accountId: acct.id, propertyId: acct.propertyId, provider: acct.providerName,
          property: acct.property.nickname || acct.property.address,
          last4: acct.accountNumber ? String(acct.accountNumber).replace(/\D/g, '').slice(-4) || null : null,
        };
        try {
          const buf = await downloadDocument(s.pdfS3Key);
          const name = s.pdfS3Key.split('/').pop() || 'statement.pdf';
          const parsed = await withAiContext({ userId }, () => parseBill(buf, name, userId, 'ai'));
          if (parsed.error) throw new Error(parsed.error);
          const loggedInWindow = await loggedBetweenBills(acct.id, s);
          for (const f of compareStatement(s, parsed.extracted, loggedInWindow)) run.findings.push({ ...who, ...f });
        } catch (err) {
          run.failed++;
          run.findings.push({ ...who, statementId: s.id, statementDate: day(s.statementDate)!, field: 'unreadable', stored: null, read: null,
            ownerEdited: false, fixable: false, note: err instanceof Error ? err.message.slice(0, 200) : 'Could not read the PDF.' });
          // Out of budget: every PDF after this one would fail the same way.
          if (err instanceof Error && err.name === 'AiBudgetError') break;
        }
        run.checked++;
        await save(userId, run);
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      await save(userId, run).catch(() => {});
      running.delete(userId);
      live.delete(userId);
    }
  })();
  return jobs.length;
}

/** Payments logged after the bill before this one and before this bill: what the bill's "payments received" covers. */
async function loggedBetweenBills(utilityAccountId: string, s: { id: string; statementDate: Date }): Promise<number | null> {
  const prev = await db.statement.findFirst({
    where: { utilityAccountId, statementDate: { lt: s.statementDate }, id: { not: s.id } },
    orderBy: { statementDate: 'desc' }, select: { statementDate: true },
  });
  if (!prev) return null;   // the first bill on file: no window to count in
  const agg = await db.payment.aggregate({
    where: { utilityAccountId, status: { not: 'FAILED' }, paymentDate: { gte: prev.statementDate, lt: s.statementDate } },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}

/** Re-read one statement for real; its findings come off the list once it is saved. */
export async function fixStatement(userId: string, statementId: string): Promise<{ outcome: string }> {
  const s = await db.statement.findFirst({
    where: { id: statementId, utilityAccount: { property: { userId } } },
    select: { id: true, pdfS3Key: true, rawDataJson: true, utilityAccount: { select: { id: true, accountNumber: true } } },
  });
  if (!s || !s.pdfS3Key) throw Object.assign(new Error('Statement not found'), { status: 404 });
  const buf = await downloadDocument(s.pdfS3Key);
  const name = s.pdfS3Key.split('/').pop() || 'statement.pdf';
  const source = String((s.rawDataJson as any)?.source ?? 'pdf_import');
  const last4 = String(s.utilityAccount.accountNumber ?? '').replace(/\D/g, '').slice(-4);
  const result = await intakeBill(buf, name, userId, 'ai', `audit-fix-${Date.now()}`, source, {
    forAccounts: [{ id: s.utilityAccount.id, last4 }], pdfKey: s.pdfS3Key, statementId: s.id,
  });
  if (result.outcome === 'filed') {
    const inProgress = live.get(userId);
    if (inProgress) { if (!inProgress.fixed.includes(statementId)) inProgress.fixed.push(statementId); await save(userId, inProgress); }
    else {
      const run = await lastAudit(userId);
      if (run) {
        const { running: _r, ...rest } = run;
        if (!rest.fixed.includes(statementId)) rest.fixed.push(statementId);
        await save(userId, rest);
      }
    }
  }
  return { outcome: result.outcome };
}
