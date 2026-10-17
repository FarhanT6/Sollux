/**
 * Crawl the whole app, at desktop and phone size, and report what is broken.
 *
 *   node scripts/crawl.mjs [outDir]          (npm run crawl)
 *
 * Needs the local dev stack (docs/DEV-STACK.md): the API on :3001 with
 * scripts/dev/devAuth.cjs and a seeded database. Starts Vite in mock mode.
 *
 * Visits every route in App.tsx and every section (?tab=…) its page source
 * names, then every in-app link found on those pages (a few per route
 * pattern, so a list of 100 tenants is not 100 visits). Reports, per page:
 * page errors, console errors, API answers of 400 or more, a link that
 * lands on the not-found page, and (on the phone) a page that scrolls
 * sideways. Exits non-zero when anything is reported.
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const require = createRequire(join(root, '../backend/package.json'));
const { chromium } = require('playwright');
const outDir = process.argv[2] ?? join(root, '.crawl');
mkdirSync(outDir, { recursive: true });

if (!(await fetch('http://localhost:3001/api/dashboard/summary').then(r => r.ok).catch(() => false))) {
  console.error('The local API is not up on :3001 — see docs/DEV-STACK.md.');
  process.exit(2);
}

// Routes and the page file behind each, from App.tsx.
const app = readFileSync(join(src, 'App.tsx'), 'utf8');
const importOf = Object.fromEntries([...app.matchAll(/import\s+(\w+)\s+from\s+'\.\/pages\/([\w/]+)'/g)].map(m => [m[1], m[2]]));
const routes = [...app.matchAll(/<Route\s+path="([^"*]+)"\s+element=\{(.*)\}\s*\/>/g)]
  .map(m => ({ path: m[1].startsWith('/') ? m[1] : '/' + m[1], pages: [...m[2].matchAll(/<(\w+)/g)].map(x => importOf[x[1]]).filter(Boolean) }))
  // The tenant portal is a tenant's sign-in; the crawl is the owner's (screens.mjs walks the portal as a tenant).
  .filter(r => !/^\/(sign-in|sign-up|privacy|terms|portal)/.test(r.path));
const patterns = routes.map(r => ({ ...r, re: new RegExp('^' + r.path.replace(/:[A-Za-z]+/g, '[^/]+') + '$') }));

// Sections each page names in its own source: tab === 'x', key: 'x', ?tab=x.
function tabsIn(file) {
  const p = join(src, 'pages', file + '.tsx');
  if (!existsSync(p)) return [];
  const t = readFileSync(p, 'utf8');
  const found = new Set();
  for (const re of [/tab === '([\w-]+)'/g, /\?tab=([\w-]+)/g]) for (const m of t.matchAll(re)) found.add(m[1]);
  // Section lists: const TABS = [...] / SECTIONS / FINANCE_SECTIONS.
  for (const block of t.matchAll(/const\s+\w*(?:TABS|SECTIONS)\w*[^=]*=\s*\[([\s\S]*?)\]\s*(?:as const)?;/g)) {
    for (const m of block[1].matchAll(/key: '([\w-]+)'/g)) found.add(m[1]);
    for (const m of block[1].matchAll(/^\s*'([\w-]+)'|,\s*'([\w-]+)'|\[\s*'([\w-]+)'/gm)) found.add(m[1] ?? m[2] ?? m[3]);
  }
  return [...found];
}

const PORT = await new Promise(res => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--mode', 'mock', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
const stop = () => { try { vite.kill(); } catch { /* gone */ } };
process.on('exit', stop);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite did not start')), 60000);
  vite.stdout.on('data', d => { if (String(d).includes('Local:')) { clearTimeout(t); resolve(); } });
});
const base = `http://localhost:${PORT}`;
const exe = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});

const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const PER_PATTERN = Number(process.env.PER_PATTERN ?? 2);
// Services a dev machine has no keys for answer 503 by design (and the page says so).
const EXPECTED = /^POST \/api\/plaid\/link-token → 503$/;
let problems = 0;

for (const [size, opts] of Object.entries(SIZES)) {
  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
  await ctx.route(u => u.hostname !== 'localhost', r => r.fulfill({ status: 200, body: '' }));
  const queue = [];
  const seen = new Set();
  const perPattern = new Map();
  const add = (url, from) => {
    const u = new URL(url, base);
    if (u.origin !== base) return;
    const key = u.pathname + (u.searchParams.get('tab') ? `?tab=${u.searchParams.get('tab')}` : '');
    if (seen.has(key)) return;
    const pat = patterns.find(p => p.re.test(u.pathname));
    const pk = (pat?.path ?? u.pathname) + (u.searchParams.get('tab') ? `?tab=${u.searchParams.get('tab')}` : '');
    if ((perPattern.get(pk) ?? 0) >= PER_PATTERN) return;
    perPattern.set(pk, (perPattern.get(pk) ?? 0) + 1);
    seen.add(key);
    queue.push({ url: key, from });
  };
  for (const r of routes) {
    if (r.path.includes(':')) continue;
    add(r.path, 'routes');
    for (const page of r.pages) for (const t of tabsIn(page)) add(`${r.path}?tab=${encodeURIComponent(t)}`, 'routes');
  }

  const page = await ctx.newPage();
  let issues = [];
  page.on('pageerror', e => issues.push(`page error: ${e.message.split('\n')[0]}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) issues.push(`console: ${m.text().slice(0, 200)}`); });
  page.on('response', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && r.status() >= 400 && !u.pathname.startsWith('/api/telemetry')) { const line = `${r.request().method()} ${u.pathname} → ${r.status()}`; if (!EXPECTED.test(line)) issues.push(line); } });

  let visited = 0;
  while (queue.length) {
    const { url, from } = queue.shift();
    issues = [];
    try {
      await page.goto(base + url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(250);
    } catch (e) { issues.push(`load: ${e.message.split('\n')[0]}`); }
    visited++;
    if (await page.getByText("This page doesn't exist").count()) issues.push(`no page here (linked from ${from})`);
    if (size === 'phone') {
      const wide = await page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const inScroller = el => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
        const el = [...document.querySelectorAll('body *')].find(e => e.getBoundingClientRect().right > w + 1 && getComputedStyle(e).position !== 'fixed' && !inScroller(e));
        return el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}` : null;
      });
      if (wide) issues.push(`scrolls sideways: ${wide}`);
    }
    if (issues.length) {
      problems += issues.length;
      console.log(`✗ [${size}] ${url}`);
      for (const i of [...new Set(issues)]) console.log(`    ${i}`);
      await page.screenshot({ path: join(outDir, `${size}-${url.replace(/[^\w]+/g, '_')}.png`) }).catch(() => {});
    }
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => h && h.startsWith('/') && !h.startsWith('/api/')));
    for (const l of links) add(l, url);
  }
  console.log(`[${size}] visited ${visited} pages`);
  await ctx.close();
}

await browser.close();
stop();
console.log(problems ? `${problems} problem(s) found` : 'No problems found');
process.exit(problems ? 1 : 0);
