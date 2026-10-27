/**
 * The kinds of fee a bill charges or a payment logs. A logged fee goes on its
 * bill as its own charge line (backend lateFees.ts FEE_KINDS, same ids); a
 * bill's own fee lines are sorted into the same kinds by their wording.
 */
export type FeeKind = 'late' | 'contamination' | 'delinquent' | 'disconnection' | 'additional' | 'returned' | 'other';
export interface FeeLine { kind: FeeKind; amount: number }

export const FEE_KIND_LABELS: Record<FeeKind, string> = {
  late: 'Late fee',
  contamination: 'Contaminated materials',
  delinquent: 'Delinquent charge',
  disconnection: 'Disconnection / reconnection',
  additional: 'Additional service',
  returned: 'Returned payment',
  other: 'Other fee',
};
export const FEE_KIND_IDS = Object.keys(FEE_KIND_LABELS) as FeeKind[];

/** The charge-list lines fees logged with payments are written to. */
const LOGGED_LINES = new Set([
  'Late fee (paid late)', 'Contaminated materials (logged)', 'Delinquent charge (logged)',
  'Disconnection / reconnection fee (logged)', 'Additional service (logged)',
  'Returned payment fee (logged)', 'Other fee (logged)',
]);
export const isLoggedFeeLine = (line: string) => LOGGED_LINES.has(line);

// What counts as a fee on a bill's itemised charges: late fees, penalties,
// returned payments, delinquent charges, disconnection / reconnection /
// service interrupt,
// contamination, additional-service (extra pickup) and incidental charges, and fees
// logged with payments. Everything else is service. The same rule as the
// statements trigger (migration 20261027120000_service_interrupt_fee).
export const FEE_LINE = /late|penalt|nsf|non[- ]?sufficient|returned (check|payment|item)|dishono|delinquen|reconnect|disconnect|interrupt|contaminat|collection fee|additional (service|pick[- ]?up)|extra (service|pick[- ]?up)|incidental|\(logged\)/i;

/** Which kind a fee line is, by its wording. */
export function feeKindOf(line: string): FeeKind {
  if (/contaminat/i.test(line)) return 'contamination';
  if (/delinquen/i.test(line)) return 'delinquent';
  if (/disconnect|reconnect|interrupt/i.test(line)) return 'disconnection';
  // WM's incidental charges are extra pickups and overages.
  if (/additional|extra|incidental/i.test(line)) return 'additional';
  if (/nsf|sufficient|returned|dishono/i.test(line)) return 'returned';
  if (/late|penalt/i.test(line)) return 'late';
  return 'other';
}

const round = (n: number) => Number(n.toFixed(2));

/**
 * The fees a bill itself charged — its charge list's fee lines (an imported
 * "Late Fee 6.07", three "Contaminated Materials" pickups) — by kind, not
 * those logged with a payment. A payment toward that bill already covers them.
 */
export function billOwnFees(st: any, withLogged = false): FeeLine[] {
  const lines = (st?.rawDataJson?.chargeBreakdown ?? {}) as Record<string, number>;
  const by = new Map<FeeKind, number>();
  for (const [k, v] of Object.entries(lines)) {
    if ((!withLogged && isLoggedFeeLine(k)) || !FEE_LINE.test(k) || !(Number(v) > 0)) continue;
    const kind = feeKindOf(k);
    by.set(kind, (by.get(kind) ?? 0) + Number(v));
  }
  return FEE_KIND_IDS.filter(k => by.has(k)).map(kind => ({ kind, amount: round(by.get(kind)!) }));
}

/** The fees a payment logged: by kind, or (older payments) its lateFeeAdded as a late fee. */
export function paymentFees(p: any): FeeLine[] {
  if (Array.isArray(p?.feesAddedJson)) {
    return p.feesAddedJson.filter((f: any) => f && f.kind in FEE_KIND_LABELS && Number(f.amount) > 0)
      .map((f: any) => ({ kind: f.kind as FeeKind, amount: round(Number(f.amount)) }));
  }
  const late = Number(p?.lateFeeAdded ?? 0);
  return late > 0 ? [{ kind: 'late', amount: round(late) }] : [];
}

/** "late fee", "contaminated materials" — for "incl. $9.79 late fee". */
export const feeKindPhrase = (kind: FeeKind) => FEE_KIND_LABELS[kind].toLowerCase();

/**
 * What a payment's `toFees` paid, named by kind from the bill's fee lines
 * (its own and those logged with payments): "$5.00 late fee · $61.60
 * contaminated materials" when the lines account for it, the one kind when
 * there is one, else plain "fees".
 */
export function feesPaidParts(toFees: number, st: any): { label: string; amount: number }[] {
  const lines = billOwnFees(st, true);
  const sum = round(lines.reduce((t, f) => t + f.amount, 0));
  if (lines.length > 1 && Math.abs(sum - toFees) < 0.01) return lines.map(f => ({ label: feeKindPhrase(f.kind), amount: f.amount }));
  if (lines.length === 1 && toFees <= sum + 0.01) return [{ label: feeKindPhrase(lines[0].kind), amount: toFees }];
  return [{ label: 'fees', amount: toFees }];
}
