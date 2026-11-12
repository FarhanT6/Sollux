import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

// GET /api/dashboard/summary
router.get('/summary', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;

    // In parallel, and without loading every statement: the newest bill on each account is
    // summed by the database (DISTINCT ON), where every statement used to come back to be read here.
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    const [totalProperties, totalUtilityAccounts, latest, unreadInsights, alertInsights, dueSoon] = await Promise.all([
      db.property.count({ where: { userId } }),
      db.utilityAccount.count({ where: { property: { userId } } }),
      // Sum of the latest statement amounts: the "monthly total".
      db.$queryRaw<{ total: number | null }[]>`
        SELECT COALESCE(SUM(t."amountDue"), 0)::float8 AS total FROM (
          SELECT DISTINCT ON (s."utilityAccountId") s."amountDue"
          FROM statements s
          JOIN utility_accounts ua ON ua.id = s."utilityAccountId"
          JOIN properties p ON p.id = ua."propertyId"
          WHERE p."userId" = ${userId}
          ORDER BY s."utilityAccountId", s."statementDate" DESC
        ) t`,
      db.aIInsight.count({ where: { property: { userId }, isRead: false, isDismissed: false } }),
      db.aIInsight.count({ where: { property: { userId }, isRead: false, isDismissed: false, severity: 'ALERT' } }),
      // Bills due within 7 days
      db.statement.findMany({
        where: {
          utilityAccount: { property: { userId } },
          dueDate: { gte: new Date(), lte: sevenDaysFromNow },
          amountPaid: null,
        },
        select: {
          id: true, dueDate: true, amountDue: true, pastDueCarried: true, billingPeriodEnd: true, statementDate: true,
          utilityAccount: { select: { id: true, providerName: true, category: true, property: { select: { id: true, address: true, nickname: true } } } },
        },
        orderBy: { dueDate: 'asc' },
      }),
    ]);
    const monthlyTotal = Number(latest[0]?.total ?? 0);

    const billsDueSoon = dueSoon.length;
    // The count alone sends the reader hunting; each bill named, with where it
    // lives, lets them go straight to it.
    const billsDueSoonList = dueSoon.map(s => ({
      id: s.id,
      dueDate: s.dueDate,
      amountDue: s.amountDue != null ? Number(s.amountDue) : null,
      pastDueCarried: s.pastDueCarried != null ? Number(s.pastDueCarried) : null,
      periodEnd: s.billingPeriodEnd ?? s.statementDate,
      accountId: s.utilityAccount.id,
      providerName: s.utilityAccount.providerName,
      category: s.utilityAccount.category,
      propertyId: s.utilityAccount.property.id,
      propertyLabel: s.utilityAccount.property.nickname || s.utilityAccount.property.address,
    }));

    res.json({
      totalProperties,
      totalUtilityAccounts,
      monthlyTotal: Math.round(monthlyTotal * 100) / 100,
      unreadInsights,
      alertInsights,
      billsDueSoon,
      billsDueSoonList,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/recent-activity
router.get('/recent-activity', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;

    // Both at once, with only the fields the Overview shows (whole statement rows, raw bill data included, came back).
    const [recentPayments, accountsWithBills] = await Promise.all([
      db.payment.findMany({
        where: { utilityAccount: { property: { userId } } },
        orderBy: { paymentDate: 'desc' },
        take: 10,
        include: {
          utilityAccount: {
            select: { providerName: true, category: true, property: { select: { address: true, nickname: true } } },
          },
        },
      }),
      // One upcoming bill per utility account — latest unpaid statement per account
      db.utilityAccount.findMany({
        where: { property: { userId }, syncEnabled: true },
        select: {
          id: true, providerName: true, category: true,
          property: { select: { id: true, address: true, nickname: true } },
          statements: {
            // Not paid: by the owner's mark, else nothing printed as paid on it.
            where: { dueDate: { gte: new Date() }, OR: [{ paidOverride: 'UNPAID' }, { paidOverride: null, amountPaid: null }] },
            orderBy: { statementDate: 'desc' },
            take: 1,
            select: {
              id: true, utilityAccountId: true, statementDate: true, dueDate: true, billingPeriodStart: true, billingPeriodEnd: true,
              amountDue: true, amountPaid: true, pastDueCarried: true, paidOverride: true, isScheduled: true, usageValue: true, usageUnit: true,
            },
          },
        },
      }),
    ]);

    const upcomingBills = accountsWithBills
      .filter(a => a.statements.length > 0)
      .map(a => ({
        ...a.statements[0],
        utilityAccount: {
          id: a.id,
          providerName: a.providerName,
          category: a.category,
          property: a.property,
        },
      }))
      .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());

    res.json({ recentPayments, upcomingBills });
  } catch (err) {
    next(err);
  }
});

export default router;
