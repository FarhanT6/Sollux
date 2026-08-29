import { Router } from 'express';
import { attachDbUser } from '../middleware/requireAuth';
import {
  buildRentRollWorkbook, buildT12Workbook, getT12Manifest,
  RENT_ROLL_COLUMNS, RentRollColumnKey,
} from '../services/reportService';

const router = Router();
router.use(attachDbUser);

function parseCsv(q: unknown): string[] | undefined {
  if (typeof q !== 'string' || q.length === 0) return undefined;
  return q.split(',').map(s => s.trim()).filter(Boolean);
}

router.get('/rent-roll/:propertyId', async (req, res, next) => {
  try {
    const requested = parseCsv(req.query.columns);
    const columns = requested
      ? RENT_ROLL_COLUMNS.map(c => c.key).filter(k => requested.includes(k)) as RentRollColumnKey[]
      : undefined;
    const buffer = await buildRentRollWorkbook(req.params.propertyId, req.dbUserId!, columns);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="RentRoll.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    if (err instanceof Error && err.message === 'Property not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

router.get('/t12/:propertyId/manifest', async (req, res, next) => {
  try {
    const manifest = await getT12Manifest(req.params.propertyId, req.dbUserId!);
    res.json(manifest);
  } catch (err) {
    if (err instanceof Error && err.message === 'Property not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

router.get('/t12/:propertyId', async (req, res, next) => {
  try {
    const rows = parseCsv(req.query.rows);
    const buffer = await buildT12Workbook(req.params.propertyId, req.dbUserId!, rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="T12.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    if (err instanceof Error && err.message === 'Property not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

export default router;
