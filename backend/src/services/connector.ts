/**
 * The Sollux connector: portal fetches in a Chrome on the owner's own computer.
 *
 * Big portals (SDG&E, T-Mobile, insurers, banks) turn away browsers on cloud
 * servers, whatever they look like. The connector (frontend/public/
 * sollux-connector.mjs, a script with no dependencies) runs on the owner's
 * computer, opens a Chrome with its own profile, and connects out to this API.
 * The portal agent in the worker then drives that Chrome over the Chrome
 * DevTools Protocol, relayed through here:
 *
 *   worker ──CDP──▶ API /api/connector/cdp/<signed session> ──▶ helper tunnel ──▶ local Chrome
 *
 * Everything else stays on the server: the credentials are typed into the
 * page by the agent, Claude runs here, statements are filed here. The helper
 * can only relay to its own Chrome — nothing else on the computer is reachable.
 *
 * Auth: the helper proves itself with its device token (only a hash is kept);
 * the worker's session URL is signed with ENCRYPTION_KEY, which the API and
 * the worker share. One API process holds the tunnels (Render runs one).
 */
import type { Server, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { db } from '../config/db';

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const newDeviceToken = () => `sxc_${crypto.randomBytes(24).toString('base64url')}`;

const sign = (s: string) => crypto.createHmac('sha256', process.env.ENCRYPTION_KEY || 'dev').update(`connector:${s}`).digest('hex').slice(0, 32);

/** Online: the API heard from the helper in the last 90 seconds. */
const ONLINE_MS = 90_000;
/**
 * The helper pings every 25 seconds. Silent this long, the computer is gone
 * (asleep, lid closed, Wi-Fi dropped) even though its connection was never
 * closed: it is cut off and shown offline. Before this, the API kept marking
 * it online on its own timer, every fetch and tax lookup waited 30 seconds
 * for a Chrome that could not answer ("connectOverCDP: Timeout 30000ms
 * exceeded") and then ran in the cloud browser the sites turn away.
 */
const SILENT_MS = Number(process.env.CONNECTOR_SILENT_MS) || 70_000;
/** A browser session asked for of a helper not heard in this long (two pings) fails at once. */
const STALE_MS = Number(process.env.CONNECTOR_STALE_MS) || 45_000;
/** A browser session asked for: the helper has this long to say Chrome is open (a cold Chrome start takes up to 20 s). */
const OPEN_MS = Number(process.env.CONNECTOR_OPEN_MS) || 25_000;

/** The owner's connector, if one is online: where the worker connects for a browser there. */
export async function connectorFor(userId: string): Promise<{ wsUrl: string; name: string } | null> {
  const d = await db.connectorDevice.findFirst({
    where: { userId, lastSeenAt: { gt: new Date(Date.now() - ONLINE_MS) }, relayUrl: { not: null } },
    orderBy: { lastSeenAt: 'desc' },
  }).catch(() => null);
  if (!d?.relayUrl) return null;
  const session = `${userId}.${crypto.randomBytes(8).toString('hex')}`;
  return { wsUrl: `${d.relayUrl}/api/connector/cdp/${session}.${sign(session)}`, name: d.name };
}

interface Helper { ws: WebSocket; deviceId: string; userId: string; /** When the helper last said anything (a ping, Chrome's traffic). */ heard: number }
interface Session { id: string; worker: WebSocket; helper: Helper; queue: string[]; open: boolean }

/** The connector version this API expects; an older helper is shown as out of date. */
export const CONNECTOR_VERSION = 3;

// Why each owner's last browser session ended, for the fetch's error message:
// a "stopped answering" with no reason could not be told apart from a computer asleep.
const drops = new Map<string, { at: number; why: string }>();
const dropped = (userId: string, why: string) => { drops.set(userId, { at: Date.now(), why }); console.log(`[Connector] ${why}`); };
/** Why the owner's last session ended, if it was in the last ten minutes. */
export function lastDrop(userId: string): string | null {
  const d = drops.get(userId);
  return d && Date.now() - d.at < 10 * 60_000 ? d.why : null;
}

// The helpers connected to this process, by owner (the newest wins), and the open browser sessions.
const helpers = new Map<string, Helper>();
const sessions = new Map<string, Session>();
// Files the owner's Chrome downloaded during a session (statement PDFs), until the worker collects them.
const files = new Map<string, { name: string; data: Buffer; at: number }[]>();

/** The worker's address for collecting a session's downloads: the session's own signed path. */
export const filesUrlFor = (wsUrl: string) => wsUrl.replace(/^ws/, 'http').replace('/api/connector/cdp/', '/api/connector/files/');

/** Check a signed session path ("<user>.<nonce>.<sig>") and give its session id, or null. */
export function verifySession(signed: string): string | null {
  const m = signed.match(/^([\w-]+)\.([0-9a-f]{16})\.([0-9a-f]{32})$/);
  if (!m) return null;
  const id = `${m[1]}.${m[2]}`;
  return crypto.timingSafeEqual(Buffer.from(sign(id)), Buffer.from(m[3])) ? id : null;
}

/** The files downloaded in a session since it was last asked; each is handed over once. */
export function takeFiles(sessionId: string): { name: string; data: Buffer }[] {
  const got = files.get(sessionId) ?? [];
  files.delete(sessionId);
  return got;
}

const text = (d: RawData) => (Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d as ArrayBuffer)).toString('utf8');
const send = (ws: WebSocket, m: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

// This process is shutting down for a deploy: the computers reconnect to the
// new one at once, and are not marked offline in between.
let restarting = false;

/**
 * A deploy: tell every connected computer the API is restarting (close code
 * 1012), so its helper reconnects to the new process within a second instead
 * of backing off. A fetch running through it waits for that and carries on
 * (portalAgent reopen). Nationwide's fetch died mid-sign-in each time an
 * update went live: "stopped answering", though the computer was awake.
 */
export function closeTunnelsForRestart(): void {
  restarting = true;
  for (const h of helpers.values()) h.ws.close(1012, 'Sollux is restarting for an update');
}

/** Disconnect a device that was removed in Settings. */
export function disconnectDevice(deviceId: string): void {
  for (const h of helpers.values()) if (h.deviceId === deviceId) h.ws.close(4401, 'removed');
}

function onHelper(ws: WebSocket, req: IncomingMessage): void {
  let helper: Helper | null = null;
  let beat: NodeJS.Timeout | null = null;
  const hello = setTimeout(() => ws.close(4401, 'no hello'), 10_000);
  // The address the helper reached, so the worker can reach it too (behind Render's proxy: https).
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || 'http';
  const relayUrl = `${proto === 'https' ? 'wss' : 'ws'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;

  // Anything from the computer, a pong to the API's own ping included, shows it is there.
  ws.on('pong', () => { if (helper) helper.heard = Date.now(); });
  ws.on('message', async raw => {
    if (helper) helper.heard = Date.now();
    let m: any;
    try { m = JSON.parse(text(raw)); } catch { return; }
    // Shutting down for an update: not here — the helper keeps trying until the new process answers.
    if (!helper && restarting) return void ws.close(1012, 'Sollux is restarting for an update');
    if (!helper) {
      if (m.type !== 'hello' || typeof m.token !== 'string') return void ws.close(4401, 'hello first');
      const device = await db.connectorDevice.findUnique({ where: { tokenHash: hashToken(m.token) } }).catch(() => null);
      clearTimeout(hello);
      if (!device) { send(ws, { type: 'denied', message: 'This connection code is not valid any more — create a new one in Sollux (Settings → AI usage → Fetch from your computer).' }); return void ws.close(4401, 'denied'); }
      helper = { ws, deviceId: device.id, userId: device.userId, heard: Date.now() };
      helpers.get(device.userId)?.ws.close(4000, 'replaced');
      helpers.set(device.userId, helper);
      // Online only while the computer answers: a silent one is cut off (and shown offline by the close below).
      const touch = () => {
        if (!helper) return;
        if (Date.now() - helper.heard > SILENT_MS) {
          dropped(helper.userId, 'the computer stopped answering (asleep, closed or offline)');
          return void ws.terminate();
        }
        try { ws.ping(); } catch { /* closing */ }
        return db.connectorDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), relayUrl } }).catch(() => {});
      };
      await db.connectorDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), relayUrl, agent: typeof m.agent === 'string' ? m.agent.slice(0, 120) : null } }).catch(() => {});
      beat = setInterval(touch, 30_000);
      send(ws, { type: 'welcome', name: device.name });
      console.log(`[Connector] ${device.name} connected`);
      return;
    }
    const s = typeof m.id === 'string' ? sessions.get(m.id) : undefined;
    if (m.type === 'ping') send(ws, { type: 'pong' });
    else if (!s || s.helper !== helper) return;
    else if (m.type === 'opened') { s.open = true; for (const d of s.queue.splice(0)) send(ws, { type: 'data', id: s.id, d }); }
    else if (m.type === 'data' && typeof m.d === 'string') { if (s.worker.readyState === WebSocket.OPEN) s.worker.send(m.d); }
    else if (m.type === 'closed') { dropped(helper.userId, `Chrome on the computer closed its connection (${String(m.reason ?? 'no reason given').slice(0, 120)})`); s.worker.close(1011, String(m.reason ?? 'the browser on the computer closed').slice(0, 100)); }
    else if (m.type === 'file' && typeof m.data === 'string') {
      const list = files.get(s.id) ?? [];
      list.push({ name: String(m.name ?? 'statement.pdf').slice(0, 200), data: Buffer.from(m.data, 'base64'), at: Date.now() });
      files.set(s.id, list.slice(-10));
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    clearTimeout(hello);
    if (beat) clearInterval(beat);
    if (!helper) return;
    const why = String(reason ?? '').slice(0, 80);
    if (!restarting) dropped(helper.userId, code === 1006
      ? 'the connector program on the computer stopped or lost its internet connection (no goodbye)'
      : `the connector program disconnected (code ${code}${why ? `, ${why}` : ''})`);
    if (helpers.get(helper.userId) === helper) {
      helpers.delete(helper.userId);
      // Offline at once, not 90 seconds from now: the next fetch uses the
      // cloud browser. Not during a restart: it is back on the new process in a second.
      if (!restarting) void db.connectorDevice.update({ where: { id: helper.deviceId }, data: { lastSeenAt: null } }).catch(() => {});
    }
    for (const s of sessions.values()) if (s.helper === helper) s.worker.close(1011, 'the computer disconnected');
    console.log('[Connector] a computer disconnected');
  });
  ws.on('error', err => { if (helper) dropped(helper.userId, `the connector's connection failed: ${err.message.slice(0, 120)}`); });
}

function onWorker(ws: WebSocket, userId: string, id: string): void {
  const helper = helpers.get(userId);
  if (!helper) return void ws.close(4404, 'connector offline');
  // Not heard from in two pings: asleep or gone. Say so now rather than leave the worker waiting 30 seconds.
  if (Date.now() - helper.heard > STALE_MS) {
    dropped(userId, 'the computer stopped answering (asleep, closed or offline)');
    helper.ws.terminate();
    return void ws.close(4404, 'the computer is not answering');
  }
  const s: Session = { id, worker: ws, helper, queue: [], open: false };
  sessions.set(id, s);
  send(helper.ws, { type: 'open', id });
  const opening = setTimeout(() => {
    if (s.open || ws.readyState !== WebSocket.OPEN) return;
    dropped(userId, 'Chrome on the computer did not open in time');
    ws.close(4408, 'Chrome on the computer did not open in time');
  }, OPEN_MS);
  opening.unref();
  ws.on('message', raw => {
    const d = text(raw);
    if (s.open) send(helper.ws, { type: 'data', id, d }); else s.queue.push(d);
  });
  ws.on('close', (code: number) => {
    clearTimeout(opening);
    // 1009: a message bigger than the relay takes (a huge screenshot or PDF).
    if (code === 1009) dropped(userId, 'a message from the browser was too large for the connection');
    sessions.delete(id); send(helper.ws, { type: 'close', id });
    setTimeout(() => files.delete(id), 120_000).unref();
  });
  ws.on('error', err => dropped(userId, `the browser session failed: ${err.message.slice(0, 120)}`));
}

/** Accept the helpers' tunnels and the worker's browser sessions on the API's server. */
export function attachConnector(server: Server): void {
  // Screenshots and PDFs travel inside CDP messages.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/api/connector/tunnel') return void wss.handleUpgrade(req, socket, head, ws => onHelper(ws, req));
    const cdp = path.match(/^\/api\/connector\/cdp\/(.+)$/);
    const sessionId = cdp ? verifySession(cdp[1]) : null;
    if (sessionId) return void wss.handleUpgrade(req, socket, head, ws => onWorker(ws, sessionId.split('.')[0], sessionId));
    socket.destroy();
  });
}
