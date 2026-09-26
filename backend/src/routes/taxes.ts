import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { uploadDocument, getSignedDocumentUrl } from '../services/s3Service';
import { readDocument } from '../services/documentReader';

const router = Router();
router.use(attachDbUser);

const TaxSchema = z.object({
  propertyId: z.string(),
  taxYear: z.string().min(1),
  assessedValue: z.number().optional().nullable(),
  annualTaxAmount: z.number().positive(),
  installment1Due: z.string().transform(s => new Date(s)).optional().nullable(),
  installment2Due: z.string().transform(s => new Date(s)).optional().nullable(),
  installment1Paid: z.string().transform(s => new Date(s)).optional().nullable(),
  installment2Paid: z.string().transform(s => new Date(s)).optional().nullable(),
  status: z.enum(['UNPAID','PAID','PARTIALLY_PAID','DELINQUENT']).default('UNPAID'),
  notes: z.string().optional().nullable(),
  apn: z.string().optional().nullable(),
  taxingAuthority: z.string().optional().nullable(),
  installment1Amount: z.number().nonnegative().optional().nullable(),
  installment2Amount: z.number().nonnegative().optional().nullable(),
  escrowLoanId: z.string().optional().nullable(),
  /** The tax bill itself, stored and read back through a signed URL. */
  file: z.object({ name: z.string(), data: z.string() }).optional(),
});

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
async function storeBill(userId: string, propertyId: string, file?: { name: string; data: string }) {
  if (!file) return undefined;
  const key = `${userId}/taxes/${propertyId}/${Date.now()}_${sanitize(file.name)}`;
  await uploadDocument(key, Buffer.from(file.data, 'base64'));
  return key;
}
async function checkLoan(loanId: string | null | undefined, userId: string) {
  if (!loanId) return true;
  return !!(await db.loan.findFirst({ where: { id: loanId, userId }, select: { id: true } }));
}

router.get('/', async (req, res, next) => {
  try {
    const { propertyId } = req.query;
    const taxes = await db.taxAssessment.findMany({
      where: {
        property: { userId: req.dbUserId! },
        ...(propertyId ? { propertyId: propertyId as string } : {}),
      },
      include: { property: { select: { id: true, address: true, nickname: true, city: true, state: true } } },
      orderBy: [{ taxYear: 'desc' }],
    });
    res.json(taxes.map(({ documentS3Key, ...t }) => ({ ...t, hasDocument: !!documentS3Key })));
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { file, ...data } = TaxSchema.parse(req.body);
    const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    if (!(await checkLoan(data.escrowLoanId, req.dbUserId!))) return res.status(404).json({ error: 'Loan not found' });
    const documentS3Key = await storeBill(req.dbUserId!, data.propertyId, file);
    // One record per property and tax year: a second bill for the same year
    // (a supplemental, a corrected bill, a re-import) updates it.
    const tax = await db.taxAssessment.upsert({
      where: { propertyId_taxYear: { propertyId: data.propertyId, taxYear: data.taxYear } },
      create: { ...data, ...(documentS3Key ? { documentS3Key } : {}) },
      update: { ...data, ...(documentS3Key ? { documentS3Key } : {}) },
    });
    res.status(201).json(tax);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { file, ...data } = TaxSchema.partial().parse(req.body);
    const existing = await db.taxAssessment.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Tax assessment not found' });
    if (data.propertyId && !(await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } }))) return res.status(404).json({ error: 'Property not found' });
    if (!(await checkLoan(data.escrowLoanId, req.dbUserId!))) return res.status(404).json({ error: 'Loan not found' });
    const documentS3Key = await storeBill(req.dbUserId!, data.propertyId ?? existing.propertyId, file);
    const tax = await db.taxAssessment.update({ where: { id: req.params.id }, data: { ...data, ...(documentS3Key ? { documentS3Key } : {}) } });
    res.json(tax);
  } catch (err) { next(err); }
});

// POST /read — the fields of a tax bill from its pages, and its property; saves nothing.
router.post('/read', async (req, res, next) => {
  try {
    const { files } = z.object({ files: z.array(z.object({ name: z.string(), data: z.string() })).min(1).max(12) }).parse(req.body);
    const result = await readDocument('tax_bill', files, req.dbUserId!);
    // The parcel number identifies a property better than its address.
    if (result.fields.apn && (!result.match || result.match.confidence !== 'high')) {
      const digits = String(result.fields.apn).replace(/\D/g, '');
      const known = digits.length >= 6 ? await db.taxAssessment.findMany({
        where: { property: { userId: req.dbUserId! }, apn: { not: null } },
        select: { apn: true, property: { select: { id: true, address: true, nickname: true } } },
      }) : [];
      const prior = known.find(k => (k.apn ?? '').replace(/\D/g, '') === digits);
      if (prior) {
        result.match = { confidence: 'high', propertyId: prior.property.id, propertyName: prior.property.nickname || prior.property.address };
      }
    }
    res.json(result);
  } catch (err: any) {
    if (err?.message) return res.status(422).json({ error: err.message });
    next(err);
  }
});

router.get('/:id/document', async (req, res, next) => {
  try {
    const existing = await db.taxAssessment.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing?.documentS3Key) return res.status(404).json({ error: 'No tax bill attached' });
    res.json({ url: await getSignedDocumentUrl(existing.documentS3Key) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.taxAssessment.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Tax assessment not found' });
    await db.taxAssessment.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
