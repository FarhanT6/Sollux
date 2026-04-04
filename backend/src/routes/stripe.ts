import { Router } from 'express';
const router = Router();
router.post('/webhook', (_, res) => res.json({ received: true }));
export default router;
