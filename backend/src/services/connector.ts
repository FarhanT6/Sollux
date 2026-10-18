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

/** Online: the API saw the helper in the last 90 seconds. */
const ONLINE_MS = 90_000;

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

interface Helper { ws: WebSocket; deviceId: string; userId: string }
interface Session { id: string; worker: WebSocket; helper: Helper; queue: string[]; open: boolean }

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

  ws.on('message', async raw => {
    let m: any;
    try { m = JSON.parse(text(raw)); } catch { return; }
    if (!helper) {
      if (m.type !== 'hello' || typeof m.token !== 'string') return void ws.close(4401, 'hello first');
      const device = await db.connectorDevice.findUnique({ where: { tokenHash: hashToken(m.token) } }).catch(() => null);
      clearTimeout(hello);
      if (!device) { send(ws, { type: 'denied', message: 'This connection code is not valid any more — create a new one in Sollux (Settings → AI usage → Fetch from your computer).' }); return void ws.close(4401, 'denied'); }
      helper = { ws, deviceId: device.id, userId: device.userId };
      helpers.get(device.userId)?.ws.close(4000, 'replaced');
      helpers.set(device.userId, helper);
      const touch = () => db.connectorDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), relayUrl } }).catch(() => {});
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
    else if (m.type === 'closed') s.worker.close(1011, String(m.reason ?? 'the browser on the computer closed').slice(0, 100));
    else if (m.type === 'file' && typeof m.data === 'string') {
      const list = files.get(s.id) ?? [];
      list.push({ name: String(m.name ?? 'statement.pdf').slice(0, 200), data: Buffer.from(m.data, 'base64'), at: Date.now() });
      files.set(s.id, list.slice(-10));
    }
  });

  ws.on('close', () => {
    clearTimeout(hello);
    if (beat) clearInterval(beat);
    if (!helper) return;
    if (helpers.get(helper.userId) === helper) {
      helpers.delete(helper.userId);
      // Offline at once, not 90 seconds from now: the next fetch uses the cloud browser.
      void db.connectorDevice.update({ where: { id: helper.deviceId }, data: { lastSeenAt: null } }).catch(() => {});
    }
    for (const s of sessions.values()) if (s.helper === helper) s.worker.close(1011, 'the computer disconnected');
    console.log('[Connector] a computer disconnected');
  });
  ws.on('error', () => {});
}

function onWorker(ws: WebSocket, userId: string, id: string): void {
  const helper = helpers.get(userId);
  if (!helper) return void ws.close(4404, 'connector offline');
  const s: Session = { id, worker: ws, helper, queue: [], open: false };
  sessions.set(id, s);
  send(helper.ws, { type: 'open', id });
  ws.on('message', raw => {
    const d = text(raw);
    if (s.open) send(helper.ws, { type: 'data', id, d }); else s.queue.push(d);
  });
  ws.on('close', () => {
    sessions.delete(id); send(helper.ws, { type: 'close', id });
    setTimeout(() => files.delete(id), 120_000).unref();
  });
  ws.on('error', () => {});
}

/** Accept the helpers' tunnels and the worker's browser sessions on the API's server. */
export function attachConnector(server: Server): void {
  // Screenshots and PDFs travel inside CDP messages.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/api/connector/tunnel') return void wss.handleUpgrade(req, socket, head, ws => onHelper(ws, req));
    const cdp = path.match(/^\/api\/connector\/cdp\/(.+)$/);
    const sessionId = cdp ? verifySession(cdp[1]) : null;
    if (sessionId) return void wss.handleUpgrade(req, socket, head, ws => onWorker(ws, sessionId.split('.')[0], sessionId));
    socket.destroy();
  });
}
