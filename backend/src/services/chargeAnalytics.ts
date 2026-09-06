import { db } from '../config/db';

/**
 * What the money actually went on, line by line, over time.
 *
 * A Republic Services bill is not one charge — it is a 3-yard waste container,
 * a 4-yard recycle container, a mixed organics cart, a recycling service, an
 * AB939 fee and a late fee. Reported only as $326.38 there is no way to see
 * that the organics cart appeared in March, or that the AB939 fee has risen
 * three times this year. The breakdown has been extracted all along; nothing
 * has ever aggregated it.
 *
 * Also reconciles the provider's own aging buckets against the statements
 * Sollux holds. Where they disagree it is not noise: either a bill is missing
 * or a payment was never recorded, and both are worth knowing.
 */

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isNaN(n) ? 0 : n;
};

/**
 * Line labels drift between bills — a date range appended, spacing changed,
 * a service period tacked on. Normalising too hard would merge genuinely
 * different containers, so this only removes what is definitely incidental:
 * embedded dates, quantities and rates, repeated whitespace, and trailing
 * punctuation.
 *
 * Quantities and rates are the electric-bill case. IID labels its main line
 * "Usage (10,813.290 kWh@$0.1884/kWh)" — the kWh and the rate change every
 * cycle, so every bill minted a brand-new charge and an account showed 81
 * distinct charges that were really about seven. The quantity is not part of
 * the charge's identity; the amount column already carries what it cost.
 *
 * A parenthetical is only dropped when it contains a unit, a rate, or a
 * dollar figure. One that merely contains a number — "Waste Container
 * (3 Yard)" — stays, because there the number IS the identity: merging the
 * 3-yard and 4-yard containers would hide exactly the distinction this page
 * exists to show.
 */
const UNIT_OR_RATE = /(?:kwh|mwh|kw\b|ccf|hcf|mcf|therm|gallon|cu\.?\s*ft|c\.?f\.?|@|\$|\/\s*kwh)/i;

/**
 * A charge that is a consequence rather than a service: something the account
 * was punished or surcharged with, not something it bought. These belong with
 * fees and penalties wherever fees are counted, whatever container or service
 * the provider printed them against.
 */
const FEE_LIKE = /late\s*fee|penalt|contaminated\s*materials?|contamination|overage|returned\s*(?:check|payment)|nsf\b|insufficient\s*funds|interest\s*charge|collection|disconnect|reconnect|shut[\s-]*off/i;

export function isFeeLikeCharge(label: string): boolean {
  return FEE_LIKE.test(label);
}

export function normaliseLabel(label: string): string {
  let out = label
    // Parentheticals carrying a quantity or rate: "(10,813.290 kWh@$0.1884/kWh)"
    .replace(/\(([^)]*)\)/g, (whole, inner) => (UNIT_OR_RATE.test(inner) && /\d/.test(inner) ? '' : whole))
    // The same fragments unparenthesised: "10,790 kWh @ $0.1093/kWh"
    .replace(/[\d,]+(?:\.\d+)?\s*(?:kWh|MWh|kW|CCF|HCF|MCF|therms?|gallons?|cu\.?\s*ft\.?)\b\s*(?:@\s*\$?[\d.]+(?:\/\s*\w+)?)?/gi, '')
    .replace(/@\s*\$?[\d.]+(?:\/\s*\w+)?/g, '')                                              // a bare rate
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*[-–]\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, '') // 08/01-08/31
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, '')                                       // a lone date
    // A spelled-out date range: "(Mar 26 Apr 9)", "(Apr 1 - Apr 30)" — a rate
    // change mid-cycle splits one charge into two dated halves.
    .replace(/\(\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?\s*(?:[-–]|to)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?\s*\)/gi, '')
    .replace(/\(\s*\)/g, '');                                                                   // an emptied "()"

  // A contamination charge is the same event whichever container it was
  // printed against — "Recycle Container 4 Cu Yd, 1 Lift Per Week
  // Contaminated Materials" and bare "Contaminated Materials" are one line of
  // spending, and it is a penalty, not a service.
  if (/contaminated\s*materials?/i.test(out)) return 'Contaminated Materials';

  // Waste-hauler labels drift more than most: the same container appears with
  // and without a leading quantity ("1 Fl Waste Container…"), a front-load
  // marker ("Fl"), "Cu Yd" vs "Yd", a lift-frequency clause, a stray " - ",
  // and a trailing service descriptor. None of that is the container's
  // identity; the size and type are.
  out = out
    .replace(/^\d+\s+(?=[A-Za-z])/, '')                       // leading quantity: "1 Waste Container…"
    .replace(/^Fl\s+/i, '')                                    // front-load marker
    .replace(/\bCu\.?\s*Yd\b/gi, 'Yd')                        // "3 Cu Yd" and "3 Yd" are the same container
    .replace(/,?\s*\d+\s*Lifts?\s*Per\s*Week\b/gi, '')      // lift frequency
    .replace(/\s+-\s+/g, ' ');                                // "… - Pickup Service"

  // Hauler labels bolt a container onto a service, in both directions: the
  // same yardwaste line appears as "Mixed Organics Cart Gal Organics
  // Yardwaste", "Organics Yardwaste Service", and bare "Yardwaste Service";
  // the same recycling line as "Recycle Container Recycling Service" and
  // "Recycling Service". When a specific service name is present, it is the
  // identity and the container is scaffolding — so the container prefix goes
  // and the service is canonicalised. A generic tail ("Pickup Service") says
  // nothing, so there the container stays and the tail goes.
  if (/\b(?:container|cart)\b/i.test(out)) {
    const specific = out.match(/\b((?:organics?\s+)?yardwaste(?:\s+service)?|organic\s+waste\s+processing|recycling\s+service|waste\/recycling\s+overage|contaminated.*)$/i);
    if (specific) {
      out = specific[1];
    } else {
      out = out.replace(/\s+(?:Pickup|Recycling)?\s*Service$/i, '').replace(/\s+Pickup$/i, '');
    }
  }
  out = out
    .replace(/^\s*Total\s+/i, '')                                  // "Total City Of Brawley Utility Fee"
    .replace(/^(?:organics?\s+)?yardwaste(?:\s+service)?$/i, 'Yardwaste Service')
    .replace(/^organic\s+waste\s+processing$/i, 'Organic Waste Processing')
    .replace(/^recycling\s+service$/i, 'Recycling Service');

  out = out
    .replace(/\s+/g, ' ')
    .replace(/[\s,.:;-]+$/, '')
    .trim();

  // Providers change their shouting between years — El Centro printed SEWER,
  // Sewer and sewer on different bills, splitting one charge into three. A
  // label written in a single case carries no casing information, so it is
  // title-cased; mixed-case labels are left as the bill wrote them.
  if (out === out.toUpperCase() || out === out.toLowerCase()) {
    out = out.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }
  return out;
}

/**
 * SDG&E prints one bill three ways at once: a summary box with three
 * sections — Electric Delivery, Electric Generation (the CCA's charge), Gas
 * Service — and, behind each, a detail block of a dozen sub-lines
 * (Transmission, Distribution, Public Purpose Programs, Nuclear
 * Decommissioning, Wildfire Fund Charge, PCIA, the generation credit, …),
 * sometimes split again at a mid-cycle rate change. Extraction picks a
 * different mix of those levels on every bill, so one account showed 55
 * distinct charges, with "Electricity Delivery", "Electric Delivery",
 * "Electric Delivery (Distribution)" and "Distribution (Electric)" all
 * competing to be the same money — and where a bill listed both a section
 * and its sub-lines, that money was counted twice.
 *
 * This reduces every bill to the summary box. Each line is assigned to a
 * section; if the bill printed the section's own total, the sub-lines are
 * folded into it (they are already inside it), and if it printed only the
 * sub-lines, they are summed to become it. Program discounts and the climate
 * credit are kept as their own lines because they are what a person looks
 * for; penalties stay separate as always.
 */
const SDGE_PROVIDER = /sdg\s*&?\s*e|san\s+diego\s+gas/i;
const SDGE_SECTION = { delivery: 'Electric Delivery', generation: 'Electric Generation', gas: 'Gas Service' } as const;
type SdgeSection = keyof typeof SDGE_SECTION;

function sdgeClassify(label: string): { section: SdgeSection; isParent: boolean } | null {
  const l = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (FEE_LIKE.test(l)) return null;
  if (/climate\s+credit|^care\s+discount|^fera\s+discount|^(?:care|fera)$/.test(l)) return null;

  if (/^electric(?:ity)?\s+delivery(?:\s+charges?)?$/.test(l)) return { section: 'delivery', isParent: true };
  if (/^(?:cca\s+)?electric(?:ity)?\s+generation(?:\s+charges?)?$/.test(l)) return { section: 'generation', isParent: true };
  if (/^gas\s+service(?:\s+charges?)?$/.test(l)) return { section: 'gas', isParent: true };

  if (/\(gas\)|^gas\b|\bgas\s+(?:energy|commodity|delivery|transmission|procurement)/.test(l)) return { section: 'gas', isParent: false };
  if (/^cca\b|community\s+power|clean\s+energy\s+alliance/.test(l)) return { section: 'generation', isParent: false };
  if (/\bgeneration\b/.test(l) && !/local\s+generation|generation\s+credit|generation\s+\(electric\)/.test(l)) return { section: 'generation', isParent: false };
  return { section: 'delivery', isParent: false };
}

export function consolidateSdgeBreakdown(breakdown: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  const parent: Partial<Record<SdgeSection, number>> = {};
  const children: Partial<Record<SdgeSection, number>> = {};

  for (const [rawLabel, value] of Object.entries(breakdown)) {
    const label = normaliseLabel(rawLabel);
    if (!label) continue;
    const amount = num(value);
    const c = sdgeClassify(label);
    if (!c) { out[label] = (out[label] ?? 0) + amount; continue; }
    if (c.isParent) parent[c.section] = (parent[c.section] ?? 0) + amount;
    else children[c.section] = (children[c.section] ?? 0) + amount;
  }

  for (const section of Object.keys(SDGE_SECTION) as SdgeSection[]) {
    const total = parent[section] ?? children[section];
    if (total == null) continue;
    out[SDGE_SECTION[section]] = total;
  }
  return out;
}

export interface ChargeLineSeries {
  label: string;
  /** A penalty or surcharge rather than a purchased service — late fees,
   *  contamination charges, returned payments. Counted with fees. */
  isFee: boolean;
  /** Every month this line appeared, most recent first. */
  months: { month: string; amount: number }[];
  total: number;
  average: number;
  latest: number | null;
  first: string | null;
  last: string | null;
  /** Change from the earliest appearance to the latest, as a percentage. */
  changePercent: number | null;
}

export interface ChargeAnalytics {
  accountId: string;
  providerName: string;
  monthsCovered: number;
  /** Every line item, largest total first. */
  lines: ChargeLineSeries[];
  /** Totals per month, so the lines can be checked against the bill. */
  byMonth: { month: string; total: number; itemised: number }[];
  yearToDate: number;
  /** Lines whose latest amount differs sharply from their own average. */
  notable: string[];
}

export async function getChargeAnalytics(
  accountId: string,
  userId: string,
  // Five years, not two: the panel filters by year and by month-across-years
  // on the client, and a filter over a window shorter than the account's
  // history quietly shows partial answers.
  months = 60,
): Promise<ChargeAnalytics | null> {
  const account = await db.utilityAccount.findFirst({
    where: { id: accountId, property: { userId } },
    select: { id: true, providerName: true, serviceLabel: true },
  });
  if (!account) return null;

  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const statements = await db.statement.findMany({
    where: { utilityAccountId: accountId, statementDate: { gte: since }, isDownPayment: false },
    select: { statementDate: true, billingPeriodEnd: true, amountDue: true, rawDataJson: true },
    orderBy: { statementDate: 'desc' },
  });

  // Attribute to the period billed, not the day the bill was issued — see
  // monthlySpend.ts for why the issue date is the wrong key.
  const monthOf = (s: { statementDate: Date; billingPeriodEnd: Date | null }) =>
    (s.billingPeriodEnd ?? s.statementDate).toISOString().slice(0, 7);

  const byLabel = new Map<string, Map<string, number>>();
  const displayName = new Map<string, string>();
  const byMonth: ChargeAnalytics['byMonth'] = [];
  const monthsSeen = new Set<string>();

  for (const s of statements) {
    const month = monthOf(s);
    monthsSeen.add(month);

    const raw = s.rawDataJson as Record<string, unknown> | null;
    let breakdown = (raw?.chargeBreakdown ?? null) as Record<string, number> | null;
    if (breakdown && SDGE_PROVIDER.test(account.providerName)) breakdown = consolidateSdgeBreakdown(breakdown);

    let itemised = 0;
    if (breakdown) {
      for (const [rawLabel, value] of Object.entries(breakdown)) {
        const label = normaliseLabel(rawLabel);
        if (!label) continue;
        const amount = num(value);
        itemised += amount;

        // Keyed case-insensitively so no casing variant that survives the
        // normalisation above can split a charge; the first-seen form is what
        // gets displayed.
        const key = label.toLowerCase();
        if (!displayName.has(key)) displayName.set(key, label);
        if (!byLabel.has(key)) byLabel.set(key, new Map());
        const series = byLabel.get(key)!;
        // A month with two bills sums rather than overwrites: both were charged.
        series.set(month, (series.get(month) ?? 0) + amount);
      }
    }

    byMonth.push({ month, total: num(s.amountDue), itemised });
  }

  const lines: ChargeLineSeries[] = [];
  for (const [key, series] of byLabel) {
    const label = displayName.get(key) ?? key;
    const entries = [...series.entries()]
      .map(([month, amount]) => ({ month, amount }))
      .sort((a, b) => b.month.localeCompare(a.month));

    const total = entries.reduce((t, e) => t + e.amount, 0);
    const first = entries[entries.length - 1];
    const latest = entries[0];
    // Only meaningful when the line has been billed more than once and started
    // from something: a first appearance of zero has no percentage change.
    const changePercent = entries.length > 1 && first.amount !== 0
      ? ((latest.amount - first.amount) / first.amount) * 100
      : null;

    lines.push({
      label,
      isFee: isFeeLikeCharge(label),
      months: entries,
      total,
      average: total / entries.length,
      latest: latest?.amount ?? null,
      first: first?.month ?? null,
      last: latest?.month ?? null,
      changePercent,
    });
  }
  lines.sort((a, b) => b.total - a.total);

  const thisYear = new Date().getFullYear().toString();
  const yearToDate = byMonth
    .filter(m => m.month.startsWith(thisYear))
    .reduce((t, m) => t + m.total, 0);

  // Worth pointing at: a line well above its own norm, or one that has stopped
  // appearing. Both are things a person would want to look at, and neither is
  // visible in a single total.
  const notable: string[] = [];
  for (const line of lines) {
    if (line.months.length < 3) continue;
    if (line.latest != null && line.average > 0 && line.latest > line.average * 1.5) {
      notable.push(`${line.label} is ${(line.latest / line.average).toFixed(1)}× its usual amount`);
    }
    if (line.last && line.last < [...monthsSeen].sort().reverse()[0]) {
      notable.push(`${line.label} last appeared in ${line.last}`);
    }
  }

  return {
    accountId: account.id,
    providerName: account.serviceLabel
      ? `${account.providerName} — ${account.serviceLabel}`
      : account.providerName,
    monthsCovered: monthsSeen.size,
    lines,
    byMonth,
    yearToDate,
    notable,
  };
}

export interface AgingReconciliation {
  /** What the provider says, from the most recent statement that reported it. */
  reported: { current: number; days30: number; days60: number; days90plus: number } | null;
  reportedAsOf: string | null;
  /** What Sollux's own unpaid statements add up to, aged the same way. */
  derived: { current: number; days30: number; days60: number; days90plus: number };
  /** Bucket-by-bucket difference, provider minus Sollux. */
  differences: { bucket: string; reported: number; derived: number; difference: number }[];
  /** What a disagreement most likely means. */
  findings: string[];
}

/**
 * Compare the provider's aging against the statements Sollux holds.
 *
 * The provider is authoritative about the balance; Sollux is authoritative
 * about which bills it has seen. So a disagreement is information about
 * Sollux's data, not about the provider's: either a bill was never imported,
 * or a payment was made and never recorded.
 */
export async function reconcileAging(accountId: string, userId: string): Promise<AgingReconciliation | null> {
  const account = await db.utilityAccount.findFirst({
    where: { id: accountId, property: { userId } },
    select: { id: true },
  });
  if (!account) return null;

  const statements = await db.statement.findMany({
    where: { utilityAccountId: accountId, isDownPayment: false },
    select: {
      statementDate: true, dueDate: true, amountDue: true, amountPaid: true,
      agingBuckets: true,
    },
    orderBy: { statementDate: 'desc' },
    take: 24,
  });

  const withBuckets = statements.find(s => s.agingBuckets != null);
  const reportedRaw = withBuckets?.agingBuckets as Record<string, number> | null | undefined;
  const reported = reportedRaw ? {
    current: num(reportedRaw.current),
    days30: num(reportedRaw.days30),
    days60: num(reportedRaw.days60),
    days90plus: num(reportedRaw.days90plus),
  } : null;

  // Sollux's own view: each unpaid statement bucketed by how long past its due
  // date it is, as of the date the provider's aging was reported (so the two
  // describe the same moment).
  const asOf = withBuckets?.statementDate ?? new Date();
  const DAY = 24 * 60 * 60 * 1000;
  const derived = { current: 0, days30: 0, days60: 0, days90plus: 0 };

  for (const s of statements) {
    const outstanding = num(s.amountDue) - num(s.amountPaid);
    if (outstanding <= 0.01) continue;
    if (!s.dueDate) continue;

    const daysPast = Math.round((asOf.getTime() - s.dueDate.getTime()) / DAY);
    if (daysPast <= 0) derived.current += outstanding;
    else if (daysPast <= 30) derived.days30 += outstanding;
    else if (daysPast <= 60) derived.days60 += outstanding;
    else derived.days90plus += outstanding;
  }

  const differences = reported ? (['current', 'days30', 'days60', 'days90plus'] as const).map(bucket => ({
    bucket,
    reported: reported[bucket],
    derived: derived[bucket],
    difference: reported[bucket] - derived[bucket],
  })) : [];

  const findings: string[] = [];
  if (!reported) {
    findings.push('No statement on this account reports aging buckets, so there is nothing to check against.');
  } else {
    const totalReported = Object.values(reported).reduce((a, b) => a + b, 0);
    const totalDerived = Object.values(derived).reduce((a, b) => a + b, 0);
    const gap = totalReported - totalDerived;

    if (Math.abs(gap) < 1) {
      findings.push('The provider’s aging matches the statements on file.');
    } else if (gap > 0) {
      findings.push(
        `The provider shows ${gap.toFixed(2)} more owing than the statements on file account for. ` +
        'Most likely a bill that was never imported.'
      );
    } else {
      findings.push(
        `The statements on file show ${Math.abs(gap).toFixed(2)} more owing than the provider does. ` +
        'Most likely a payment that was made but never recorded here.'
      );
    }

    for (const d of differences) {
      if (Math.abs(d.difference) >= 1) {
        findings.push(`${d.bucket}: provider ${d.reported.toFixed(2)}, statements on file ${d.derived.toFixed(2)}`);
      }
    }
  }

  return {
    reported,
    reportedAsOf: withBuckets?.statementDate.toISOString() ?? null,
    derived,
    differences,
    findings,
  };
}
