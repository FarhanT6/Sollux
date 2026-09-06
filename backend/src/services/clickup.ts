/**
 * ClickUp, as Sollux uses it.
 *
 * Sollux is the system of record for money — bills, payments, arrears,
 * deadlines. ClickUp is where the work lives: repairs, vendors, tenant
 * follow-ups, and the act of paying a bill. So the integration runs one way:
 * Sollux knows things ClickUp cannot (that a bill is overdue, that a penalty
 * lands on the 9th) and turns them into tasks; people do the tasks in ClickUp.
 *
 * Shape in ClickUp: one folder for property operations, one list per
 * property inside it. Lists are created on demand and remembered on the
 * property, so nothing has to be set up by hand beyond choosing the folder.
 */
import { db } from '../config/db';
import { encrypt, decrypt } from '../crypto/encrypt';
import { getPaymentPriorities } from './paymentPriority';

const API = 'https://api.clickup.com/api/v2';

export interface ClickUpTask {
  id: string;
  name: string;
  description?: string;
  status: { status: string; type: string; color?: string };
  priority: { id: string; priority: string } | null;
  due_date: string | null;         // ms epoch as string
  date_created: string;
  date_updated: string;
  date_closed: string | null;
  url: string;
  tags: { name: string }[];
  assignees: { id: number; username: string; initials?: string; profilePicture?: string | null }[];
  list?: { id: string; name: string };
}

export class ClickUpError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { err?: string }).err ?? ''; } catch { /* not json */ }
    throw new ClickUpError(
      res.status === 401 ? 'ClickUp rejected the token.' : `ClickUp ${res.status}${detail ? `: ${detail}` : ''}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

// ── Connection ──────────────────────────────────────────────────────────────

export async function getConnection(userId: string) {
  return db.clickUpConnection.findUnique({ where: { userId } });
}

/** The decrypted token, or null when the user is not connected. */
export async function tokenFor(userId: string): Promise<string | null> {
  const c = await getConnection(userId);
  return c ? decrypt(c.tokenEnc) : null;
}

export async function verifyToken(token: string) {
  const { user } = await call<{ user: { id: number; username: string } }>(token, '/user');
  return user;
}

export async function connect(userId: string, token: string) {
  const user = await verifyToken(token);
  return db.clickUpConnection.upsert({
    where: { userId },
    create: { userId, tokenEnc: encrypt(token), clickupUserId: String(user.id), clickupUserName: user.username },
    update: { tokenEnc: encrypt(token), clickupUserId: String(user.id), clickupUserName: user.username },
  });
}

export async function disconnect(userId: string) {
  const c = await getConnection(userId);
  if (!c) return;
  // Best-effort: remove the webhook so ClickUp stops calling a dead endpoint.
  if (c.webhookId) {
    try { await call(decrypt(c.tokenEnc), `/webhook/${c.webhookId}`, { method: 'DELETE' }); } catch { /* gone already */ }
  }
  await db.clickUpConnection.delete({ where: { userId } });
  // Lists and tasks stay in ClickUp — they are the user's work. Only the
  // pointers go, so a reconnect creates fresh ones rather than pointing at
  // lists in a workspace it may no longer have access to.
  await db.property.updateMany({ where: { userId, clickupListId: { not: null } }, data: { clickupListId: null } });
}

// ── Hierarchy pickers ───────────────────────────────────────────────────────

export const listTeams = (token: string) =>
  call<{ teams: { id: string; name: string }[] }>(token, '/team').then(r => r.teams);

export const listSpaces = (token: string, teamId: string) =>
  call<{ spaces: { id: string; name: string }[] }>(token, `/team/${teamId}/space?archived=false`).then(r => r.spaces);

export const listFolders = (token: string, spaceId: string) =>
  call<{ folders: { id: string; name: string; lists: { id: string; name: string }[] }[] }>(token, `/space/${spaceId}/folder?archived=false`).then(r => r.folders);

export async function saveTarget(userId: string, target: { teamId: string; teamName: string; spaceId: string; spaceName: string; folderId: string; folderName: string }) {
  return db.clickUpConnection.update({ where: { userId }, data: target });
}

// ── Lists per property ──────────────────────────────────────────────────────

/**
 * The property's list, created on first use. Named by the property's nickname
 * or address, which is how the owner thinks of it.
 */
export async function ensurePropertyList(token: string, userId: string, propertyId: string): Promise<{ listId: string; created: boolean }> {
  const property = await db.property.findFirst({
    where: { id: propertyId, userId },
    select: { id: true, address: true, nickname: true, clickupListId: true },
  });
  if (!property) throw new ClickUpError('Property not found', 404);
  if (property.clickupListId) return { listId: property.clickupListId, created: false };

  const conn = await getConnection(userId);
  if (!conn?.folderId) throw new ClickUpError('Choose a ClickUp folder for property operations first.', 400);

  const name = property.nickname || property.address;
  // Reuse a list of the same name if one exists — a reconnect, or a list the
  // owner made by hand — rather than creating a duplicate.
  const existing = (await call<{ lists: { id: string; name: string }[] }>(token, `/folder/${conn.folderId}/list?archived=false`)).lists
    .find(l => l.name.trim().toLowerCase() === name.trim().toLowerCase());
  const list = existing ?? await call<{ id: string }>(token, `/folder/${conn.folderId}/list`, {
    method: 'POST', body: JSON.stringify({ name }),
  });
  await db.property.update({ where: { id: property.id }, data: { clickupListId: list.id } });
  return { listId: list.id, created: !existing };
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export const listTasks = (token: string, listId: string, includeClosed = false) =>
  call<{ tasks: ClickUpTask[] }>(token, `/list/${listId}/task?include_closed=${includeClosed}&subtasks=true&order_by=due_date`).then(r => r.tasks);

export interface NewTask {
  name: string;
  description?: string;
  /** ISO date; sent as an all-day due date. */
  dueDate?: string | null;
  /** 1 urgent · 2 high · 3 normal · 4 low */
  priority?: 1 | 2 | 3 | 4 | null;
  tags?: string[];
  status?: string;
}

const toDueMs = (iso?: string | null) => (iso ? new Date(iso).getTime() : undefined);

export const createTask = (token: string, listId: string, t: NewTask) =>
  call<ClickUpTask>(token, `/list/${listId}/task`, {
    method: 'POST',
    body: JSON.stringify({
      name: t.name,
      description: t.description ?? undefined,
      due_date: toDueMs(t.dueDate),
      due_date_time: false,
      priority: t.priority ?? undefined,
      tags: t.tags ?? undefined,
      status: t.status ?? undefined,
    }),
  });

export const updateTask = (token: string, taskId: string, t: Partial<NewTask>) =>
  call<ClickUpTask>(token, `/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...(t.name !== undefined && { name: t.name }),
      ...(t.description !== undefined && { description: t.description }),
      ...(t.dueDate !== undefined && { due_date: toDueMs(t.dueDate) ?? null, due_date_time: false }),
      ...(t.priority !== undefined && { priority: t.priority }),
      ...(t.status !== undefined && { status: t.status }),
    }),
  });

export const getTask = (token: string, taskId: string) => call<ClickUpTask>(token, `/task/${taskId}`);

/**
 * Status names are per list in ClickUp, so "done" has to be looked up: the
 * list's status of type "closed", whatever it is called there.
 */
export async function closeTask(token: string, listId: string, taskId: string) {
  const list = await call<{ statuses: { status: string; type: string }[] }>(token, `/list/${listId}`);
  const closed = list.statuses.find(s => s.type === 'closed') ?? list.statuses[list.statuses.length - 1];
  if (!closed) return;
  await updateTask(token, taskId, { status: closed.status });
}

// ── Bills → tasks ───────────────────────────────────────────────────────────

const BILL_TAG = 'sollux-bill';
const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null);

/**
 * One task per unpaid bill, kept current; closed when Sollux sees it paid.
 *
 * Priority follows what lateness costs: overdue is urgent, a penalty within a
 * week is high, otherwise normal. The task carries the amount, the due and
 * penalty dates, and a link back to the account, so paying it needs nothing
 * that is not on the card.
 */
export async function syncBillTasks(userId: string, appUrl: string): Promise<{ created: number; updated: number; closed: number; skipped: string[] }> {
  const conn = await getConnection(userId);
  const result = { created: 0, updated: 0, closed: 0, skipped: [] as string[] };
  if (!conn || !conn.syncBills || !conn.folderId) return result;
  const token = decrypt(conn.tokenEnc);

  const priorities = await getPaymentPriorities(userId);
  const owedByAccount = new Map(priorities.map(p => [p.accountId, p]));

  // Every latest statement that carries a task, plus every account that owes
  // something: the union is what needs looking at.
  const accounts = await db.utilityAccount.findMany({
    where: { property: { userId }, isActive: true },
    select: {
      id: true, providerName: true, serviceLabel: true, propertyId: true,
      statements: { orderBy: { statementDate: 'desc' }, take: 1, select: { id: true, clickupTaskId: true } },
    },
  });

  for (const acct of accounts) {
    const latest = acct.statements[0];
    if (!latest) continue;
    const owed = owedByAccount.get(acct.id);
    const label = acct.serviceLabel ? `${acct.providerName} — ${acct.serviceLabel}` : acct.providerName;

    try {
      if (owed && owed.balanceToCurrent > 0.01) {
        const { listId } = await ensurePropertyList(token, userId, acct.propertyId);
        const overdue = owed.dueDate ? new Date(owed.dueDate) < new Date() : false;
        const penaltySoon = owed.daysUntilPenalty != null && owed.daysUntilPenalty <= 7;
        const task: NewTask = {
          name: `Pay ${label} — ${money(owed.balanceToCurrent)}`,
          description: [
            `**${owed.propertyName}** · ${label}`,
            `Owed now: ${money(owed.balanceToCurrent)}` + (owed.pastDue > 0 ? ` (${money(owed.pastDue)} past due)` : ''),
            owed.dueDate ? `Due: ${day(owed.dueDate)}` : null,
            owed.penaltyDate ? `Penalty ${owed.penaltyDateIsEstimate ? 'expected' : 'assessed'} after: ${day(owed.penaltyDate)}` : null,
            '',
            `${appUrl}/properties/${acct.propertyId}/utilities/${acct.id}`,
          ].filter(l => l != null).join('\n'),
          dueDate: owed.penaltyDate ?? owed.dueDate ?? null,
          priority: overdue ? 1 : penaltySoon ? 2 : 3,
          tags: [BILL_TAG],
        };
        if (latest.clickupTaskId) {
          await updateTask(token, latest.clickupTaskId, task);
          result.updated++;
        } else {
          const created = await createTask(token, listId, task);
          await db.statement.update({ where: { id: latest.id }, data: { clickupTaskId: created.id } });
          result.created++;
        }
      } else if (latest.clickupTaskId) {
        // Paid, or nothing owed: close the task and forget it, so a future
        // balance gets a fresh task rather than reopening a settled one.
        const property = await db.property.findUnique({ where: { id: acct.propertyId }, select: { clickupListId: true } });
        if (property?.clickupListId) await closeTask(token, property.clickupListId, latest.clickupTaskId);
        await db.statement.update({ where: { id: latest.id }, data: { clickupTaskId: null } });
        result.closed++;
      }
    } catch (err) {
      result.skipped.push(`${label}: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }
  return result;
}

// ── Webhook ─────────────────────────────────────────────────────────────────

export async function ensureWebhook(userId: string, endpoint: string) {
  const conn = await getConnection(userId);
  if (!conn?.teamId) return null;
  if (conn.webhookId) return conn.webhookId;
  const token = decrypt(conn.tokenEnc);
  const created = await call<{ id: string; webhook: { secret: string } }>(token, `/team/${conn.teamId}/webhook`, {
    method: 'POST',
    body: JSON.stringify({ endpoint, events: ['taskStatusUpdated', 'taskDeleted', 'taskUpdated'] }),
  });
  await db.clickUpConnection.update({
    where: { userId },
    data: { webhookId: created.id, webhookSecretEnc: encrypt(created.webhook.secret) },
  });
  return created.id;
}
