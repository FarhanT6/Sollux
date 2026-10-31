/**
 * The bills sheet: every active account, grouped by property, with its bills
 * and payments — what the owner's old spreadsheet showed on one tab per
 * property (company, account, amount, due day, link, notes, and a column per
 * month). The paid state of each bill is decided in the browser with the same
 * rule the account page uses (frontend lib/paidState.ts), so the two never
 * disagree; this route only gathers the rows.
 */
import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { websiteFor } from '../lib/providerDirectory';

const router = Router();
router.use(attachDbUser);

const num = (v: unknown) => (v == null ? null : Number(v));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// GET /api/bills — accounts by property, each with its statements (newest first) and payments.
router.get('/', async (req, res, next) => {
  try {
    const props = await db.property.findMany({
      where: { userId: req.dbUserId!, status: { not: 'SOLD' } },
      select: {
        id: true, nickname: true, address: true, city: true, state: true,
        utilityAccounts: {
          where: { isActive: true },
          select: {
            id: true, providerName: true, providerSlug: true, category: true, accountNumber: true, loginUrl: true, isPersonal: true,
            notes: true, serviceLabel: true, billingCadence: true, unit: { select: { unitLabel: true } },
          },
          orderBy: [{ category: 'asc' }, { providerName: 'asc' }],
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const accountIds = props.flatMap(p => p.utilityAccounts.map(a => a.id));
    const [statements, payments] = await Promise.all([
      db.statement.findMany({
        where: { utilityAccountId: { in: accountIds } },
        select: {
          id: true, utilityAccountId: true, statementDate: true, dueDate: true, amountDue: true, amountPaid: true,
          pastDueCarried: true, balance: true, trueUpDeferred: true, paymentPlanAmount: true, paidOverride: true,
          isScheduled: true, isDownPayment: true, pdfS3Key: true,
        },
        orderBy: { statementDate: 'desc' },
      }),
      db.payment.findMany({
        where: { utilityAccountId: { in: accountIds } },
        select: {
          id: true, utilityAccountId: true, statementId: true, amount: true, paymentDate: true, status: true,
          notes: true, lateFeeAdded: true, feesAddedJson: true,
        },
        orderBy: { paymentDate: 'desc' },
      }),
    ]);
    const stmtsBy = new Map<string, any[]>();
    for (const s of statements) {
      const list = stmtsBy.get(s.utilityAccountId) ?? [];
      list.push({
        id: s.id, statementDate: day(s.statementDate), dueDate: day(s.dueDate),
        amountDue: num(s.amountDue), amountPaid: num(s.amountPaid), pastDueCarried: num(s.pastDueCarried), balance: num(s.balance),
        trueUpDeferred: num(s.trueUpDeferred), paymentPlanAmount: num(s.paymentPlanAmount), paidOverride: s.paidOverride,
        isScheduled: s.isScheduled, isDownPayment: s.isDownPayment, hasPdf: !!s.pdfS3Key,
      });
      stmtsBy.set(s.utilityAccountId, list);
    }
    const paysBy = new Map<string, any[]>();
    for (const p of payments) {
      const list = paysBy.get(p.utilityAccountId) ?? [];
      list.push({
        id: p.id, statementId: p.statementId, amount: Number(p.amount), paymentDate: day(p.paymentDate), status: p.status,
        notes: p.notes, lateFeeAdded: num(p.lateFeeAdded), feesAddedJson: p.feesAddedJson,
      });
      paysBy.set(p.utilityAccountId, list);
    }
    type Acct = typeof props[number]['utilityAccounts'][number];
    const row = (a: Acct, propertyId: string) => ({
      id: a.id, propertyId, providerName: a.providerName, category: a.category, billingCadence: a.billingCadence,
      last4: a.accountNumber ? String(a.accountNumber).replace(/\D/g, '').slice(-4) || null : null,
      serves: a.unit?.unitLabel ?? a.serviceLabel ?? null, notes: a.notes,
      website: websiteFor(a)?.url ?? null,
      statements: stmtsBy.get(a.id) ?? [], payments: paysBy.get(a.id) ?? [],
    });
    // The owner's personal bills sit together at the end, not under the property they were filed on.
    const personal = props.flatMap(p => p.utilityAccounts.filter(a => a.isPersonal).map(a => row(a, p.id)));
    res.json({
      properties: [
        ...props.map(p => ({
          id: p.id, name: p.nickname || p.address, address: p.address, city: p.city, state: p.state,
          accounts: p.utilityAccounts.filter(a => !a.isPersonal).map(a => row(a, p.id)),
        })),
        ...(personal.length ? [{ id: 'personal', name: 'Personal', address: 'Personal', city: '', state: '', accounts: personal, personal: true }] : []),
      ],
    });
  } catch (err) { next(err); }
});

export default router;
