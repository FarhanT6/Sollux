/**
 * ClickUp: connection, the folder that holds property operations, tasks per
 * property, and a task per unpaid bill.
 *
 * Every route here needs the user except the webhook, which ClickUp calls
 * and which authenticates by signature instead (exempted in index.ts).
 */
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { decrypt } from '../crypto/encrypt';
import * as cu from '../services/clickup';

const router = Router();

const appUrl = () => (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
const apiUrl = () => (process.env.BACKEND_URL ?? process.env.RENDER_EXTERNAL_URL ?? '').replace(/\/$/, '');

async function requireToken(userId: string) {
  const token = await cu.tokenFor(userId);
  if (!token) throw new cu.ClickUpError('ClickUp is not connected.', 400);
  return token;
}

function fail(res: import('express').Response, err: unknown) {
  if (err instanceof cu.ClickUpError) return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({ error: err.message });
  console.error('[ClickUp]', err instanceof Error ? err.message : err);
  return res.status(502).json({ error: 'ClickUp request failed.' });
}

// ── Connection ──────────────────────────────────────────────────────────────

router.get('/status', attachDbUser, async (req, res) => {
  const c = await cu.getConnection(req.dbUserId!);
  if (!c) return res.json({ connected: false });
  res.json({
    connected: true,
    user: c.clickupUserName,
    team: c.teamId ? { id: c.teamId, name: c.teamName } : null,
    space: c.spaceId ? { id: c.spaceId, name: c.spaceName } : null,
    folder: c.folderId ? { id: c.folderId, name: c.folderName } : null,
    syncBills: c.syncBills,
    webhook: !!c.webhookId,
  });
});

router.post('/connect', attachDbUser, async (req, res) => {
  const parsed = z.object({ token: z.string().min(10) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Paste your ClickUp personal API token.' });
  try {
    const token = parsed.data.token.trim();
    const c = await cu.connect(req.dbUserId!, token);
    // The token verified and is saved. Listing workspaces is the next step,
    // not a condition of connecting — if it fails the card still shows
    // Connected and the folder picker can retry it.
    let teams: { id: string; name: string }[] = [];
    let warning: string | undefined;
    try { teams = await cu.listTeams(token); } catch (e) { warning = e instanceof Error ? e.message : 'Could not list workspaces.'; }
    res.json({ connected: true, user: c.clickupUserName, teams, warning });
  } catch (err) { fail(res, err); }
});

router.delete('/disconnect', attachDbUser, async (req, res) => {
  await cu.disconnect(req.dbUserId!);
  res.status(204).send();
});

router.get('/teams', attachDbUser, async (req, res) => {
  try { res.json({ teams: await cu.listTeams(await requireToken(req.dbUserId!)) }); } catch (err) { fail(res, err); }
});
router.get('/spaces', attachDbUser, async (req, res) => {
  const teamId = String(req.query.teamId ?? '');
  if (!teamId) return res.status(400).json({ error: 'teamId required' });
  try { res.json({ spaces: await cu.listSpaces(await requireToken(req.dbUserId!), teamId) }); } catch (err) { fail(res, err); }
});
router.get('/folders', attachDbUser, async (req, res) => {
  const spaceId = String(req.query.spaceId ?? '');
  if (!spaceId) return res.status(400).json({ error: 'spaceId required' });
  try { res.json({ folders: await cu.listFolders(await requireToken(req.dbUserId!), spaceId) }); } catch (err) { fail(res, err); }
});

router.put('/target', attachDbUser, async (req, res) => {
  const parsed = z.object({
    teamId: z.string(), teamName: z.string(),
    spaceId: z.string(), spaceName: z.string(),
    folderId: z.string(), folderName: z.string(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a workspace, space and folder.' });
  try {
    await cu.saveTarget(req.dbUserId!, parsed.data);
    // The webhook lives at the workspace level; register it once the
    // workspace is known. Best-effort — the integration works without it.
    if (apiUrl()) {
      try { await cu.ensureWebhook(req.dbUserId!, `${apiUrl()}/api/clickup/webhook`); } catch (e) { console.warn('[ClickUp] webhook not registered:', e instanceof Error ? e.message : e); }
    }
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

router.patch('/settings', attachDbUser, async (req, res) => {
  const parsed = z.object({ syncBills: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid settings' });
  await db.clickUpConnection.update({ where: { userId: req.dbUserId! }, data: parsed.data });
  res.json({ ok: true });
});

// ── Tasks ───────────────────────────────────────────────────────────────────

/**
 * Tasks for one property, or for every property that has a list. Grouped by
 * property so the operations page can show the portfolio at a glance.
 */
router.get('/tasks', attachDbUser, async (req, res) => {
  const userId = req.dbUserId!;
  const propertyId = req.query.propertyId ? String(req.query.propertyId) : null;
  const includeClosed = req.query.includeClosed === 'true';
  try {
    const token = await requireToken(userId);
    const properties = await db.property.findMany({
      where: { userId, ...(propertyId ? { id: propertyId } : {}) },
      select: { id: true, address: true, nickname: true, clickupListId: true },
      orderBy: { address: 'asc' },
    });

    // A single property's page creates its list on first visit so "Add task"
    // always has somewhere to go; the portfolio view only reads what exists.
    if (propertyId && properties[0] && !properties[0].clickupListId) {
      const { listId } = await cu.ensurePropertyList(token, userId, propertyId);
      properties[0].clickupListId = listId;
    }

    const groups = await Promise.all(
      properties.filter(p => p.clickupListId).map(async p => ({
        propertyId: p.id,
        propertyName: p.nickname || p.address,
        listId: p.clickupListId!,
        tasks: await cu.listTasks(token, p.clickupListId!, includeClosed),
      })),
    );
    res.json({ groups });
  } catch (err) { fail(res, err); }
});

router.post('/tasks', attachDbUser, async (req, res) => {
  const parsed = z.object({
    propertyId: z.string(),
    name: z.string().min(1),
    description: z.string().optional(),
    dueDate: z.string().nullable().optional(),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A property and a task name are required.' });
  try {
    const token = await requireToken(req.dbUserId!);
    const { listId } = await cu.ensurePropertyList(token, req.dbUserId!, parsed.data.propertyId);
    const task = await cu.createTask(token, listId, parsed.data);
    res.status(201).json(task);
  } catch (err) { fail(res, err); }
});

router.patch('/tasks/:id', attachDbUser, async (req, res) => {
  const parsed = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    dueDate: z.string().nullable().optional(),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable().optional(),
    status: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nothing valid to update.' });
  try {
    const token = await requireToken(req.dbUserId!);
    res.json(await cu.updateTask(token, req.params.id, parsed.data));
  } catch (err) { fail(res, err); }
});

router.post('/tasks/:id/close', attachDbUser, async (req, res) => {
  const listId = String(req.body?.listId ?? '');
  if (!listId) return res.status(400).json({ error: 'listId required' });
  try {
    const token = await requireToken(req.dbUserId!);
    await cu.closeTask(token, listId, req.params.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/** Create, refresh and close the task for every unpaid bill. */
router.post('/sync-bills', attachDbUser, async (req, res) => {
  try {
    res.json(await cu.syncBillTasks(req.dbUserId!, appUrl()));
  } catch (err) { fail(res, err); }
});

// ── Webhook (no session — signed by ClickUp) ────────────────────────────────

/**
 * ClickUp signs each delivery with the secret it issued when the webhook was
 * registered. The raw body is what was signed, so this route is mounted with
 * express.raw in index.ts, ahead of the JSON parser.
 */
router.post('/webhook', async (req, res) => {
  const raw: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : undefined;
  if (!raw) return res.status(400).end();

  let payload: { event?: string; webhook_id?: string; task_id?: string };
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).end(); }
  if (!payload.webhook_id) return res.status(400).end();

  const conn = await db.clickUpConnection.findFirst({ where: { webhookId: payload.webhook_id } });
  if (!conn?.webhookSecretEnc) return res.status(404).end();

  const expected = createHmac('sha256', decrypt(conn.webhookSecretEnc)).update(raw).digest('hex');
  const given = String(req.header('X-Signature') ?? '');
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(401).end();
  }

  // A bill task deleted in ClickUp: forget the pointer so the next sync makes
  // a fresh one rather than trying to update a task that is gone.
  if (payload.event === 'taskDeleted' && payload.task_id) {
    await db.statement.updateMany({ where: { clickupTaskId: payload.task_id }, data: { clickupTaskId: null } });
  }
  res.status(200).end();
});

export default router;
