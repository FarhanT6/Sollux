/**
 * Renders the iOS app icon and launch splash from public/favicon.svg (the
 * logo mark), so the phone's home screen matches the app. Rerun after
 * changing the mark:  node scripts/brand-assets.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, '../backend/package.json'));
const { chromium } = require('playwright');
const mark = readFileSync(join(root, 'public/favicon.svg'), 'utf8');
const exe = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const assets = join(root, 'ios/App/App/Assets.xcassets');

async function render(size, html, out) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;width:${size}px;height:${size}px;overflow:hidden">${html}</body>`);
  await page.screenshot({ path: out, omitBackground: false });
  await page.close();
}

// App icon: iOS draws its own rounded corners; the art fills the square.
await render(1024, `<div style="width:1024px;height:1024px;background:radial-gradient(circle at 30% 20%,#2b3648,#1F2937 70%);display:flex;align-items:center;justify-content:center">
  <div style="width:720px;height:720px">${mark}</div></div>`, join(assets, 'AppIcon.appiconset/AppIcon-512@2x.png'));

// Splash: the mark and the wordmark, centred on charcoal.
const splash = `<div style="width:2732px;height:2732px;background:#1F2937;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:60px;font-family:-apple-system,system-ui,sans-serif">
  <div style="width:520px;height:520px">${mark}</div>
  <div style="font-size:220px;font-weight:800;letter-spacing:-9px;color:#FFF7E6;line-height:1">sollux</div>
  <div style="font-size:54px;font-weight:500;letter-spacing:14px;text-transform:uppercase;color:#F59E0B">Property utility intelligence</div></div>`;
for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) await render(2732, splash, join(assets, 'Splash.imageset', f));
await browser.close();
console.log('icon and splash written');
