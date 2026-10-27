/**
 * How property tax runs in each state: when installments fall due and turn
 * delinquent, what a late installment adds, when an unpaid year defaults
 * (or is sold as a certificate or lien), what it costs to redeem, and when
 * the county may sell the property or a certificate holder may take it.
 *
 * These are the statutory defaults; a county's own bill or website wins
 * when it prints a date or an amount (a lookup or a bill fills those in).
 * States without rules here still get whatever the bill states.
 *
 * Dates are ISO day strings (YYYY-MM-DD) and stay that way — no Date
 * objects on date-only values, so no timezone shift.
 */

export type StateCode = string;

export interface InstallmentRule {
  n: 1 | 2;
  /** The day the installment is due (bills go out before it). */
  due: string;
  /** Paid after this day, it is delinquent (moved past a weekend). */
  delinquentAfter: string;
  /** Share of the installment added when it goes delinquent. */
  penaltyRate: number;
  /** Flat cost added with the penalty. */
  cost: number;
}

export interface Discount { by: string; rate: number }

export interface TaxCalendar {
  state: StateCode;
  /** "2026-27" for a fiscal year, "2026" for a calendar year. */
  yearLabel: string;
  installments: InstallmentRule[];
  /** Florida: early-payment discounts. */
  discounts?: Discount[];
  /** Every rule here in a sentence, for the page. */
  notes: string[];
}

export interface DefaultTimeline {
  /** The day an unpaid year becomes tax-defaulted (CA) or delinquent and saleable. */
  defaultDate: string | null;
  /** CA: the county may sell at auction from this day (5 years after default). */
  powerToSell: string | null;
  /** CA: 3 years after default, for nonresidential commercial property where the county adopted it. */
  powerToSellCommercial: string | null;
  /** FL / AZ: the certificate or lien sale. */
  certificateSale: string | null;
  /** FL: the holder may apply for a tax deed from this day. AZ: may foreclose. */
  deedEligible: string | null;
  /** FL: a certificate with no deed application is void after this day. */
  certificateExpires: string | null;
  notes: string[];
}

export interface RedemptionPart { label: string; amount: number }
export interface Redemption { total: number; parts: RedemptionPart[]; asOf: string; months: number }

const r2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The day of the week of an ISO day, 0 = Sunday. */
function weekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
/** A deadline on a Saturday or Sunday moves to Monday. */
export function nextBusinessDay(day: string): string {
  const w = weekday(day);
  return w === 6 ? addDays(day, 2) : w === 0 ? addDays(day, 1) : day;
}

/** "2026-2027", "2026-27", "FY 2026/27" and "2026" all start in 2026. */
export function firstYear(taxYear: string): number | null {
  const m = String(taxYear).match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

/** Whole or part months from one day to another (1.5%-a-month penalties count a part month as a month). */
export function monthsFrom(from: string, to: string): number {
  if (to < from) return 0;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td >= fd) months += 1;
  return Math.max(months, 0);
}

const normState = (s?: string | null) => String(s ?? '').trim().toUpperCase().slice(0, 2);

export const STATES_WITH_RULES = ['CA', 'FL', 'TX', 'AZ'] as const;

/** The year's calendar in `state`, or null where Sollux has no rules (the bill's dates are used). */
export function calendarFor(state: string | null | undefined, taxYear: string): TaxCalendar | null {
  const st = normState(state);
  const y = firstYear(taxYear);
  if (y == null) return null;
  switch (st) {
    case 'CA':
      return {
        state: st, yearLabel: `${y}-${String(y + 1).slice(2)}`,
        installments: [
          { n: 1, due: iso(y, 11, 1), delinquentAfter: nextBusinessDay(iso(y, 12, 10)), penaltyRate: 0.10, cost: 0 },
          { n: 2, due: iso(y + 1, 2, 1), delinquentAfter: nextBusinessDay(iso(y + 1, 4, 10)), penaltyRate: 0.10, cost: 10 },
        ],
        notes: [
          `Fiscal year July 1, ${y} – June 30, ${y + 1}.`,
          'First installment due Nov 1, delinquent after Dec 10; second due Feb 1, delinquent after Apr 10 (a weekend moves it to Monday).',
          'A delinquent installment adds 10%; the second also adds a $10 cost.',
          `Unpaid on June 30, ${y + 1}, the year is tax-defaulted on July 1, ${y + 1}.`,
        ],
      };
    case 'FL':
      return {
        state: st, yearLabel: String(y),
        installments: [{ n: 1, due: iso(y, 11, 1), delinquentAfter: iso(y + 1, 3, 31), penaltyRate: 0.03, cost: 0 }],
        discounts: [
          { by: iso(y, 11, 30), rate: 0.04 }, { by: iso(y, 12, 31), rate: 0.03 },
          { by: iso(y + 1, 1, 31), rate: 0.02 }, { by: iso(y + 1, 2, 28 + (isLeap(y + 1) ? 1 : 0)), rate: 0.01 },
        ],
        notes: [
          `Calendar year ${y}; bills go out around Nov 1.`,
          'Pay by Nov 30 for 4% off, Dec 31 for 3%, Jan 31 for 2%, end of February for 1%; the gross amount is due by Mar 31.',
          `Unpaid on April 1, ${y + 1}, it is delinquent: 3% interest plus advertising costs, and a tax certificate is sold by June 1.`,
        ],
      };
    case 'TX':
      return {
        state: st, yearLabel: String(y),
        installments: [{ n: 1, due: iso(y, 10, 1), delinquentAfter: nextBusinessDay(iso(y + 1, 1, 31)), penaltyRate: 0.07, cost: 0 }],
        notes: [
          `Tax year ${y}; bills go out in October and are due by Jan 31, ${y + 1}.`,
          'Delinquent on Feb 1: 6% penalty plus 1% interest, rising by 1% penalty and 1% interest a month to 12% penalty by July.',
          'From July 1 an attorney collection fee of up to 20% may be added.',
        ],
      };
    case 'AZ':
      return {
        state: st, yearLabel: String(y),
        installments: [
          { n: 1, due: iso(y, 10, 1), delinquentAfter: nextBusinessDay(iso(y, 11, 1)), penaltyRate: 0, cost: 0 },
          { n: 2, due: iso(y + 1, 3, 1), delinquentAfter: nextBusinessDay(iso(y + 1, 5, 1)), penaltyRate: 0, cost: 0 },
        ],
        notes: [
          `Tax year ${y}. First half due Oct 1, delinquent after Nov 1; second half due Mar 1, delinquent after May 1.`,
          'Paying the whole year by Dec 31 waives first-half interest. Delinquent taxes accrue 16% a year.',
        ],
      };
    default:
      return null;
  }
}

function isLeap(y: number) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

/** What happens to the year if it stays unpaid. */
export function defaultTimeline(state: string | null | undefined, taxYear: string, opts: { defaultDate?: string | null; certificateIssued?: string | null } = {}): DefaultTimeline | null {
  const st = normState(state);
  const y = firstYear(taxYear);
  if (y == null) return null;
  const blank: DefaultTimeline = { defaultDate: null, powerToSell: null, powerToSellCommercial: null, certificateSale: null, deedEligible: null, certificateExpires: null, notes: [] };
  switch (st) {
    case 'CA': {
      const def = opts.defaultDate ?? iso(y + 1, 7, 1);
      const dy = Number(def.slice(0, 4));
      return {
        ...blank,
        defaultDate: def,
        powerToSell: iso(dy + 5, 7, 1),
        powerToSellCommercial: iso(dy + 3, 7, 1),
        notes: [
          'A defaulted year is redeemed with the tax, its penalties and costs, a $15 redemption fee and 1.5% a month on the tax from July 1 of the default year.',
          'An installment plan of redemption spreads it over up to 5 years (20% plus interest each year, by April 10); it must start before the power to sell.',
          'The county may sell the property five years after default (R&T §3691), or three years for nonresidential commercial property where the county has adopted it.',
        ],
      };
    }
    case 'FL': {
      const sale = opts.certificateIssued ?? iso(y + 1, 6, 1);
      const sy = Number(sale.slice(0, 4));
      return {
        ...blank,
        defaultDate: iso(y + 1, 4, 1),
        certificateSale: sale,
        deedEligible: iso(sy + 2, 4, 1),
        certificateExpires: iso(sy + 7, Number(sale.slice(5, 7)), Number(sale.slice(8, 10))),
        notes: [
          'A tax certificate is a lien sold to the bidder who accepts the lowest interest (18% at most, 5% minimum unless bid to 0%).',
          'Redeeming means paying the certificate, its interest and costs to the tax collector.',
          'The holder may apply for a tax deed two years after April 1 of the year the certificate was issued; the property then goes to auction. A certificate with no application is void after seven years.',
        ],
      };
    }
    case 'TX':
      return {
        ...blank,
        defaultDate: nextBusinessDay(iso(y + 1, 2, 1)),
        notes: [
          'The county or school district can sue to foreclose and sell at a sheriff\'s sale.',
          'After a tax sale the owner may redeem within 180 days (two years for a homestead or agricultural land), paying the bid plus 25% (50% in the second year).',
        ],
      };
    case 'AZ': {
      const sale = opts.certificateIssued ?? iso(y + 2, 2, 1);
      const sy = Number(sale.slice(0, 4));
      return {
        ...blank,
        defaultDate: nextBusinessDay(iso(y + 1, 5, 1)),
        certificateSale: sale,
        deedEligible: iso(sy + 3, Number(sale.slice(5, 7)), Number(sale.slice(8, 10))),
        notes: [
          'Unpaid taxes are sold as a tax lien certificate at the February sale (16% a year at most).',
          'The holder may foreclose three years after the sale if it is not redeemed.',
        ],
      };
    }
    default:
      return null;
  }
}

/**
 * California: what it costs to redeem a defaulted year on `asOf`. Uses the
 * county's own figure when it printed one; this is the estimate between
 * lookups — tax + penalties + costs + $15 + 1.5% of the tax per month (a
 * part month counts) from July 1 of the default year.
 */
export function redemptionEstimate(state: string | null | undefined, d: { tax: number; penalties?: number | null; costs?: number | null; defaultDate: string }, asOf: string): Redemption | null {
  const st = normState(state);
  if (!(d.tax > 0)) return null;
  if (st === 'CA') {
    const months = monthsFrom(d.defaultDate, asOf);
    const interest = r2(d.tax * 0.015 * months);
    const parts: RedemptionPart[] = [
      { label: 'Tax', amount: r2(d.tax) },
      ...(d.penalties ? [{ label: 'Delinquent penalties', amount: r2(d.penalties) }] : []),
      ...(d.costs ? [{ label: 'Costs', amount: r2(d.costs) }] : []),
      { label: `Redemption penalty (1.5% × ${months} mo)`, amount: interest },
      { label: 'Redemption fee', amount: 15 },
    ];
    return { total: r2(parts.reduce((t, p) => t + p.amount, 0)), parts, asOf, months };
  }
  if (st === 'AZ') {
    const months = monthsFrom(d.defaultDate, asOf);
    const interest = r2(d.tax * (0.16 / 12) * months);
    const parts: RedemptionPart[] = [{ label: 'Tax', amount: r2(d.tax) }, { label: `Interest (16%/yr × ${months} mo)`, amount: interest }];
    return { total: r2(parts.reduce((t, p) => t + p.amount, 0)), parts, asOf, months };
  }
  return null;
}

/** Where one installment stands on `asOf`, with the penalty it carries once delinquent. */
export function installmentStatus(rule: InstallmentRule, amount: number | null, paid: string | null, asOf: string): { state: 'paid' | 'upcoming' | 'due' | 'delinquent'; penalty: number } {
  if (paid) return { state: 'paid', penalty: 0 };
  if (asOf > rule.delinquentAfter) return { state: 'delinquent', penalty: amount != null ? r2(amount * rule.penaltyRate + rule.cost) : 0 };
  if (asOf >= rule.due) return { state: 'due', penalty: 0 };
  return { state: 'upcoming', penalty: 0 };
}

/** Is the property nonresidential commercial (CA's three-year power to sell can apply)? */
export const isCommercial = (type?: string | null) => type === 'COMMERCIAL' || type === 'GOLF_COURSE';
