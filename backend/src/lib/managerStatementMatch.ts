/**
 * Matching a manager's statement lines to the owner's records — pure, so it
 * is tested without a database. A property manager's monthly statement
 * names a property by its street address (or a nickname), a tenant by name
 * or unit, a lender by name; each is matched to the one record it plainly
 * means, or left for the owner to choose when two fit or none does.
 */

export type LineKind = 'RENT' | 'MANAGEMENT_FEE' | 'REPAIR' | 'UTILITY' | 'LOAN_PAYMENT' | 'OTHER_EXPENSE' | 'OWNER_DRAW' | 'OTHER';

const STOP = new Set(['the', 'and', 'of', 'llc', 'inc', 'co', 'st', 'street', 'rd', 'road', 'ave', 'avenue', 'dr', 'drive', 'ln', 'lane', 'way', 'blvd', 'ct', 'court', 'pl', 'unit', 'apt', 'suite', 'ste', 'n', 's', 'e', 'w', 'bank', 'mortgage', 'loan', 'servicing', 'financial']);

export function words(s: string | null | undefined): string[] {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
}

/** The house number of an address, when it starts with one. */
export const houseNumber = (s: string | null | undefined) => String(s ?? '').trim().match(/^(\d+)\b/)?.[1] ?? null;

/** How well a property hint names a property: the house number and a street word, or the nickname. 0 when it does not. */
export function propertyScore(hint: string, p: { address: string; nickname: string | null }): number {
  const h = words(hint);
  if (!h.length) return 0;
  const num = houseNumber(hint);
  if (num && houseNumber(p.address) === num) {
    const street = words(p.address).filter(w => w !== num);
    if (street.some(w => h.includes(w))) return 3;
  }
  const nick = words(p.nickname);
  if (nick.length && nick.every(w => h.includes(w))) return 2;
  return 0;
}

/** How well a tenant/unit hint names a lease: every word of a tenant's name, or the unit label within its property. */
export function leaseScore(hint: string, l: { tenantNames: string[]; unitLabel: string }): number {
  const h = words(hint);
  if (!h.length) return 0;
  for (const name of l.tenantNames) {
    const n = words(name);
    if (n.length && n.every(w => h.includes(w))) return 3;
    // A last name alone ("Alvarez, rent") still points at one tenant.
    if (n.length > 1 && h.includes(n[n.length - 1])) return 1;
  }
  const unit = words(l.unitLabel);
  if (unit.length && unit.every(w => h.includes(w))) return 2;
  return 0;
}

export function lenderScore(hint: string, lender: string): number {
  const h = words(hint), l = words(lender);
  if (!h.length || !l.length) return 0;
  const hits = l.filter(w => h.includes(w)).length;
  return hits === l.length ? 2 : hits > 0 ? 1 : 0;
}

/** The one best candidate, or null when none fits or two fit equally well. */
export function best<T>(items: T[], score: (t: T) => number): T | null {
  let top: T | null = null, topScore = 0, tie = false;
  for (const t of items) {
    const s = score(t);
    if (s > topScore) { top = t; topScore = s; tie = false; }
    else if (s === topScore && s > 0) tie = true;
  }
  return topScore > 0 && !tie ? top : null;
}

/** Which expense category a cost line is filed under. */
export function categoryFor(kind: LineKind): string | null {
  switch (kind) {
    case 'MANAGEMENT_FEE': return 'PROPERTY_MANAGEMENT';
    case 'REPAIR': return 'REPAIRS_MAINTENANCE';
    case 'UTILITY': return 'UTILITIES';
    case 'OTHER_EXPENSE': return 'OTHER';
    default: return null;
  }
}
