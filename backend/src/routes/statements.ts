import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { getSignedDocumentUrl } from '../services/s3Service';

const router = Router();
router.use(attachDbUser);

// GET /api/statements?utilityAccountId=xxx&propertyId=xxx
router.get('/', async (req, res, next) => {
  try {
    const { utilityAccountId, propertyId } = req.query;

    const where: any = {};

    if (utilityAccountId) {
      // Verify access
      const account = await db.utilityAccount.findFirst({
        where: { id: String(utilityAccountId), property: { userId: req.dbUserId! } },
      });
      if (!account) return res.status(404).json({ error: 'Utility account not found' });
      where.utilityAccountId = String(utilityAccountId);
    } else if (propertyId) {
      const property = await db.property.findFirst({
        where: { id: String(propertyId), userId: req.dbUserId! },
      });
      if (!property) return res.status(404).json({ error: 'Property not found' });
      where.utilityAccount = { propertyId: String(propertyId) };
    } else {
      const userProperties = await db.property.findMany({
        where: { userId: req.dbUserId! },
        select: { id: true },
      });
      where.utilityAccount = { propertyId: { in: userProperties.map(p => p.id) } };
    }

    const statements = await db.statement.findMany({
      where,
      orderBy: { statementDate: 'desc' },
      take: 100,
      include: {
        utilityAccount: {
          select: { providerName: true, category: true, property: { select: { address: true, nickname: true } } },
        },
      },
    });

    res.json(statements);
  } catch (err) {
    next(err);
  }
});

// GET /api/statements/:id/download — signed S3 URL for PDF
router.get('/:id/download', async (req, res, next) => {
  try {
    const statement = await db.statement.findFirst({
      where: {
        id: req.params.id,
        utilityAccount: { property: { userId: req.dbUserId! } },
      },
    });

    if (!statement) return res.status(404).json({ error: 'Statement not found' });
    if (!statement.pdfS3Key) return res.status(404).json({ error: 'No PDF available' });

    const url = await getSignedDocumentUrl(statement.pdfS3Key);
    res.json({ url, expiresIn: 3600 });
  } catch (err) {
    next(err);
  }
});

export default router;
