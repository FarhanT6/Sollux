/**
 * Screen tests at iPhone size. Starts the dev server in mock mode (a
 * stand-in for Clerk, src/dev/clerkMock.tsx), serves the API from
 * scripts/mock-api.mjs, opens each route in Chromium as an iPhone 15
 * (393×852, 3x, touch) and saves a screenshot. Any page error, console
 * error, failed request or sideways overflow is reported, and fails the run.
 *
 *   node scripts/screens.mjs [outDir] [route ...]
 *
 * Playwright comes from the backend's dependencies (it prints e-bills there).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { handle } from './mock-api.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, '../backend/package.json'));
const { chromium } = require('playwright');

const [outDir = join(root, '.screens'), ...only] = process.argv.slice(2);
const ROUTES = only.length ? only : [
  '/dashboard', '/properties', '/scan', '/finances', '/payments', '/more',
  '/portfolio', '/settings', '/import', '/insights', '/tenants', '/personal', '/vault',
  '/taxes', '/compliance', '/projects', '/operations', '/legal', '/payments/priorities',
];
mkdirSync(outDir, { recursive: true });

// A free port each run, so back-to-back runs never collide.
import { createServer } from 'node:net';
const PORT = await new Promise(res => { const srv = createServer(); srv.listen(0, () => { const p = srv.address().port; srv.close(() => res(p)); }); });
const server = spawn('npx', ['vite', '--mode', 'mock', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite did not start')), 60000);
  server.stdout.on('data', d => { if (String(d).includes('Local:')) { clearTimeout(t); resolve(); } });
  server.stderr.on('data', d => process.stderr.write(d));
});

// The preinstalled Chromium when there is one (cloud sessions), else Playwright's own.
import { existsSync } from 'node:fs';
const exe = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
// DESKTOP=1: a laptop window instead of an iPhone.
const ctx = await browser.newContext(process.env.DESKTOP ? {
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
  colorScheme: process.env.SCHEME === 'light' ? 'light' : 'dark',
} : {
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  colorScheme: process.env.SCHEME === 'light' ? 'light' : 'dark',
});
// The app's own theme choice (Settings / More → Appearance), not the device's.
await ctx.addInitScript(t => { try { localStorage.setItem('sollux.theme', t); } catch {} }, process.env.SCHEME === 'light' ? 'light' : 'dark');
// Only the API (not Vite's /src/api/*.ts modules). Outside hosts (fonts) are
// served nothing, so the run needs no network and no certificates.
await ctx.route(u => u.hostname !== 'localhost', route => route.fulfill({ status: 200, body: '' }));
// The real API when the local dev stack is up (backend on :3001 with
// scripts/dev/devAuth.cjs and a seeded database; Vite proxies /api to it),
// else the sample answers in mock-api.mjs.
const realApi = await fetch('http://localhost:3001/api/dashboard/summary').then(r => r.ok).catch(() => false);
console.log(realApi ? 'API: local dev stack on :3001' : 'API: mock-api.mjs');
if (!realApi) await ctx.route(u => u.hostname === 'localhost' && u.pathname.startsWith('/api/'), async route => {
  const req = route.request();
  const url = new URL(req.url());
  const r = handle(req.method(), url.pathname.replace(/^\/api/, ''), url.searchParams, req.postDataJSON?.() ?? null);
  await route.fulfill({ status: r.status ?? 200, contentType: 'application/json', body: JSON.stringify(r.body ?? null) });
});

let failed = false;
for (const path of ROUTES) {
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`); });
  page.on('response', r => { if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`); });
  await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    // Inside a sideways-scrolling strip (tabs, chips) is fine; the page itself must not scroll sideways.
    const inScroller = el => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
    const wide = [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > w + 1 && getComputedStyle(el).position !== 'fixed' && !inScroller(el));
    return wide.slice(0, 3).map(el => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(el.getBoundingClientRect().right)}`);
  });
  if (overflow.length) problems.push(`sideways overflow: ${overflow.join(' | ')}`);
  const file = join(outDir, `${path.replace(/\//g, '_').replace(/^_/, '') || 'root'}.png`);
  await page.screenshot({ path: file });
  console.log(`${problems.length ? '✗' : '✓'} ${path} → ${file}`);
  for (const p of problems) console.log(`    ${p}`);
  if (problems.length) failed = true;
  await page.close();
}
// Flows: tap through the phone navigation and check where each tap lands.
if (!only.length || process.env.FLOWS) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const base = `http://localhost:${PORT}`;
  const step = async (name, fn) => {
    try { await fn(); console.log(`✓ flow: ${name}`); }
    catch (e) { failed = true; console.log(`✗ flow: ${name}\n    ${String(e.message).split('\n')[0]}`); await page.screenshot({ path: join(outDir, `flow-fail-${name.replace(/\W+/g, '-')}.png`) }); }
  };
  const expectPath = async (re) => { await page.waitForURL(u => re.test(u.pathname + u.search), { timeout: 5000 }); };
  await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
  await step('tab bar → Utilities', async () => { await page.getByRole('link', { name: 'Utilities' }).last().click(); await expectPath(/^\/properties$/); });
  await step('utility row → account page', async () => { await page.locator('a.ios-row').first().click(); await expectPath(/^\/properties\/[^/]+\/utilities\/[^/]+$/); });
  await step('browser back → Utilities', async () => { await page.goBack(); await expectPath(/^\/properties$/); await page.locator('.ios-largetitle h1', { hasText: 'Utilities' }).waitFor(); });
  await step('account: Back is named for where you came from', async () => {
    await page.locator('a.ios-row').first().click(); await expectPath(/\/utilities\//);
    await page.getByRole('button', { name: 'Utilities' }).waitFor();
  });
  await step('account: a bill opens its sheet', async () => {
    await page.locator('button.ios-row', { hasText: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* 20\d\d/ }).first().click();
    await page.locator('.ios-sheet').getByRole('button', { name: /Mark as (paid|unpaid)/ }).waitFor();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.locator('.ios-sheet').waitFor({ state: 'detached' });
  });
  await step('account: Log payment opens the form in a sheet', async () => {
    await page.getByRole('tab', { name: 'Payments' }).click();
    await page.getByRole('button', { name: 'Log payment' }).click();
    await page.locator('.ios-sheet input').first().waitFor();
    await page.locator('.ios-sheet').getByRole('button', { name: 'Cancel' }).click();
    await page.locator('.ios-sheet').waitFor({ state: 'detached' });
  });
  await step('account: actions sheet', async () => {
    await page.getByRole('button', { name: 'Account actions' }).click();
    await page.locator('.ios-sheet').getByText('Delete account').waitFor();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.locator('.ios-sheet').waitFor({ state: 'detached' });
  });
  await step('account: portal login opens in a sheet', async () => {
    await page.getByRole('button', { name: 'Account actions' }).click();
    await page.locator('.ios-sheet button.ios-row', { hasText: 'Portal login' }).click();
    await page.locator('.ios-sheet input[type="password"]').waitFor();
    await page.locator('.ios-sheet').getByRole('button', { name: 'Cancel' }).click();
    await page.locator('.ios-sheet').waitFor({ state: 'detached' });
  });
  await step('account: Back returns to Utilities', async () => {
    await page.getByRole('button', { name: 'Utilities' }).click(); await expectPath(/^\/properties$/);
  });
  await step('deep link to a page: Back goes to its parent', async () => {
    await page.goto(`${base}/tenants`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'More' }).click(); await expectPath(/^\/more$/);
  });
  await step('Finances index → section → back', async () => {
    await page.getByRole('link', { name: 'Finances' }).last().click(); await expectPath(/^\/finances$/);
    await page.locator('a.ios-row', { has: page.locator('.ios-row-title', { hasText: /^Loans$/ }) }).first().click(); await expectPath(/tab=loans/);
    await page.getByRole('button', { name: 'Finances' }).click(); await expectPath(/^\/finances$/);
  });
  await step('Payments row opens a sheet, Done closes it', async () => {
    await page.getByRole('link', { name: 'Payments' }).last().click(); await expectPath(/^\/payments$/);
    await page.locator('button.ios-row').first().click();
    await page.locator('.ios-sheet').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Done' }).click();
    await page.locator('.ios-sheet').waitFor({ state: 'detached' });
  });
  await step('More → Insights', async () => {
    await page.getByRole('link', { name: 'More' }).last().click(); await expectPath(/^\/more$/);
    await page.locator('a.ios-row', { hasText: 'Insights' }).click(); await expectPath(/^\/insights$/);
  });
  await step('Scan → Library segment', async () => {
    await page.getByRole('link', { name: 'Scan' }).last().click(); await expectPath(/^\/scan/);
    await page.getByRole('tab', { name: 'Library' }).click(); await expectPath(/tab=library/);
  });
  await step('property: section opens, Back names the property', async () => {
    await page.goto(`${base}/portfolio`, { waitUntil: 'networkidle' });
    await page.locator('a[href^="/portfolio/"]').first().click(); await expectPath(/^\/portfolio\/[^/?]+$/);
    const name = (await page.locator('.ios-largetitle h1').textContent())?.trim() ?? '';
    await page.locator('a.ios-row', { has: page.locator('.ios-row-title', { hasText: /^Tenants$/ }) }).click(); await expectPath(/tab=Tenants/);
    await page.getByRole('button', { name }).click(); await expectPath(/^\/portfolio\/[^/?]+$/);
  });
  await step('Settings → Notifications → Back', async () => {
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
    await page.locator('a.ios-row', { hasText: 'Notifications' }).click(); await expectPath(/tab=notifications/);
    await page.getByRole('button', { name: 'Settings' }).click(); await expectPath(/^\/settings$/);
  });
  await step('Settings → Plan & billing shows where the plan stands', async () => {
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
    await page.locator('a.ios-row', { hasText: 'Plan & billing' }).click(); await expectPath(/tab=billing/);
    await page.getByText(/Complimentary|Free trial|plan/).first().waitFor();
  });
  await step('Settings → AI usage shows spend and the test run', async () => {
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
    await page.locator('a.ios-row', { hasText: 'AI usage' }).click(); await expectPath(/tab=ai/);
    await page.getByText('Test every AI feature').first().waitFor();
  });
  await step('Personal: segments switch sections', async () => {
    await page.goto(`${base}/personal`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Cards' }).click(); await expectPath(/tab=cards/);
    await page.getByRole('tab', { name: 'Loans' }).click(); await expectPath(/tab=loans/);
  });
  await step('Taxes: add opens the form in a sheet', async () => {
    await page.goto(`${base}/taxes`, { waitUntil: 'networkidle' });
    await page.locator('button.ios-row', { hasText: 'Add or upload a tax bill' }).click();
    await page.locator('.ios-sheet select').first().waitFor();
    await page.locator('.ios-sheet').getByRole('button', { name: 'Cancel' }).click();
    await page.locator('.ios-sheet').waitFor({ state: 'detached' });
  });
  // Repairs and the tenant portal need the real API (the sample answers have neither).
  if (realApi) {
    await step('Repairs: a request opens with its messages', async () => {
      await page.goto(`${base}/repairs`, { waitUntil: 'networkidle' });
      const empty = await page.getByText('No open repairs').count();
      if (!empty) { await page.locator('a[href^="/repairs/"]').first().click(); await expectPath(/^\/repairs\/[^/]+$/); await page.getByText('Messages with the tenant').waitFor(); }
    });
    await step('Settings → Rent collection explains who pays what', async () => {
      await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
      await page.locator('a.ios-row', { hasText: 'Rent collection' }).click(); await expectPath(/tab=rent/);
      await page.getByText('Who pays what').waitFor();
    });
    // A tenant's sign-in (the dev stubs switch on localStorage sollux.mockUser).
    const tctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    await tctx.addInitScript(() => { try { localStorage.setItem('sollux.mockUser', 'tenant'); } catch {} });
    await tctx.route(u => u.hostname !== 'localhost', route => route.fulfill({ status: 200, body: '' }));
    const tp = await tctx.newPage();
    tp.on('pageerror', e => errors.push(`tenant: ${e.message}`));
    const tstep = async (name, fn) => {
      try { await fn(); console.log(`✓ flow: ${name}`); }
      catch (e) { failed = true; console.log(`✗ flow: ${name}\n    ${String(e.message).split('\n')[0]}`); await tp.screenshot({ path: join(outDir, `flow-fail-${name.replace(/\W+/g, '-')}.png`) }); }
    };
    await tstep('tenant: an owner page sends them to the portal', async () => {
      // The app sends them on while the page is still loading, which cuts that load short.
      await tp.goto(`${base}/dashboard`).catch(() => {});
      for (let i = 0; i < 40 && new URL(tp.url()).pathname !== '/portal'; i++) await tp.waitForTimeout(200);
      if (new URL(tp.url()).pathname !== '/portal') throw new Error(`stayed on ${tp.url()}`);
      await tp.getByText('Your landlord').waitFor();
      await tp.screenshot({ path: join(outDir, 'portal-home.png') });
    });
    await tstep('tenant: Repairs → New request form', async () => {
      await tp.getByRole('link', { name: 'Repairs' }).click(); await tp.waitForURL(u => u.pathname === '/portal/repairs');
      await tp.getByRole('button', { name: 'New request' }).click(); await tp.getByText('How urgent').waitFor();
      await tp.screenshot({ path: join(outDir, 'portal-new-repair.png') });
    });
    await tstep('tenant: Payments history', async () => {
      await tp.goto(`${base}/portal/payments`, { waitUntil: 'networkidle' }); await tp.getByRole('heading', { name: 'Payments' }).waitFor();
    });
    await tctx.close();
  }

  if (errors.length) { failed = true; console.log(`✗ flow page errors:\n    ${errors.join('\n    ')}`); }
  await page.close();
}

await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
