/**
 * Report Service
 *
 * Generates lender/investor-style export documents (Rent Roll, T-12
 * Operating Statement) as .xlsx workbooks from a property's real Sollux
 * data — units, leases, rent payments, expenses, and utility statements.
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

function toNum(v: unknown): number {
  return v == null ? 0 : Number(v);
}

function propertyAddress(p: { address: string; city: string; state: string; zip: string }) {
  return `${p.address}, ${p.city}, ${p.state} ${p.zip}`;
}

// ─── Rent Roll ────────────────────────────────────────────────────────────────

export async function buildRentRollWorkbook(propertyId: string, userId: string): Promise<ExcelJS.Buffer> {
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

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rent Roll');

  ws.getCell('A1').value = 'Property Address';
  ws.getCell('B1').value = propertyAddress(property);
  ws.getCell('A1').font = { bold: true };

  const headers = ['Unit', 'BD/BA', 'Status', 'Move-in Date', 'Period Start', 'Period End', 'Agreement Type', 'Monthly Rent ($)', 'Deposits Held ($)'];
  const headerRow = ws.getRow(3);
  headers.forEach((h, i) => { headerRow.getCell(i + 1).value = h; });
  headerRow.font = { bold: true };

  let rowIdx = 4;
  let rentTotal = 0;
  for (const unit of property.units) {
    const lease = unit.leases[0];
    const row = ws.getRow(rowIdx++);
    row.getCell(1).value = unit.unitLabel;
    row.getCell(2).value = unit.bedrooms != null && unit.bathrooms != null ? `${unit.bedrooms}BD/${unit.bathrooms}BA` : '';
    if (lease && lease.status === 'ACTIVE') {
      row.getCell(3).value = 'Occupied';
      row.getCell(4).value = lease.startDate;
      row.getCell(5).value = lease.startDate;
      row.getCell(6).value = lease.endDate;
      row.getCell(7).value = lease.leaseType === 'MONTH_TO_MONTH' ? 'MTM' : 'Fixed Term';
      row.getCell(8).value = toNum(lease.rentAmount);
      row.getCell(9).value = toNum(lease.securityDeposit);
      rentTotal += toNum(lease.rentAmount);
    } else {
      row.getCell(3).value = 'VACANT';
    }
    [4, 5, 6].forEach(c => { row.getCell(c).numFmt = 'm/d/yyyy'; });
    [8, 9].forEach(c => { row.getCell(c).numFmt = '$#,##0.00'; });
  }

  rowIdx += 1;
  ws.getCell(`G${rowIdx}`).value = 'Monthly Rent Total ($)';
  ws.getCell(`G${rowIdx}`).font = { bold: true };
  ws.getCell(`H${rowIdx}`).value = rentTotal;
  ws.getCell(`H${rowIdx}`).numFmt = '$#,##0.00';
  ws.getCell(`H${rowIdx}`).font = { bold: true };

  ws.columns.forEach(col => { col.width = 16; });

  return wb.xlsx.writeBuffer();
}

// ─── T-12 Operating Statement ───────────────────────────────────────────────

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(d: Date) {
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

export async function buildT12Workbook(propertyId: string, userId: string): Promise<ExcelJS.Buffer> {
  const property = await db.property.findFirst({ where: { id: propertyId, userId } });
  if (!property) throw new Error('Property not found');

  const now = new Date();
  const months: Date[] = [];
  for (let i = 11; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const rangeStart = months[0];
  const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

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

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('T12');

  ws.getCell('A2').value = 'Property Address:';
  ws.getCell('C2').value = `${propertyAddress(property)} — Trailing 12 Month Operating Statement`;
  ws.getCell('A2').font = { bold: true };

  const headerRow = ws.getRow(4);
  headerRow.getCell(2).value = 'PERIOD';
  months.forEach((m, i) => { headerRow.getCell(3 + i).value = monthLabel(m); });
  headerRow.getCell(15).value = 'AVERAGE';
  headerRow.getCell(16).value = 'TOTAL (T-12)';
  headerRow.font = { bold: true };

  let r = 5;

  function writeDataRow(label: string, byMonth: Map<string, number>, boldFirstCol?: string) {
    const row = ws.getRow(r++);
    if (boldFirstCol) { row.getCell(1).value = boldFirstCol; row.getCell(1).font = { bold: true }; }
    row.getCell(2).value = label;
    let total = 0;
    months.forEach((m, i) => {
      const v = byMonth.get(monthKey(m)) ?? 0;
      row.getCell(3 + i).value = v;
      row.getCell(3 + i).numFmt = '$#,##0.00';
      total += v;
    });
    row.getCell(15).value = total / 12;
    row.getCell(15).numFmt = '$#,##0.00';
    row.getCell(16).value = total;
    row.getCell(16).numFmt = '$#,##0.00';
    return total;
  }

  writeDataRow('Rents Collected', rentByMonth, 'INCOME:');
  const grossByMonth = new Map(rentByMonth);
  writeDataRow('GROSS INCOME', grossByMonth);
  ws.getRow(r - 1).font = { bold: true };

  r += 1;
  const expenseTotalByMonth = new Map<string, number>();
  let firstExpenseRow = true;
  for (const [label, byMonth] of [...expenseRows.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    writeDataRow(label, byMonth, firstExpenseRow ? 'EXPENSES:' : undefined);
    firstExpenseRow = false;
    for (const m of months) {
      const k = monthKey(m);
      expenseTotalByMonth.set(k, (expenseTotalByMonth.get(k) ?? 0) + (byMonth.get(k) ?? 0));
    }
  }
  r += 1;
  writeDataRow('TOTAL EXPENSES', expenseTotalByMonth);
  ws.getRow(r - 1).font = { bold: true };

  r += 1;
  const netByMonth = new Map<string, number>();
  months.forEach(m => { const k = monthKey(m); netByMonth.set(k, (rentByMonth.get(k) ?? 0) - (expenseTotalByMonth.get(k) ?? 0)); });
  writeDataRow('NET INCOME', netByMonth);
  ws.getRow(r - 1).font = { bold: true };
  ws.getCell(`Q${r - 1}`).value = '<- NET OPERATING INCOME';

  ws.columns.forEach(col => { col.width = 13; });
  ws.getColumn(2).width = 24;

  return wb.xlsx.writeBuffer();
}
