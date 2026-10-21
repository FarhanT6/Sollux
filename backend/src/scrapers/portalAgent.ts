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
import * as crypto from 'crypto';
import { websiteFor, findProvider, isLookupPage } from '../lib/providerDirectory';
import * as fs from 'fs';
import { BrowserContext, Page, Download, Frame, Locator } from 'playwright';
import { launchPortalContext, isHttp2Reset } from './browser';
import { chromium, type Browser } from 'playwright';
import { connectorFor, filesUrlFor, CONNECTOR_VERSION } from '../services/connector';
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
// The frames that hold a checkbox-style human check: Cloudflare Turnstile,
// reCAPTCHA's checkbox, hCaptcha's checkbox. The box itself sits in a closed
// frame the page reader cannot see into.
const CAPTCHA_FRAME = /challenges\.cloudflare\.com|(google\.com|recaptcha\.net)\/recaptcha\/(api2|enterprise)\/anchor|hcaptcha\.com\/.*checkbox/i;
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
  /** Statements filed, by the account each one was filed to (several accounts on one login). */
  filedFor?: Record<string, number>;
  /** What the agent reported for each account, by the last 4 of its number (several accounts on one login). */
  accountResults?: Record<string, string>;
}

const TOOLS: Anthropic.Tool[] = [
  { name: 'tick_captcha', description: 'Tick the "Verify you are human" / "I\'m not a robot" checkbox on the page (Cloudflare, reCAPTCHA, hCaptcha) with a real mouse click. Call it before submitting a form that has one.', input_schema: { type: 'object', properties: {} } },
  { name: 'look', description: 'Describe the current page: URL, title, visible text, and numbered interactive elements [n]. Every other action already returns the page as it is afterwards, so only call this at the start or if a page was still loading.', input_schema: { type: 'object', properties: {} } },
  { name: 'screenshot', description: 'A picture of the page, when the text description is not enough.', input_schema: { type: 'object', properties: {} } },
  { name: 'click', description: 'Click element [n].', input_schema: { type: 'object', properties: { ref: { type: 'number' } }, required: ['ref'] } },
  { name: 'type', description: 'Type text into field [n] (not for passwords, usernames or codes). submit: press Enter afterwards.', input_schema: { type: 'object', properties: { ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] } },
  { name: 'select', description: 'Choose an option in dropdown [n] by its visible label.', input_schema: { type: 'object', properties: { ref: { type: 'number' }, label: { type: 'string' } }, required: ['ref', 'label'] } },
  { name: 'fill_account_number', description: "Type the account's full number into field [ref] (you never see it) — for a portal's lookup without signing in (\"pay as guest\", \"view bill by account number\", InvoiceCloud's customer lookup). part: 'full' (default), or 'first'/'second' for a number printed in two parts (\"177299-182052\": customer number, then account number), or 'name' for the name the bill is addressed to (\"Customer or Business Name\"). submitRef: click it afterwards.", input_schema: { type: 'object', properties: { ref: { type: 'number' }, part: { type: 'string', enum: ['full', 'first', 'second', 'name'] }, submitRef: { type: 'number' } }, required: ['ref'] } },
  { name: 'fill_login', description: "Type the owner's username into [usernameRef] and password into [passwordRef] (you never see them), tick [rememberRef] if given, then click [submitRef]. A site that asks for the username first: give only usernameRef and submitRef, then call again with passwordRef on the next page.", input_schema: { type: 'object', properties: { usernameRef: { type: 'number' }, passwordRef: { type: 'number' }, rememberRef: { type: 'number' }, submitRef: { type: 'number' } } } },
  { name: 'press', description: 'Press a key (Enter, Tab, Escape).', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'goto', description: "Open a URL on the provider's own site.", input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'download_statement', description: 'Click element [n] that downloads or opens one statement PDF, and keep it. Give the statement date if shown.', input_schema: { type: 'object', properties: { ref: { type: 'number' }, statementDate: { type: 'string' } }, required: ['ref'] } },
  { name: 'save_page_as_statement', description: "The portal has no statement PDFs, but the page now open shows the bill itself: the amount due and due date, or a payment schedule / payment history with the latest installment (premium financing, some lenders and insurers). Saves this page as a PDF and files it like a statement — fees included (a late fee, an NSF fee), so they are caught every time it is fetched. For each account save the payment schedule / payment history page (every installment, payment and fee charged) and, when it shows a current amount due or fees due, the account's main summary page too. Only when there is no statement document to download. statementDate: the date of the bill it shows (the current installment's due date), YYYY-MM-DD.", input_schema: { type: 'object', properties: { statementDate: { type: 'string' } }, required: ['statementDate'] } },
  { name: 'ask_owner_for_code', description: "The portal sent a verification code. Reads it from the owner's email (up to 2 minutes), else asks the owner (up to 5 more). Say where it was sent.", input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  { name: 'open_emailed_link', description: 'The portal emailed a link that signs you in, instead of a code ("magic link", "Access your account", "check your email to log in"). Finds that link in the owner\'s email (up to 2 minutes) and opens it in this browser; returns the page afterwards.', input_schema: { type: 'object', properties: {} } },
  { name: 'type_code', description: 'Type the verification code into field [ref] (a code split into one-digit boxes: give the first box), tick [rememberRef] ("remember this device") if given, then click [submitRef].', input_schema: { type: 'object', properties: { ref: { type: 'number' }, rememberRef: { type: 'number' }, submitRef: { type: 'number' } }, required: ['ref'] } },
  { name: 'finish', description: 'Stop. outcome: done (downloaded what was new, or nothing new), bad_login (the portal said the username or password is wrong), captcha, no_code, turned_away (the site refused the browser itself: Access Denied, "invalid request", "unable to process your request" after a sign-in, a bot check), blocked (anything else in the way).', input_schema: { type: 'object', properties: { outcome: { type: 'string', enum: ['done', 'bad_login', 'captcha', 'no_code', 'turned_away', 'blocked'] }, summary: { type: 'string' }, accounts: { type: 'array', description: 'When several accounts were listed: what you found for each one.', items: { type: 'object', properties: { account: { type: 'string', description: 'last 4 of the account number' }, result: { type: 'string', enum: ['downloaded', 'nothing_new', 'not_listed', 'not_checked'] } }, required: ['account', 'result'] } } }, required: ['outcome', 'summary'] } },
];

/**
 * The page now open as a PDF, for a portal with no statement documents (a
 * premium-finance account's payment schedule). Printed as it looks on screen;
 * where Chrome will not print (a visible window on the owner's computer), a
 * full-page screenshot laid onto letter pages.
 */
export async function pageAsPdf(page: Page): Promise<Buffer | null> {
  try {
    await page.emulateMedia({ media: 'screen' }).catch(() => {});
    const pdf = await page.pdf({ printBackground: true, format: 'Letter', margin: { top: '0.3in', bottom: '0.3in', left: '0.3in', right: '0.3in' } });
    if (pdf.length > 1000) return Buffer.from(pdf);
  } catch { /* not printable here: screenshot below */ }
  try {
    const png = await page.screenshot({ fullPage: true, scale: 'css' });
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(png);
    const W = 612, H = 792; // US letter, in points
    const h = img.height * (W / img.width);
    for (let y = 0; y < h; y += H) doc.addPage([W, H]).drawImage(img, { x: 0, y: H - h + y, width: W, height: h });
    return Buffer.from(await doc.save());
  } catch { return null; }
}

/** The tools for an account found by its biller's lookup page: no way to sign in. */
const LOOKUP_TOOLS = TOOLS.filter(t => !['fill_login', 'ask_owner_for_code', 'open_emailed_link', 'type_code'].includes(t.name));
const SIGN_IN_URL = /log-?in|log-?on|sign-?in|sign-?on|register|auth/i;
/** A sign-in page, whatever its address: a password box is showing. */
const onSignIn = (page: Page) => page.locator('input[type="password"]').first().isVisible().catch(() => false);
/** Signed in: the page offers Log out / Sign out, has no password box, and is not an error page. */
const looksSignedIn = async (page: Page, text: string) =>
  /\b(log ?out|sign ?out|logout|signout)\b/i.test(text) && !TURNED_AWAY.test(text) && !(await onSignIn(page));

/**
 * A biller's lookup page filled in by code, not by Claude: the account number
 * (split into customer and account number when the bill prints two) and the
 * name on the bill, matched to the fields by their labels, then Search. Left
 * to Claude, a page asking for a name it had no way to type was abandoned for
 * the sign-in (City of Imperial's InvoiceCloud page, every time).
 */
async function fillLookup(page: Page, number: string, name: string): Promise<{ filled: string[]; missing: string[]; searched: boolean; captcha: boolean }> {
  const parts = number.split(/[\s-]+/).filter(Boolean);
  const out = { filled: [] as string[], missing: [] as string[], searched: false, captcha: false };
  for (const frame of page.frames()) {
    if (/challenges\.cloudflare\.com|recaptcha|hcaptcha|turnstile/i.test(frame.url())) { out.captcha = true; continue; }
    const fields = await frame.evaluate(`(function () {
      var out = [];
      Array.prototype.slice.call(document.querySelectorAll('input')).forEach(function (el, i) {
        var t = (el.getAttribute('type') || 'text').toLowerCase();
        if (['text', 'tel', 'number', 'search'].indexOf(t) < 0) return;
        var r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
        var label = '';
        if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) label = l.textContent || ''; }
        if (!label && el.closest('label')) label = el.closest('label').textContent || '';
        if (!label) label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
        for (var p = el.parentElement, k = 0; !label && p && k < 3; p = p.parentElement, k++) {
          var txt = (p.textContent || '').replace(/\\s+/g, ' ').trim();
          if (txt && txt.length < 80) label = txt;
        }
        el.setAttribute('data-sollux-lookup', String(i));
        out.push({ i: i, label: label.replace(/\\s+/g, ' ').trim().slice(0, 80) });
      });
      return out;
    })()`).catch(() => []) as { i: number; label: string }[];
    for (const f of fields) {
      const what = /account\s*(number|no\b|#|id)/i.test(f.label) ? 'account number'
        : /customer\s*(number|no\b|#|id)/i.test(f.label) ? 'customer number'
        : /name/i.test(f.label) && !/user\s*name|e-?mail/i.test(f.label) ? 'name on the bill' : null;
      if (!what) continue;
      const value = what === 'account number' ? (parts.length > 1 ? parts[parts.length - 1] : number)
        : what === 'customer number' ? (parts.length > 1 ? parts[0] : '')
        : name;
      if (!value) { out.missing.push(what); continue; }
      await frame.locator(`[data-sollux-lookup="${f.i}"]`).fill(value).then(() => out.filled.push(what)).catch(() => out.missing.push(what));
    }
  }
  if (!out.captcha) out.captcha = await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-turnstile, .g-recaptcha').count().then(c => c > 0).catch(() => false);
  if (out.filled.includes('account number') && !out.missing.length && !out.captcha) {
    const search = page.locator('button, a, input[type="submit"], input[type="button"]')
      .filter({ hasText: /search invoices|search bills|^\s*search\s*$|find (my )?(bill|account|invoice)|look ?up|view bill/i }).first();
    const submit = await search.count() ? search : page.locator('input[type="submit"]').first();
    if (await submit.count()) {
      await submit.click({ timeout: 10000 }).then(() => { out.searched = true; }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }
  return out;
}

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
      const sel = 'a,button,input,select,textarea,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[onclick]';
      for (const root of roots) {
        if (root !== document) for (const c of Array.from(root.children)) { const t = (c as HTMLElement).innerText; if (t) shadowText.push(t); }
        for (const el of Array.from(root.querySelectorAll(sel))) {
          if (i - start >= limit) break;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || getComputedStyle(el as HTMLElement).visibility === 'hidden') continue;
          // A checkbox or radio drawn by the site (Angular Material shrinks the real
          // one to 1px under a styled box): list its label, which takes the click,
          // instead of the 1px input, whose click something else intercepts.
          const ctrl = el.tagName === 'LABEL' ? (el as HTMLLabelElement).control as HTMLInputElement | null : null;
          if (el.tagName === 'LABEL') {
            if (!ctrl || (ctrl.type !== 'checkbox' && ctrl.type !== 'radio')) continue;
            const cb = ctrl.getBoundingClientRect();
            if (cb.width >= 4 && cb.height >= 4) continue; // a normal checkbox: listed itself
          }
          if (el.tagName === 'INPUT' && ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio') && (r.width < 4 || r.height < 4)) {
            const lab = (el as HTMLInputElement).labels?.[0];
            if (lab && lab.getBoundingClientRect().width > 0) continue; // its label is listed
          }
          const n = ++i;
          el.setAttribute('data-sref', String(n));
          const tag = el.tagName.toLowerCase();
          const inp = el as HTMLInputElement;
          let label = (el.getAttribute('aria-label') || (inp.labels && inp.labels[0]?.innerText) || inp.placeholder || el.getAttribute('title') || (el as HTMLElement).innerText || inp.name || el.id || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          // A bare box (a checkbox drawn at the side of an option card): name it by the card it sits in.
          for (let up = el.parentElement, k = 0; !label.replace(/[^\w]/g, '') && up && k < 5; up = up.parentElement, k++) {
            label = (up.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          }
          let d = `[${n}] ${tag}`;
          if (tag === 'input') d += ` type=${inp.type || 'text'}${inp.type === 'checkbox' || inp.type === 'radio' ? (inp.checked ? ' (checked)' : ' (unchecked)') : inp.value ? ' (filled)' : ''}`;
          // An option card is often a label around a hidden checkbox or radio: its state goes on the label.
          const ctl = tag === 'label' ? (el as HTMLLabelElement).control as HTMLInputElement | null : null;
          if (ctl && (ctl.type === 'checkbox' || ctl.type === 'radio')) d += ctl.checked ? ' (checked)' : ' (unchecked)';
          const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected') ?? el.getAttribute('aria-pressed');
          if (aria) d += aria === 'true' ? ' (selected)' : ' (not selected)';
          if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') d += ' (disabled)';
          if (tag === 'a' && (el as HTMLAnchorElement).href) d += ` href=${(el as HTMLAnchorElement).href.slice(0, 120)}`;
          if (tag === 'select') d += ` options=${Array.from((el as HTMLSelectElement).options).slice(0, 15).map(o => o.text.trim()).join(' | ').slice(0, 200)}`;
          out.push(`${d} "${label}"`);
        }
      }
      // Clickable cards with no button, link or role — only a click handler
      // (Westlake's "SMS / Call / Email" choices): the outermost element that
      // shows a pointer cursor, has short text, and holds nothing listed above.
      for (const root of roots) {
        for (const el of Array.from(root.querySelectorAll('div,span,li,section,article,mat-card,[tabindex]'))) {
          if (i - start >= limit) break;
          if (el.hasAttribute('data-sref') || el.closest('[data-sref]') || el.querySelector('[data-sref]')) continue;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          const t = ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 160) continue;
          const cs = getComputedStyle(el as HTMLElement);
          if (cs.cursor !== 'pointer' || cs.visibility === 'hidden') continue;
          if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
          const n = ++i;
          el.setAttribute('data-sref', String(n));
          out.push(`[${n}] ${el.tagName.toLowerCase()} (clickable) "${t.slice(0, 80)}"`);
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
  const checks = page.frames().filter(f => CAPTCHA_FRAME.test(f.url()));
  const checkNote = checks.length ? `\n\nSecurity check on this page: ${checks.map(f => /cloudflare/.test(f.url()) ? 'Cloudflare "Verify you are human"' : /hcaptcha/.test(f.url()) ? 'hCaptcha "I am human"' : 'reCAPTCHA "I\'m not a robot"').join(', ')} checkbox — use tick_captcha before submitting.` : '';
  let text = `URL: ${main.url}\nTitle: ${main.title}\n\nVisible text:\n${main.text}\n\nElements:\n${main.els.join('\n')}`;
  for (const f of framed) text += `\n\nEmbedded frame (${f.url.slice(0, 100)}):\n${f.text.slice(0, 600)}\nElements in it:\n${f.els.join('\n')}`;
  text += checkNote;
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

/** A PDF fetched by the page itself (its cookies, its internet connection); null if it is not one. */
async function pdfFromPage(page: Page, url: string): Promise<Buffer | null> {
  const b64 = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...Array.from(bytes.subarray(k, k + 0x8000)));
    return btoa(bin);
  }, url).catch(() => null);
  const b = b64 ? Buffer.from(b64, 'base64') : null;
  return b && b.subarray(0, 1024).includes('%PDF-') ? b : null;
}

export async function capturePdf(ctx: BrowserContext, page: Page, action: () => Promise<void>, remoteFiles?: () => Promise<Buffer[]>): Promise<Buffer | null> {
  let got: Buffer | null = null;
  const onDownload = async (d: Download) => {
    try { const p = await d.path(); if (p) { const b = await fs.promises.readFile(p); if (b.subarray(0, 1024).includes('%PDF-')) got = b; } } catch { /* ignore */ }
    // A browser on the owner's computer saves downloads there, out of reach:
    // fetch the same address from inside the page (its cookies, its internet).
    if (!got) got = await pdfFromPage(page, d.url());
  };
  const onResponse = async (r: import('playwright').Response) => {
    // A PDF opened in a tab reports its viewer's HTML as the body; keep only real PDF bytes.
    try { if (!got && (r.headers()['content-type'] ?? '').includes('application/pdf')) { const b = await r.body(); if (b.subarray(0, 1024).includes('%PDF-')) got = b; } } catch { /* ignore */ }
  };
  // A statement that opens in a new tab arrives as that tab's download.
  const onPage = (p: Page) => p.on('download', onDownload);
  const popups: Page[] = [];
  page.on('download', onDownload);
  ctx.on('response', onResponse);
  ctx.on('page', onPage);
  const newPage = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  try {
    // Anything the owner's Chrome downloaded before this click is not this statement.
    if (remoteFiles) await remoteFiles().catch(() => []);
    await action();
    const deadline = Date.now() + 20000;
    let polled = Date.now();
    while (!got && Date.now() < deadline) {
      // On the owner's computer Chrome saves the PDF there, and the connector
      // sends it up (a "View/Print" that builds the PDF on the spot, which no
      // second request can fetch again — CR&R's bill reprints).
      if (remoteFiles && Date.now() - polled > 1500) {
        polled = Date.now();
        const pdf = (await remoteFiles().catch(() => [])).find(b => b.subarray(0, 1024).includes('%PDF-'));
        if (pdf) { got = pdf; break; }
      }
      await page.waitForTimeout(500);
      const np = await Promise.race([newPage, new Promise<null>(r => setTimeout(() => r(null), 10))]);
      if (np && !got) {
        await np.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        // A tab opened blank and then sent to the PDF: wait for its address.
        for (let k = 0; k < 20 && !np.url().startsWith('http'); k++) await page.waitForTimeout(250);
        const url = np.url();
        if (url && url.startsWith('http')) {
          // From inside the portal's own tab first: on the owner's computer that is
          // their internet and sign-in; the request below comes from Sollux's
          // server, which SDG&E turns away (its bill PDF opens in a new tab).
          got = await pdfFromPage(page, url);
          // A pop-up that is a page holding the bill (CR&R's View/Print): the
          // PDF is whatever it embeds or links, fetched from inside the pop-up.
          if (!got) {
            const inner = await np.evaluate(() => Array.from(document.querySelectorAll('embed[src],iframe[src],object[data],a[href]'))
              .map(e => (e as HTMLEmbedElement).src || (e as HTMLObjectElement).data || (e as HTMLAnchorElement).href)
              .filter(u => /^https?:/.test(u) && (/pdf|bill|print|invoice|statement|document|view/i.test(u)))
              .slice(0, 6)).catch(() => [] as string[]);
            for (const u of inner) { got = await pdfFromPage(np, u); if (got) break; }
          }
          const res = got ? null : await ctx.request.get(url).catch(() => null);
          if (res && (res.headers()['content-type'] ?? '').includes('pdf')) { const b = Buffer.from(await res.body()); if (b.subarray(0, 1024).includes('%PDF-')) got = b; }
        }
        // Left open until the end: a pop-up closed now would cancel a download still arriving.
        popups.push(np);
      }
    }
  } finally {
    page.off('download', onDownload);
    for (const p of popups) await p.close().catch(() => {});
    ctx.off('response', onResponse);
    ctx.off('page', onPage);
  }
  const b = got as Buffer | null;
  return b && b.subarray(0, 1024).includes('%PDF-') ? b : null;
}

export interface AgentOptions {
  interactive?: boolean;
  /** Other accounts on the same login: one sign-in fetches them all. */
  also?: string[];
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
  // Every status line says which browser it is in: the "Opening …" line alone
  // was replaced by the next one before anyone could read it.
  let where = '';
  const say = (t: string) => { try { opts.onProgress?.(where ? `${where} · ${t}` : t); } catch { /* status only */ } };
  const account = await db.utilityAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true, providerName: true, providerSlug: true, loginUrl: true, lookupName: true, usernameEnc: true, passwordEnc: true, accountNumber: true, accountNumberEnc: true,
      property: { select: { userId: true, address: true } },
      statements: { where: { pdfS3Key: { not: null } }, orderBy: { statementDate: 'desc' }, take: 1, select: { statementDate: true } },
    },
  });
  if (!account) return { ok: false, filed: 0, review: 0, applied: 0, downloads: 0, summary: '', error: 'Account not found' };
  // The login page: the one the owner saved (or a bill printed), else the
  // provider directory's; the agent finds "Sign in" from a home page.
  const loginUrl = websiteFor(account)?.url ?? null;
  // The website is the biller's lookup page: the bills are found there by
  // account number and name, and this run never signs in — no sign-in tool,
  // no saved route, no going to a sign-in page.
  const lookup = isLookupPage(loginUrl);
  // The full account number, for a lookup without signing in. Not hidden from the
  // page text: the agent picks the right account on a portal by its number.
  const fullNumber = (() => { try { return account.accountNumberEnc ? decrypt(account.accountNumberEnc).trim() : ''; } catch { return ''; } })();
  const lookupName = account.lookupName?.trim() ?? '';
  const fail = (error: string): PortalRun => ({ ok: false, filed: 0, review: 0, applied: 0, downloads: 0, summary: '', error });
  if (!loginUrl) return fail('Add the provider\'s website (Website on the account) so the agent knows where to sign in.');
  if (lookup && !fullNumber) return fail('This account\'s website is a bill lookup page, which needs the full account number: add it on the account (Edit).');
  if (!lookup && (!account.usernameEnc || !account.passwordEnc)) return fail('Add your portal username and password (Edit on the account) so Sollux can fetch statements.');
  const username = account.usernameEnc ? decrypt(account.usernameEnc) : '', password = account.passwordEnc ? decrypt(account.passwordEnc) : '';
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
  // The other accounts this login holds: fetched in the same visit — one
  // sign-in and one code instead of one each (SDG&E turned away twelve
  // sign-ins in five minutes).
  const others = opts.also?.length ? await db.utilityAccount.findMany({
    where: { id: { in: opts.also } },
    select: { id: true, accountNumber: true, property: { select: { address: true } }, statements: { where: { pdfS3Key: { not: null } }, orderBy: { statementDate: 'desc' }, take: 1, select: { statementDate: true } } },
  }) : [];
  const n = 1 + others.length;
  const maxDownloads = Math.min(MAX_DOWNLOADS * n, 24);
  const batchId = `portal-${account.id}-${Date.now()}`;
  const review: ReviewItem[] = [];
  const run: PortalRun = { ok: false, filed: 0, review: 0, applied: 0, downloads: 0, summary: '', aiSteps: 0, costUsd: 0, replayed: 0, filedFor: {} };

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
  // The PDFs the owner's Chrome downloaded in this session, collected from the API (services/connector.ts).
  // The session on the owner's computer now in use: a new one after a reconnect.
  let liveWs: string | null = connector?.wsUrl ?? null;
  const remoteFiles = async (): Promise<Buffer[]> => {
    if (!connector) return [];
    const r = await fetch(filesUrlFor(liveWs ?? connector.wsUrl)).then(x => x.json() as Promise<{ files?: { data: string }[] }>);
    return (r.files ?? []).map(f => Buffer.from(f.data, 'base64'));
  };
  // Why the owner's computer was not used although it is connected, for the status and the error.
  let connectorProblem = '';
  const prepare = async (http1 = false) => {
    let c: BrowserContext | null = null;
    if (connector && !http1) {
      try {
        say(`Connecting to ${connector.name}`);
        // A computer that stops answering must not hold the fetch: 45 seconds, then Sollux's own browser.
        const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error('no answer from the computer in 45 seconds')), 45_000));
        c = await Promise.race([timeout, (async () => {
          remote = await chromium.connectOverCDP(connector.wsUrl, { timeout: 30_000 });
          // The connector profile's own window, not a private one: what the owner
          // signs in to there by hand (a site that refuses the agent, a device
          // to trust) is what the agent finds signed in next time.
          return remote.contexts()[0] ?? await remote.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 900 }, locale: 'en-US' });
        })()]);
        where = `On ${connector.name}`;
      } catch (err) {
        connectorProblem = `${connector.name} is connected but Sollux could not open its Chrome (${err instanceof Error ? err.message.split('\n')[0].slice(0, 120) : String(err)}), so this ran in Sollux's own browser.`;
        console.warn('[PortalAgent] connector browser unavailable, using the cloud one:', connectorProblem);
        await (remote as Browser | null)?.close().catch(() => {}); remote = null; c = null;
        where = "Sollux's browser (couldn't reach your computer)";
      }
    }
    if (!c) {
      c = await launchPortalContext(profileDir, { http1 });
      if (!connector) where = "Sollux's browser (your computer isn't connected)";
    }
    // A fresh bot score every run: none from the profile on disk, none from the database.
    // The owner's own Chrome keeps its own sign-ins and its standing with each
    // site: restoring saved cookies over them signed SDG&E out mid-session, and
    // clearing its bot-check cookie each run brought on reCAPTCHA. Images stay
    // too — a captcha the owner solves there needs them.
    if ((remote as Browser | null) && c === (remote as Browser | null)!.contexts()[0]) return c;
    await c.clearCookies({ name: BOT_COOKIE }).catch(() => {});
    if (saved) {
      try { await c.addCookies((JSON.parse(decrypt(saved.stateEnc)).cookies ?? []).filter((k: { name: string }) => !BOT_COOKIE.test(k.name))); }
      catch (err) { console.warn('[PortalAgent] saved session not restored:', err instanceof Error ? err.message.split('\n')[0] : err); }
    }
    await c.route('**/*', r => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue())).catch(() => {});
    return c;
  };
  let ctx = await prepare();
  // Sollux's own browser closing under the run (out of memory): nothing more can be done in it.
  let ctxClosed = false;
  ctx.on('close', () => { ctxClosed = true; });
  // On the owner's computer: a tab of its own, closed afterwards; the window stays.
  let page = remote ? await ctx.newPage() : ctx.pages()[0] ?? await ctx.newPage();
  // Every tab this run opened or the site opened for it, oldest first.
  const runPages: Page[] = [page];
  let tabsAtAction = 1;
  const onNewTab = (p: Page) => { runPages.push(p); };
  ctx.on('page', onNewTab);
  // A site that moves the sign-in to a new tab and closes the old one (Blue
  // Shield's 2-step page): carry on in the newest tab still open, instead of
  // stopping because "the tab closed".
  const follow = async () => {
    if (!page.isClosed()) return;
    // The newest tab this run saw, else any open tab on the provider's site.
    const next = runPages.filter(p => !p.isClosed()).pop()
      ?? ctx.pages().filter(p => !p.isClosed() && (() => { try { return allowed.has(rootOf(new URL(p.url()).hostname)); } catch { return false; } })()).pop();
    if (next) { page = next; await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {}); }
  };
  const shutdown = async () => {
    ctx.off('page', onNewTab);
    if (remote) {
      for (const p of runPages) await p.close().catch(() => {});
      await ctx.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await (remote as Browser | null)?.close().catch(() => {});
    } else await ctx.close().catch(() => {});
  };
  // Cancel: checked every few seconds; closing the browser ends whatever it
  // is waiting on (a page load, a click), and every loop below stops on it.
  let cancelled = false;
  const watch = opts.cancelled ? setInterval(() => {
    void opts.cancelled!().then(c => { if (c && !cancelled) { cancelled = true; void shutdown(); } }).catch(() => {});
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
  // More accounts, more room: each one is a switch, a history page and its downloads.
  const deadline = Date.now() + RUN_MS + (n - 1) * 3 * 60_000;
  const costCap = RUN_MAX_USD + (n - 1) * 0.35;
  let code: string | null = null;
  // A code was entered this run: the device may now be trusted, so keep the browser's memory.
  let usedCode = false;
  // Codes already typed: a second request must bring a new one.
  const triedCodes = new Set<string>();
  let triedLinks = 0;
  // Why the last email search came up empty, for the error the owner sees.
  let mailNote = '';
  const runStartedAt = Date.now();
  // When the page was last acted on (a click, a sign-in, Enter): a code sent
  // because of it arrives after this. Searching from the run's start (less 30s)
  // picked up a code an earlier run had asked for — Westlake typed 168168,
  // the code from the run before, and the portal counted it as a wrong try.
  let actedAt = runStartedAt;
  // After an action: let the page settle, then show it as it is now (saves a look step).
  // The page as Claude last saw it, and whether giving up has been second-guessed yet.
  let lastPage = '';
  let rechecked = false;
  let triedHome = false;
  let askedCaptcha = false;
  // Got past the sign-in (a code accepted, or a sign-in that left no password
  // box): an error page after this is the site's own trouble — a bill viewer
  // that fails — not the site turning the browser away. Nationwide's run signed
  // in, reached the accounts page and was then reported as "bot protection".
  let signedIn = false;
  // The PDFs downloaded this run, by content, with the date each was taken for.
  const pdfsSeen = new Map<string, string>();
  let repeats = 0;
  let reconnected = false;
  /**
   * The browser itself went away mid-run — the owner's computer slept, the
   * connector stopped, or its Chrome window was closed. Every later step
   * failed with "Target page, context or browser has been closed" and the run
   * spent its steps on a dead browser. Reconnect once while the computer is
   * still online (starting again at the sign-in page); otherwise say why and stop.
   * Returns true when back, a message to stop with, or null when the browser is fine.
   */
  // What the server saw end the session, and whether the computer runs an old connector.
  const dropNote = async (): Promise<string> => {
    let note = '';
    try {
      const r = await fetch(filesUrlFor(liveWs ?? connector!.wsUrl)).then(x => x.json() as Promise<{ drop?: string | null }>);
      if (r.drop) note += ` What happened: ${r.drop}.`;
    } catch { /* the server is unreachable too */ }
    const d = await db.connectorDevice.findFirst({ where: { userId }, orderBy: { lastSeenAt: 'desc' }, select: { agent: true } }).catch(() => null);
    const v = Number(d?.agent?.match(/connector v(\d+)/)?.[1] ?? 0);
    if (v < CONNECTOR_VERSION) note += ' The connector on that computer is an older version that can stop on an error and not reconnect: download it again from Settings → AI usage → Fetch from your computer, and run the new one.';
    return note;
  };
  const reopen = async (retry = true): Promise<true | string | null> => {
    if (remote) {
      if ((remote as Browser).isConnected()) return null;
      const gone = `The Chrome on ${connector!.name} stopped answering partway through and did not come back within 90 seconds — the computer went to sleep, the connector program stopped, or that Chrome window was closed. Nothing was changed; press Fetch now again once it is back.`;
      // Usually it is Sollux restarting for an update: the computer reconnects
      // to the new server within seconds. Keep trying for up to 90 seconds.
      if (!retry || reconnected || cancelled) return `${gone}${await dropNote()}`;
      reconnected = true;
      say(`Lost the connection to ${connector!.name} — waiting for it to reconnect`);
      let again: Awaited<ReturnType<typeof connectorFor>> = null;
      for (const until = Date.now() + 90_000; !cancelled && Date.now() < until;) {
        await new Promise(r => setTimeout(r, 3000));
        const c = await connectorFor(userId);
        if (!c) continue;
        const b = await chromium.connectOverCDP(c.wsUrl, { timeout: 15_000 }).catch(() => null);
        if (b) { remote = b; again = c; break; }
      }
      if (!again || !remote) return `${gone}${await dropNote()}`;
      try {
        say(`${connector!.name} is back — carrying on`);
        liveWs = again.wsUrl;
        ctx = (remote as Browser).contexts()[0] ?? await (remote as Browser).newContext({ acceptDownloads: true, viewport: { width: 1366, height: 900 }, locale: 'en-US' });
        ctx.on('page', onNewTab);
        page = await ctx.newPage();
        runPages.push(page); tabsAtAction = runPages.length;
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        lastPage = await describe(page, secrets);
        return true;
      } catch { return gone; }
    }
    return ctxClosed ? "Sollux's browser closed unexpectedly partway through (it may have run out of memory). Nothing was changed; press Fetch now to try again." : null;
  };
  const after = async (what: string) => {
    // The next step opened in a new tab (a link, or a sign-in button): work there.
    await page.waitForTimeout(500);
    const opened = runPages.length > tabsAtAction ? runPages[runPages.length - 1] : null;
    if (opened && opened !== page && !opened.isClosed()) {
      await opened.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      if (/^https?:/.test(opened.url()) && !/\.pdf(\?|$)/i.test(opened.url())) { page = opened; what += ' It opened in a new tab; you are now on that tab.'; }
    }
    tabsAtAction = runPages.length;
    await follow();
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    lastPage = await describe(page, secrets);
    return `${what}\n\n${lastPage}`;
  };

  const system = `You operate a web browser for a property owner to collect their statements from ${account.providerName}'s customer portal — any bill they track: utilities, phone and internet, insurance, loans and mortgages, HOA dues. Account ${account.accountNumber ? `ending ${String(account.accountNumber).slice(-4)}` : ''} at ${account.property.address}.
This is the owner's own account, signed in with the owner's own login at the owner's request. Notices shown to everyone before signing in — a government "authorized use only" warning (student-loan servicers), a cookie banner, an "I understand / Accept / Continue" on such a notice — are addressed to the account holder, who is the owner: acknowledge them and carry on. That is not agreeing to anything new on the account.
${others.length ? `This login holds several of the owner's accounts. Fetch every one of them in this one visit — sign in once, then for each account open it (account picker, "switch account", or a list of accounts) and its billing / statement history, and download each statement PDF dated after its date, newest first:
- ${account.accountNumber ? `account ending ${String(account.accountNumber).slice(-4)}` : 'this account'} at ${account.property.address}: after ${since ?? 'the last 12 months'}
${others.map(o => `- ${o.accountNumber ? `account ending ${String(o.accountNumber).slice(-4)}` : 'an account'} at ${o.property.address}: after ${o.statements[0]?.statementDate?.toISOString().slice(0, 10) ?? 'the last 12 months'}`).join('\n')}
At most ${maxDownloads} downloads in all. An account the portal does not list is not an error: say so and carry on. Finish with outcome done when every listed account is checked, and fill in accounts with each one's result (downloaded, nothing_new, not_listed, or not_checked if you did not get to it) — an account is only nothing_new if you opened its own statement history.` : lookup ? `Goal: this account's bills are found on the biller's lookup page you start on, by account number and the name on the bill — never by signing in. Do not open a sign-in or register page, even if one is offered. Sollux fills in the lookup fields and presses Search for you where it can; otherwise fill them with fill_account_number (part 'name' for a name field), then open the invoices / bill history and download each statement PDF dated after ${since ?? 'the last 12 months'} — newest first, at most ${MAX_DOWNLOADS}. If the lookup says the account was not found, finish with blocked and quote what it said. If there is nothing newer, finish with outcome done.` : `Goal: log in, open the billing / statement history, and download each statement PDF dated after ${since ?? 'the last 12 months'} — newest first, at most ${MAX_DOWNLOADS}. If there is nothing newer, finish with outcome done.`}
Rules: use fill_login for credentials (you never see them). If the portal offers where to send a verification code, choose email over text or a phone call. If it emails a sign-in link instead of a code, call open_emailed_link (the owner is never asked for it); if none arrives, finish with no_code. When a code has been sent, call ask_owner_for_code (it reads the code from the owner's email, or asks the owner), then type_code. Pass any "Remember this device", "Trust this browser", "Keep me signed in" or "Don't ask again" checkbox as rememberRef so the next visit is not asked again. Never pay, enroll, change settings, accept offers or send messages. If a "Verify you are human" / "I'm not a robot" checkbox is on the page, call tick_captcha before submitting. If the page you start on asks for an account number (a bill lookup), use fill_account_number there rather than going to the sign-in. If the sign-in stays blocked by such a check, look for a way in without signing in — "Pay as guest", "Quick pay", "View bill", "Find my account" — and use fill_account_number (with the property's ZIP code if asked); statements found that way count the same. If a captcha still blocks you (a picture puzzle, or the check keeps failing), finish with captcha (on the owner's own computer they may solve it, and you are then shown the page to carry on). If the login is rejected, finish with bad_login. If a code you entered is rejected, ask_owner_for_code once more for a fresh one; after a second rejection finish with no_code — never start the login over.
Once you are signed in (you see the account, a greeting, a Log out button), an error after that — a bill viewer that fails, "unable to process your request" on one page — is not the site refusing the browser: go back and try another way to the statements ("View bill", "Billing history", "Documents", "View policy documents", "Statements"), and finish with blocked, saying which page failed, only when none works. Before signing in: if the site refuses the browser itself (Access Denied, "invalid request", "unable to process your request" right after submitting the sign-in, a bot check), finish with turned_away at once: never submit the login a second time — each retry makes the site more suspicious and can lock the owner's account.
If the portal has no statement documents at all (premium financing, some lenders), use save_page_as_statement on each account's payment schedule / history page, and on its main summary page when that shows an amount due or fees due (late fee, NSF fee) — so new fees are caught on every fetch.
Always end with the finish tool, never with a message. If the page seems gone or closed, call look: the browser follows the site to its newest tab. Each action returns the page as it is afterwards: do not call look after it. Fill and submit in one step (submitRef). A typical visit is: look, fill_login (with submit), code if asked, open billing/statements, download, finish — aim for about 10 steps. When several accounts are listed, choose the one matching the account number, else the address. The account number is what identifies the account: the address a portal shows is often the owner's mailing address, not the property's, so an account whose number matches is the right one whatever address it shows.`;
  // Every step that changed the page, in order: replayed ones and Claude's.
  // The ones before the first download become the recipe for next time.
  const steps: RecipeStep[] = [];
  let navDone = false;
  const recipe = lookup ? null : await loadRecipe(account.id, host);

  try {
    // Say which browser this is, so a run that was turned away shows why.
    say(`Opening ${start.hostname}`);
    const res = await openStart();
    // Refused before any sign-in (Safeco's and Nelnet's Access Denied): nothing for Claude to do.
    const title = await page.title().catch(() => '');
    if (res?.status() === 403 || /access denied|forbidden|attention required/i.test(title)) {
      throw Object.assign(new Error(`${start.hostname} answered ${res?.status() ?? ''} "${title || 'Access Denied'}" before any sign-in.`), { turnedAway: true });
    }
    let opening = "Start. The browser is open on the provider's login page (or its home page — find Sign in from there).";
    if (lookup) {
      say('Filling in the bill lookup');
      const f = await fillLookup(page, fullNumber, lookupName);
      // Nothing to look up without it: stop here, not on whatever page Claude would try next.
      if (f.missing.includes('name on the bill') && !lookupName) throw new Error('The lookup page asks for the name on the bill: add it on the account (Name on the bill), then Sync again.');
      if (f.searched) say('Searching for the bills');
      opening = `Start. The browser is on ${account.providerName}'s bill lookup page. `
        + (f.filled.length ? `Sollux filled in ${f.filled.join(' and ')}${f.searched ? ' and pressed Search' : ''}. ` : 'Sollux could not match the lookup fields by their labels: fill them with fill_account_number. ')
        + (f.captcha ? 'A "Verify you are human" check is on the page: call tick_captcha, then press Search. ' : '')
        + `Carry on to the invoices from here.\n\n${lastPage = await describe(page, secrets)}`;
    }
    if (recipe) {
      say(`Replaying the saved route (${recipe.steps.length} steps, no AI)`);
      const done = await replay(page, recipe.steps, { username, password }, h => allowed.has(rootOf(h)));
      run.replayed = done;
      steps.push(...recipe.steps.slice(0, done));
      try { const h = new URL(page.url()).hostname; if (h) allowed.add(rootOf(h)); } catch { /* about:blank */ }
      if (done === recipe.steps.length) {
        signedIn = true;
        opening = "Start. A previous run's steps were replayed: the browser should be signed in and on the page with the statement history. Look, then download what is new — or finish if nothing is.";
      } else {
        await recipeWorked(recipe.key, false);
        opening = `Start. A previous run's steps were replayed but the site has changed at step ${done + 1} of ${recipe.steps.length}; the browser is wherever that left it (possibly the login page). Look, and carry on to the statements.`;
      }
    }
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opening }];
    const stepLimit = (recipe && run.replayed === recipe.steps.length ? MAX_STEPS : MAX_STEPS_FIRST) + (n - 1) * 10;
    for (let step = 0; step < stepLimit && Date.now() < deadline && !cancelled; step++) {
      if ((run.costUsd ?? 0) >= costCap) { run.error = `Stopped after spending $${(run.costUsd ?? 0).toFixed(2)} without finishing — the portal needs a look.`; break; }
      // Cached: each step resends the run so far, and reads it back at a tenth of the price.
      const res = await meteredCreate(client, 'portal-agent', { ...paramsFor(PRIMARY_MODEL, { maxTokens: 1500, system, messages, cache: true }), tools: lookup ? LOOKUP_TOOLS : TOOLS });
      run.aiSteps = (run.aiSteps ?? 0) + 1;
      run.costUsd = (run.costUsd ?? 0) + costOf(PRIMARY_MODEL, res.usage);
      const uses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
      messages.push({ role: 'assistant', content: res.content });
      // Stopping with a note instead of finish is not a finished fetch: Blue
      // Shield's run wrote "the browser session has been fully terminated" and
      // was shown as a success.
      if (!uses.length) {
        const note = res.content.map(c => (c.type === 'text' ? c.text : '')).join('').replace(/\s+/g, ' ').trim();
        run.error = `The agent stopped without finishing: ${note.slice(0, 400) || 'no reason given'}`;
        break;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      let finished = false;
      for (const u of uses) {
        const i = u.input as any;
        // The element numbered [ref] by the last look, in whichever frame it is in.
        const el = (ref: number) => refLocator(page, ref);
        let content: Anthropic.ToolResultBlockParam['content'] = 'ok';
        let rec: RecipeStep | null = null;
        let recAfter: RecipeStep | null = null; // the submit click that fill_login made
        if (u.name === 'download_statement' || u.name === 'save_page_as_statement' || u.name === 'finish') navDone = true;
        const n = `Step ${step + 1}`;
        if (u.name === 'look') say(`${n}: reading the page${await page.title().then(t => (t ? ` "${t.slice(0, 60)}"` : '')).catch(() => '')}`);
        else if (u.name === 'click') {
          // What it clicks, as the page described it when the element has no label of its own (a bare checkbox).
          const label = await targetOf(page, i.ref).then(t => t?.label ?? '').catch(() => '')
            || (lastPage.match(new RegExp(`\\[${Number(i.ref)}\\]([^\\n]*)`))?.[1] ?? '').replace(/\s+/g, ' ').trim();
          say(`${n}: clicking${label ? ` "${label.slice(0, 50)}"` : ''}`);
        }
        else if (u.name === 'fill_login') say(`${n}: signing in`);
        else if (u.name === 'fill_account_number') say(`${n}: looking up the bill by account number`);
        else if (u.name === 'save_page_as_statement') say(`${n}: saving this page as the statement (${String(i.statementDate ?? '').slice(0, 20)})`);
        else if (u.name === 'download_statement') say(`${n}: downloading a statement${i.statementDate ? ` (${String(i.statementDate).slice(0, 20)})` : ''}`);
        else if (u.name === 'goto') say(`${n}: opening ${String(i.url).replace(/^https?:\/\//, '').slice(0, 60)}`);
        else if (u.name === 'type_code') say(`${n}: entering the verification code`);
        else if (u.name === 'type') say(`${n}: typing`);
        else if (u.name === 'select') say(`${n}: choosing "${String(i.label).slice(0, 40)}"`);
        else if (u.name === 'ask_owner_for_code') say(`${n}: the portal sent a verification code`);
        else if (u.name === 'tick_captcha') say(`${n}: ticking "Verify you are human"`);
        else if (u.name === 'open_emailed_link') say(`${n}: the portal emailed a sign-in link — looking for it in your email`);
        if (['click', 'fill_login', 'fill_account_number', 'press', 'type', 'select', 'goto', 'type_code'].includes(u.name)) { actedAt = Date.now(); tabsAtAction = runPages.length; }
        await follow();
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
            case 'look': content = lastPage = await describe(page, secrets); break;
            case 'screenshot': content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: (await page.screenshot({ type: 'png', scale: 'css' })).toString('base64') } }]; break;
            case 'click': {
              const before = lastPage;
              await el(i.ref).click({ timeout: 10000 });
              content = await after('Clicked.');
              // A click that changes nothing, said plainly: Westlake's run spent
              // a dozen steps clicking an option card that never took.
              // A lookup account never signs in: a click that lands on a sign-in page is undone.
              if (lookup && await onSignIn(page)) {
                await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                content = await after('That opened a sign-in page, which this account never uses: the browser is back on the lookup page. Fill it in (fill_account_number) and press Search.');
                break;
              }
              if (lastPage === before) content = `Clicked, but nothing on the page changed. If that was an option card or a custom checkbox, click its text or the box itself (or press Space on it); if a Continue button stays disabled, something above it still needs choosing. Do not click the same thing again.\n\n${lastPage}`;
              break;
            }
            case 'type':
              await el(i.ref).fill(String(i.text ?? ''));
              if (i.submit) await el(i.ref).press('Enter');
              content = await after(i.submit ? 'Typed and submitted.' : 'Typed.'); break;
            case 'select': await el(i.ref).selectOption({ label: String(i.label) }); content = await after('Selected.'); break;
            case 'fill_account_number': {
              if (i.part === 'name' && !lookupName) { content = 'No name on the bill is saved for this account: finish with blocked and say "Add the name on the bill (Portal login on the account)".'; break; }
              if (i.part !== 'name' && !fullNumber) { content = 'No full account number is saved for this account — sign in instead, or finish with blocked.'; break; }
              const parts = fullNumber.split(/[\s-]+/).filter(Boolean);
              const value = i.part === 'name' ? lookupName : i.part === 'first' ? parts[0] : i.part === 'second' ? (parts[1] ?? parts[0]) : fullNumber;
              await el(i.ref).fill(value);
              if (i.submitRef != null) await el(i.submitRef).click({ timeout: 10000 });
              content = await after(i.submitRef != null ? 'Account number entered and submitted.' : 'Account number entered.');
              break;
            }
            case 'fill_login': {
              if (i.usernameRef == null && i.passwordRef == null) { content = 'Give usernameRef and/or passwordRef.'; break; }
              if (i.usernameRef != null) await el(i.usernameRef).fill(username);
              if (i.passwordRef != null) await el(i.passwordRef).fill(password);
              if (i.rememberRef != null) await el(i.rememberRef).check({ timeout: 3000 }).catch(() => el(i.rememberRef).click({ timeout: 3000 }).catch(() => {}));
              if (i.submitRef != null) await el(i.submitRef).click({ timeout: 10000 });
              content = await after(i.submitRef != null ? 'Signed in details entered and submitted.' : 'Entered.');
              if (i.passwordRef != null && i.submitRef != null && await looksSignedIn(page, lastPage)) signedIn = true;
              break;
            }
            case 'press': await page.keyboard.press(String(i.key)); content = await after(`Pressed ${i.key}.`); break;
            case 'goto': {
              const url = new URL(String(i.url), page.url());
              if (url.protocol !== 'https:' || !allowed.has(rootOf(url.hostname))) { content = 'Refused: only the provider\'s own site.'; break; }
              if (lookup && SIGN_IN_URL.test(url.pathname)) { content = 'Refused: this account is found with the lookup page, never by signing in.'; break; }
              await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
              if (lookup && await onSignIn(page)) {
                await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                content = await after('That is a sign-in page, which this account never uses: the browser is back on the lookup page. Fill it in (fill_account_number) and press Search.');
                break;
              }
              if (!navDone) rec = { tool: 'goto', url: url.toString() };
              content = await after('Opened.');
              break;
            }
            case 'save_page_as_statement':
            case 'download_statement': {
              if (run.downloads >= maxDownloads) { content = `Limit of ${maxDownloads} reached — finish.`; break; }
              const got = [...pdfsSeen.values()].join(', ') || 'none yet';
              // Already on file for that date: nothing to click for. A saved
              // page is always read again — its fees change after the bill.
              const day = u.name === 'download_statement' && /^\d{4}-\d{2}-\d{2}$/.test(String(i.statementDate ?? '')) ? new Date(`${i.statementDate}T12:00:00Z`) : null;
              if (day && await db.statement.findFirst({ where: { utilityAccountId: { in: [account.id, ...others.map(o => o.id)] }, pdfS3Key: { not: null }, statementDate: { gte: new Date(day.getTime() - 36e5 * 36), lte: new Date(day.getTime() + 36e5 * 36) } }, select: { id: true } })) {
                content = `The ${i.statementDate} statement is already on file — not downloaded. Downloaded this run: ${got}. Move to an older or newer one, or finish.`;
                break;
              }
              const pdf = u.name === 'save_page_as_statement' ? await pageAsPdf(page)
                : await capturePdf(ctx, page, () => el(i.ref).click({ timeout: 10000 }), (remote as Browser | null) ? remoteFiles : undefined);
              if (!pdf) { content = 'No PDF came back from that click. Try the link that opens or downloads the statement itself.'; break; }
              // The same file again (Blue Shield's past bills gave one PDF over
              // and over; the run read it ten times and ran out of steps):
              // not read again, and the agent is told so.
              const hash = crypto.createHash('sha256').update(pdf).digest('hex');
              if (pdfsSeen.has(hash)) {
                repeats++;
                if (repeats >= 3) {
                  // The third time: stop here, keeping what came in.
                  finished = true;
                  run.summary = run.downloads
                    ? `Downloaded ${run.downloads} statement${run.downloads === 1 ? '' : 's'} (${got}); the site kept giving the same PDF after that, so the fetch stopped there.`
                    : '';
                  if (!run.downloads) run.error = 'The site gave the same PDF every time — the agent could not reach the statements themselves.';
                  content = 'Stopped: the same PDF three times.';
                  break;
                }
                content = `That is the same PDF as one already downloaded this run (${pdfsSeen.get(hash)}) — not saved again. Downloaded this run: ${got}. This link does not give a different statement: try a different row, or finish.`;
                break;
              }
              pdfsSeen.set(hash, String(i.statementDate ?? `statement ${pdfsSeen.size + 1}`));
              run.downloads++;
              const name = `${account.providerName.replace(/[^\w]+/g, '_')}_${String(i.statementDate ?? run.downloads).replace(/[^\w-]+/g, '_')}.pdf`;
              const r = await intakeBill(pdf, name, userId, 'ai', batchId, 'portal');
              if (r.outcome === 'filed') { run.filed++; run.filedFor![r.utilityAccountId] = (run.filedFor![r.utilityAccountId] ?? 0) + 1; }
              else if (r.outcome === 'review') { run.review++; review.push(r.reviewItem); }
              else if (r.outcome === 'error') content = `Saved, but: ${r.error}`;
              else run.applied++;
              if (content === 'ok') content = `Statement saved (${r.outcome}). Downloaded this run: ${[...pdfsSeen.values()].join(', ')}.`;
              break;
            }
            case 'ask_owner_for_code': {
              if (triedCodes.size >= 2) { content = 'Two codes have been rejected — finish with no_code.'; break; }
              const mailHost = new URL(page.url()).hostname || start.hostname;
              // Only mail sent after the action that made the portal send the code (a little slack for clocks).
              const since = new Date(Math.max(runStartedAt, actedAt) - 10_000);
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
              const linkHost = new URL(page.url()).hostname || start.hostname, linkSince = new Date(Math.max(runStartedAt, actedAt) - 10_000);
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
            case 'tick_captcha': {
              const boxes = page.frames().filter(f => CAPTCHA_FRAME.test(f.url()));
              if (!boxes.length) { content = await after('There is no checkbox check on this page.'); break; }
              for (const f of boxes) {
                const owner = await f.frameElement().catch(() => null);
                const box = owner ? await owner.boundingBox().catch(() => null) : null;
                if (!box || box.width < 20) continue;
                // The checkbox sits at the left of the widget; get there the way a hand would.
                const x = box.x + Math.min(30, box.width / 4), y = box.y + box.height / 2;
                await page.mouse.move(x - 60 - Math.random() * 30, y + 20 + Math.random() * 10, { steps: 6 });
                await page.mouse.move(x + Math.random() * 3, y + Math.random() * 3, { steps: 14 });
                await page.waitForTimeout(150 + Math.random() * 250);
                await page.mouse.click(x, y);
              }
              await page.waitForTimeout(5000);
              content = await after('Ticked the check. If it passed (no error, or a green tick), carry on; if a picture puzzle or "complete the security check" remains, finish with captcha.');
              break;
            }
            case 'type_code': {
              if (!code) { content = 'No code yet — call ask_owner_for_code.'; break; }
              await fillCode(el(i.ref), code);
              triedCodes.add(code);
              if (i.rememberRef != null) await el(i.rememberRef).check({ timeout: 3000 }).catch(() => el(i.rememberRef).click({ timeout: 3000 }).catch(() => {}));
              if (i.submitRef != null) await el(i.submitRef).click({ timeout: 10000 });
              content = await after(i.submitRef != null ? 'Code entered and submitted.' : 'Code entered.');
              if (i.submitRef != null && await looksSignedIn(page, lastPage)) signedIn = true;
              code = null; // used: a rejected code is never typed again
              break;
            }
            case 'finish':
              // A captcha on the owner's own computer, with the owner watching:
              // they can tick it in that Chrome window. Wait for it once.
              // A human check on the owner's own computer, with the owner watching.
              // Cloudflare fails even a person's tick while software drives the
              // window (City of Imperial: "Verification failed"), so the agent lets
              // go of it, asks the owner to tick it (and sign in or search if they
              // like), then takes the window back.
              if (String(i.outcome) === 'captcha' && (remote as Browser | null) && opts.interactive && !askedCaptcha) {
                askedCaptcha = true;
                const host = new URL(page.url()).hostname;
                ctx.off('page', onNewTab);
                await (remote as Browser | null)?.close().catch(() => {});
                remote = null;
                const prompt = `Tick "Verify you are human" in the Chrome window on ${connector!.name} — sign in or search there too if you like — then type done here.`;
                await db.utilityAccount.update({ where: { id: account.id }, data: { mfaPrompt: prompt, mfaRequestedAt: new Date(), mfaCodeEnc: null } });
                say(prompt);
                const until = Date.now() + CODE_WAIT_MS;
                let done = false;
                while (!done && !cancelled && Date.now() < until) {
                  await new Promise(r => setTimeout(r, 3000));
                  const a = await db.utilityAccount.findUnique({ where: { id: account.id }, select: { mfaCodeEnc: true } });
                  done = !!a?.mfaCodeEnc;
                }
                await db.utilityAccount.update({ where: { id: account.id }, data: { mfaPrompt: null, mfaRequestedAt: null, mfaCodeEnc: null } });
                // Take the window back: the owner's tab on the portal, as they left it.
                const again = await connectorFor(userId);
                if (again && !cancelled) {
                  remote = await chromium.connectOverCDP(again.wsUrl, { timeout: 30_000 }).catch(() => null);
                  if (remote) liveWs = again.wsUrl;
                  const back = remote?.contexts()[0];
                  const tab = back?.pages().filter(p => { try { return new URL(p.url()).hostname === host; } catch { return false; } }).pop();
                  if (back && tab) {
                    ctx = back; page = tab; runPages.push(tab); ctx.on('page', onNewTab);
                    lastPage = await describe(page, secrets).catch(() => '');
                    content = done
                      ? `Not finished: the owner dealt with the check in the window (and may have signed in or searched). Carry on from here.\n\n${lastPage}`
                      : `The owner did not get to the check in time. Finish with captcha.\n\n${lastPage}`;
                    if (done) break;
                  }
                }
              }
              // Before giving up, look once more: T-Mobile flashes "Invalid
              // request, access denied" for a moment and then moves on to its
              // code page — the run stopped there with the code already sent.
              if (['turned_away', 'blocked', 'captcha'].includes(String(i.outcome)) && !rechecked) {
                rechecked = true;
                await page.waitForTimeout(5000);
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                const now = await describe(page, secrets).catch(() => lastPage);
                if (now !== lastPage) {
                  lastPage = now;
                  content = `Not finished: the page changed after a few seconds. If it now goes on (a code page, the account), carry on; otherwise finish again.\n\n${now}`;
                  break;
                }
              }
              // A saved deep sign-in link (Mohela's login.do?command=…, CRI's
              // auth page) can answer "invalid request" or "not available" when
              // not reached from the site itself: start once from the home page.
              if (['turned_away', 'blocked'].includes(String(i.outcome)) && !triedHome && !lookup) {
                triedHome = true;
                const home = findProvider(account.providerName, account.providerSlug)?.site ?? `${start.origin}/`;
                try {
                  const h = new URL(home);
                  if (h.href !== page.url()) {
                    allowed.add(rootOf(h.hostname));
                    await page.goto(h.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    content = await after(`Not finished: the saved sign-in link may only work when reached from the site itself, so the browser is now on ${account.providerName}'s home page. Find Log in / Sign in here and carry on; if this is refused too, finish again.`);
                    break;
                  }
                } catch { /* the home page did not open either: finish */ }
              }
              finished = true;
              run.ok = i.outcome === 'done';
              run.summary = String(i.summary ?? '').slice(0, 500);
              if (Array.isArray(i.accounts)) run.accountResults = Object.fromEntries(i.accounts.map((a: { account?: unknown; result?: unknown }) => [String(a.account ?? '').replace(/\D/g, '').slice(-4), String(a.result ?? '')]));
              if (!run.ok) run.error = { bad_login: 'The portal rejected the username or password.', captcha: 'The portal showed a captcha the agent cannot solve — sync this one by email or upload.', no_code: `The portal asked for a verification code or sign-in link and none was found. ${mailNote || 'It may go to your phone.'}${opts.interactive ? '' : ' Press Fetch now to type it yourself.'}`, turned_away: 'turned_away', blocked: 'The agent could not get to the statements.' }[String(i.outcome)] + (run.summary ? ` ${run.summary}` : '');
              break;
            default: content = 'Unknown tool.';
          }
          if (rec) steps.push(rec);
          if (recAfter) steps.push(recAfter);
        } catch (err) {
          const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
          content = `Failed: ${why}`;
          if (!cancelled && /has been closed|Target closed|browser has disconnected|Connection closed/i.test(why)) {
            const back = await reopen();
            if (back === true) content = `The browser closed partway through and was opened again on the sign-in page. Start over from here — the earlier steps did not finish.\n\n${lastPage}`;
            else if (back) { run.error = back; finished = true; }
          }
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
    if (!run.summary && !run.error && run.downloads > 0) {
      // Statements came in before the steps ran out: that is a fetch, not a failure.
      run.summary = `Downloaded ${run.downloads} statement${run.downloads === 1 ? '' : 's'} (${[...pdfsSeen.values()].join(', ')}); stopped at the step limit before checking for more — press Fetch now to look again.`;
    } else if (!run.summary && !run.error) {
      // Where it got stuck, so the next look starts from there.
      const at = await page.title().catch(() => '');
      run.error = `The agent ran out of steps before finishing (last on ${at ? `"${at.slice(0, 80)}" — ` : ''}${page.url().slice(0, 120)}).`;
    }
    if (!run.error) run.ok = true;
    // Reached the statements: keep the way there for next time.
    if (run.ok && navDone && !lookup) {
      if (recipe && run.replayed === recipe.steps.length) await recipeWorked(recipe.key, true);
      else await saveRecipe(account.id, host, steps);
    }
  } catch (err) {
    run.error = cancelled ? 'Cancelled by you.' : err instanceof Error ? err.message.split('\n')[0] : String(err);
    if ((err as { turnedAway?: boolean })?.turnedAway) run.error = `turned_away ${run.error}`;
    else if (!cancelled && /has been closed|Target closed|browser has disconnected|Connection closed/i.test(run.error ?? '')) {
      run.error = (await reopen(false).then(b => (typeof b === 'string' ? b : null), () => null)) ?? run.error;
    }
  } finally {
    if (watch) clearInterval(watch);
    if (cancelled) { run.ok = false; run.error = 'Cancelled by you.'; }
    // Keep the cookies after a good run, or once a code got us in (the trusted-device cookie).
    if (run.ok || usedCode) {
      try {
        const state = await ctx.storageState();
        const cookies = state.cookies.filter(k => !BOT_COOKIE.test(k.name));
        // The same login's other accounts share the sign-in (and its trusted device).
        for (const id of [account.id, ...others.map(o => o.id)]) {
          await db.portalSession.upsert({ where: { utilityAccountId: id }, create: { utilityAccountId: id, stateEnc: encrypt(JSON.stringify({ cookies })) }, update: { stateEnc: encrypt(JSON.stringify({ cookies })) } });
        }
      } catch (err) { console.warn('[PortalAgent] session not saved:', err instanceof Error ? err.message.split('\n')[0] : err); }
    }
    await shutdown();
    await db.utilityAccount.update({ where: { id: account.id }, data: { lastAgentRunAt: new Date(), mfaPrompt: null, mfaRequestedAt: null, mfaCodeEnc: null } }).catch(() => {});
  }

  // Turned away (said so, or the summary shows it whatever outcome was picked):
  // say what it means, and hold scheduled fetches of this site for a while.
  const refused = !!run.error && (run.error.startsWith('turned_away') || TURNED_AWAY.test(`${run.error} ${run.summary}`));
  if (!run.ok && refused && signedIn) {
    // Signed in: say what went wrong after it, first, and hold nothing back.
    const detail = run.error!.replace(/^turned_away\s*/, '').replace(/^The agent could not get to the statements\.\s*/, '');
    run.error = `Signed in to ${account.providerName}, but the site showed an error on the way to the statements (not bot protection — the sign-in worked). ${detail}`;
  } else if (!run.ok && run.error && !/^Not tried/.test(run.error) && refused) {
    const until = Date.now() + TURNED_AWAY_MS;
    turnedAway.set(host, until);
    const detail = run.error.replace(/^turned_away\s*/, '').replace(/^The agent could not get to the statements\.\s*/, '');
    run.error = (remote as Browser | null)
      ? `${account.providerName} turned away the Chrome on ${connector!.name} too (bot protection, not your password). Sign in to ${start.hostname} by hand once in that Chrome window — the agent uses that sign-in next time — or bring its bills in by email or upload. ${detail}`
      : `${account.providerName} turned Sollux's browser away (bot protection, not your password); scheduled fetches wait until ${clock(until)} so the login isn't locked. If it keeps happening the site blocks cloud servers: turn on Fetch from your computer (Settings → AI usage), or bring its bills in by email or upload. ${detail}`;
  }

  // First, so it is not cut off where the error is shown short.
  if (!run.ok && connectorProblem && run.error) run.error = `${connectorProblem} ${run.error}`;

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
