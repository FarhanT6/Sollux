/**
 * The year-end tax packager: a Schedule E (Supplemental Income and Loss,
 * Part I) per property, on a cash basis, from what Sollux already holds —
 * rent received, expenses by category, utility and insurance bills paid,
 * property-tax installments paid, and mortgage interest from the loan
 * payments. It is a worksheet for the owner's preparer, not a return:
 * depreciation needs the basis and placed-in-service date, so it is left
 * to them, and every figure that had to be estimated says so.
 */
import { db } from '../config/db';

export const LINES = [
  { line: '3', key: 'rents', label: 'Rents received' },
  { line: '5', key: 'advertising', label: 'Advertising' },
  { line: '6', key: 'travel', label: 'Auto and travel' },
  { line: '7', key: 'cleaning', label: 'Cleaning and maintenance' },
  { line: '8', key: 'commissions', label: 'Commissions' },
  { line: '9', key: 'insurance', label: 'Insurance' },
  { line: '10', key: 'legal', label: 'Legal and other professional fees' },
  { line: '11', key: 'management', label: 'Management fees' },
  { line: '12', key: 'mortgageInterest', label: 'Mortgage interest paid to banks, etc.' },
  { line: '13', key: 'otherInterest', label: 'Other interest' },
  { line: '14', key: 'repairs', label: 'Repairs' },
  { line: '15', key: 'supplies', label: 'Supplies' },
  { line: '16', key: 'taxes', label: 'Taxes' },
  { line: '17', key: 'utilities', label: 'Utilities' },
  { line: '18', key: 'depreciation', label: 'Depreciation expense or depletion' },
  { line: '19', key: 'other', label: 'Other (HOA, permits, other)' },
] as const;
export type LineKey = typeof LINES[number]['key'];

// Expense category → Schedule E line. Fines and penalties are not deductible;
// capital improvements are depreciated, not expensed.
const CATEGORY_LINE: Record<string, LineKey | null> = {
  ADVERTISING: 'advertising', TRAVEL: 'travel', LANDSCAPING: 'cleaning', INSURANCE: 'insurance', LEGAL: 'legal',
  PROPERTY_MANAGEMENT: 'management', REPAIRS_MAINTENANCE: 'repairs', HANDYMAN: 'repairs', SUPPLIES: 'supplies',
  PROPERTY_TAX: 'taxes', UTILITIES: 'utilities', HOA: 'other', PERMITS: 'other', OTHER: 'other',
  CITATIONS_FINES: null, CAPITAL_IMPROVEMENT: null, MORTGAGE_DEBT_SERVICE: null,
};
const STATEMENT_LINE: Record<string, LineKey | null> = {
  ELECTRIC: 'utilities', GAS: 'utilities', WATER: 'utilities', SEWER: 'utilities', TRASH: 'utilities', SOLAR: 'utilities',
  INTERNET: 'utilities', PHONE: 'utilities', INSURANCE: 'insurance', HOA: 'other', TAXES: 'taxes', OTHER: 'other',
  LOAN: null, CREDIT_CARD: null,
};

export interface ScheduleEProperty {
  propertyId: string; name: string; address: string;
  lines: Record<LineKey, number>;
  totalExpenses: number; net: number;
  capitalImprovements: number; finesExcluded: number;
  notes: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const blank = () => Object.fromEntries(LINES.map(l => [l.key, 0])) as Record<LineKey, number>;

export async function buildScheduleE(userId: string, year: number) {
  const start = new Date(Date.UTC(year, 0, 1)), end = new Date(Date.UTC(year + 1, 0, 1));
  const inYear = (d: Date | null | undefined) => !!d && d >= start && d < end;
  const properties = await db.property.findMany({ where: { userId }, select: { id: true, address: true, nickname: true, city: true, state: true }, orderBy: { address: 'asc' } });
  const out: ScheduleEProperty[] = [];

  for (const p of properties) {
    const lines = blank();
    const notes: string[] = [];
    let capex = 0, fines = 0;

    const [rent, expenses, statements, taxes, loans] = await Promise.all([
      db.rentPayment.findMany({ where: { lease: { unit: { propertyId: p.id } }, paidDate: { gte: start, lt: end }, status: 'RECEIVED' }, select: { amount: true } }),
      db.expense.findMany({ where: { propertyId: p.id, isPersonal: false, date: { gte: start, lt: end } }, select: { category: true, amount: true, isCapEx: true } }),
      db.statement.findMany({
        where: { isScheduled: false, utilityAccount: { propertyId: p.id, escrowLoanId: null }, OR: [{ dueDate: { gte: start, lt: end } }, { dueDate: null, statementDate: { gte: start, lt: end } }] },
        select: { amountDue: true, amountPaid: true, paidOverride: true, utilityAccount: { select: { category: true } } },
      }),
      db.taxAssessment.findMany({ where: { propertyId: p.id }, select: { installment1Paid: true, installment2Paid: true, installment1Amount: true, installment2Amount: true, annualTaxAmount: true, escrowLoanId: true } }),
      db.loan.findMany({
        where: { propertyId: p.id, isPersonal: false },
        select: { lender: true, interestRate: true, currentBalance: true, originalAmount: true, escrowAmount: true, loanPayments: { where: { date: { gte: start, lt: end } }, select: { amount: true, interest: true, escrow: true } } },
      }),
    ]);

    lines.rents = rent.reduce((s, r) => s + Number(r.amount), 0);

    for (const e of expenses) {
      const amt = Number(e.amount);
      if (e.isCapEx || e.category === 'CAPITAL_IMPROVEMENT') { capex += amt; continue; }
      if (e.category === 'CITATIONS_FINES') { fines += amt; continue; }
      const line = CATEGORY_LINE[e.category];
      if (line) lines[line] += amt;
    }

    // Cash basis: a bill counts when it was paid.
    let unpaid = 0;
    for (const s of statements) {
      const line = STATEMENT_LINE[s.utilityAccount.category];
      if (!line) continue;
      const paid = s.amountPaid != null && Number(s.amountPaid) > 0 ? Number(s.amountPaid) : s.paidOverride === 'PAID' ? Number(s.amountDue ?? 0) : 0;
      if (paid > 0) lines[line] += paid; else unpaid++;
    }
    if (unpaid) notes.push(`${unpaid} bill${unpaid === 1 ? '' : 's'} due in ${year} not marked paid — left out (cash basis). Mark them paid if they were.`);

    let escrowTax = false;
    for (const t of taxes) {
      const half = Number(t.annualTaxAmount) / 2;
      if (inYear(t.installment1Paid)) lines.taxes += t.installment1Amount != null ? Number(t.installment1Amount) : half;
      if (inYear(t.installment2Paid)) lines.taxes += t.installment2Amount != null ? Number(t.installment2Amount) : half;
      if (t.escrowLoanId) escrowTax = true;
    }
    if (escrowTax) notes.push('Property tax paid through a mortgage escrow is on the lender\'s Form 1098, not here — add it from the 1098.');

    let estimated = false;
    for (const l of loans) {
      for (const pay of l.loanPayments) {
        if (pay.interest != null) { lines.mortgageInterest += Number(pay.interest); continue; }
        // No split on file: interest ≈ balance × rate ÷ 12, never more than the payment less escrow.
        const bal = Number(l.currentBalance ?? l.originalAmount ?? 0), rate = Number(l.interestRate ?? 0);
        if (!bal || !rate) continue;
        const cap = Number(pay.amount) - Number(pay.escrow ?? l.escrowAmount ?? 0);
        lines.mortgageInterest += Math.max(0, Math.min(cap, (bal * rate) / 100 / 12));
        estimated = true;
      }
    }
    if (estimated) notes.push('Mortgage interest is partly estimated (balance × rate) for payments logged without an interest split — use each lender\'s Form 1098 for the exact figure.');
    if (fines > 0) notes.push(`$${r2(fines).toLocaleString()} in citations and fines left out — fines and penalties are not deductible.`);
    if (capex > 0) notes.push(`$${r2(capex).toLocaleString()} of capital improvements left out of expenses — they are depreciated; give the list to your preparer.`);
    notes.push('Depreciation (line 18) needs the purchase price, land value and placed-in-service date — your preparer computes it.');

    for (const k of Object.keys(lines) as LineKey[]) lines[k] = r2(lines[k]);
    const totalExpenses = r2(LINES.filter(l => l.key !== 'rents').reduce((s, l) => s + lines[l.key], 0));
    if (lines.rents === 0 && totalExpenses === 0 && capex === 0) continue;
    out.push({
      propertyId: p.id, name: p.nickname || p.address, address: [p.address, p.city, p.state].filter(Boolean).join(', '),
      lines, totalExpenses, net: r2(lines.rents - totalExpenses), capitalImprovements: r2(capex), finesExcluded: r2(fines), notes,
    });
  }

  const totals = blank();
  for (const pr of out) for (const k of Object.keys(totals) as LineKey[]) totals[k] = r2(totals[k] + pr.lines[k]);
  return { year, lines: LINES, properties: out, totals, totalExpenses: r2(out.reduce((s, p) => s + p.totalExpenses, 0)), net: r2(out.reduce((s, p) => s + p.net, 0)) };
}

/** The same worksheet as CSV: one row per line, one column per property. */
export function scheduleECsv(data: Awaited<ReturnType<typeof buildScheduleE>>): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = [['Line', 'Item', ...data.properties.map(p => p.address), 'Total'].map(q).join(',')];
  for (const l of data.lines) rows.push([l.line, l.label, ...data.properties.map(p => p.lines[l.key].toFixed(2)), data.totals[l.key].toFixed(2)].map(String).map(q).join(','));
  rows.push(['20', 'Total expenses', ...data.properties.map(p => p.totalExpenses.toFixed(2)), data.totalExpenses.toFixed(2)].map(q).join(','));
  rows.push(['21', 'Income or (loss)', ...data.properties.map(p => p.net.toFixed(2)), data.net.toFixed(2)].map(q).join(','));
  rows.push(['', 'Capital improvements (depreciate)', ...data.properties.map(p => p.capitalImprovements.toFixed(2)), ''].map(q).join(','));
  return rows.join('\n') + '\n';
}
