import { Router } from 'express';
const router = Router();
router.get('/me', (_, res) => res.json({ status: 'ok' }));
export default router;
