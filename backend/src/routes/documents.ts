import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
const router = Router();
router.use(attachDbUser);
router.get('/', async (req, res, next) => {
  try {
    const userProperties = await db.property.findMany({ where: { userId: req.dbUserId! }, select: { id: true } });
    const statements = await db.statement.findMany({
      where: { pdfS3Key: { not: null }, utilityAccount: { propertyId: { in: userProperties.map(p => p.id) } } },
      orderBy: { statementDate: 'desc' },
      take: 200,
      include: { utilityAccount: { select: { providerName: true, category: true, property: { select: { address: true, nickname: true } } } } },
    });
    res.json(statements);
  } catch (err) { next(err); }
});
export default router;
