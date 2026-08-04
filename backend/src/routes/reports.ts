import { Router } from 'express';
import { attachDbUser } from '../middleware/requireAuth';
import { buildRentRollWorkbook, buildT12Workbook } from '../services/reportService';

const router = Router();
router.use(attachDbUser);

router.get('/rent-roll/:propertyId', async (req, res, next) => {
  try {
    const buffer = await buildRentRollWorkbook(req.params.propertyId, req.dbUserId!);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="RentRoll.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    if (err instanceof Error && err.message === 'Property not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

router.get('/t12/:propertyId', async (req, res, next) => {
  try {
    const buffer = await buildT12Workbook(req.params.propertyId, req.dbUserId!);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="T12.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    if (err instanceof Error && err.message === 'Property not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

export default router;
