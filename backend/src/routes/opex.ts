/**
 * Operating expenses: a statement per property built from the records and
 * the owner's setup (lib/opexStatement.ts, services/operatingExpenses.ts).
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { opexFacts, saveSetup, estimateFor, rangeFor, type Period } from '../services/operatingExpenses';
import { buildStatement, suggestionsFor, type OpexConfig } from '../lib/opexStatement';

const router = Router();
router.use(attachDbUser);

const PeriodQ = z.enum(['last12', 'ytd', 'lastYear']).default('last12');
const Config = z.object({
  utilities: z.record(z.boolean()).optional(),
  lateFees: z.enum(['separate', 'exclude']).optional(),
  debtService: z.boolean().optional(),
  categories: z.record(z.boolean()).optional(),
  capex: z.boolean().optional(),
  taxes: z.object({ source: z.enum(['records', 'manual', 'estimate', 'none']), manualAnnual: z.number().nonnegative().nullable().optional() }).optional(),
  insurance: z.object({ source: z.enum(['records', 'manual', 'estimate', 'none']), manualAnnual: z.number().nonnegative().nullable().optional() }).optional(),
  manual: z.array(z.object({ id: z.string().min(1).max(60), label: z.string().min(1).max(120), amount: z.number().nonnegative(), per: z.enum(['month', 'year', 'pctRent']) })).max(40).optional(),
});
const fail = (res: any, next: any) => (err: any) => (err?.status ? res.status(err.status).json({ error: err.message }) : next(err));

/** The statement for one property, from the saved setup or one being tried (config). */
async function statementFor(userId: string, propertyId: string, period: Period, config?: OpexConfig) {
  const range = rangeFor(period);
  const { facts, saved, property } = await opexFacts(propertyId, userId, range);
  const cfg = config ?? saved.config ?? {};
  return {
    property, period: { key: period, label: range.label, start: range.start.toISOString().slice(0, 10), end: range.end.toISOString().slice(0, 10) },
    configured: !!saved.config, config: cfg, facts, suggestions: suggestionsFor(facts, cfg), statement: buildStatement(facts, cfg),
  };
}

// GET /api/opex — every property's statement on its saved setup: the portfolio summary.
router.get('/', async (req, res, next) => {
  try {
    const period = PeriodQ.parse(req.query.period);
    const props = await db.property.findMany({ where: { userId: req.dbUserId!, status: { not: 'SOLD' } }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    const rows = [];
    for (const p of props) {
      const r = await statementFor(req.dbUserId!, p.id, period);
      rows.push({ property: r.property, configured: r.configured, statement: r.statement });
    }
    res.json({ period: rangeFor(period).label, properties: rows });
  } catch (err) { fail(res, next)(err); }
});

// GET /api/opex/:propertyId?period= — the statement and everything the setup offers.
router.get('/:propertyId', async (req, res, next) => {
  try { res.json(await statementFor(req.dbUserId!, req.params.propertyId, PeriodQ.parse(req.query.period))); }
  catch (err) { fail(res, next)(err); }
});

// POST /api/opex/:propertyId/preview { config, period } — the statement with a setup not yet saved.
router.post('/:propertyId/preview', async (req, res, next) => {
  try {
    const body = z.object({ config: Config, period: PeriodQ }).parse(req.body);
    res.json(await statementFor(req.dbUserId!, req.params.propertyId, body.period, body.config));
  } catch (err) { fail(res, next)(err); }
});

// PUT /api/opex/:propertyId/setup { config } — save what the statement includes.
router.put('/:propertyId/setup', async (req, res, next) => {
  try {
    const { config } = z.object({ config: Config }).parse(req.body);
    await saveSetup(req.params.propertyId, req.dbUserId!, { config });
    res.json({ ok: true });
  } catch (err) { fail(res, next)(err); }
});

// POST /api/opex/:propertyId/estimate { kind } — an insurance premium or property tax estimate (AI with web search).
router.post('/:propertyId/estimate', async (req, res, next) => {
  try {
    const { kind } = z.object({ kind: z.enum(['insurance', 'tax']) }).parse(req.body);
    res.json(await estimateFor(req.params.propertyId, req.dbUserId!, kind));
  } catch (err) { fail(res, next)(err); }
});

export default router;
