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
import { BrowserContext, Page, Download, Frame, Locator } from 'playwright';
import { launchPortalContext, isHttp2Reset } from './browser';
import { chromium, type Browser } from 'playwright';
import { connectorFor } from '../services/connector';
import { db } from '../config/db';
import { decrypt, encrypt } from '../crypto/encrypt';
import { PRIMARY_MODEL, paramsFor, meteredCreate } from '../ai/models';
import { costOf, withAiContext } from '../ai/meter';
import { findEmailedCode, findEmailedLink, mailMiss, type MailReport } from '../services/emailCode';
import { loadRecipe, saveRecipe, recipeWorked, replay, targetOf, refLocator, setRefFrames, type RecipeStep } from './portalRecipe';
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

// Bot-protection cookies (Akamai, Imperva, PerimeterX, DataDome, Cloudflare):
// the site's score for this browser, not a sign-in. Once a site marks one as a
// bot it turns away every visit that sends it back — T-Mobile went from asking
// for a code to "Invalid request, access denied" on every run after its cookies
// were kept — so they are never kept between runs. Sign-in and trusted-device
// cookies are.
const BOT_COOKIE = /^(_abck|bm_[a-z]+|ak_bmsc|_px[a-z0-9_]*|incap_ses_\w*|visid_incap_\w*|nlbi_\w*|reese84|datadome|__cf_bm|cf_clearance)$/i;
// What a site says when it refuses the browser itself, whatever the password.
const TURNED_AWAY = /access denied|invalid request|unable to process your request|request (was )?(rejected|blocked)|pardon our interruption|unusual (activity|traffic)|are you a robot|bot protection|akamai/i;
// Sites that turned the browser away, and when a scheduled fetch may try them
// again. Retrying a site that is refusing only makes it more suspicious and can
// lock the login: SDG&E was sent twelve sign-ins in five minutes.
const turnedAway = new Map<string, number>();
const TURNED_AWAY_MS = 6 * 3600_000;
const clock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });

export interface PortalRun {
  ok: boolean; filed: number; review: number; applied: number; downloads: number; summary: string; error?: string; jobId?: string | null;
  /** Claude turns this run took, what they cost, and how many recorded steps were replayed without Claude. */
  aiSteps?: number; costUsd?: number; replayed?: number;
}

const TOOLS: Anthropic.Tool[] = [
  { name: 'look', description: 'Describe the current page: URL, title, visible text, and numbered interactive elements [n]. Every other action already returns the page as it is afterwards, so only call this at the start or if a page was still loading.', input_schema: { type: 'object', properties: {} } },
  { name: 'screenshot', description: 'A picture of the page, when the text description is not enough.', input_schema: { type: 'object', properties: {} } },
  { name: 'click', description: 'Click element [n].', input_schema: { type: 'object', properties: { ref: { type: 'number' } }, required: ['ref'] } },
  { name: 'type', description: 'Type text into field [n] (not for passwords, usernames or codes). submit: press Enter afterwards.', input_schema: { type: 'object', properties: { ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] } },
  { name: 'select', description: 'Choose an option in dropdown [n] by its visible label.', input_schema: { type: 'object', properties: { ref: { type: 'number' }, label: { type: 'string' } }, required: ['ref', 'label'] } },
  { name: 'fill_login', description: "Type the owner's username into [usernameRef] and password into [passwordRef] (you never see them), tick [rememberRef] if given, then click [submitRef]. A site that asks for the username first: give only usernameRef and submitRef, then call again with passwordRef on the next page.", input_schema: { type: 'object', properties: { usernameRef: { type: 'number' }, passwordRef: { type: 'number' }, rememberRef: { type: 'number' }, submitRef: { type: 'number' } } } },
  { name: 'press', description: 'Press a key (Enter, Tab, Escape).', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'goto', description: "Open a URL on the provider's own site.", input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'download_statement', description: 'Click element [n] that downloads or opens one statement PDF, and keep it. Give the statement date if shown.', input_schema: { type: 'object', properties: { ref: { type: 'number' }, statementDate: { type: 'string' } }, required: ['ref'] } },
  { name: 'ask_owner_for_code', description: "The portal sent a verification code. Reads it from the owner's email (up to 2 minutes), else asks the owner (up to 5 more). Say where it was sent.", input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  { name: 'open_emailed_link', description: 'The portal emailed a link that signs you in, instead of a code ("magic link", "Access your account", "check your email to log in"). Finds that link in the owner\'s email (up to 2 minutes) and opens it in this browser; returns the page afterwards.', input_schema: { type: 'object', properties: {} } },
  { name: 'type_code', description: 'Type the verification code into field [ref] (a code split into one-digit boxes: give the first box), tick [rememberRef] ("remember this device") if given, then click [submitRef].', input_schema: { type: 'object', properties: { ref: { type: 'number' }, rememberRef: { type: 'number' }, submitRef: { type: 'number' } }, required: ['ref'] } },
  { name: 'finish', description: 'Stop. outcome: done (downloaded what was new, or nothing new), bad_login (the portal said the username or password is wrong), captcha, no_code, turned_away (the site refused the browser itself: Access Denied, "invalid request", "unable to process your request" after a sign-in, a bot check), blocked (anything else in the way).', input_schema: { type: 'object', properties: { outcome: { type: 'string', enum: ['done', 'bad_login', 'captcha', 'no_code', 'turned_away', 'blocked'] }, summary: { type: 'string' } }, required: ['outcome', 'summary'] } },
];

/** The site and its parent domain: example.com for www.example.com and billing.example.com. */
const rootOf = (host: string) => host.split('.').slice(-2).join('.');

/** Numbered interactive elements and visible text, with the login scrubbed out. */
export async function describe(page: Page, secrets: string[]): Promise<string> {
  // Every visible frame (sign-in forms often live in an embedded one), each
  // read including the inside of web components (shadow DOM) — a page search
  // that stops at either finds no login fields on sites like T-Mobile's.
  const refs = new Map<number, Frame>();
  const parts: { url: string; title: string; text: string; els: string[]; inFrame: boolean }[] = [];
  let next = 0;
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    const inFrame = frame !== page.mainFrame();
    if (inFrame) {
      const box = await frame.frameElement().then(e => e.boundingBox()).catch(() => null);
      if (!box || box.width < 40 || box.height < 20) continue; // trackers and hidden helpers
    }
    const snap = await frame.evaluate(({ start, limit }) => {
      // No named helper functions in here: the page runs this as plain source.
      const roots: (Document | ShadowRoot)[] = [document];
      for (let k = 0; k < roots.length; k++) {
        roots[k].querySelectorAll('[data-sref]').forEach(el => el.removeAttribute('data-sref'));
        for (const el of Array.from(roots[k].querySelectorAll('*'))) if (el.shadowRoot) roots.push(el.shadowRoot);
      }
      const out: string[] = [];
      const shadowText: string[] = [];
      let i = start;
      const sel = 'a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[onclick]';
      for (const root of roots) {
        if (root !== document) for (const c of Array.from(root.children)) { const t = (c as HTMLElement).innerText; if (t) shadowText.push(t); }
        for (const el of Array.from(root.querySelectorAll(sel))) {
          if (i - start >= limit) break;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || getComputedStyle(el as HTMLElement).visibility === 'hidden') continue;
          const n = ++i;
          el.setAttribute('data-sref', String(n));
          const tag = el.tagName.toLowerCase();
          const inp = el as HTMLInputElement;
          const label = (el.getAttribute('aria-label') || (inp.labels && inp.labels[0]?.innerText) || inp.placeholder || el.getAttribute('title') || (el as HTMLElement).innerText || inp.name || el.id || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          let d = `[${n}] ${tag}`;
          if (tag === 'input') d += ` type=${inp.type || 'text'}${inp.type === 'checkbox' ? (inp.checked ? ' (checked)' : ' (unchecked)') : inp.value ? ' (filled)' : ''}`;
          if (tag === 'a' && (el as HTMLAnchorElement).href) d += ` href=${(el as HTMLAnchorElement).href.slice(0, 120)}`;
          if (tag === 'select') d += ` options=${Array.from((el as HTMLSelectElement).options).slice(0, 15).map(o => o.text.trim()).join(' | ').slice(0, 200)}`;
          out.push(`${d} "${label}"`);
        }
      }
      const text = [(document.body?.innerText || ''), ...shadowText].join('\n').replace(/\n{2,}/g, '\n').slice(0, 2000);
      return { url: location.href, title: document.title, text, els: out, next: i };
    }, { start: next, limit: Math.max(0, 90 - next) }).catch(() => null);
    if (!snap) continue;
    for (let n = next + 1; n <= snap.next; n++) refs.set(n, frame);
    next = snap.next;
    parts.push({ url: snap.url, title: snap.title, text: snap.text, els: snap.els, inFrame });
  }
  setRefFrames(page, refs);
  const main = parts[0] ?? { url: page.url(), title: '', text: '', els: [], inFrame: false };
  const framed = parts.slice(1).filter(f => f.els.length || f.text.trim());
  let text = `URL: ${main.url}\nTitle: ${main.title}\n\nVisible text:\n${main.text}\n\nElements:\n${main.els.join('\n')}`;
  for (const f of framed) text += `\n\nEmbedded frame (${f.url.slice(0, 100)}):\n${f.text.slice(0, 600)}\nElements in it:\n${f.els.join('\n')}`;
  for (const s of secrets) if (s && s.length >= 3) text = text.split(s).join('[hidden]');
  return text;
}

/**
 * Type a code into its field — or across one-digit boxes (IID splits its
 * six-digit code into six), one digit per box, since filling the first box
 * with the whole code leaves the rest empty.
 */
export async function fillCode(first: Locator, code: string): Promise<void> {
  const boxes = await first.evaluate((el) => {
    const inp = el as HTMLInputElement;
    if (inp.maxLength !== 1) return 0;
    const root = el.getRootNode() as Document | ShadowRoot;
    const all = Array.from(root.querySelectorAll('input')).filter(b => b.maxLength === 1 && b.getBoundingClientRect().width > 0);
    const from = all.indexOf(inp);
    all.slice(from).forEach((b, k) => b.setAttribute('data-sbox', String(k)));
    return all.length - from;
  }).catch(() => 0);
  if (boxes < 2) { await first.fill(code); return; }
  // Focus each box in its own document or shadow root, then type the digit as
  // a keypress (split-box widgets listen for keys and move focus themselves).
  for (let k = 0; k < Math.min(boxes, code.length); k++) {
    await first.evaluate((el, n) => {
      const box = (el.getRootNode() as Document | ShadowRoot).querySelector(`[data-sbox="${n}"]`) as HTMLInputElement | null;
      if (box) { box.value = ''; box.focus(); }
    }, k);
    await first.page().keyboard.type(code[k]);
  }
}

export async function capturePdf(ctx: BrowserContext, page: Page, action: () => Promise<void>): Promise<Buffer | null> {
  let got: Buffer | null = null;
  const onDownload = async (d: Download) => {
    try { const p = await d.path(); if (p) { const b = await fs.promises.readFile(p); if (b.subarray(0, 1024).includes('%PDF-')) got = b; } } catch { /* ignore */ }
    // A browser on the owner's computer saves downloads there, out of reach:
    // fetch the same address from inside the page (its cookies, its internet).
    if (!got) {
      const b64 = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: 'include' });
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...Array.from(bytes.subarray(k, k + 0x8000)));
        return btoa(bin);
      }, d.url()).catch(() => null);
      const b = b64 ? Buffer.from(b64, 'base64') : null;
      if (b && b.subarray(0, 1024).includes('%PDF-')) got = b;
    }
  };
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
  /** True once the owner pressed Cancel: the run stops at once and closes its browser. */
  cancelled?: () => Promise<boolean>;
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
  const host = rootOf(start.hostname);
  // The owner's own computer, when its connector is online: a real Chrome on
  // home internet, which sites that refuse cloud servers let in.
  const connector = await connectorFor(userId);
  const awayUntil = turnedAway.get(host) ?? 0;
  if (!connector && !opts.interactive && awayUntil > Date.now()) {
    return { ok: false, filed: 0, review: 0, applied: 0, downloads: 0, summary: '', error: `Not tried: ${start.hostname} turned the browser away earlier, so scheduled fetches wait until ${clock(awayUntil)} rather than risk locking the login. Fetch now tries it at once.` };
  }
  const since = account.statements[0]?.statementDate?.toISOString().slice(0, 10) ?? null;
  const batchId = `portal-${account.id}-${Date.now()}`;
  const review: ReviewItem[] = [];
  const run: PortalRun = { ok: false, filed: 0, review: 0, applied: 0, downloads: 0, summary: '', aiSteps: 0, costUsd: 0, replayed: 0 };

  const profileDir = BaseScraperProvider.profileDir(`agent-${account.id}`);
  await fs.promises.mkdir(profileDir, { recursive: true });
  // The browser a person would use; the session is kept so a trusted device stays trusted.
  // The browser's memory from the last good run ("remember this device"):
  // the worker's disk is wiped on every deploy, so it is kept in the database.
  const saved = await db.portalSession.findUnique({ where: { utilityAccountId: account.id } }).catch(() => null);
  // A browser that looks like the Chrome it is (scrapers/browser.ts), with the
  // saved cookies restored. The agent reads pages as text: images, video and
  // fonts only cost memory (a 512MB worker ran out with Chrome on a heavy portal).
  let remote: Browser | null = null;
  const prepare = async (http1 = false) => {
    let c: BrowserContext | null = null;
    if (connector && !http1) {
      try {
        remote = await chromium.connectOverCDP(connector.wsUrl, { timeout: 30_000 });
        c = await remote.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 900 }, locale: 'en-US' });
      } catch (err) {
        console.warn('[PortalAgent] connector browser unavailable, using the cloud one:', err instanceof Error ? err.message.split('\n')[0] : err);
        await remote?.close().catch(() => {}); remote = null;
      }
    }
    if (!c) c = await launchPortalContext(profileDir, { http1 });
    // A fresh bot score every run: none from the profile on disk, none from the database.
    await c.clearCookies({ name: BOT_COOKIE }).catch(() => {});
    if (saved) {
      try { await c.addCookies((JSON.parse(decrypt(saved.stateEnc)).cookies ?? []).filter((k: { name: string }) => !BOT_COOKIE.test(k.name))); }
      catch (err) { console.warn('[PortalAgent] saved session not restored:', err instanceof Error ? err.message.split('\n')[0] : err); }
    }
    await c.route('**/*', r => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue())).catch(() => {});
    return c;
  };
  let ctx = await prepare();
  let page = ctx.pages()[0] ?? await ctx.newPage();
  // Cancel: checked every few seconds; closing the browser ends whatever it
  // is waiting on (a page load, a click), and every loop below stops on it.
  let cancelled = false;
  const watch = opts.cancelled ? setInterval(() => {
    void opts.cancelled!().then(c => { if (c && !cancelled) { cancelled = true; void ctx.close().catch(() => {}); } }).catch(() => {});
  }, 3000) : null;
  // A portal that resets HTTP/2 from automated browsers (Mohela) is opened again without it.
  const openStart = async () => {
    try { return await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
    catch (err) {
      if (!isHttp2Reset(err)) throw err;
      console.log(`[PortalAgent] ${start.hostname} reset HTTP/2 — opening it again without`);
      await ctx.close().catch(() => {});
      ctx = await prepare(true);
      page = ctx.pages()[0] ?? await ctx.newPage();
      return page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
  };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const secrets = [password, username];
  const deadline = Date.now() + RUN_MS;
  let code: string | null = null;
  // A code was entered this run: the device may now be trusted, so keep the browser's memory.
  let usedCode = false;
  // Codes already typed: a second request must bring a new one.
  const triedCodes = new Set<string>();
  let triedLinks = 0;
  // Why the last email search came up empty, for the error the owner sees.
  let mailNote = '';
  const runStartedAt = Date.now();
  // After an action: let the page settle, then show it as it is now (saves a look step).
  const after = async (what: string) => {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    return `${what}\n\n${await describe(page, secrets)}`;
  };

  const system = `You operate a web browser for a property owner to collect utility statements from ${account.providerName}'s customer portal. Account ${account.accountNumber ? `ending ${String(account.accountNumber).slice(-4)}` : ''} at ${account.property.address}.
Goal: log in, open the billing / statement history, and download each statement PDF dated after ${since ?? 'the last 12 months'} — newest first, at most ${MAX_DOWNLOADS}. If there is nothing newer, finish with outcome done.
Rules: use fill_login for credentials (you never see them). If the portal offers where to send a verification code, choose email over text or a phone call. If it emails a sign-in link instead of a code, call open_emailed_link (the owner is never asked for it); if none arrives, finish with no_code. When a code has been sent, call ask_owner_for_code (it reads the code from the owner's email, or asks the owner), then type_code. Pass any "Remember this device", "Trust this browser", "Keep me signed in" or "Don't ask again" checkbox as rememberRef so the next visit is not asked again. Never pay, enroll, change settings, accept offers or send messages. If a captcha appears, finish with captcha. If the login is rejected, finish with bad_login. If a code you entered is rejected, ask_owner_for_code once more for a fresh one; after a second rejection finish with no_code — never start the login over.
If the site refuses the browser itself (Access Denied, "invalid request", "unable to process your request" after a correct sign-in, a bot check), finish with turned_away at once: never submit the login a second time — each retry makes the site more suspicious and can lock the owner's account.
Each action returns the page as it is afterwards: do not call look after it. Fill and submit in one step (submitRef). A typical visit is: look, fill_login (with submit), code if asked, open billing/statements, download, finish — aim for about 10 steps. When several accounts are listed, choose the one matching the account number, else the address. The account number is what identifies the account: the address a portal shows is often the owner's mailing address, not the property's, so an account whose number matches is the right one whatever address it shows.`;
  // Every step that changed the page, in order: replayed ones and Claude's.
  // The ones before the first download become the recipe for next time.
  const steps: RecipeStep[] = [];
  let navDone = false;
  const recipe = await loadRecipe(account.id, host);

  try {
    say(remote ? `Opening ${start.hostname} on ${connector!.name}` : `Opening ${start.hostname}`);
    const res = await openStart();
    // Refused before any sign-in (Safeco's and Nelnet's Access Denied): nothing for Claude to do.
    const title = await page.title().catch(() => '');
    if (res?.status() === 403 || /access denied|forbidden|attention required/i.test(title)) {
      throw Object.assign(new Error(`${start.hostname} answered ${res?.status() ?? ''} "${title || 'Access Denied'}" before any sign-in.`), { turnedAway: true });
    }
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
    for (let step = 0; step < stepLimit && Date.now() < deadline && !cancelled; step++) {
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
        // The element numbered [ref] by the last look, in whichever frame it is in.
        const el = (ref: number) => refLocator(page, ref);
        let content: Anthropic.ToolResultBlockParam['content'] = 'ok';
        let rec: RecipeStep | null = null;
        let recAfter: RecipeStep | null = null; // the submit click that fill_login made
        if (u.name === 'download_statement' || u.name === 'finish') navDone = true;
        const n = `Step ${step + 1}`;
        if (u.name === 'look') say(`${n}: reading the page${await page.title().then(t => (t ? ` "${t.slice(0, 60)}"` : '')).catch(() => '')}`);
        else if (u.name === 'click') say(`${n}: clicking${await targetOf(page, i.ref).then(t => (t?.label ? ` "${t.label.slice(0, 50)}"` : '')).catch(() => '')}`);
        else if (u.name === 'fill_login') say(`${n}: signing in`);
        else if (u.name === 'download_statement') say(`${n}: downloading a statement${i.statementDate ? ` (${String(i.statementDate).slice(0, 20)})` : ''}`);
        else if (u.name === 'goto') say(`${n}: opening ${String(i.url).replace(/^https?:\/\//, '').slice(0, 60)}`);
        else if (u.name === 'type_code') say(`${n}: entering the verification code`);
        else if (u.name === 'type') say(`${n}: typing`);
        else if (u.name === 'select') say(`${n}: choosing "${String(i.label).slice(0, 40)}"`);
        else if (u.name === 'ask_owner_for_code') say(`${n}: the portal sent a verification code`);
        else if (u.name === 'open_emailed_link') say(`${n}: the portal emailed a sign-in link — looking for it in your email`);
        try {
          if (!navDone) {
            if (u.name === 'click' || u.name === 'type' || u.name === 'select') {
              const target = await targetOf(page, i.ref);
              if (target) rec = u.name === 'click' ? { tool: 'click', target } : u.name === 'type' ? { tool: 'type', target, text: String(i.text ?? '') } : { tool: 'select', target, label: String(i.label) };
            } else if (u.name === 'fill_login') {
              const pass = i.passwordRef != null ? await targetOf(page, i.passwordRef) : null;
              const user = i.usernameRef != null ? await targetOf(page, i.usernameRef) : null;
              if (pass || user) rec = { tool: 'fill_login', ...(pass ? { pass } : {}), ...(user ? { user } : {}) } as RecipeStep;
              const submit = i.submitRef != null ? await targetOf(page, i.submitRef) : null;
              if (submit) recAfter = { tool: 'click', target: submit };
            } else if (u.name === 'press') rec = { tool: 'press', key: String(i.key) };
          }
          switch (u.name) {
            case 'look': content = await describe(page, secrets); break;
            case 'screenshot': content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: (await page.screenshot({ type: 'png' })).toString('base64') } }]; break;
            case 'click': await el(i.ref).click({ timeout: 10000 }); content = await after('Clicked.'); break;
            case 'type':
              await el(i.ref).fill(String(i.text ?? ''));
              if (i.submit) await el(i.ref).press('Enter');
              content = await after(i.submit ? 'Typed and submitted.' : 'Typed.'); break;
            case 'select': await el(i.ref).selectOption({ label: String(i.label) }); content = await after('Selected.'); break;
            case 'fill_login': {
              if (i.usernameRef == null && i.passwordRef == null) { content = 'Give usernameRef and/or passwordRef.'; break; }
              if (i.usernameRef != null) await el(i.usernameRef).fill(username);
              if (i.passwordRef != null) await el(i.passwordRef).fill(password);
              if (i.rememberRef != null) await el(i.rememberRef).check({ timeout: 3000 }).catch(() => el(i.rememberRef).click({ timeout: 3000 }).catch(() => {}));
              if (i.submitRef != null) await el(i.submitRef).click({ timeout: 10000 });
              content = await after(i.submitRef != null ? 'Signed in details entered and submitted.' : 'Entered.'); break;
            }
            case 'press': await page.keyboard.press(String(i.key)); content = await after(`Pressed ${i.key}.`); break;
            case 'goto': {
              const url = new URL(String(i.url), page.url());
              if (url.protocol !== 'https:' || !allowed.has(rootOf(url.hostname))) { content = 'Refused: only the provider\'s own site.'; break; }
              await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
              if (!navDone) rec = { tool: 'goto', url: url.toString() };
              content = await after('Opened.');
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
              if (triedCodes.size >= 2) { content = 'Two codes have been rejected — finish with no_code.'; break; }
              const mailHost = new URL(page.url()).hostname || start.hostname;
              const since = new Date(runStartedAt - 30_000);
              const report: MailReport = { inboxes: [], errors: [], fromPortal: 0 };
              // A Fetch the owner pressed shows the code box at once: the code is
              // taken from the email or from the owner, whichever comes first, so
              // nobody waits on an email search that cannot find it.
              if (opts.interactive) await db.utilityAccount.update({ where: { id: account.id }, data: { mfaPrompt: String(i.prompt).slice(0, 300), mfaRequestedAt: new Date(), mfaCodeEnc: null } });
              say(opts.interactive ? 'Looking for the code in your email — or type it in the box' : 'Looking for the verification code in your email');
              let stop = false;
              const fromEmail = findEmailedCode(userId, { since, host: mailHost, providerName: account.providerName, timeoutMs: 120_000, exclude: [...triedCodes], report, stop: () => stop || cancelled }).catch(() => null)
                .then(v => { if (!v && !stop && opts.interactive) say(`${mailMiss(report, mailHost, since)} Waiting for you to type the code.`); return v ? { code: v, by: 'email' } : null; });
              const fromOwner = (async () => {
                if (!opts.interactive) return null;
                const until = Date.now() + CODE_WAIT_MS;
                while (!stop && !cancelled && Date.now() < until) {
                  await new Promise(r => setTimeout(r, 3000));
                  const a = await db.utilityAccount.findUnique({ where: { id: account.id }, select: { mfaCodeEnc: true } });
                  if (a?.mfaCodeEnc) return { code: decrypt(a.mfaCodeEnc), by: 'owner' };
                }
                return null;
              })();
              const got = await new Promise<{ code: string; by: string } | null>(resolve => {
                let left = 2;
                const settle = (v: { code: string; by: string } | null) => { if (v) resolve(v); else if (--left === 0) resolve(null); };
                void fromEmail.then(settle); void fromOwner.then(settle);
              });
              stop = true;
              if (opts.interactive) await db.utilityAccount.update({ where: { id: account.id }, data: { mfaPrompt: null, mfaRequestedAt: null, mfaCodeEnc: null } });
              if (got) {
                code = got.code.trim(); secrets.push(code); usedCode = true;
                content = got.by === 'email' ? 'The code arrived by email. Use type_code.' : 'The owner gave the code. Use type_code.';
                say(got.by === 'email' ? 'Found the code in your email — entering it' : 'Got your code — entering it');
              } else {
                mailNote = mailMiss(report, mailHost, since);
                content = `No code: ${mailNote}${opts.interactive ? ' The owner did not type one within 5 minutes either.' : ' Nobody is watching a scheduled run.'} Finish with no_code.`;
              }
              break;
            }
            case 'open_emailed_link': {
              if (triedLinks >= 2) { content = 'Two emailed links have been tried — finish with no_code.'; break; }
              triedLinks++;
              // Only mail sent since this fetch began, from the portal itself.
              const linkHost = new URL(page.url()).hostname || start.hostname, linkSince = new Date(runStartedAt - 30_000);
              const linkReport: MailReport = { inboxes: [], errors: [], fromPortal: 0 };
              const link = await findEmailedLink(userId, { since: linkSince, host: linkHost, providerName: account.providerName, timeoutMs: 120_000, report: linkReport }).catch(() => null);
              if (!link) { mailNote = mailMiss(linkReport, linkHost, linkSince); content = `No sign-in link: ${mailNote} Finish with no_code.`; break; }
              secrets.push(link);
              usedCode = true; // signed in by email: keep the browser's memory like after a code
              say('Found the sign-in link in your email — opening it');
              await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
              content = await after('Opened the emailed sign-in link.');
              break;
            }
            case 'type_code': {
              if (!code) { content = 'No code yet — call ask_owner_for_code.'; break; }
              await fillCode(el(i.ref), code);
              triedCodes.add(code);
              if (i.rememberRef != null) await el(i.rememberRef).check({ timeout: 3000 }).catch(() => el(i.rememberRef).click({ timeout: 3000 }).catch(() => {}));
              if (i.submitRef != null) await el(i.submitRef).click({ timeout: 10000 });
              content = await after(i.submitRef != null ? 'Code entered and submitted.' : 'Code entered.');
              code = null; // used: a rejected code is never typed again
              break;
            }
            case 'finish':
              finished = true;
              run.ok = i.outcome === 'done';
              run.summary = String(i.summary ?? '').slice(0, 500);
              if (!run.ok) run.error = { bad_login: 'The portal rejected the username or password.', captcha: 'The portal showed a captcha the agent cannot solve — sync this one by email or upload.', no_code: `The portal asked for a verification code or sign-in link and none was found. ${mailNote || 'It may go to your phone.'}${opts.interactive ? '' : ' Press Fetch now to type it yourself.'}`, turned_away: 'turned_away', blocked: 'The agent could not get to the statements.' }[String(i.outcome)] + (run.summary ? ` ${run.summary}` : '');
              break;
            default: content = 'Unknown tool.';
          }
          if (rec) steps.push(rec);
          if (recAfter) steps.push(recAfter);
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
    if (cancelled) run.error = 'Cancelled by you.';
    if (!run.summary && !run.error) {
      // Where it got stuck, so the next look starts from there.
      const at = await page.title().catch(() => '');
      run.error = `The agent ran out of steps before finishing (last on ${at ? `"${at.slice(0, 80)}" — ` : ''}${page.url().slice(0, 120)}).`;
    }
    if (!run.error) run.ok = true;
    // Reached the statements: keep the way there for next time.
    if (run.ok && navDone) {
      if (recipe && run.replayed === recipe.steps.length) await recipeWorked(recipe.key, true);
      else await saveRecipe(account.id, host, steps);
    }
  } catch (err) {
    run.error = cancelled ? 'Cancelled by you.' : err instanceof Error ? err.message.split('\n')[0] : String(err);
    if ((err as { turnedAway?: boolean })?.turnedAway) run.error = `turned_away ${run.error}`;
  } finally {
    if (watch) clearInterval(watch);
    if (cancelled) { run.ok = false; run.error = 'Cancelled by you.'; }
    // Keep the cookies after a good run, or once a code got us in (the trusted-device cookie).
    if (run.ok || usedCode) {
      try {
        const state = await ctx.storageState();
        const cookies = state.cookies.filter(k => !BOT_COOKIE.test(k.name));
        await db.portalSession.upsert({ where: { utilityAccountId: account.id }, create: { utilityAccountId: account.id, stateEnc: encrypt(JSON.stringify({ cookies })) }, update: { stateEnc: encrypt(JSON.stringify({ cookies })) } });
      } catch (err) { console.warn('[PortalAgent] session not saved:', err instanceof Error ? err.message.split('\n')[0] : err); }
    }
    await ctx.close().catch(() => {});
    await (remote as Browser | null)?.close().catch(() => {});
    await db.utilityAccount.update({ where: { id: account.id }, data: { lastAgentRunAt: new Date(), mfaPrompt: null, mfaRequestedAt: null, mfaCodeEnc: null } }).catch(() => {});
  }

  // Turned away (said so, or the summary shows it whatever outcome was picked):
  // say what it means, and hold scheduled fetches of this site for a while.
  if (!run.ok && run.error && !/^Not tried/.test(run.error) && (run.error.startsWith('turned_away') || TURNED_AWAY.test(`${run.error} ${run.summary}`))) {
    const until = Date.now() + TURNED_AWAY_MS;
    turnedAway.set(host, until);
    const detail = run.error.replace(/^turned_away\s*/, '').replace(/^The agent could not get to the statements\.\s*/, '');
    run.error = `${account.providerName} turned Sollux's browser away (bot protection, not your password); scheduled fetches wait until ${clock(until)} so the login isn't locked. If it keeps happening the site blocks cloud servers: turn on Fetch from your computer (Settings → AI usage), or bring its bills in by email or upload. ${detail}`;
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
