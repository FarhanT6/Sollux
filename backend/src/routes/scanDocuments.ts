import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument, getSignedDocumentUrl } from '../services/s3Service';
import { classifyDocument } from '../services/documentClassifyService';

const router = Router();
router.use(attachDbUser);

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

// GET / — list documents, optionally filtered by property/category
router.get('/', async (req, res, next) => {
  try {
    const { propertyId, category } = req.query;
    const documents = await db.document.findMany({
      where: {
        userId: req.dbUserId!,
        ...(propertyId ? { propertyId: propertyId as string } : {}),
        ...(category ? { category: category as any } : {}),
      },
      include: { property: { select: { id: true, address: true, nickname: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(documents);
  } catch (err) { next(err); }
});

// POST /analyze — classify a scanned PDF and suggest a property + category.
// Does NOT save anything; the frontend confirms via POST / afterward.
router.post('/analyze', async (req, res, next) => {
  try {
    const { fileData } = req.body as { fileData?: string };
    if (!fileData) return res.status(400).json({ error: 'fileData (base64 PDF) is required' });

    const buffer = Buffer.from(fileData, 'base64');
    const { classified, match } = await classifyDocument(buffer, req.dbUserId!);

    const properties = await db.property.findMany({
      where: { userId: req.dbUserId! },
      select: { id: true, address: true, nickname: true },
      orderBy: { address: 'asc' },
    });

    res.json({ classified, match, properties });
  } catch (err) { next(err); }
});

const ConfirmSchema = z.object({
  fileData:   z.string(),
  filename:   z.string().optional(),
  propertyId: z.string().optional().nullable(),
  category:   z.enum(['UTILITY', 'INSURANCE', 'TAX', 'LEGAL', 'HOA', 'EXPENSE_RECEIPT', 'LEASE', 'OTHER']),
  title:      z.string().min(1),
  pageCount:  z.number().int().min(1).default(1),
  notes:      z.string().optional().nullable(),
});

// POST / — save the confirmed document (uploads PDF to S3, creates the row)
router.post('/', async (req, res, next) => {
  try {
    const data = ConfirmSchema.parse(req.body);

    if (data.propertyId) {
      const prop = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
      if (!prop) return res.status(404).json({ error: 'Property not found' });
    }

    const buffer = Buffer.from(data.fileData, 'base64');
    const key = `${req.dbUserId}/documents/${data.propertyId || 'unfiled'}/${Date.now()}_${sanitizeFilename(data.filename || 'scan.pdf')}`;
    const s3Url = await uploadDocument(key, buffer);

    const document = await db.document.create({
      data: {
        userId:     req.dbUserId!,
        propertyId: data.propertyId || null,
        category:   data.category as any,
        title:      data.title,
        s3Key:      key,
        s3Url,
        pageCount:  data.pageCount,
        sourceType: 'SCAN',
        notes:      data.notes || null,
      },
    });
    res.status(201).json(document);
  } catch (err) { next(err); }
});

// GET /:id/url — signed URL to view the PDF
router.get('/:id/url', async (req, res, next) => {
  try {
    const doc = await db.document.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const url = await getSignedDocumentUrl(doc.s3Key);
    res.json({ url });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const doc = await db.document.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await db.document.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
