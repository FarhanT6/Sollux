/**
 * Turning what was read from a lease agreement into what Sollux stores: the
 * rent in effect today, the steps still to come (as scheduled increases), and
 * the rest kept as the lease's summary.
 */
import type { ExtractedLeaseTerms, LeaseDetails, LeaseRentStep } from '../api/client';
import { todayISO } from './date';

const round2 = (n: number) => Math.round(n * 100) / 100;
const addYears = (iso: string, n: number) => `${Number(iso.slice(0, 4)) + n}${iso.slice(4)}`;

export interface RentPlan {
  /** The monthly rent in effect today (the first rent until the first step comes). */
  currentRent: number | null;
  /** Steps after today, oldest first. A recurring percent is written out for the next few years. */
  futureSteps: { effectiveDate: string; newAmount: number | null; percent: number | null; note: string | null }[];
}

/** The rent today and the steps still to come, from the lease's schedule. */
export function rentPlan(t: Pick<ExtractedLeaseTerms, 'rentAmount' | 'rentSchedule'>, today = todayISO(), years = 3): RentPlan {
  let rent = t.rentAmount;
  const future: RentPlan['futureSteps'] = [];
  const steps = [...(t.rentSchedule ?? [])].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const apply = (s: LeaseRentStep) => {
    if (s.amount != null) rent = s.amount;
    else if (s.percent != null && rent != null) rent = round2(rent * (1 + s.percent / 100));
  };
  for (const s of steps) {
    const dates = s.recurring && s.percent != null
      // A recurring increase applies every year from its first date: the past
      // ones are in today's rent, the next few are scheduled.
      ? Array.from({ length: 40 }, (_, i) => addYears(s.effectiveDate, i))
      : [s.effectiveDate];
    let scheduled = 0;
    for (const d of dates) {
      if (d <= today) { apply({ ...s, effectiveDate: d }); continue; }
      if (scheduled >= (s.recurring ? years : 1)) break;
      future.push({
        effectiveDate: d,
        newAmount: s.amount,
        percent: s.amount == null ? s.percent : null,
        note: [s.note, s.recurring ? 'yearly increase written into the lease' : null].filter(Boolean).join(' · ') || null,
      });
      scheduled++;
    }
  }
  return { currentRent: rent, futureSteps: future };
}

/** The lease summary to save: the details plus the schedule as written. */
export function summaryOf(t: ExtractedLeaseTerms, source: string): LeaseDetails {
  return { ...t.details, source, rentSchedule: t.rentSchedule, utilityCharges: t.utilityCharges };
}

/** Labelled rows of a summary, for showing it. Empty values are left out. */
export function summaryRows(d: LeaseDetails | null | undefined, money: (n: number) => string): [string, string][] {
  if (!d) return [];
  const person = (p: { fullName: string; email: string | null; phone: string | null }) => [p.fullName, p.phone, p.email].filter(Boolean).join(' · ');
  const rows: [string, string | null][] = [
    ['Premises', [d.premises, d.unitLabel && !d.premises?.includes(d.unitLabel) ? d.unitLabel : null].filter(Boolean).join(' · ') || null],
    ['Use', d.use],
    ['Landlord', d.landlord ? [d.landlord.name, d.landlord.signer].filter(Boolean).join(' · ') || null : null],
    ['Rent paid to', d.landlord ? [d.landlord.payTo, d.landlord.payToAddress].filter(Boolean).join(', ') || null : null],
    ['Guarantor', d.guarantors?.length ? d.guarantors.map(person).join('; ') : null],
    ['Rent schedule', d.rentSchedule?.length ? d.rentSchedule.map(s => `${s.effectiveDate}: ${s.amount != null ? money(s.amount) : `+${s.percent}%`}${s.recurring ? ' yearly' : ''}`).join(' · ') : null],
    ['Utilities to landlord', d.utilityCharges?.length ? d.utilityCharges.map(u => `${u.category.toLowerCase()} ${money(u.amount)}/mo${u.note ? ` (${u.note})` : ''}`).join(' · ') : null],
    ['Utilities', d.utilities],
    ['Deposit', d.depositIncreasesWithRent ? 'increases with rent' : null],
    ['Late charges', [d.lateInterestPercent != null ? `${d.lateInterestPercent}% interest a year` : null, d.nsfFee != null ? `${money(d.nsfFee)} NSF fee` : null].filter(Boolean).join(' · ') || null],
    ['Operating expenses', d.operatingExpenses],
    ['Property taxes', d.propertyTaxes],
    ['Maintenance', d.maintenance],
    ['Insurance', d.insurance],
    ['Parking', d.parking],
    ['Storage', d.storage],
    ['Early possession', d.earlyPossession],
    ['Renewal', d.renewal],
    ['After the term', d.afterTerm],
    ['Condition', d.condition],
    ['Move-in costs', d.moveInCosts?.length ? d.moveInCosts.map(m => `${m.label} ${money(m.amount)}${m.dueDate ? ` due ${m.dueDate}` : ''}`).join(' · ') : null],
  ];
  const out = rows.filter((r): r is [string, string] => !!r[1]);
  for (const o of d.otherTerms ?? []) out.push(['Other', o]);
  return out;
}
