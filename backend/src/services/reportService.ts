/**
 * Report Service
 *
 * Generates lender/investor-style export documents (Rent Roll, T-12
 * Operating Statement) as .xlsx workbooks from a property's real Sollux
 * data — units, leases, rent payments, expenses, and utility statements.
 * Callers can choose which columns (Rent Roll) or which income/expense
 * rows (T-12) to include.
 *
 * Note: these only cover what Sollux actually tracks. Lease-increase
 * history and speculative proforma projections (e.g. "14-unit projected
 * rent") aren't stored anywhere in the schema, so those columns are left
 * out rather than fabricated.
 */
import ExcelJS from 'exceljs';
import { db } from '../config/db';

const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  UTILITIES: 'Utilities (uncategorized)',
  REPAIRS_MAINTENANCE: 'Repairs & Maintenance',
  LANDSCAPING: 'Landscaping',
  PROPERTY_MANAGEMENT: 'Property Management',
  LEGAL: 'Legal & Professional Fees',
  INSURANCE: 'Insurance',
  PROPERTY_TAX: 'Property Tax',
  HOA: 'HOA',
  MORTGAGE_DEBT_SERVICE: 'Mortgage Debt Service',
  CAPITAL_IMPROVEMENT: 'Capital Improvement',
  SUPPLIES: 'Office/Supplies',
  TRAVEL: 'Travel',
  ADVERTISING: 'Advertising',
  OTHER: 'Other',
};

const UTILITY_CATEGORY_LABELS: Record<string, string> = {
  ELECTRIC: 'Utilities - Electric', GAS: 'Utilities - Gas', WATER: 'Utilities - Water',
  SEWER: 'Utilities - Sewer', TRASH: 'Utilities - Trash', SOLAR: 'Utilities - Solar',
  INTERNET: 'Utilities - Internet', PHONE: 'Utilities - Phone', INSURANCE: 'Utilities - Insurance',
  HOA: 'Utilities - HOA', TAXES: 'Utilities - Taxes', OTHER: 'Utilities - Other',
};

// ─── Colors ─────────────────────────────────────────────────────────────────

const FILL_TITLE   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E6F5' } } as const; // light blue
const FILL_HEADER  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6E0B4' } } as const; // light green
const FILL_SECTION = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } } as const; // pale blue band
const FILL_GROSS   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2A8' } } as const; // yellow
const FILL_TOTAL   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } } as const; // dark blue
const FILL_ALT_ROW = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } } as const; // subtle zebra
const THIN_BORDER   = { style: 'thin', color: { argb: 'FFB8C4D9' } } as const;

function toNum(v: unknown): number {
  return v == null ? 0 : Number(v);
}

function propertyAddress(p: { address: string; city: string; state: string; zip: string }) {
  return `${p.address}, ${p.city}, ${p.state} ${p.zip}`;
}

function styleTitleRow(ws: ExcelJS.Worksheet, row: number, lastCol: number, text: string) {
  ws.mergeCells(row, 1, row, lastCol);
  const cell = ws.getCell(row, 1);
  cell.value = text;
  cell.font = { bold: true, size: 13, color: { argb: 'FF1F4E78' } };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
  for (let c = 1; c <= lastCol; c++) ws.getCell(row, c).fill = FILL_TITLE as ExcelJS.Fill;
  ws.getRow(row).height = 22;
}

// ─── Rent Roll ────────────────────────────────────────────────────────────────

export const RENT_ROLL_COLUMNS = [
  { key: 'bdba', label: 'BD/BA' },
  { key: 'status', label: 'Status' },
  { key: 'moveIn', label: 'Move-in Date' },
  { key: 'periodStart', label: 'Period Start' },
  { key: 'periodEnd', label: 'Period End' },
  { key: 'agreementType', label: 'Agreement Type' },
  { key: 'rent', label: 'Monthly Rent ($)' },
  { key: 'deposit', label: 'Deposits Held ($)' },
] as const;
export type RentRollColumnKey = typeof RENT_ROLL_COLUMNS[number]['key'];

export async function buildRentRollWorkbook(
  propertyId: string,
  userId: string,
  columns: RentRollColumnKey[] = RENT_ROLL_COLUMNS.map(c => c.key),
): Promise<ExcelJS.Buffer> {
  const property = await db.property.findFirst({
    where: { id: propertyId, userId },
    include: {
      units: {
        include: { leases: { orderBy: { startDate: 'desc' }, take: 1 } },
        orderBy: { unitLabel: 'asc' },
      },
    },
  });
  if (!property) throw new Error('Property not found');

  const cols = RENT_ROLL_COLUMNS.filter(c => columns.includes(c.key));
  const lastCol = 1 + cols.length; // +1 for Unit column

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rent Roll');

  styleTitleRow(ws, 1, Math.max(lastCol, 6), `Rent Roll - ${propertyAddress(property)}`);

  const headerRow = ws.getRow(3);
  headerRow.getCell(1).value = 'Unit';
  cols.forEach((c, i) => { headerRow.getCell(2 + i).value = c.label; });
  for (let c = 1; c <= lastCol; c++) {
    const cell = headerRow.getCell(c);
    cell.font = { bold: true, underline: true };
    cell.fill = FILL_HEADER as ExcelJS.Fill;
    cell.border = { bottom: THIN_BORDER };
  }
  headerRow.height = 18;

  let rowIdx = 4;
  let rentTotal = 0;
  let rentColOffset = -1;
  cols.forEach((c, i) => { if (c.key === 'rent') rentColOffset = 2 + i; });

  property.units.forEach((unit, uIdx) => {
    const lease = unit.leases[0];
    const row = ws.getRow(rowIdx++);
    row.getCell(1).value = unit.unitLabel;
    const occupied = !!lease && lease.status === 'ACTIVE';

    cols.forEach((c, i) => {
      const cell = row.getCell(2 + i);
      switch (c.key) {
        case 'bdba':
          cell.value = unit.bedrooms != null && unit.bathrooms != null ? `${unit.bedrooms}BD/${unit.bathrooms}BA` : '';
          break;
        case 'status':
          cell.value = occupied ? 'Occupied' : 'VACANT';
          break;
        case 'moveIn':
          if (occupied) { cell.value = lease!.startDate; cell.numFmt = 'm/d/yyyy'; }
          break;
        case 'periodStart':
          if (occupied) { cell.value = lease!.startDate; cell.numFmt = 'm/d/yyyy'; }
          break;
        case 'periodEnd':
          if (occupied && lease!.endDate) { cell.value = lease!.endDate; cell.numFmt = 'm/d/yyyy'; }
          break;
        case 'agreementType':
          if (occupied) cell.value = lease!.leaseType === 'MONTH_TO_MONTH' ? 'MTM' : 'Fixed Term';
          break;
        case 'rent':
          if (occupied) { cell.value = toNum(lease!.rentAmount); cell.numFmt = '$#,##0.00'; rentTotal += toNum(lease!.rentAmount); }
          break;
        case 'deposit':
          if (occupied) { cell.value = toNum(lease!.securityDeposit); cell.numFmt = '$#,##0.00'; }
          break;
      }
    });

    if (uIdx % 2 === 1) for (let c = 1; c <= lastCol; c++) row.getCell(c).fill = FILL_ALT_ROW as ExcelJS.Fill;
    for (let c = 1; c <= lastCol; c++) row.getCell(c).border = { bottom: THIN_BORDER };
  });

  if (rentColOffset > -1) {
    rowIdx += 1;
    const totalRow = ws.getRow(rowIdx);
    const labelCell = totalRow.getCell(rentColOffset - 1);
    labelCell.value = 'Monthly Rent Total ($)';
    labelCell.font = { bold: true };
    labelCell.alignment = { horizontal: 'right' };
    const totalCell = totalRow.getCell(rentColOffset);
    totalCell.value = rentTotal;
    totalCell.numFmt = '$#,##0.00';
    totalCell.font = { bold: true };
    for (let c = 1; c <= lastCol; c++) totalRow.getCell(c).fill = FILL_GROSS as ExcelJS.Fill;
  }

  ws.getColumn(1).width = 10;
  for (let i = 0; i < cols.length; i++) ws.getColumn(2 + i).width = cols[i].key === 'agreementType' ? 16 : 15;

  return wb.xlsx.writeBuffer();
}

// ─── T-12 Operating Statement ───────────────────────────────────────────────

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(d: Date) {
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function trailing12Range() {
  const now = new Date();
  const months: Date[] = [];
  for (let i = 11; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  return { months, rangeStart: months[0], rangeEnd: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
}

async function loadT12Data(propertyId: string, userId: string) {
  const property = await db.property.findFirst({ where: { id: propertyId, userId } });
  if (!property) throw new Error('Property not found');

  const { months, rangeStart, rangeEnd } = trailing12Range();

  const [rentPayments, expenses, utilityAccounts] = await Promise.all([
    db.rentPayment.findMany({
      where: { paidDate: { gte: rangeStart, lt: rangeEnd }, lease: { unit: { propertyId } } },
      select: { amount: true, paidDate: true },
    }),
    db.expense.findMany({
      where: { propertyId, date: { gte: rangeStart, lt: rangeEnd }, isPersonal: false },
      select: { amount: true, date: true, category: true },
    }),
    db.utilityAccount.findMany({
      where: { propertyId },
      select: {
        category: true,
        statements: {
          where: { statementDate: { gte: rangeStart, lt: rangeEnd } },
          select: { amountDue: true, statementDate: true },
        },
      },
    }),
  ]);

  const rentByMonth = new Map<string, number>();
  for (const p of rentPayments) rentByMonth.set(monthKey(p.paidDate), (rentByMonth.get(monthKey(p.paidDate)) ?? 0) + toNum(p.amount));

  const expenseRows = new Map<string, Map<string, number>>(); // label -> monthKey -> amount
  for (const e of expenses) {
    const label = EXPENSE_CATEGORY_LABELS[e.category] ?? e.category;
    if (!expenseRows.has(label)) expenseRows.set(label, new Map());
    const m = expenseRows.get(label)!;
    m.set(monthKey(e.date), (m.get(monthKey(e.date)) ?? 0) + toNum(e.amount));
  }
  for (const acct of utilityAccounts) {
    const label = UTILITY_CATEGORY_LABELS[acct.category] ?? `Utilities - ${acct.category}`;
    if (!expenseRows.has(label)) expenseRows.set(label, new Map());
    const m = expenseRows.get(label)!;
    for (const s of acct.statements) {
      m.set(monthKey(s.statementDate), (m.get(monthKey(s.statementDate)) ?? 0) + toNum(s.amountDue));
    }
  }

  return { property, months, rentByMonth, expenseRows };
}

/** Row labels actually present in this property's trailing-12-month data, for a selection UI. */
export async function getT12Manifest(propertyId: string, userId: string) {
  const { expenseRows } = await loadT12Data(propertyId, userId);
  return {
    incomeRows: ['Rents Collected'],
    expenseRows: [...expenseRows.keys()].sort((a, b) => a.localeCompare(b)),
  };
}

export async function buildT12Workbook(
  propertyId: string,
  userId: string,
  includeExpenseRows?: string[],
): Promise<ExcelJS.Buffer> {
  const { property, months, rentByMonth, expenseRows: allExpenseRows } = await loadT12Data(propertyId, userId);

  const expenseRows = includeExpenseRows
    ? new Map([...allExpenseRows.entries()].filter(([label]) => includeExpenseRows.includes(label)))
    : allExpenseRows;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('T12');

  const lastCol = 2 + months.length + 2; // label col(2) + months + AVERAGE + TOTAL
  styleTitleRow(ws, 1, lastCol, `T-12 - ${propertyAddress(property)}`);

  const headerRow = ws.getRow(3);
  headerRow.getCell(2).value = 'PERIOD';
  months.forEach((m, i) => { headerRow.getCell(3 + i).value = monthLabel(m); });
  headerRow.getCell(3 + months.length).value = 'AVERAGE';
  headerRow.getCell(4 + months.length).value = 'TOTAL (T-12)';
  for (let c = 1; c <= lastCol; c++) {
    const cell = headerRow.getCell(c);
    cell.font = { bold: true, underline: c >= 2 };
    cell.fill = FILL_HEADER as ExcelJS.Fill;
    cell.border = { bottom: THIN_BORDER };
  }
  headerRow.height = 18;

  let r = 4;

  function writeDataRow(label: string, byMonth: Map<string, number>, opts?: { sectionLabel?: string; fill?: ExcelJS.Fill; bold?: boolean; underline?: boolean }) {
    const row = ws.getRow(r++);
    if (opts?.sectionLabel) { row.getCell(1).value = opts.sectionLabel; row.getCell(1).font = { bold: true }; }
    row.getCell(2).value = label;
    let total = 0;
    months.forEach((m, i) => {
      const v = byMonth.get(monthKey(m)) ?? 0;
      row.getCell(3 + i).value = v;
      row.getCell(3 + i).numFmt = '$#,##0.00';
      total += v;
    });
    row.getCell(3 + months.length).value = total / 12;
    row.getCell(3 + months.length).numFmt = '$#,##0.00';
    row.getCell(4 + months.length).value = total;
    row.getCell(4 + months.length).numFmt = '$#,##0.00';
    if (opts?.fill) for (let c = 1; c <= lastCol; c++) row.getCell(c).fill = opts.fill;
    if (opts?.bold) row.font = { bold: true };
    if (opts?.underline) row.eachCell(cell => { cell.font = { ...(cell.font || {}), bold: true, underline: true }; });
    return total;
  }

  writeDataRow('Rents Collected', rentByMonth, { sectionLabel: 'INCOME:', fill: FILL_SECTION as ExcelJS.Fill });
  writeDataRow('GROSS INCOME', rentByMonth, { fill: FILL_GROSS as ExcelJS.Fill, bold: true });

  r += 1;
  const expenseTotalByMonth = new Map<string, number>();
  let firstExpenseRow = true;
  for (const [label, byMonth] of [...expenseRows.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    writeDataRow(label, byMonth, { sectionLabel: firstExpenseRow ? 'EXPENSES:' : undefined, fill: FILL_SECTION as ExcelJS.Fill });
    firstExpenseRow = false;
    for (const m of months) {
      const k = monthKey(m);
      expenseTotalByMonth.set(k, (expenseTotalByMonth.get(k) ?? 0) + (byMonth.get(k) ?? 0));
    }
  }
  r += 1;
  writeDataRow('TOTAL EXPENSES', expenseTotalByMonth, { fill: FILL_TOTAL as ExcelJS.Fill, bold: true });
  ws.getRow(r - 1).eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });

  r += 1;
  const netByMonth = new Map<string, number>();
  months.forEach(m => { const k = monthKey(m); netByMonth.set(k, (rentByMonth.get(k) ?? 0) - (expenseTotalByMonth.get(k) ?? 0)); });
  writeDataRow('NET INCOME', netByMonth, { fill: FILL_GROSS as ExcelJS.Fill, bold: true, underline: true });
  ws.getCell(r - 1, lastCol + 2).value = '<- NET OPERATING INCOME';
  ws.getCell(r - 1, lastCol + 2).font = { italic: true, color: { argb: 'FF666666' } };

  ws.getColumn(1).width = 12;
  ws.getColumn(2).width = 26;
  for (let i = 0; i < months.length; i++) ws.getColumn(3 + i).width = 12;
  ws.getColumn(3 + months.length).width = 13;
  ws.getColumn(4 + months.length).width = 14;

  return wb.xlsx.writeBuffer();
}
