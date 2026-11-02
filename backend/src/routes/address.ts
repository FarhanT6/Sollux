/** Address suggestions as the owner types (services/addressSuggest.ts). */
import { Router } from 'express';
import { attachDbUser } from '../middleware/requireAuth';
import { suggestAddresses, addressDetails } from '../services/addressSuggest';

const router = Router();
router.use(attachDbUser);

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

router.get('/suggest', async (req, res) => {
  try {
    res.json({ suggestions: await suggestAddresses(str(req.query.q, 200), str(req.query.session, 64) || undefined) });
  } catch (e) {
    // Typing still works without suggestions; say why without failing loudly.
    res.json({ suggestions: [], error: e instanceof Error ? e.message : 'Address search failed' });
  }
});

router.get('/details', async (req, res) => {
  const placeId = str(req.query.placeId, 300);
  if (!placeId) return res.status(400).json({ error: 'placeId is required' });
  try {
    res.json(await addressDetails(placeId, str(req.query.session, 64) || undefined));
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'Address lookup failed' });
  }
});

export default router;
