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
  '/portfolio', '/settings', '/import', '/insights',
];
mkdirSync(outDir, { recursive: true });

const PORT = 5199;
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
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  colorScheme: process.env.SCHEME === 'light' ? 'light' : 'dark',
});
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
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
