/**
 * The connector relay: a computer that stopped answering (asleep, lid closed) is not
 * offered as online, so a fetch or tax lookup fails at once with the reason instead of
 * waiting 30 seconds for a Chrome that cannot answer and then running in the cloud
 * browser the sites turn away. Made-up device; limits shortened for the test.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, TEST_DB, type TestApi } from './server';

let api: TestApi;
let userId = '';
const TOKEN = 'sxc_test_device_token';

before(async () => {
  if (skip) return;
  api = await startApi({ CONNECTOR_STALE_MS: '800', CONNECTOR_OPEN_MS: '1500', CONNECTOR_ANSWER_MS: '1200' });
  process.env.DATABASE_URL = TEST_DB;
  const { hashToken } = await import('../../src/services/connector');
  const me = await api.db.user.create({ data: OWNER as any });
  userId = me.id;
  await api.db.connectorDevice.create({ data: { userId, name: 'Test laptop', tokenHash: hashToken(TOKEN) } });
});
after(async () => { if (!skip) await api.stop(); });

const wsUrl = () => api.url.replace(/^http/, 'ws');
/** The helper's side: says hello, then answers the relay only while `alive()`. */
async function helper(alive: () => boolean): Promise<WebSocket> {
  const ws = new WebSocket(`${wsUrl()}/api/connector/tunnel`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN, agent: 'test · connector v3' })));
    ws.addEventListener('message', ev => {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'welcome') resolve();
      if (m.type === 'open' && alive()) ws.send(JSON.stringify({ type: 'opened', id: m.id }));
    });
    ws.addEventListener('error', () => reject(new Error('helper could not connect')));
  });
  return ws;
}
/** The worker's side: open a browser session and see how it ends within `ms`. */
async function session(ms: number): Promise<{ closed: boolean; code?: number; reason?: string; after: number }> {
  const { connectorFor } = await import('../../src/services/connector');
  const c = await connectorFor(userId);
  assert.ok(c, 'the device shows as online right after it connected');
  const t0 = Date.now();
  const ws = new WebSocket(c!.wsUrl);
  return new Promise(resolve => {
    const timer = setTimeout(() => { ws.close(); resolve({ closed: false, after: Date.now() - t0 }); }, ms);
    ws.addEventListener('close', ev => { clearTimeout(timer); resolve({ closed: true, code: ev.code, reason: ev.reason, after: Date.now() - t0 }); });
  });
}

test('a computer that answers gets its browser session', { skip }, async () => {
  const h = await helper(() => true);
  const r = await session(600);
  assert.equal(r.closed, false, `stays open: ${JSON.stringify(r)}`);
  h.close();
});

test('a computer silent past two pings is not waited on: the session ends at once, saying why', { skip }, async () => {
  const h = await helper(() => true);
  await new Promise(r => setTimeout(r, 1200));   // asleep: nothing from it since hello
  const r = await session(5000);
  assert.ok(r.closed && r.after < 1000, `closed at once: ${JSON.stringify(r)}`);
  assert.equal(r.code, 4404);
  assert.match(r.reason ?? '', /not answering/);
  h.close();
});

test('Chrome on the computer that never opens ends the session with a reason, before the 30 s attach timeout', { skip }, async () => {
  let pinging = true;
  const h = await helper(() => false);              // answers pings, but its Chrome never opens
  const beat = setInterval(() => pinging && h.send(JSON.stringify({ type: 'ping' })), 200);
  const r = await session(5000);
  pinging = false; clearInterval(beat);
  assert.ok(r.closed, JSON.stringify(r));
  assert.equal(r.code, 4408);
  assert.match(r.reason ?? '', /did not open in time/);
  h.close();
});


test('Chrome that opens but never answers ends the session with a reason (#344)', { skip }, async () => {
  let pinging = true;
  const h = await helper(() => true);               // Chrome opens, then never answers anything
  const beat = setInterval(() => pinging && h.send(JSON.stringify({ type: 'ping' })), 200);
  const { connectorFor } = await import('../../src/services/connector');
  const c = await connectorFor(userId);
  const t0 = Date.now();
  const ws = new WebSocket(c!.wsUrl);
  const r = await new Promise<{ closed: boolean; code?: number; reason?: string; after: number }>(resolve => {
    const timer = setTimeout(() => { ws.close(); resolve({ closed: false, after: Date.now() - t0 }); }, 6000);
    // The worker asks Chrome something, as connectOverCDP does first.
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })));
    ws.addEventListener('close', ev => { clearTimeout(timer); resolve({ closed: true, code: ev.code, reason: ev.reason, after: Date.now() - t0 }); });
  });
  pinging = false; clearInterval(beat);
  assert.ok(r.closed && r.after < 5000, JSON.stringify(r));
  assert.equal(r.code, 4408);
  assert.match(r.reason ?? '', /did not answer/);
  h.close();
});
