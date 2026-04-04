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

    const billsDueSoon = await db.statement.count({
      where: {
        utilityAccount: { property: { userId } },
        dueDate: { gte: new Date(), lte: sevenDaysFromNow },
        amountPaid: null,
      },
    });

    res.json({
      totalProperties,
      totalUtilityAccounts,
      monthlyTotal: Math.round(monthlyTotal * 100) / 100,
      unreadInsights,
      alertInsights,
      billsDueSoon,
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

    const upcomingBills = await db.statement.findMany({
      where: {
        utilityAccount: { property: { userId } },
        dueDate: { gte: new Date() },
        amountPaid: null,
      },
      orderBy: { dueDate: 'asc' },
      take: 10,
      include: {
        utilityAccount: {
          select: { providerName: true, category: true, property: { select: { address: true, nickname: true } } },
        },
      },
    });

    res.json({ recentPayments, upcomingBills });
  } catch (err) {
    next(err);
  }
});

export default router;
