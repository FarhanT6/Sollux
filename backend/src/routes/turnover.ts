import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const MS_PER_DAY = 86_400_000;

// Rent is quoted monthly but vacancy is measured in days, so convert through
// the year rather than assuming a 30-day month — otherwise every 31-day month
// quietly under-reports the loss.
const dailyRate = (monthlyRent: number) => (monthlyRent * 12) / 365;

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);

const round2 = (n: number) => Math.round(n * 100) / 100;

// Statuses that represent a real tenancy. PENDING leases haven't started, so
// they'd otherwise invent a turnover against a tenant who never moved in.
const REAL_STATUSES = new Set(['ACTIVE', 'ENDED', 'TERMINATED']);

interface Tenancy {
  leaseId: string;
  tenants: string[];
  businessName: string | null;
  startDate: string;
  endDate: string | null;
  rentAmount: number;
  status: string;
  leaseType: string;
  isCurrent: boolean;
  months: number | null;  // length of the tenancy, to date if still running
}

interface Turnover {
  outgoingLeaseId: string;
  incomingLeaseId: string;
  outgoingTenants: string[];
  incomingTenants: string[];
  vacatedOn: string;
  reoccupiedOn: string;
  daysVacant: number;
  rentLost: number;
  previousRent: number;
  newRent: number;
  rentChange: number;
  rentChangePct: number | null;
}

// GET /api/turnover?propertyId=... — tenancy history and turnover analysis.
//
// Everything here is derived from the lease timeline of each unit: consecutive
// leases on one unit are consecutive tenancies, and the gap between one ending
// and the next starting is the turnaround. Nothing extra is stored, so this
// works retroactively over leases that were entered long before this endpoint
// existed. The tradeoff is that a lease's endDate stands in for the actual
// move-out date; they differ when someone leaves early or holds over.
router.get('/', async (req, res, next) => {
  try {
    const { propertyId } = req.query;

    const units = await db.unit.findMany({
      where: {
        property: {
          userId: req.dbUserId!,
          ...(propertyId ? { id: propertyId as string } : {}),
        },
      },
      include: {
        property: { select: { id: true, address: true, nickname: true } },
        leases: {
          include: { leaseTenants: { include: { tenant: { select: { fullName: true } } } } },
          orderBy: { startDate: 'asc' },
        },
      },
    });

    const now = new Date();
    const unitReports = [];

    // Portfolio-wide accumulators.
    let totalDaysVacant = 0;
    let totalRentLost = 0;
    let ongoingRentLost = 0;
    let currentlyVacant = 0;
    const allTurnoverDays: number[] = [];
    const allTenancyMonths: number[] = [];
    const allRentChanges: number[] = [];

    for (const unit of units) {
      const leases = unit.leases.filter(l => REAL_STATUSES.has(l.status));
      if (leases.length === 0) continue;

      const tenantNames = (l: (typeof leases)[number]) =>
        l.leaseTenants.map(lt => lt.tenant.fullName);

      const tenancies: Tenancy[] = leases.map(l => {
        const end = l.endDate ?? null;
        // A month-to-month lease past its end date is still running, so measure
        // an ACTIVE tenancy to today rather than to a stale endDate.
        const measureTo = l.status === 'ACTIVE' ? now : (end ?? now);
        const months = round2(daysBetween(l.startDate, measureTo) / 30.44);
        return {
          leaseId: l.id,
          tenants: tenantNames(l),
          businessName: l.businessName ?? null,
          startDate: l.startDate.toISOString(),
          endDate: end ? end.toISOString() : null,
          rentAmount: Number(l.rentAmount),
          status: l.status,
          leaseType: l.leaseType,
          isCurrent: l.status === 'ACTIVE',
          months: months >= 0 ? months : null,
        };
      });

      // Turnovers: each adjacent pair of leases on this unit.
      const turnovers: Turnover[] = [];
      for (let i = 0; i < leases.length - 1; i++) {
        const prev = leases[i];
        const next = leases[i + 1];
        // Without an end date on the outgoing lease there's no gap to measure.
        if (!prev.endDate) continue;

        // Clamp: overlapping or back-to-back leases mean no vacancy, not a
        // negative one (a re-let that starts before the old lease formally ends
        // is common and costs nothing).
        const daysVacant = Math.max(0, daysBetween(prev.endDate, next.startDate));
        const previousRent = Number(prev.rentAmount);
        const newRent = Number(next.rentAmount);
        const rentLost = round2(daysVacant * dailyRate(previousRent));

        turnovers.push({
          outgoingLeaseId: prev.id,
          incomingLeaseId: next.id,
          outgoingTenants: tenantNames(prev),
          incomingTenants: tenantNames(next),
          vacatedOn: prev.endDate.toISOString(),
          reoccupiedOn: next.startDate.toISOString(),
          daysVacant,
          rentLost,
          previousRent,
          newRent,
          rentChange: round2(newRent - previousRent),
          rentChangePct: previousRent > 0 ? round2(((newRent - previousRent) / previousRent) * 100) : null,
        });

        totalDaysVacant += daysVacant;
        totalRentLost += rentLost;
        allTurnoverDays.push(daysVacant);
        allRentChanges.push(newRent - previousRent);
      }

      // Vacant right now? True when no lease is ACTIVE and the most recent one
      // has already ended. This is money still being lost, so it is tracked
      // separately from settled turnovers rather than mixed into them.
      const last = leases[leases.length - 1];
      let currentVacancy = null;
      const hasActive = leases.some(l => l.status === 'ACTIVE');
      if (!hasActive && last.endDate && last.endDate < now) {
        const days = daysBetween(last.endDate, now);
        const lastRent = Number(last.rentAmount);
        const lostSoFar = round2(days * dailyRate(lastRent));
        currentVacancy = {
          vacatedOn: last.endDate.toISOString(),
          daysVacant: days,
          lostSoFar,
          lastRent,
          lastTenants: tenantNames(last),
        };
        currentlyVacant += 1;
        ongoingRentLost += lostSoFar;
      }

      for (const t of tenancies) if (t.months != null) allTenancyMonths.push(t.months);

      unitReports.push({
        unitId: unit.id,
        unitLabel: unit.unitLabel,
        propertyId: unit.property.id,
        propertyAddress: unit.property.nickname || unit.property.address,
        tenancies,
        turnovers,
        currentVacancy,
      });
    }

    const avg = (xs: number[]) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

    res.json({
      summary: {
        turnovers: allTurnoverDays.length,
        avgVacancyDays: avg(allTurnoverDays),
        longestVacancyDays: allTurnoverDays.length ? Math.max(...allTurnoverDays) : null,
        totalDaysVacant,
        totalRentLost: round2(totalRentLost),
        avgTenancyMonths: avg(allTenancyMonths),
        avgRentChange: avg(allRentChanges),
        currentlyVacant,
        ongoingRentLost: round2(ongoingRentLost),
        unitsTracked: unitReports.length,
      },
      units: unitReports.sort((a, b) =>
        a.propertyAddress.localeCompare(b.propertyAddress) || a.unitLabel.localeCompare(b.unitLabel)),
    });
  } catch (err) { next(err); }
});

export default router;
