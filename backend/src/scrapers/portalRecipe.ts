/**
 * Portal recipes: the clicks that took the portal agent from a provider's
 * sign-in page to its statements, kept so the next run replays them in the
 * browser without asking Claude. Claude is then only needed at the end —
 * to pick out the statements that are new — or when the site has changed
 * and a step no longer matches, where it carries on from wherever the
 * replay stopped and the recipe is re-recorded.
 *
 * Elements are found again by what a person sees (tag, label, link), not by
 * position, so a page that moves things around still matches. Nothing
 * secret is stored: logins are a fill_login step that names the fields, and
 * the username and password are typed from the account at replay time.
 *
 * A recipe with nothing specific to one account (no typed text, no account
 * numbers in what it clicks) is kept per provider site, so everyone on that
 * provider gets it; otherwise it is kept per account.
 */
import type { Page, Locator, Frame } from 'playwright';
import { db } from '../config/db';

export interface Target { tag: string; label: string; href?: string; type?: string; name?: string }
export type RecipeStep =
  | { tool: 'click'; target: Target }
  | { tool: 'type'; target: Target; text: string }
  | { tool: 'select'; target: Target; label: string }
  | { tool: 'fill_login'; user?: Target; pass?: Target }
  | { tool: 'press'; key: string }
  | { tool: 'goto'; url: string };

const INTERACTIVE = 'a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]';

// Which frame each element numbered by describe() is in: a sign-in form in
// an embedded frame is not reachable from the page's own locator.
const refFrames = new WeakMap<Page, Map<number, Frame>>();
export function setRefFrames(page: Page, refs: Map<number, Frame>): void { refFrames.set(page, refs); }
/** Element [ref], found in its own frame; Playwright's CSS locators see inside open shadow DOM. */
export function refLocator(page: Page, ref: number): Locator {
  const frame = refFrames.get(page)?.get(Number(ref)) ?? page.mainFrame();
  return frame.locator(`[data-sref="${Number(ref)}"]`).first();
}

/** What element [ref] (as numbered by describe()) looks like to a person. */
export async function targetOf(page: Page, ref: number): Promise<Target | null> {
  return refLocator(page, ref).evaluate((el) => {
    const inp = el as HTMLInputElement;
    const label = (el.getAttribute('aria-label') || (inp.labels && inp.labels[0]?.innerText) || inp.placeholder || el.getAttribute('title') || (el as HTMLElement).innerText || inp.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const href = el.tagName === 'A' ? (el as HTMLAnchorElement).getAttribute('href') || undefined : undefined;
    return { tag: el.tagName.toLowerCase(), label, href: href?.slice(0, 300), type: el.tagName === 'INPUT' ? inp.type || 'text' : undefined, name: inp.name || undefined };
  }).catch(() => null);
}

/** The element on the page now that matches a recorded target, waiting a little for it to render. */
async function find(page: Page, t: Target, waitMs = 8000): Promise<Locator | null> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    // Every frame, and inside web components (shadow DOM), as describe() reads them.
    for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    const hit = await frame.evaluate(({ t, sel }) => {
      // No named helper functions in here: the page runs this as plain source,
      // and a dev build's name-keeping wrapper (__name) does not exist there.
      const roots: (Document | ShadowRoot)[] = [document];
      for (let k = 0; k < roots.length; k++) {
        roots[k].querySelectorAll('[data-rref]').forEach(el => el.removeAttribute('data-rref'));
        for (const el of Array.from(roots[k].querySelectorAll('*'))) if (el.shadowRoot) roots.push(el.shadowRoot);
      }
      const candidates: Element[] = [];
      for (const root of roots) candidates.push(...Array.from(root.querySelectorAll(sel)));
      let wantPath = '';
      try { wantPath = t.href ? new URL(t.href, location.href).pathname : ''; } catch { /* not a URL */ }
      let best: Element | null = null, bestScore = 0;
      for (const el of candidates) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || getComputedStyle(el as HTMLElement).visibility === 'hidden') continue;
        if (el.tagName.toLowerCase() !== t.tag) continue;
        const inp = el as HTMLInputElement;
        const label = (el.getAttribute('aria-label') || (inp.labels && inp.labels[0]?.innerText) || inp.placeholder || el.getAttribute('title') || (el as HTMLElement).innerText || inp.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        let score = 0;
        if (t.label && label === t.label) score += 4;
        if (wantPath && el.tagName === 'A') {
          let path = '';
          try { path = new URL(el.getAttribute('href') || '', location.href).pathname; } catch { /* not a URL */ }
          if (path === wantPath) score += 3;
        }
        if (t.name && inp.name === t.name) score += 3;
        if (t.type && (inp.type || 'text') === t.type) score += 1;
        // Its label, its link or its field name must match; the type alone is not enough.
        if (score >= 3 && score > bestScore) { best = el; bestScore = score; }
      }
      if (!best) return false;
      best.setAttribute('data-rref', '1');
      return true;
    }, { t, sel: INTERACTIVE }).catch(() => false);
    if (hit) return frame.locator('[data-rref="1"]').first();
    }
    await page.waitForTimeout(500);
  }
  return null;
}

const settle = (page: Page) => page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

/**
 * Replay a recipe. Returns how many steps went through; fewer than the
 * recipe has means the site changed at that step, and the agent takes over
 * from there.
 */
export async function replay(page: Page, steps: RecipeStep[], login: { username: string; password: string }, allowedHost: (host: string) => boolean): Promise<number> {
  let done = 0;
  for (const s of steps) {
    try {
      if (s.tool === 'goto') {
        const url = new URL(s.url);
        if (url.protocol !== 'https:' || !allowedHost(url.hostname)) break;
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else if (s.tool === 'press') {
        await page.keyboard.press(s.key); await settle(page);
      } else if (s.tool === 'fill_login') {
        // A username-only page (the password comes on the next one).
        if (!s.pass) {
          const user = s.user ? await find(page, s.user) : null;
          if (!user) { if (await page.locator('input[type=password]').count() === 0 && !(await page.locator('input[type=email]').count())) { done++; continue; } break; }
          await user.fill(login.username);
          done++;
          continue;
        }
        const pass = await find(page, s.pass);
        // Already signed in (the browser kept the session): skip the login.
        if (!pass) { if (await page.locator('input[type=password]').count() === 0) { done++; continue; } break; }
        if (s.user) { const user = await find(page, s.user, 2000); if (user) await user.fill(login.username); }
        await pass.fill(login.password);
      } else {
        const el = await find(page, s.target);
        if (!el) {
          // A step on the sign-in form that is not there because the session is still signed in.
          if (await page.locator('input[type=password]').count() === 0 && /sign ?in|log ?in|submit|continue/i.test(s.target.label)) { done++; continue; }
          break;
        }
        if (s.tool === 'click') { await el.click({ timeout: 10000 }); await settle(page); }
        else if (s.tool === 'type') await el.fill(s.text);
        else await el.selectOption({ label: s.label });
      }
      done++;
    } catch {
      break;
    }
  }
  return done;
}

/** Specific to one account: anything typed, or an account number in what was clicked. */
function accountSpecific(steps: RecipeStep[]): boolean {
  const digits = /\d{4,}/;
  return steps.some(s => s.tool === 'type' || ('target' in s && (digits.test(s.target.label) || digits.test(s.target.href ?? ''))));
}

/**
 * Payment platforms that host many billers on one site (InvoiceCloud serves
 * City of Imperial and City of Oceanside alike): a route through one biller's
 * pages is not a route through another's, so these are never shared per site.
 */
const SHARED_PLATFORMS = /(^|\.)(invoicecloud\.com|paymentus\.com|doxo\.com|xpressbillpay\.com|municipalonlinepayments\.com|papergov\.com|govpaynow\.com|nexbillpay\.com|billerpayments\.com|smartbill\.com)$/i;

export async function loadRecipe(accountId: string, host: string): Promise<{ key: string; steps: RecipeStep[] } | null> {
  const r = await db.portalRecipe.findUnique({ where: { key: `acct:${accountId}` } })
    ?? (SHARED_PLATFORMS.test(host) ? null : await db.portalRecipe.findUnique({ where: { key: `host:${host}` } }));
  return r ? { key: r.key, steps: r.steps as unknown as RecipeStep[] } : null;
}

/** Keep the steps of a run that reached the statements. */
export async function saveRecipe(accountId: string, host: string, steps: RecipeStep[]): Promise<void> {
  if (!steps.length) return;
  const key = accountSpecific(steps) || SHARED_PLATFORMS.test(host) ? `acct:${accountId}` : `host:${host}`;
  await db.portalRecipe.upsert({
    where: { key },
    create: { key, host, steps: steps as any, successes: 1 },
    update: { steps: steps as any, successes: { increment: 1 }, failures: 0 },
  }).catch(err => console.warn('[PortalRecipe] could not save:', err instanceof Error ? err.message : err));
}

export async function recipeWorked(key: string, worked: boolean): Promise<void> {
  await db.portalRecipe.update({ where: { key }, data: worked ? { successes: { increment: 1 } } : { failures: { increment: 1 } } }).catch(() => {});
}
