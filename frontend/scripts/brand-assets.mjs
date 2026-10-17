/**
 * Every brand image, built from the owner's artwork in brand-source/:
 *   public/brand/sollux-mark.png   the mark, cut from its white background
 *                                  (flood-filled from the edges, so the white
 *                                  building front inside it stays)
 *   public/favicon.png, public/apple-touch-icon.png
 *   ios/…/AppIcon-512@2x.png       1024px on charcoal (iOS rounds the corners)
 *   ios/…/Splash.imageset/*        mark + wordmark + tagline on charcoal
 * Run after changing the artwork:  node scripts/brand-assets.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, '../backend/package.json'));
const { chromium } = require('playwright');
const exe = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();
const b64 = p => readFileSync(p).toString('base64');
const font = w => `data:font/woff2;base64,${b64(join(root, `node_modules/@fontsource/montserrat/files/montserrat-latin-${w}-normal.woff2`))}`;
const CHARCOAL = '#1F2937';

// 1. The mark, transparent.
const src = `data:image/webp;base64,${b64(join(root, 'brand-source/sollux-mark-original.webp'))}`;
const mark = await page.evaluate(async (url) => {
  const img = new Image(); img.src = url; await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H); const px = d.data;
  const white = i => px[i] > 232 && px[i + 1] > 232 && px[i + 2] > 232;
  const bg = new Uint8Array(W * H); const q = [];
  for (let x = 0; x < W; x++) q.push(x, x + (H - 1) * W);
  for (let y = 0; y < H; y++) q.push(y * W, y * W + W - 1);
  while (q.length) { const k = q.pop(); if (bg[k] || !white(k * 4)) continue; bg[k] = 1; const x = k % W, y = (k / W) | 0;
    if (x > 0) q.push(k - 1); if (x < W - 1) q.push(k + 1); if (y > 0) q.push(k - W); if (y < H - 1) q.push(k + W); }
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let k = 0; k < W * H; k++) {
    const i = k * 4;
    if (bg[k]) { px[i + 3] = 0; continue; }
    const x = k % W, y = (k / W) | 0;
    if ((x > 0 && bg[k - 1]) || (x < W - 1 && bg[k + 1]) || (y > 0 && bg[k - W]) || (y < H - 1 && bg[k + W])) {
      const a = Math.max(0, Math.min(1, (255 - Math.min(px[i], px[i + 1], px[i + 2])) / 150));
      if (a > 0 && a < 1) for (let ch = 0; ch < 3; ch++) px[i + ch] = Math.max(0, Math.min(255, (px[i + ch] - 255 * (1 - a)) / a));
      px[i + 3] = Math.round(a * 255);
    }
    if (px[i + 3] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  g.putImageData(d, 0, 0);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const o = document.createElement('canvas'); o.width = w; o.height = h;
  o.getContext('2d').drawImage(c, minX, minY, w, h, 0, 0, w, h);
  return o.toDataURL('image/png');
}, src);
writeFileSync(join(root, 'public/brand/sollux-mark.png'), Buffer.from(mark.split(',')[1], 'base64'));

async function render(w, h, html, out) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(`<style>@font-face{font-family:M;font-weight:500;src:url(${font(500)})}@font-face{font-family:M;font-weight:800;src:url(${font(800)})}</style>
    <body style="margin:0;width:${w}px;height:${h}px;overflow:hidden">${html}</body>`);
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: out, omitBackground: true });
  await p.close();
}
const img = (hh) => `<img src="${mark}" style="height:${hh}px;display:block">`;
const centred = (bgc, inner) => `<div style="width:100%;height:100%;background:${bgc};display:flex;align-items:center;justify-content:center">${inner}</div>`;

// 2. Browser icons.
await render(64, 64, centred('transparent', img(60)), join(root, 'public/favicon.png'));
await render(180, 180, centred(CHARCOAL, img(132)), join(root, 'public/apple-touch-icon.png'));

// 3. iOS app icon (no transparency allowed) and splash.
const assets = join(root, 'ios/App/App/Assets.xcassets');
await render(1024, 1024, centred(CHARCOAL, img(720)), join(assets, 'AppIcon.appiconset/AppIcon-512@2x.png'));
const splash = centred(CHARCOAL, `<div style="display:flex;flex-direction:column;align-items:center;gap:70px">${img(560)}
  <div style="display:flex;flex-direction:column;align-items:center;gap:40px">
  <div style="font:800 260px M;letter-spacing:-8px;color:#FFF7E6;line-height:1">sollux</div>
  <div style="font:500 64px M;letter-spacing:12px;color:#D6CFC2">Property utility intelligence</div></div></div>`);
for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) await render(2732, 2732, splash, join(assets, 'Splash.imageset', f));
await browser.close();
console.log('brand assets written');
