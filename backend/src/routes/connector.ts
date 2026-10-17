/**
 * Settings for the Sollux connector (services/connector.ts): the owner's
 * computers that portal fetches can run on. A connection code is shown once;
 * only its hash is kept.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { newDeviceToken, hashToken, disconnectDevice } from '../services/connector';

const router = Router();
router.use(attachDbUser);
router.use((req, res, next) => (req.isAccountOwner ? next() : res.status(403).json({ error: 'Only the account owner can connect a computer.' })));

const ONLINE_MS = 90_000;

router.get('/', async (req: Request, res: Response) => {
  const devices = await db.connectorDevice.findMany({ where: { userId: req.dbUserId! }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, createdAt: true, lastSeenAt: true, agent: true } });
  res.json({ devices: devices.map(d => ({ ...d, online: !!d.lastSeenAt && Date.now() - d.lastSeenAt.getTime() < ONLINE_MS })) });
});

router.post('/', async (req: Request, res: Response) => {
  const { name } = z.object({ name: z.string().trim().min(1).max(60).default('My computer') }).parse(req.body ?? {});
  if (await db.connectorDevice.count({ where: { userId: req.dbUserId! } }) >= 5) return res.status(400).json({ error: 'Five computers at most — remove one first.' });
  const token = newDeviceToken();
  const device = await db.connectorDevice.create({ data: { userId: req.dbUserId!, name, tokenHash: hashToken(token) }, select: { id: true, name: true } });
  res.json({ ...device, token });
});

router.delete('/:id', async (req: Request, res: Response) => {
  const d = await db.connectorDevice.findFirst({ where: { id: req.params.id, userId: req.dbUserId! }, select: { id: true } });
  if (!d) return res.status(404).json({ error: 'Not found' });
  await db.connectorDevice.delete({ where: { id: d.id } });
  disconnectDevice(d.id);
  res.json({ ok: true });
});

export default router;
