import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const LegalSchema = z.object({
  propertyId: z.string().optional().nullable(),
  title: z.string().min(1),
  matterType: z.string().min(1),
  status: z.enum(['OPEN','CLOSED','ON_HOLD']).default('OPEN'),
  filedDate: z.string().transform(s => new Date(s)).optional().nullable(),
  closedDate: z.string().transform(s => new Date(s)).optional().nullable(),
  attorney: z.string().optional().nullable(),
  caseNumber: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  documentUrl: z.string().optional().nullable(),
});

router.get('/', async (req, res, next) => {
  try {
    const { propertyId, status } = req.query;
    const matters = await db.legalMatter.findMany({
      where: {
        userId: req.dbUserId!,
        ...(propertyId ? { propertyId: propertyId as string } : {}),
        ...(status ? { status: status as any } : {}),
      },
      include: { property: { select: { id: true, address: true, nickname: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(matters);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = LegalSchema.parse(req.body);
    const matter = await db.legalMatter.create({ data: { ...data, userId: req.dbUserId! } });
    res.status(201).json(matter);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const data = LegalSchema.partial().parse(req.body);
    const existing = await db.legalMatter.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Legal matter not found' });
    const matter = await db.legalMatter.update({ where: { id: req.params.id }, data });
    res.json(matter);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.legalMatter.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Legal matter not found' });
    await db.legalMatter.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
