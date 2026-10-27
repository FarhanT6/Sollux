/**
 * An operating-expense statement from the facts on file and the owner's
 * setup: which utility accounts count, whether late fees and penalties are
 * their own line or left out, whether the mortgage is shown (below NOI, as
 * cash flow — debt service is not an operating expense), which recorded
 * expense categories count, where taxes and insurance come from (Sollux's
 * records, an amount typed in, or an estimate), and amounts typed in for
 * what Sollux does not track (maintenance, management, reserves …), per
 * month, per year or as a share of rent.
 *
 * Pure: services/operatingExpenses.ts gathers the facts.
 */

export type Per = 'month' | 'year' | 'pctRent';
export type Source = 'records' | 'manual' | 'estimate' | 'none';

export interface ManualLine { id: string; label: string; amount: number; per: Per }

export interface OpexConfig {
  /** Utility account id → counted. Accounts not listed count. */
  utilities?: Record<string, boolean>;
  /** Late fees, penalties and other fees on bills: their own line (default), or left out. */
  lateFees?: 'separate' | 'exclude';
  /** Show the mortgage below NOI as debt service and cash flow. */
  debtService?: boolean;
  /** Recorded expense category → counted. Categories not listed count. */
  categories?: Record<string, boolean>;
  /** Capital improvements are not operating costs; shown below NOI when asked. */
  capex?: boolean;
  taxes?: { source: Source; manualAnnual?: number | null };
  insurance?: { source: Source; manualAnnual?: number | null };
  manual?: ManualLine[];
}

export interface Estimate { low: number; high: number; typical: number; basis: string; sources?: { title: string; url: string }[]; at: string; contacts?: string[] }

export interface OpexFacts {
  months: number;
  rentIncome: number;
  units: number;
  sqft: number | null;
  utilities: { id: string; name: string; category: string; total: number; fees: number; bills: number }[];
  categories: { category: string; total: number; count: number }[];
  capex: number;
  tax: { annual: number | null; source: string | null };
  insurance: { annual: number | null; source: string | null };
  debt: { paid: number; escrow: number; monthlyPI: number | null; lenders: string[]; fromBills: number };
  estimates?: { insurance?: Estimate | null; tax?: Estimate | null };
}

export type Group = 'Utilities' | 'HOA' | 'Fees & penalties' | 'Taxes & insurance' | 'Operating' | 'Your amounts';
export interface Line { key: string; group: Group; label: string; period: number; monthly: number; annual: number; source: Source | 'rule'; note?: string }

export interface OpexStatement {
  months: number;
  income: { period: number; monthly: number; annual: number };
  lines: Line[];
  totals: { period: number; monthly: number; annual: number };
  noi: { period: number; monthly: number; annual: number };
  /** Operating expenses as a share of rent. */
  ratio: number | null;
  perUnit: { annual: number } | null;
  perSqft: { annual: number } | null;
  belowNoi: Line[];
  cashFlow: { period: number; monthly: number; annual: number } | null;
  missing: ('taxes' | 'insurance')[];
  notes: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export const CATEGORY_LABELS: Record<string, string> = {
  UTILITIES: 'Utilities (logged)', REPAIRS_MAINTENANCE: 'Repairs & maintenance', LANDSCAPING: 'Landscaping', PROPERTY_MANAGEMENT: 'Property management',
  LEGAL: 'Legal & professional', HOA: 'HOA (logged)', SUPPLIES: 'Supplies', TRAVEL: 'Travel', ADVERTISING: 'Advertising', HANDYMAN: 'Handyman',
  PERMITS: 'Permits & licenses', CITATIONS_FINES: 'Citations & fines', OTHER: 'Other',
};

/** What to suggest typing in, with a typical figure, for what Sollux has no records of. */
export const SUGGESTED_LINES: { id: string; label: string; per: Per; typical: number; hint: string; unless?: string[] }[] = [
  { id: 'maintenance', label: 'Repairs & maintenance', per: 'pctRent', typical: 8, hint: 'Typically 5–10% of rent', unless: ['REPAIRS_MAINTENANCE', 'HANDYMAN'] },
  { id: 'management', label: 'Property management', per: 'pctRent', typical: 8, hint: 'Typically 8–10% of rent, or your own time', unless: ['PROPERTY_MANAGEMENT'] },
  { id: 'vacancy', label: 'Vacancy & credit loss', per: 'pctRent', typical: 5, hint: 'Typically 5–8% of rent' },
  { id: 'capexReserve', label: 'Capital reserve (roof, HVAC, appliances)', per: 'pctRent', typical: 5, hint: 'Typically 5–10% of rent' },
  { id: 'landscaping', label: 'Landscaping', per: 'month', typical: 0, hint: 'Monthly service, if any', unless: ['LANDSCAPING'] },
  { id: 'pest', label: 'Pest control', per: 'month', typical: 0, hint: 'Quarterly service ÷ 3' },
  { id: 'hoa', label: 'HOA dues', per: 'month', typical: 0, hint: 'If not tracked as an account' },
  { id: 'turnover', label: 'Turnover & cleaning', per: 'year', typical: 0, hint: 'Paint, cleaning and listing between tenants' },
  { id: 'legal', label: 'Accounting & legal', per: 'year', typical: 0, hint: 'Tax prep, eviction reserve', unless: ['LEGAL'] },
];

function money(period: number, months: number) {
  const monthly = months > 0 ? period / months : 0;
  return { period: r2(period), monthly: r2(monthly), annual: r2(monthly * 12) };
}

export function buildStatement(f: OpexFacts, c: OpexConfig): OpexStatement {
  const months = Math.max(f.months, 1);
  const lines: Line[] = [];
  const notes: string[] = [];
  const add = (key: string, group: Group, label: string, period: number, source: Line['source'], note?: string) => {
    if (Math.abs(period) < 0.005) return;
    lines.push({ key, group, label, ...money(period, months), source, ...(note ? { note } : {}) });
  };
  const rent = money(f.rentIncome, months);

  // Utilities, each account its own line; fees taken out to their own line.
  let fees = 0;
  for (const u of f.utilities) {
    if (c.utilities?.[u.id] === false) continue;
    fees += u.fees;
    add(`util:${u.id}`, u.category === 'HOA' ? 'HOA' : 'Utilities', u.name, u.total - u.fees, 'records', `${u.bills} bill${u.bills === 1 ? '' : 's'}`);
  }
  if ((c.lateFees ?? 'separate') === 'separate') add('fees', 'Fees & penalties', 'Late fees & penalties on bills', fees, 'records');
  else if (fees > 0) notes.push(`Late fees and penalties on bills (${fmt(fees)} in the period) are left out.`);

  // Taxes and insurance: records, a typed amount, or an estimate.
  const missing: OpexStatement['missing'] = [];
  const pick = (kind: 'taxes' | 'insurance', label: string, rec: { annual: number | null; source: string | null }, est: Estimate | null | undefined) => {
    const set = kind === 'taxes' ? c.taxes : c.insurance;
    const source: Source = set?.source ?? (rec.annual != null ? 'records' : 'none');
    if (source === 'records' && rec.annual != null) return add(kind, 'Taxes & insurance', label, rec.annual * months / 12, 'records', rec.source ?? undefined);
    if (source === 'manual' && set?.manualAnnual != null) return add(kind, 'Taxes & insurance', label, set.manualAnnual * months / 12, 'manual', 'Typed in');
    if (source === 'estimate' && est) return add(kind, 'Taxes & insurance', label, est.typical * months / 12, 'estimate', `Estimate (${fmt(est.low)}–${fmt(est.high)} a year)`);
    missing.push(kind);
  };
  pick('taxes', 'Property tax', f.tax, f.estimates?.tax);
  pick('insurance', 'Insurance', f.insurance, f.estimates?.insurance);

  // Recorded expenses, by category.
  const recorded = new Set<string>();
  for (const cat of f.categories) {
    if (c.categories?.[cat.category] === false) continue;
    recorded.add(cat.category);
    add(`cat:${cat.category}`, 'Operating', CATEGORY_LABELS[cat.category] ?? cat.category, cat.total, 'records', `${cat.count} expense${cat.count === 1 ? '' : 's'}`);
  }

  // Typed-in amounts.
  for (const m of c.manual ?? []) {
    if (!(m.amount > 0)) continue;
    const period = m.per === 'month' ? m.amount * months : m.per === 'year' ? m.amount * months / 12 : (m.amount / 100) * f.rentIncome;
    add(`manual:${m.id}`, 'Your amounts', m.label, period, 'manual', m.per === 'pctRent' ? `${m.amount}% of rent` : m.per === 'month' ? `${fmt(m.amount)} a month` : `${fmt(m.amount)} a year`);
  }

  const total = lines.reduce((t, l) => t + l.period, 0);
  const totals = money(total, months);
  const noi = money(f.rentIncome - total, months);

  // Below NOI: the mortgage and capital improvements.
  const belowNoi: Line[] = [];
  if (c.debtService) {
    let paid = f.debt.paid > 0 ? f.debt.paid : f.debt.fromBills > 0 ? f.debt.fromBills : (f.debt.monthlyPI ?? 0) * months;
    let note = f.debt.paid > 0 ? 'Mortgage payments logged' : f.debt.fromBills > 0 ? 'Loan bills on file' : f.debt.monthlyPI ? 'Monthly payment × months' : undefined;
    // An escrow payment carries the taxes and insurance already counted above.
    if (f.debt.escrow > 0 && (lines.some(l => l.key === 'taxes') || lines.some(l => l.key === 'insurance'))) {
      paid -= f.debt.escrow;
      note = `${note ?? 'Payments'}, less ${fmt(f.debt.escrow)} escrow (taxes and insurance are counted above)`;
    }
    if (paid > 0) belowNoi.push({ key: 'debt', group: 'Operating', label: `Debt service${f.debt.lenders.length ? ` (${f.debt.lenders.join(', ')})` : ''}`, ...money(paid, months), source: 'records', ...(note ? { note } : {}) });
  }
  if (c.capex && f.capex > 0) belowNoi.push({ key: 'capex', group: 'Operating', label: 'Capital improvements', ...money(f.capex, months), source: 'records' });
  const below = belowNoi.reduce((t, l) => t + l.period, 0);
  const cashFlow = belowNoi.length ? money(f.rentIncome - total - below, months) : null;

  if (!f.rentIncome) notes.push('No rent on file for the period (no leases), so NOI is negative and the expense ratio is not shown.');
  return {
    months, income: rent, lines, totals, noi,
    ratio: f.rentIncome > 0 ? r2(total / f.rentIncome) : null,
    perUnit: f.units > 0 ? { annual: r2(totals.annual / f.units) } : null,
    perSqft: f.sqft ? { annual: r2(totals.annual / f.sqft) } : null,
    belowNoi, cashFlow, missing, notes,
  };
}

/** Suggestions for typed-in lines, leaving out what the records already cover. */
export function suggestionsFor(f: OpexFacts, c: OpexConfig) {
  const have = new Set([...f.categories.map(x => x.category), ...(c.manual ?? []).map(m => m.id)]);
  const hoaAccount = f.utilities.some(u => u.category === 'HOA');
  return SUGGESTED_LINES.filter(s => !have.has(s.id) && !(s.unless ?? []).some(cat => have.has(cat)) && !(s.id === 'hoa' && hoaAccount));
}

function fmt(n: number) { return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`; }
