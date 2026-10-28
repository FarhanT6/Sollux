/**
 * Where the owner can save — each finding a dollar figure a year, worked
 * out from the owner's own records, and the one thing to do about it.
 * Pure: services/savingsReport.ts gathers the facts.
 *
 *   late fees        penalties and late fees billed in the last 12 months
 *   card fees        processing fees paid on top of bills
 *   rising bills     an account's last three months against the same three a year before
 *   insurance        a premium that went up against the year before
 *   idle services    internet, phone or TV billing at a property with nobody renting it
 *   duplicates       two internet (or two phone) accounts at one property
 *   high-rate loans  what one point lower is worth on a loan at 8% or more
 */

export type SavingKind = 'LATE_FEES' | 'CARD_FEES' | 'RISING_BILL' | 'INSURANCE_UP' | 'IDLE_SERVICE' | 'DUPLICATE_SERVICE' | 'HIGH_RATE_LOAN';

export interface Saving {
  kind: SavingKind;
  title: string;
  detail: string;
  action: string;
  /** What it is worth a year. */
  perYear: number;
  propertyId: string | null;
  propertyName: string | null;
  link: string | null;
}

export interface AccountFacts {
  id: string; propertyId: string; propertyName: string; providerName: string; category: string; last4: string | null;
  /** Bill amount by month issued (YYYY-MM), the last 24 months. */
  charges: Record<string, number>;
  /** Penalties and late fees billed, last 12 months. */
  feesLast12: number;
  /** Processing fees paid on top of payments, last 12 months. */
  cardFeesLast12: number;
  /** Bills paid after their due day in the last 12 months, of those paid. */
  latePaid: number;
}

export interface LoanFacts { id: string; propertyName: string | null; lender: string; rate: number; balance: number }

const r0 = (x: number) => Math.round(x);
const money = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
const shift = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number); const t = y * 12 + m - 1 + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const ACCOUNT_LINK = (a: AccountFacts) => `/properties/${a.propertyId}/utilities/${a.id}`;
const name = (a: AccountFacts) => `${a.providerName}${a.last4 ? ` ••${a.last4}` : ''}`;
const IDLE = ['INTERNET', 'PHONE'];
const RISING = ['ELECTRIC', 'GAS', 'WATER', 'SEWER', 'TRASH', 'INTERNET', 'PHONE', 'HOA', 'OTHER'];

/** Everything found, biggest first. `month` is this month (YYYY-MM); `occupied` the properties with a tenant. */
export function findSavings(accounts: AccountFacts[], loans: LoanFacts[], occupied: Set<string>, month: string): Saving[] {
  const out: Saving[] = [];
  const last3 = [1, 2, 3].map(k => shift(month, -k));
  const sum = (a: AccountFacts, ms: string[]) => ms.reduce((t, m) => t + (a.charges[m] ?? 0), 0);

  for (const a of accounts) {
    if (a.feesLast12 >= 15) out.push({
      kind: 'LATE_FEES', title: `Late fees on ${name(a)}`, perYear: r0(a.feesLast12),
      detail: `${money(a.feesLast12)} in late fees and penalties in the last 12 months${a.latePaid ? `; ${a.latePaid} bill${a.latePaid === 1 ? ' was' : 's were'} paid after the due date` : ''}.`,
      action: 'Turn on autopay, or pay a few days before the due date.', propertyId: a.propertyId, propertyName: a.propertyName, link: ACCOUNT_LINK(a),
    });
    if (a.cardFeesLast12 >= 15) out.push({
      kind: 'CARD_FEES', title: `Card fees paying ${name(a)}`, perYear: r0(a.cardFeesLast12),
      detail: `${money(a.cardFeesLast12)} in processing fees on top of the bills in the last 12 months.`,
      action: 'Pay from the bank account (ACH or e-check), which is usually free.', propertyId: a.propertyId, propertyName: a.propertyName, link: ACCOUNT_LINK(a),
    });
    if (a.category === 'INSURANCE') {
      const now = Object.entries(a.charges).filter(([m]) => m > shift(month, -13) && m <= month).reduce((t, [, v]) => t + v, 0);
      const before = Object.entries(a.charges).filter(([m]) => m > shift(month, -25) && m <= shift(month, -12)).reduce((t, [, v]) => t + v, 0);
      if (before > 0 && now - before >= 100 && now / before >= 1.1) out.push({
        kind: 'INSURANCE_UP', title: `${name(a)} premium up ${Math.round((now / before - 1) * 100)}%`, perYear: r0(now - before),
        detail: `${money(now)} billed in the last 12 months against ${money(before)} the year before.`,
        action: 'Get two or three quotes before the renewal, and ask about a higher deductible.', propertyId: a.propertyId, propertyName: a.propertyName, link: ACCOUNT_LINK(a),
      });
      continue;
    }
    if (RISING.includes(a.category)) {
      const now = sum(a, last3), before = sum(a, last3.map(m => shift(m, -12)));
      if (before > 0 && now - before >= 60 && now / before >= 1.2) out.push({
        kind: 'RISING_BILL', title: `${name(a)} up ${Math.round((now / before - 1) * 100)}% on last year`, perYear: r0((now - before) * 4),
        detail: `${money(now)} over the last three months against ${money(before)} for the same months a year before.`,
        action: a.category === 'WATER' || a.category === 'SEWER' ? 'Check for a leak or a running toilet; compare the meter reads.'
          : a.category === 'ELECTRIC' || a.category === 'GAS' ? 'Check the rate plan (time-of-use, tiers) and what changed in use.'
          : 'Call and ask for the current promotional rate, or compare providers.',
        propertyId: a.propertyId, propertyName: a.propertyName, link: ACCOUNT_LINK(a),
      });
    }
    if (IDLE.includes(a.category) && !occupied.has(a.propertyId)) {
      const recent = sum(a, last3);
      if (recent > 0) out.push({
        kind: 'IDLE_SERVICE', title: `${name(a)} at a property with no tenant`, perYear: r0((recent / 3) * 12),
        detail: `${money(recent)} billed over the last three months while ${a.propertyName} has no active lease.`,
        action: 'Pause or cancel it until there is a tenant, or bill it to whoever uses it.', propertyId: a.propertyId, propertyName: a.propertyName, link: ACCOUNT_LINK(a),
      });
    }
  }

  // Two of the same service at one property, both billing.
  const byKey = new Map<string, AccountFacts[]>();
  for (const a of accounts) if (IDLE.includes(a.category) && sum(a, last3) > 0) {
    const k = `${a.propertyId}|${a.category}`; byKey.set(k, [...(byKey.get(k) ?? []), a]);
  }
  for (const list of byKey.values()) if (list.length > 1) {
    const sorted = [...list].sort((x, y) => sum(x, last3) - sum(y, last3));
    const cheaper = sorted[0];
    out.push({
      kind: 'DUPLICATE_SERVICE', title: `Two ${cheaper.category === 'PHONE' ? 'phone' : 'internet'} accounts at ${cheaper.propertyName}`,
      perYear: r0((sum(cheaper, last3) / 3) * 12),
      detail: `${list.map(name).join(' and ')} are both billing.`,
      action: 'If one is not needed, cancel it.', propertyId: cheaper.propertyId, propertyName: cheaper.propertyName, link: ACCOUNT_LINK(cheaper),
    });
  }

  for (const l of loans) if (l.rate >= 8 && l.balance >= 20000) out.push({
    kind: 'HIGH_RATE_LOAN', title: `${l.lender} at ${l.rate}%`, perYear: r0(l.balance * 0.01),
    detail: `About ${money(l.balance)} owed. Each point lower on the rate is worth about ${money(l.balance * 0.01)} a year in interest.`,
    action: 'Ask for a rate quote to refinance, or ask the lender for a modification.', propertyId: null, propertyName: l.propertyName, link: `/loans/${l.id}`,
  });

  return out.sort((x, y) => y.perYear - x.perYear);
}
