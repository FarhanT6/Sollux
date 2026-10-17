/**
 * The portal agent: logs into a provider's website that has no hand-written
 * scraper, finds the billing history, and downloads the statements Sollux
 * does not have yet — Claude driving a real browser through a small set of
 * tools.
 *
 * What the model never sees: the password or username (the fill_login tool
 * types them in the browser; page text is scrubbed of both), nor a
 * verification code (ask_owner_for_code pauses the run, the owner types the
 * code into Sollux, and type_code enters it). What it cannot do: leave the
 * portal's own sites, or submit anything but a login — there is no tool to
 * pay, change settings or send messages, and it is told to stop on
 * captchas.
 *
 * Downloaded statements go through the same filing as email and Drive
 * (documentIntake): filed on a confident match, staged for review otherwise.
 */
import Anthropic from '@anthropic-ai/sdk';
import { websiteFor } from '../lib/providerDirectory';
import * as fs from 'fs';
import { chromium, BrowserContext, Page, Download } from 'playwright';
import { db } from '../config/db';
import { decrypt, encrypt } from '../crypto/encrypt';
import { PRIMARY_MODEL, paramsFor, meteredCreate } from '../ai/models';
import { costOf, withAiContext } from '../ai/meter';
import { loadRecipe, saveRecipe, recipeWorked, replay, targetOf, type RecipeStep } from './portalRecipe';
import { intakeBill, type ReviewItem } from '../services/documentIntake';
import { BaseScraperProvider } from './base';

// A run that needs more than this is lost, not nearly done; each step resends
// the conversation (cached), so the last steps cost the most.
const MAX_STEPS = 20;
// A first visit (no saved route yet) has to find its way: sign-in, account
// picker, billing, statements. Prescott and Eternal Hills ran out at 20.
const MAX_STEPS_FIRST = 32;
// Stop a run that has cost this much, whatever it is doing (dollars).
const RUN_MAX_USD = Number(process.env.PORTAL_RUN_MAX_USD) || 0.75;
const MAX_DOWNLOADS = 6;
const RUN_MS = 8 * 60 * 1000;
const CODE_WAIT_MS = 5 * 60 * 1000;

export interface PortalRun {
  ok: boolean; filed: number; review: number; applied: number; downloads: number; summary: string; error?: string; jobId?: string | null;
  /** Claude turns this run took, what they cost, and how many recorded steps were replayed without Claude. */
  aiSteps?: number; costUsd?: number; replayed?: number;
}

const TOOLS: Anthropic.Tool[] = [
  { name: 'look', description: 'Describe the current page: URL, title, visible text, and numbered interactive elements [n]. Call after every action that changes the page.', input_schema: { type: 'object', properties: {} } },
  { name: 'screenshot', description: 'A picture of the page, when the text description is not enough.', input_schema: { type: 'object', properties: {} } },
  { name: 'click', description: 'Click element [n].', input_schema: { type: 'object', properties: { ref: { type: 'number' } }, required: ['ref'] } },
  { name: 'type', description: 'Type text into field [n] (not for passwords, usernames or codes).', input_schema: { type: 'object', properties: { ref: { type: 'number' }, text: { type: 'string' } }, required: ['ref', 'text'] } },
  { name: 'select', description: 'Choose an option in dropdown [n] by its visible label.', input_schema: { type: 'object', properties: { ref: { type: 'number' }, label: { type: 'string' } }, required: ['ref', 'label'] } },
  { name: 'fill_login', description: "Type the owner's username into field [usernameRef] and password into [passwordRef]. You never see them.", input_schema: { type: 'object', properties: { usernameRef: { type: 'number' }, passwordRef: { type: 'number' } }, required: ['passwordRef'] } },
  { name: 'press', description: 'Press a key (Enter, Tab, Escape).', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'goto', description: "Open a URL on the provider's own site.", input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'download_statement', description: 'Click element [n] that downloads or opens one statement PDF, and keep it. Give the statement date if shown.', input_schema: { type: 'object', properties: { ref: { type: 'number' }, statementDate: { type: 'string' } }, required: ['ref'] } },
  { name: 'ask_owner_for_code', description: 'The portal sent a verification code. Ask the owner for it (waits up to 5 minutes). Say where it was sent.', input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  { name: 'type_code', description: 'Type the code the owner gave into field [n].', input_schema: { type: 'object', properties: { ref: { type: 'number' } }, required: ['ref'] } },
  { name: 'finish', description: 'Stop. outcome: done (downloaded what was new, or nothing new), bad_login, captcha, no_code, blocked.', input_schema: { type: 'object', properties: { outcome: { type: 'string', enum: ['done', 'bad_login', 'captcha', 'no_code', 'blocked'] }, summary: { type: 'string' } }, required: ['outcome', 'summary'] } },
];

/** The site and its parent domain: example.com for www.example.com and billing.example.com. */
const rootOf = (host: string) => host.split('.').slice(-2).join('.');

/** Numbered interactive elements and visible text, with the login scrubbed out. */
export async function describe(page: Page, secrets: string[]): Promise<string> {
  const snap = await page.evaluate(() => {
    const out: string[] = [];
    let i = 0;
    document.querySelectorAll('[data-sref]').forEach(el => el.removeAttribute('data-sref'));
    const els = document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]');
    for (const el of Array.from(els)) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el as HTMLElement).visibility === 'hidden') continue;
      if (i >= 120) break;
      const n = ++i;
      el.setAttribute('data-sref', String(n));
      const tag = el.tagName.toLowerCase();
      const inp = el as HTMLInputElement;
      const label = (el.getAttribute('aria-label') || (inp.labels && inp.labels[0]?.innerText) || inp.placeholder || el.getAttribute('title') || (el as HTMLElement).innerText || inp.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      let d = `[${n}] ${tag}`;
      if (tag === 'input') d += ` type=${inp.type || 'text'}${inp.value ? ' (filled)' : ''}`;
      if (tag === 'a' && (el as HTMLAnchorElement).href) d += ` href=${(el as HTMLAnchorElement).href.slice(0, 120)}`;
      if (tag === 'select') d += ` options=${Array.from((el as HTMLSelectElement).options).slice(0, 15).map(o => o.text.trim()).join(' | ').slice(0, 200)}`;
      out.push(`${d} "${label}"`);
    }
    return { url: location.href, title: document.title, text: (document.body?.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 3000), els: out };
  });
  let text = `URL: ${snap.url}\nTitle: ${snap.title}\n\nVisible text:\n${snap.text}\n\nElements:\n${snap.els.join('\n')}`;
  for (const s of secrets) if (s && s.length >= 3) text = text.split(s).join('[hidden]');
  return text;
}

export async function capturePdf(ctx: BrowserContext, page: Page, action: () => Promise<void>): Promise<Buffer | null> {
  let got: Buffer | null = null;
  const onDownload = async (d: Download) => { try { const p = await d.path(); if (p) { const b = await fs.promises.readFile(p); if (b.subarray(0, 1024).includes('%PDF-')) got = b; } } catch { /* ignore */ } };
  const onResponse = async (r: import('playwright').Response) => {
    // A PDF opened in a tab reports its viewer's HTML as the body; keep only real PDF bytes.
    try { if (!got && (r.headers()['content-type'] ?? '').includes('application/pdf')) { const b = await r.body(); if (b.subarray(0, 1024).includes('%PDF-')) got = b; } } catch { /* ignore */ }
  };
  // A statement that opens in a new tab arrives as that tab's download.
  const onPage = (p: Page) => p.on('download', onDownload);
  page.on('download', onDownload);
  ctx.on('response', onResponse);
  ctx.on('page', onPage);
  const newPage = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  try {
    await action();
    const deadline = Date.now() + 20000;
    while (!got && Date.now() < deadline) {
      await page.waitForTimeout(500);
      const np = await Promise.race([newPage, new Promise<null>(r => setTimeout(() => r(null), 10))]);
      if (np && !got) {
        await np.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        const url = np.url();
        if (url && url.startsWith('http')) {
          const res = await ctx.request.get(url).catch(() => null);
          if (res && (res.headers()['content-type'] ?? '').includes('pdf')) { const b = Buffer.from(await res.body()); if (b.subarray(0, 1024).includes('%PDF-')) got = b; }
        }
        await np.close().catch(() => {});
      }
    }
  } finally {
    page.off('download', onDownload);
    ctx.off('response', onResponse);
    ctx.off('page', onPage);
  }
  const b = got as Buffer | null;
  return b && b.subarray(0, 1024).includes('%PDF-') ? b : null;
}

export interface AgentOptions {
  interactive?: boolean;
  /** Called with a short line on what the agent is doing, for a live status. */
  onProgress?: (text: string) => void;
}

export async function runPortalAgent(accountId: string, opts: AgentOptions = {}): Promise<PortalRun> {
  // The spend is the account owner's (ai/meter.ts).
  const owner = await db.utilityAccount.findUnique({ where: { id: accountId }, select: { property: { select: { userId: true } } } });
  return withAiContext({ userId: owner?.property.userId ?? null }, () => runAgent(accountId, opts));
}

async function runAgent(accountId: string, opts: AgentOptions): Promise<PortalRun> {
  const say = (t: string) => { try { opts.onProgress?.(t); } catch { /* status only */ } };
  const account = await db.utilityAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true, providerName: true, providerSlug: true, loginUrl: true, usernameEnc: true, passwordEnc: true, accountNumber: true,
      property: { select: { userId: true, address: true } },
      statements: { where: { pdfS3Key: { not: null } }, orderBy: { statementDate: 'desc' }, take: 1, select: { statementDate: true } },
    },
  });
  if (!account) return { ok: false, filed: 0, review: 0, applied: 0, downloads: 0, summary: '', error: 'Account not found' };
  // The login page: the one the owner saved (or a bill printed), else the
  // provider directory's; the agent finds "Sign in" from a home page.
  const loginUrl = websiteFor(account)?.url ?? null;
  if (!loginUrl || !account.usernameEnc || !account.passwordEnc) {
    return { ok: false, filed: 0, review: 0, applied: 0, downloads: 0, summary: '', error: !loginUrl ? 'Add the provider\'s website (Website on the account) so the agent knows where to sign in.' : 'Add your portal username and password (Edit on the account) so Sollux can fetch statements.' };
  }
  const username = decrypt(account.usernameEnc), password = decrypt(account.passwordEnc);
  const start = new URL(loginUrl);
  const allowed = new Set([rootOf(start.hostname)]);
  const userId = account.property.userId;
  const since = account.statements[0]?.statementDate?.toISOString().slice(0, 10) ?? null;
  const batchId = `portal-${account.id}-${Date.now()}`;
  const review: ReviewItem[] = [];
  const run: PortalRun = { ok: false, filed: 0, review: 0, applied: 0, downloads: 0, summary: '', aiSteps: 0, costUsd: 0, replayed: 0 };

  const profileDir = BaseScraperProvider.profileDir(`agent-${account.id}`);
  await fs.promises.mkdir(profileDir, { recursive: true });
  // The browser a person would use; the session is kept so a trusted device stays trusted.
  const ctx = await chromium.launchPersistentContext(profileDir, {
    // --disable-http2: some portals (Mohela) reset HTTP/2 from automated browsers (ERR_HTTP2_PROTOCOL_ERROR).
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-http2'],
    viewport: { width: 1366, height: 900 }, locale: 'en-US', timezoneId: 'America/Los_Angeles', acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const secrets = [password, username];
  const deadline = Date.now() + RUN_MS;
  let code: string | null = null;

  const system = `You operate a web browser for a property owner to collect utility statements from ${account.providerName}'s customer portal. Account ${account.accountNumber ? `ending ${String(account.accountNumber).slice(-4)}` : ''} at ${account.property.address}.
Goal: log in, open the billing / statement history, and download each statement PDF dated after ${since ?? 'the last 12 months'} — newest first, at most ${MAX_DOWNLOADS}. If there is nothing newer, finish with outcome done.
Rules: use fill_login for credentials (you never see them); if the portal sends a verification code, call ask_owner_for_code, then type_code. Never pay, enroll, change settings, accept offers or send messages. If a captcha appears, finish with captcha. If the login is rejected, finish with bad_login. Call look after each action. When several accounts are listed, choose the one matching the account number or address. Be efficient.`;
  // Every step that changed the page, in order: replayed ones and Claude's.
  // The ones before the first download become the recipe for next time.
  const steps: RecipeStep[] = [];
  let navDone = false;
  const host = rootOf(start.hostname);
  const recipe = await loadRecipe(account.id, host);

  try {
    say(`Opening ${start.hostname}`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    let opening = "Start. The browser is open on the provider's login page (or its home page — find Sign in from there).";
    if (recipe) {
      say(`Replaying the saved route (${recipe.steps.length} steps, no AI)`);
      const done = await replay(page, recipe.steps, { username, password }, h => allowed.has(rootOf(h)));
      run.replayed = done;
      steps.push(...recipe.steps.slice(0, done));
      try { const h = new URL(page.url()).hostname; if (h) allowed.add(rootOf(h)); } catch { /* about:blank */ }
      if (done === recipe.steps.length) {
        opening = "Start. A previous run's steps were replayed: the browser should be signed in and on the page with the statement history. Look, then download what is new — or finish if nothing is.";
      } else {
        await recipeWorked(recipe.key, false);
        opening = `Start. A previous run's steps were replayed but the site has changed at step ${done + 1} of ${recipe.steps.length}; the browser is wherever that left it (possibly the login page). Look, and carry on to the statements.`;
      }
    }
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opening }];
    const stepLimit = recipe && run.replayed === recipe.steps.length ? MAX_STEPS : MAX_STEPS_FIRST;
    for (let step = 0; step < stepLimit && Date.now() < deadline; step++) {
      if ((run.costUsd ?? 0) >= RUN_MAX_USD) { run.error = `Stopped after spending $${(run.costUsd ?? 0).toFixed(2)} without finishing — the portal needs a look.`; break; }
      // Cached: each step resends the run so far, and reads it back at a tenth of the price.
      const res = await meteredCreate(client, 'portal-agent', { ...paramsFor(PRIMARY_MODEL, { maxTokens: 1500, system, messages, cache: true }), tools: TOOLS });
      run.aiSteps = (run.aiSteps ?? 0) + 1;
      run.costUsd = (run.costUsd ?? 0) + costOf(PRIMARY_MODEL, res.usage);
      const uses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
      messages.push({ role: 'assistant', content: res.content });
      if (!uses.length) { run.summary = res.content.map(c => (c.type === 'text' ? c.text : '')).join('').slice(0, 500); break; }
      const results: Anthropic.ToolResultBlockParam[] = [];
      let finished = false;
      for (const u of uses) {
        const i = u.input as any;
        const el = (ref: number) => page.locator(`[data-sref="${Number(ref)}"]`).first();
        let content: Anthropic.ToolResultBlockParam['content'] = 'ok';
        let rec: RecipeStep | null = null;
        if (u.name === 'download_statement' || u.name === 'finish') navDone = true;
        const n = `Step ${step + 1}`;
        if (u.name === 'look') say(`${n}: reading the page${await page.title().then(t => (t ? ` "${t.slice(0, 60)}"` : '')).catch(() => '')}`);
        else if (u.name === 'click') say(`${n}: clicking${await targetOf(page, i.ref).then(t => (t?.label ? ` "${t.label.slice(0, 50)}"` : '')).catch(() => '')}`);
        else if (u.name === 'fill_login') say(`${n}: signing in`);
        else if (u.name === 'download_statement') say(`${n}: downloading a statement${i.statementDate ? ` (${String(i.statementDate).slice(0, 20)})` : ''}`);
        else if (u.name === 'goto') say(`${n}: opening ${String(i.url).replace(/^https?:\/\//, '').slice(0, 60)}`);
        else if (u.name === 'type_code') say(`${n}: entering your code`);
        try {
          if (!navDone) {
            if (u.name === 'click' || u.name === 'type' || u.name === 'select') {
              const target = await targetOf(page, i.ref);
              if (target) rec = u.name === 'click' ? { tool: 'click', target } : u.name === 'type' ? { tool: 'type', target, text: String(i.text ?? '') } : { tool: 'select', target, label: String(i.label) };
            } else if (u.name === 'fill_login') {
              const pass = await targetOf(page, i.passwordRef);
              const user = i.usernameRef != null ? await targetOf(page, i.usernameRef) : null;
              if (pass) rec = { tool: 'fill_login', pass, ...(user ? { user } : {}) };
            } else if (u.name === 'press') rec = { tool: 'press', key: String(i.key) };
          }
          switch (u.name) {
            case 'look': content = await describe(page, secrets); break;
            case 'screenshot': content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: (await page.screenshot({ type: 'png' })).toString('base64') } }]; break;
            case 'click': await el(i.ref).click({ timeout: 10000 }); await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); break;
            case 'type': await el(i.ref).fill(String(i.text ?? '')); break;
            case 'select': await el(i.ref).selectOption({ label: String(i.label) }); break;
            case 'fill_login':
              if (i.usernameRef != null) await el(i.usernameRef).fill(username);
              await el(i.passwordRef).fill(password);
              content = 'Username and password entered.'; break;
            case 'press': await page.keyboard.press(String(i.key)); await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); break;
            case 'goto': {
              const url = new URL(String(i.url), page.url());
              if (url.protocol !== 'https:' || !allowed.has(rootOf(url.hostname))) { content = 'Refused: only the provider\'s own site.'; break; }
              await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
              if (!navDone) rec = { tool: 'goto', url: url.toString() };
              break;
            }
            case 'download_statement': {
              if (run.downloads >= MAX_DOWNLOADS) { content = `Limit of ${MAX_DOWNLOADS} reached — finish.`; break; }
              const pdf = await capturePdf(ctx, page, () => el(i.ref).click({ timeout: 10000 }));
              if (!pdf) { content = 'No PDF came back from that click. Try the link that opens or downloads the statement itself.'; break; }
              run.downloads++;
              const name = `${account.providerName.replace(/[^\w]+/g, '_')}_${String(i.statementDate ?? run.downloads).replace(/[^\w-]+/g, '_')}.pdf`;
              const r = await intakeBill(pdf, name, userId, 'ai', batchId, 'portal');
              if (r.outcome === 'filed') run.filed++;
              else if (r.outcome === 'review') { run.review++; review.push(r.reviewItem); }
              else if (r.outcome === 'error') content = `Saved, but: ${r.error}`;
              else run.applied++;
              if (content === 'ok') content = `Statement saved (${r.outcome}).`;
              break;
            }
            case 'ask_owner_for_code': {
              // A scheduled run has nobody watching; only a Sync the owner pressed waits for a code.
              if (!opts.interactive) { content = 'The owner is not here to give a code on a scheduled run — finish with no_code.'; break; }
              say(`Waiting for your verification code: ${String(i.prompt).slice(0, 160)}`);
              await db.utilityAccount.update({ where: { id: account.id }, data: { mfaPrompt: String(i.prompt).slice(0, 300), mfaRequestedAt: new Date(), mfaCodeEnc: null } });
              const until = Date.now() + CODE_WAIT_MS;
              while (Date.now() < until && !code) {
                await new Promise(r => setTimeout(r, 4000));
                const a = await db.utilityAccount.findUnique({ where: { id: account.id }, select: { mfaCodeEnc: true } });
                if (a?.mfaCodeEnc) code = decrypt(a.mfaCodeEnc);
              }
              await db.utilityAccount.update({ where: { id: account.id }, data: { mfaPrompt: null, mfaRequestedAt: null, mfaCodeEnc: null } });
              content = code ? 'The owner gave the code. Use type_code.' : 'No code within 5 minutes — finish with no_code.';
              if (code) secrets.push(code);
              break;
            }
            case 'type_code': if (!code) { content = 'No code yet.'; break; } await el(i.ref).fill(code); content = 'Code entered.'; break;
            case 'finish':
              finished = true;
              run.ok = i.outcome === 'done';
              run.summary = String(i.summary ?? '').slice(0, 500);
              if (!run.ok) run.error = { bad_login: 'The portal rejected the username or password.', captcha: 'The portal showed a captcha the agent cannot solve — sync this one by email or upload.', no_code: opts.interactive ? 'The portal asked for a verification code and none was entered in time.' : 'The portal asks for a verification code — press Sync on this account and enter the code when Sollux asks.', blocked: 'The agent could not get to the statements.' }[String(i.outcome)] + (run.summary ? ` ${run.summary}` : '');
              break;
            default: content = 'Unknown tool.';
          }
          if (rec) steps.push(rec);
        } catch (err) {
          content = `Failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
        }
        // A site the portal itself sent the browser to (its sign-in or billing
        // domain) becomes one the agent may open again.
        try { const h = new URL(page.url()).hostname; if (h) allowed.add(rootOf(h)); } catch { /* about:blank */ }
        results.push({ type: 'tool_result', tool_use_id: u.id, content });
      }
      messages.push({ role: 'user', content: results });
      if (finished) break;
      // The history is only ever appended to: editing an earlier turn would
      // throw away the cache for everything after it and cost more than it saves.
    }
    if (!run.summary && !run.error) run.error = 'The agent ran out of steps before finishing.';
    if (!run.error) run.ok = true;
    // Reached the statements: keep the way there for next time.
    if (run.ok && navDone) {
      if (recipe && run.replayed === recipe.steps.length) await recipeWorked(recipe.key, true);
      else await saveRecipe(account.id, host, steps);
    }
  } catch (err) {
    run.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
  } finally {
    await ctx.close().catch(() => {});
    await db.utilityAccount.update({ where: { id: account.id }, data: { lastAgentRunAt: new Date(), mfaPrompt: null, mfaRequestedAt: null, mfaCodeEnc: null } }).catch(() => {});
  }

  if (review.length || run.filed) {
    const job = await db.driveImportJob.create({
      data: { userId, source: 'portal', folderName: `Portal · ${account.providerName}`, status: run.error ? 'PARTIAL' : 'SUCCESS', totalFiles: run.downloads, processedFiles: run.downloads, autoImported: run.filed, needsReviewJson: review as any, errorLog: run.error ?? null, finishedAt: new Date() },
    });
    run.jobId = job.id;
  }
  return run;
}

/** Store the code the owner typed, for the running agent to pick up. */
export async function submitPortalCode(accountId: string, code: string): Promise<void> {
  await db.utilityAccount.update({ where: { id: accountId }, data: { mfaCodeEnc: encrypt(code.trim()) } });
}
