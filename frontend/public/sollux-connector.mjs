#!/usr/bin/env node
/**
 * Sollux connector — lets Sollux fetch your statements through Chrome on this
 * computer, from your own internet connection. Utility and insurance sites
 * that turn away cloud servers let a normal home browser in.
 *
 *   First time:  node sollux-connector.mjs --api https://YOUR-API --token sxc_...
 *   After that:  node sollux-connector.mjs
 *
 * What it does: opens a separate Chrome window with its own profile (your own
 * Chrome, bookmarks and passwords are untouched) and keeps a connection to
 * Sollux open. When Sollux fetches a statement, it drives that window. It can
 * only control that Chrome — nothing else on this computer. Close this
 * program (Ctrl+C) to stop; Sollux goes back to its own browser.
 *
 * Options: --hidden   run Chrome without a window
 *          --name "…" what Sollux calls this computer (set when the code was made)
 *          CHROME_PATH=/path/to/chrome  if Chrome is somewhere unusual
 * Needs Node.js 22 or newer (https://nodejs.org). No other installs.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOME = path.join(os.homedir(), '.sollux');
const CONFIG = path.join(HOME, 'connector.json');
const PROFILE = path.join(HOME, 'chrome-profile');

if (typeof WebSocket === 'undefined') {
  console.error('The Sollux connector needs Node.js 22 or newer — this is ' + process.version + '. Install it from https://nodejs.org and run this again.');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const opt = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

fs.mkdirSync(HOME, { recursive: true });
let saved = {};
try { saved = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* first run */ }
const api = (opt('api') ?? saved.api ?? '').replace(/\/+$/, '').replace(/\/api$/, '');
const token = opt('token') ?? saved.token;
if (!api || !token) {
  console.error('First run: node sollux-connector.mjs --api https://YOUR-API --token sxc_...\nCopy the exact command from Sollux → Settings → AI usage → Fetch from your computer.');
  process.exit(1);
}
fs.writeFileSync(CONFIG, JSON.stringify({ api, token }, null, 2), { mode: 0o600 });

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

let chrome = null; // { proc, wsUrl, version }
const portFile = path.join(PROFILE, 'DevToolsActivePort');
/** The Chrome on this profile that is already running (left open by an earlier run), if any. */
async function runningChrome() {
  try {
    const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    const j = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }).then(r => r.json());
    return { proc: null, port, wsUrl: `ws://127.0.0.1:${port}${wsPath}`, version: j.Browser };
  } catch { return null; }
}
async function startChrome() {
  if (chrome && (chrome.proc ? chrome.proc.exitCode === null : await runningChrome())) return chrome;
  chrome = await runningChrome();
  if (chrome) return chrome;
  const bin = findChrome();
  if (!bin) throw new Error('Google Chrome was not found. Install it, or set CHROME_PATH to where it is.');
  try { fs.unlinkSync(portFile); } catch { /* none */ }
  // Sollux types the logins: Chrome offering to save each password only gets in the way.
  try {
    const prefsFile = path.join(PROFILE, 'Default', 'Preferences');
    fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch { /* new profile */ }
    prefs.credentials_enable_service = false;
    prefs.profile = { ...(prefs.profile ?? {}), password_manager_enabled: false };
    fs.writeFileSync(prefsFile, JSON.stringify(prefs));
  } catch { /* Chrome works without it */ }
  const proc = spawn(bin, [
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
    ...(flag('hidden') ? ['--headless=new'] : []), 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      if (port && wsPath) {
        const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()).then(j => j.Browser).catch(() => 'Chrome');
        chrome = { proc, port, wsUrl: `ws://127.0.0.1:${port}${wsPath}`, version };
        proc.on('exit', () => { if (chrome?.proc === proc) chrome = null; });
        return chrome;
      }
    } catch { /* not written yet */ }
  }
  proc.kill();
  throw new Error('Chrome started but did not open its control port.');
}

/**
 * Make sure Chrome has a window. On a Mac, closing the last window leaves
 * Chrome running but unloads its profile, and Sollux then cannot use it
 * ("Browser context management is not supported"): open a new window, which
 * loads the profile again.
 */
async function ensureWindow({ port }) {
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
  if (pages.some(t => t.type === 'page')) return;
  await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    const now = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    if (now.some(t => t.type === 'page')) return;
  }
}

const sessions = new Map(); // id → local WebSocket to Chrome
let server = null;
let backoff = 1000;

function connect() {
  const url = api.replace(/^http/, 'ws') + '/api/connector/tunnel';
  const ws = new WebSocket(url);
  server = ws;
  let ping = null;
  const send = m => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

  ws.addEventListener('open', () => {
    // Say hello at once (Sollux waits 10 seconds for it), then get Chrome ready.
    send({ type: 'hello', token, agent: `${os.type()} ${os.release()}${chrome ? ` · ${chrome.version}` : ''}` });
    ping = setInterval(() => send({ type: 'ping' }), 25_000);
    startChrome().catch(e => console.error(String(e.message ?? e)));
  });

  ws.addEventListener('message', async ev => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
    if (m.type === 'welcome') { backoff = 1000; console.log(`Connected to Sollux as "${m.name}". Leave this running; press Ctrl+C to stop.`); }
    else if (m.type === 'denied') { console.error(m.message); try { fs.unlinkSync(CONFIG); } catch { /* gone */ } process.exit(1); }
    else if (m.type === 'open') {
      try {
        const c = await startChrome();
        await ensureWindow(c);
        const { wsUrl } = c;
        const local = new WebSocket(wsUrl);
        sessions.set(m.id, local);
        local.addEventListener('open', () => { send({ type: 'opened', id: m.id }); console.log(`${new Date().toLocaleTimeString()} Sollux is fetching statements in the Chrome window`); });
        local.addEventListener('message', e => send({ type: 'data', id: m.id, d: typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8') }));
        local.addEventListener('close', () => { if (sessions.delete(m.id)) send({ type: 'closed', id: m.id }); });
        local.addEventListener('error', () => {});
      } catch (e) {
        send({ type: 'closed', id: m.id, reason: String(e.message ?? e) });
      }
    }
    else if (m.type === 'data') sessions.get(m.id)?.send(m.d);
    else if (m.type === 'close') { const s = sessions.get(m.id); sessions.delete(m.id); s?.close(); }
  });

  ws.addEventListener('close', () => {
    if (ping) clearInterval(ping);
    for (const s of sessions.values()) s.close();
    sessions.clear();
    console.log(`Disconnected from Sollux — trying again in ${Math.round(backoff / 1000)}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  });
  ws.addEventListener('error', () => {});
}

process.on('SIGINT', () => { console.log('\nStopping. Sollux will use its own browser until you run this again.'); chrome?.proc?.kill(); process.exit(0); });
console.log(`Sollux connector — connecting to ${api}`);
connect();
