import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

// GET /api/dashboard/summary
router.get('/summary', async (req, res, next) => {
  try {
    const userId = req.dbUserId!;

    const properties = await db.property.findMany({
      where: { userId },
      include: {
        utilityAccounts: {
          include: {
            statements: { orderBy: { statementDate: 'desc' }, take: 1 },
          },
        },
        _count: { select: { insights: { where: { isRead: false, isDismissed: false } } } },
      },
    });

    const totalProperties = properties.length;
    const totalUtilityAccounts = properties.reduce((s, p) => s + p.utilityAccounts.length, 0);

    // Sum latest statement amounts for "monthly total"
    const monthlyTotal = properties.reduce((sum, prop) =>
      sum + prop.utilityAccounts.reduce((s, acc) => {
        const latest = acc.statements[0];
        return s + Number(latest?.amountDue ?? 0);
      }, 0), 0);

    const unreadInsights = await db.aIInsight.count({
      where: {
        property: { userId },
        isRead: false,
        isDismissed: false,
      },
    });

    const alertInsights = await db.aIInsight.count({
      where: {
        property: { userId },
        isRead: false,
        isDismissed: false,
        severity: 'ALERT',
      },
    });

    // Bills due within 7 days
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    const dueSoon = await db.statement.findMany({
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
    });
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

    const recentPayments = await db.payment.findMany({
      where: { utilityAccount: { property: { userId } } },
      orderBy: { paymentDate: 'desc' },
      take: 10,
      include: {
        utilityAccount: {
          select: { providerName: true, category: true, property: { select: { address: true, nickname: true } } },
        },
      },
    });

    // One upcoming bill per utility account — latest unpaid statement per account
    const accountsWithBills = await db.utilityAccount.findMany({
      where: { property: { userId }, syncEnabled: true },
      include: {
        property: { select: { id: true, address: true, nickname: true } },
        statements: {
          where: { dueDate: { gte: new Date() }, amountPaid: null },
          orderBy: { statementDate: 'desc' },
          take: 1,
        },
      },
    });

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
