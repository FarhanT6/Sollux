/**
 * AI spend: what Claude has cost this month, by feature, against the budget —
 * and a test run that exercises every feature that calls Claude once, on the
 * owner's own documents, so each can be checked for working and for what it
 * costs before it runs on its own every night.
 *
 * Owner only. Test spend is marked as such (ai_usage.test) so it does not
 * read as everyday use.
 */
import { Router, Request, Response } from 'express';
import { fillLookupDetails, lookupFillState } from '../services/lookupDetails';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { askClaude, PRIMARY_MODEL, FALLBACK_MODEL } from '../ai/models';
import { monthlyBudget, setMonthlyBudget, monthSpend, withAiContext, accountSpend, allowanceOf } from '../ai/meter';
import { downloadDocument } from '../services/s3Service';
import { parseBill } from '../services/pdfImportService';
import { extractLeaseTerms } from '../services/leaseExtract';
import { extractDeclarations } from '../services/declarationsExtractor';
import { classifyDocument } from '../services/documentClassifyService';
import { callClaudeForInsight } from '../ai/insightEngine';
import { assistantTurn } from '../ai/assistant';
import { detectLeaks } from '../ai/leakDetective';
import { runBookkeeperForUser } from '../ai/bookkeeper';
import { scrapeQueue } from '../workers/queues';
import { workerStatus } from '../workers/heartbeat';
import { websiteFor, isLookupPage, isLookupAccount, lookupStartFor } from '../lib/providerDirectory';

const router = Router();
router.use(attachDbUser);
router.use((req, res, next) => (req.isAccountOwner ? next() : res.status(403).json({ error: 'Only the account owner can see AI spend.' })));

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };

/** What feature names mean, for the page. */
const FEATURES: Record<string, string> = {
  'bill-read': 'Reading a bill PDF',
  'bill-read-image': 'Reading a bill photo',
  'bill-transcribe-scan': 'Transcribing a scanned bill',
  'portal-agent': 'Fetching statements from portals',
  'lease-extract': 'Reading a lease',
  'insurance-declarations': 'Reading an insurance declarations page',
  'document-classify': 'Sorting a scanned document',
  'read-statement': 'Reading a bank or card statement',
  'insight': 'Bill insights',
  'leak-detective': 'Leak detective',
  'bookkeeper-digest': 'Nightly bookkeeper digest',
  'rent-reminder': 'Rent reminder drafts',
  'assistant': 'Ask Sollux (assistant)',
  'ask-question': 'Ask Sollux (quick answer)',
  'fallback-test': 'Fallback model check',
};
const nameOf = (f: string) => FEATURES[f] ?? (f.startsWith('read-') ? `Reading a ${f.slice(5)} document` : f);

router.get('/', async (req: Request, res: Response) => {
  const since = monthStart();
  // A customer sees their own account's spend against its plan's allowance;
  // only the admin (you) sees the whole app's, against AI_MONTHLY_BUDGET.
  const admin = !!req.isPlatformAdmin;
  const mine = admin ? {} : { userId: req.dbUserId! };
  const [byFeature, recent, total, recipes] = await Promise.all([
    db.aiUsage.groupBy({
      by: ['feature', 'test'], where: { createdAt: { gte: since }, ...mine },
      _sum: { costUsd: true, inputTokens: true, outputTokens: true, cacheReadTokens: true }, _count: { _all: true },
    }),
    db.aiUsage.findMany({ where: mine, orderBy: { createdAt: 'desc' }, take: 40, select: { createdAt: true, feature: true, model: true, costUsd: true, fellBack: true, test: true, inputTokens: true, outputTokens: true, cacheReadTokens: true } }),
    admin ? monthSpend() : accountSpend(req.dbUserId!),
    // Saved routes: all of them for the admin; a customer's own accounts' otherwise.
    admin ? db.portalRecipe.count() : db.utilityAccount.findMany({ where: { property: { userId: req.dbUserId! } }, select: { id: true } })
      .then(rows => db.portalRecipe.count({ where: { key: { in: rows.map(r => `acct:${r.id}`) } } })),
  ]);
  const fallbacks = await db.aiUsage.groupBy({ by: ['feature'], where: { createdAt: { gte: since }, fellBack: true, ...mine }, _count: { _all: true } });
  const fb = new Map(fallbacks.map(f => [f.feature, f._count._all]));
  res.json({
    month: since.toISOString().slice(0, 7),
    spent: total,
    budget: admin ? await monthlyBudget() : await allowanceOf(req.dbUserId!),
    scope: admin ? 'app' : 'account',
    primaryModel: PRIMARY_MODEL,
    fallbackModel: FALLBACK_MODEL,
    portalRecipes: recipes,
    features: byFeature.map(f => ({
      feature: f.feature, name: nameOf(f.feature), test: f.test,
      calls: f._count._all, cost: Number(f._sum.costUsd ?? 0),
      avgCost: Number(f._sum.costUsd ?? 0) / Math.max(1, f._count._all),
      fallbacks: f.test ? 0 : fb.get(f.feature) ?? 0,
      cachedShare: (() => { const r = f._sum.cacheReadTokens ?? 0, i = f._sum.inputTokens ?? 0; return r + i ? r / (r + i) : 0; })(),
    })).sort((a, b) => b.cost - a.cost),
    recent: recent.map(r => ({ ...r, costUsd: Number(r.costUsd), name: nameOf(r.feature) })),
  });
});

// PUT /api/ai-spend/budget { monthly: number | null } — the app-wide monthly cap (admin only).
router.put('/budget', async (req: Request, res: Response) => {
  if (!req.isPlatformAdmin) return res.status(403).json({ error: 'Only the admin sets the app budget.' });
  const m = req.body?.monthly;
  if (m !== null && !(typeof m === 'number' && Number.isFinite(m) && m >= 0 && m <= 10000)) return res.status(400).json({ error: 'A dollar amount from 0 to 10,000, or no cap.' });
  await setMonthlyBudget(m);
  res.json({ budget: m });
});

// ─── Test run ──────────────────────────────────────────────
interface TestResult { key: string; name: string; status: 'pending' | 'running' | 'ok' | 'problem' | 'skipped'; detail?: string; cost?: number; calls?: number; models?: string[]; fellBack?: boolean; ms?: number }
interface TestRun { startedAt: string; finishedAt?: string; results: TestResult[] }
// One run per owner, held in memory: a test is watched while it runs and re-run when wanted.
const runs = new Map<string, TestRun>();

const money = (n: unknown) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '—');

type Check = { key: string; name: string; run: (userId: string) => Promise<{ ok: boolean; detail: string } | { skipped: string }> };

const CHECKS: Check[] = [
  {
    key: 'bill-read', name: 'Read your latest bill PDF and compare it with what is on file',
    run: async (userId) => {
      const s = await db.statement.findFirst({
        where: { pdfS3Key: { not: null }, utilityAccount: { property: { userId } } }, orderBy: { createdAt: 'desc' },
        select: { pdfS3Key: true, amountDue: true, dueDate: true, utilityAccount: { select: { providerName: true } } },
      });
      if (!s?.pdfS3Key) return { skipped: 'No bill PDF on file yet.' };
      const pdf = await downloadDocument(s.pdfS3Key);
      const p = await parseBill(pdf, 'test.pdf', userId, 'ai');
      if (p.error) return { ok: false, detail: `${s.utilityAccount.providerName}: ${p.error}` };
      const read = p.extracted.amountDue, filed = s.amountDue == null ? null : Number(s.amountDue);
      const same = read != null && filed != null && Math.abs(read - filed) < 0.01;
      return { ok: same && p.extractedBy === 'ai', detail: `${s.utilityAccount.providerName}: read ${money(read)} due ${p.extracted.dueDate ?? '—'}; on file ${money(filed)} due ${day(s.dueDate)}${p.extractedBy === 'text' ? ' — Claude could not open it; the text reader was used' : ''}${same ? '' : ' — these differ'}` };
    },
  },
  {
    key: 'fallback', name: `Fallback model (${FALLBACK_MODEL ?? 'off'}) answers when the first answer fails its check`,
    run: async () => {
      if (!FALLBACK_MODEL) return { skipped: 'The fallback is turned off (CLAUDE_FALLBACK_MODEL=none).' };
      let first = true;
      const r = await askClaude(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), {
        feature: 'fallback-test', label: 'test', maxTokens: 20,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        check: () => (first ? ((first = false), 'test: the first answer is rejected on purpose') : null),
      });
      return { ok: r.fellBack && r.model === FALLBACK_MODEL, detail: r.fellBack ? `${PRIMARY_MODEL}'s answer was rejected on purpose; ${r.model} answered "${r.text.slice(0, 20)}".` : 'The fallback did not run.' };
    },
  },
  {
    key: 'lease-extract', name: 'Read your latest lease and compare rent and dates',
    run: async (userId) => {
      const l = await db.lease.findFirst({ where: { documentUrl: { not: null }, unit: { property: { userId } } }, orderBy: { createdAt: 'desc' }, select: { documentUrl: true, rentAmount: true, startDate: true, endDate: true } });
      if (!l?.documentUrl) return { skipped: 'No lease PDF uploaded yet.' };
      const t = await extractLeaseTerms(await downloadDocument(l.documentUrl), 'lease.pdf');
      const same = t.rentAmount != null && Math.abs(t.rentAmount - Number(l.rentAmount)) < 0.01;
      return { ok: same, detail: `Read rent ${money(t.rentAmount)}, ${t.startDate ?? '—'} to ${t.endDate ?? 'month-to-month'}, deposit ${money(t.securityDeposit)}; on file rent ${money(l.rentAmount)}, ${day(l.startDate)} to ${day(l.endDate)}${same ? '' : ' — rent differs'}` };
    },
  },
  {
    key: 'insurance-declarations', name: 'Read your latest insurance document',
    run: async (userId) => {
      const d = await db.document.findFirst({ where: { userId, category: 'INSURANCE' }, orderBy: { createdAt: 'desc' }, select: { s3Key: true, title: true } });
      if (!d) return { skipped: 'No insurance document saved yet.' };
      const x = await extractDeclarations(await downloadDocument(d.s3Key), 'policy.pdf');
      const ok = !!(x.carrier && (x.effectiveDate || x.expirationDate));
      return { ok, detail: `"${d.title}": ${x.carrier ?? 'carrier not found'}, policy ending ${x.policyNumber ? x.policyNumber.slice(-4) : '—'}, ${x.effectiveDate ?? '—'} to ${x.expirationDate ?? '—'}` };
    },
  },
  {
    key: 'document-classify', name: 'Sort a saved document by type and property',
    run: async (userId) => {
      const d = await db.document.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { s3Key: true, title: true, category: true } });
      if (!d) return { skipped: 'No saved documents yet.' };
      const { classified, match } = await classifyDocument(await downloadDocument(d.s3Key), userId);
      const c = classified as any;
      const same = String(c.category ?? '').toUpperCase() === d.category;
      return { ok: true, detail: `"${d.title}": sorted as ${c.category ?? '—'} (filed as ${d.category})${match ? `, property ${(match as any).propertyName ?? (match as any).propertyId ?? 'matched'}` : ', no property matched'}${same ? '' : ' — category differs'}` };
    },
  },
  {
    key: 'insight', name: 'Write a bill insight',
    run: async (userId) => {
      const a = await db.utilityAccount.findFirst({ where: { property: { userId }, statements: { some: {} } }, select: { providerName: true, category: true, statements: { orderBy: { statementDate: 'desc' }, take: 4, select: { amountDue: true } } } });
      if (!a) return { skipped: 'No bills yet.' };
      const amounts = a.statements.map(s => Number(s.amountDue ?? 0));
      const avg = amounts.slice(1).reduce((x, y) => x + y, 0) / Math.max(1, amounts.length - 1) || amounts[0] || 100;
      const r = await callClaudeForInsight({ type: 'anomaly', providerName: a.providerName, category: a.category, currentAmount: amounts[0] || avg * 1.3, averageAmount: avg, deviation: 30, direction: 'higher', recentAmounts: amounts });
      const templated = /Review your account for any changes/.test(r.body);
      return { ok: !templated, detail: templated ? 'Claude did not answer; the template was used.' : r.body.slice(0, 220) };
    },
  },
  {
    key: 'assistant', name: 'Ask Sollux: "What bills are due in the next 7 days?"',
    run: async (userId) => {
      const r = await assistantTurn(userId, [{ role: 'user', content: 'What bills are due in the next 7 days?' }], new Date().toISOString().slice(0, 10));
      return { ok: !!r.answer && !/could not find/i.test(r.answer), detail: r.answer.slice(0, 300) };
    },
  },
  {
    key: 'leak-detective', name: 'Leak detective (run twice: the second should cost nothing)',
    run: async (userId) => {
      const first = await detectLeaks(userId);
      if (!first.length) return { ok: true, detail: 'No unusual usage on any metered account, so Claude was not called.' };
      const before = await db.aiUsage.count({ where: { feature: 'leak-detective', test: true } });
      await detectLeaks(userId);
      const after = await db.aiUsage.count({ where: { feature: 'leak-detective', test: true } });
      return { ok: after === before, detail: `${first.length} finding${first.length === 1 ? '' : 's'}: ${first[0].title}. Second run: ${after - before === 0 ? 'reused the answers, no new calls' : `${after - before} new calls — reuse is not working`}.` };
    },
  },
  {
    key: 'bookkeeper-digest', name: 'Nightly bookkeeper (run twice: the second should cost nothing)',
    run: async (userId) => {
      const r = await runBookkeeperForUser(userId);
      const before = await db.aiUsage.count({ where: { feature: { in: ['bookkeeper-digest', 'leak-detective', 'rent-reminder'] }, test: true } });
      await runBookkeeperForUser(userId);
      const after = await db.aiUsage.count({ where: { feature: { in: ['bookkeeper-digest', 'leak-detective', 'rent-reminder'] }, test: true } });
      return { ok: after === before, detail: `${r.findings.length} findings (${r.raised} raised, ${r.refreshed} refreshed). Second run: ${after === before ? 'no new calls' : `${after - before} new calls — reuse is not working`}.` };
    },
  },
];

async function runTests(userId: string, only?: string) {
  const checks = only ? CHECKS.filter(c => c.key === only) : CHECKS;
  const run: TestRun = { startedAt: new Date().toISOString(), results: checks.map(c => ({ key: c.key, name: c.name, status: 'pending' })) };
  runs.set(userId, run);
  for (const [i, c] of checks.entries()) {
    const r = run.results[i];
    r.status = 'running';
    const started = new Date();
    try {
      const out = await withAiContext({ userId, test: true }, () => c.run(userId));
      if ('skipped' in out) { r.status = 'skipped'; r.detail = out.skipped; }
      else { r.status = out.ok ? 'ok' : 'problem'; r.detail = out.detail; }
    } catch (err) {
      r.status = 'problem';
      r.detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    }
    r.ms = Date.now() - started.getTime();
    // Checks run one at a time, so the calls since this one started are its own.
    const used = await db.aiUsage.findMany({ where: { test: true, userId, createdAt: { gte: started } }, select: { costUsd: true, model: true, fellBack: true } });
    r.calls = used.length;
    r.cost = used.reduce((s, u) => s + Number(u.costUsd), 0);
    r.models = [...new Set(used.map(u => u.model))];
    r.fellBack = used.some(u => u.fellBack);
  }
  run.finishedAt = new Date().toISOString();
}

router.get('/test', (req: Request, res: Response) => {
  res.json({ checks: CHECKS.map(c => ({ key: c.key, name: c.name })), run: runs.get(req.dbUserId!) ?? null, apiKey: !!process.env.ANTHROPIC_API_KEY });
});

router.post('/test', (req: Request, res: Response) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });
  const current = runs.get(req.dbUserId!);
  if (current && !current.finishedAt) return res.status(409).json({ error: 'A test run is already going.' });
  const only = typeof req.body?.only === 'string' ? req.body.only : undefined;
  void runTests(req.dbUserId!, only).catch(err => console.error('[AI test]', err));
  res.json({ started: true });
});

/** Fetch statements for one account now, as a test: the worker runs it and its spend is marked as a test. */
router.post('/test/portal/:accountId', async (req: Request, res: Response) => {
  const a = await db.utilityAccount.findFirst({ where: { id: req.params.accountId, property: { userId: req.dbUserId! } }, select: { id: true, usernameEnc: true, lookupCustomerId: true, syncEnabled: true, providerName: true, providerSlug: true, loginUrl: true } });
  if (!a) return res.status(404).json({ error: 'Account not found' });
  // A bill lookup page needs no login (the name on the bill instead).
  if (!a.usernameEnc && !isLookupAccount(a)) return res.status(400).json({ error: 'Add a portal login to this account first.' });
  if (!a.syncEnabled) return res.status(400).json({ error: 'Syncing is turned off for this account (it is marked inactive). Turn it back on from the account first.' });
  // One run at a time: a second would fight the first over the same login.
  const running = await db.syncJob.findFirst({ where: { utilityAccountId: a.id, status: 'PENDING', createdAt: { gte: new Date(Date.now() - 15 * 60_000) } }, select: { id: true } });
  if (running) return res.status(409).json({ error: 'A fetch is already running for this account.' });
  // The job exists from the moment Fetch is pressed, so the row shows "queued"
  // at once — and says so plainly if the background worker never picks it up.
  const job = await db.syncJob.create({ data: { utilityAccountId: a.id, status: 'PENDING', progress: 'Queued — waiting for the background worker' } });
  await scrapeQueue.add('scrape', { utilityAccountId: a.id, manual: true, test: true, syncJobId: job.id }, { jobId: `test-${a.id}-${Date.now()}`, lifo: true, removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } });
  res.json({ queued: true, syncJobId: job.id });
});

/** What the scrape worker is on right now and how much is waiting, so a queued press can say why it waits. */
async function queueSnapshot(userId: string) {
  try {
    const [counts, active] = await Promise.all([scrapeQueue.getJobCounts('waiting', 'active', 'prioritized', 'delayed'), scrapeQueue.getActive(0, 4)]);
    const ids = active.map(j => j.data?.utilityAccountId).filter(Boolean) as string[];
    // Another customer's account is not named: only "another account".
    const names = new Map((await db.utilityAccount.findMany({ where: { id: { in: ids }, property: { userId } }, select: { id: true, providerName: true, accountNumber: true } }))
      .map(a => [a.id, `${a.providerName}${a.accountNumber ? ` ··${String(a.accountNumber).slice(-4)}` : ''}`]));
    return {
      waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.delayed ?? 0),
      active: active.map(j => ({ account: names.get(j.data?.utilityAccountId) ?? 'another account', since: j.processedOn ? new Date(j.processedOn) : null, kind: j.data?.manual ? 'a Sync or Fetch press' : j.data?.trigger === 'bill_posted' ? 'a bill-ready email' : 'the schedule' })),
    };
  } catch {
    return null; // Redis unreachable: the worker status says so
  }
}

/**
 * Every account, with how its last fetch went and what it still needs to be
 * fetched at all: a portal login, or the name on the bill for a lookup page.
 * Listing only accounts with a login left Cox and Service Finance out with no
 * word of why.
 */
// POST /test/portal/fill-lookup — fill the customer number, name on the bill and pay-online
// address from the bills already on file (services/lookupDetails.ts).
router.post('/test/portal/fill-lookup', async (req: Request, res: Response) => {
  try {
    const count = await fillLookupDetails(req.dbUserId!);
    res.status(202).json({ started: count != null, count, state: lookupFillState(req.dbUserId!) });
  } catch (err: any) {
    res.status(err?.status ?? (/budget|allowance/i.test(err?.message ?? '') ? 402 : 500)).json({ error: err?.message ?? 'Could not start.' });
  }
});

router.get('/test/portal', async (req: Request, res: Response) => {
  const accounts = await db.utilityAccount.findMany({
    where: { property: { userId: req.dbUserId! } },
    select: { id: true, providerName: true, providerSlug: true, category: true, escrowLoanId: true, usernameEnc: true, lookupName: true, lookupCustomerId: true, propertyId: true, accountNumber: true, loginUrl: true, lastSyncStatus: true, lastSyncError: true, lastAgentRunAt: true, syncEnabled: true, mfaPrompt: true, mfaRequestedAt: true, property: { select: { nickname: true, address: true } } },
    orderBy: { providerName: 'asc' },
  });
  const jobs = await db.syncJob.findMany({
    where: { utilityAccountId: { in: accounts.map(a => a.id) } }, orderBy: { createdAt: 'desc' }, distinct: ['utilityAccountId'],
    select: { utilityAccountId: true, status: true, progress: true, error: true, createdAt: true, startedAt: true, completedAt: true, statementsFound: true, costUsd: true },
  });
  const lastJob = new Map(jobs.map(j => [j.utilityAccountId, j]));
  // A run actually under way wins over a newer press still waiting behind it.
  const running = await db.syncJob.findMany({
    where: { utilityAccountId: { in: accounts.map(a => a.id) }, status: 'PENDING', startedAt: { not: null, gte: new Date(Date.now() - 15 * 60_000) } },
    orderBy: { startedAt: 'desc' }, distinct: ['utilityAccountId'],
    select: { utilityAccountId: true, status: true, progress: true, error: true, createdAt: true, startedAt: true, completedAt: true, statementsFound: true, costUsd: true },
  });
  for (const r of running) lastJob.set(r.utilityAccountId, r);
  const recipes = await db.portalRecipe.findMany({ select: { key: true, host: true, successes: true, failures: true, updatedAt: true } });
  const myHosts = new Set(accounts.map(a => { try { return new URL(websiteFor(a)?.url ?? '').hostname.split('.').slice(-2).join('.'); } catch { return ''; } }).filter(Boolean));
  const usage = await db.aiUsage.groupBy({ by: ['userId'], where: { feature: 'portal-agent', userId: req.dbUserId!, createdAt: { gte: monthStart() } }, _sum: { costUsd: true }, _count: { _all: true } });
  res.json({
    lookupFill: lookupFillState(req.dbUserId!),
    accounts: accounts.map(a => ({
      id: a.id, providerName: a.providerName, last4: a.accountNumber ? String(a.accountNumber).slice(-4) : null, propertyId: a.propertyId,
      hasCredentials: !!a.usernameEnc, lookupName: a.lookupName, lookupCustomerId: a.lookupCustomerId, website: (a.usernameEnc ? websiteFor(a)?.url : lookupStartFor(a)) ?? null,
      // What stands between this account and a fetch.
      needs: (() => {
        // A customer-ID lookup (Munis) needs no name; InvoiceCloud's does.
        if (!a.usernameEnc && a.lookupCustomerId) return null;
        if (!a.usernameEnc && isLookupAccount(a)) return /munisselfservice\.com/i.test(lookupStartFor(a) ?? '') ? 'name' : a.lookupName ? null : 'name';
        if (isLookupPage(websiteFor(a)?.url)) return a.lookupName ? null : 'name';
        if (!a.usernameEnc) return a.escrowLoanId ? 'escrow' : 'login';
        return null;
      })() as 'login' | 'name' | 'escrow' | null,
      place: a.property.nickname || a.property.address, lastSyncStatus: a.lastSyncStatus, lastSyncError: a.lastSyncError, lastAgentRunAt: a.lastAgentRunAt,
      syncEnabled: a.syncEnabled, mfaPrompt: a.mfaPrompt, mfaRequestedAt: a.mfaRequestedAt,
      run: (() => {
        const j = lastJob.get(a.id);
        if (!j) return null;
        // Pending with no start time: still in the queue. Not picked up in two minutes means no worker is running.
        let state = j.status === 'PENDING' ? (j.startedAt ? 'running' : 'queued') : j.status === 'SUCCESS' ? 'done' : 'failed';
        // A run lasts at most 8 minutes; one still "running" well past that was cut off (the worker restarted).
        const cutOff = state === 'running' && Date.now() - j.startedAt!.getTime() > 15 * 60_000;
        if (cutOff) state = 'failed';
        const stuck = state === 'queued' && Date.now() - j.createdAt.getTime() > 2 * 60_000;
        return { state, stuck, progress: cutOff ? null : j.progress, error: cutOff ? 'The run stopped without finishing (the background worker restarted). Press Fetch now to try again.' : j.error, createdAt: j.createdAt, startedAt: j.startedAt, completedAt: j.completedAt, statementsFound: j.statementsFound, costUsd: j.costUsd == null ? null : Number(j.costUsd) };
      })(),
      recipe: recipes.find(r => r.key === `acct:${a.id}`) ?? null,
    })),
    // Routes shared by provider, only for providers this account uses: the
    // list of every provider any customer has connected is not theirs to see.
    sharedRecipes: recipes.filter(r => r.key.startsWith('host:') && myHosts.has(r.host)),
    monthCalls: usage[0]?._count._all ?? 0, monthCost: Number(usage[0]?._sum.costUsd ?? 0),
    workers: await workerStatus(),
    queue: await queueSnapshot(req.dbUserId!),
  });
});

export default router;
