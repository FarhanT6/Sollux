/**
 * How each loan gets paid — due day, grace, method, where a check is mailed,
 * the lender's bank (last four only), the payment website — read from the
 * owner's loan sheet and filed onto the loans that already exist. Rows are
 * matched to loans, never used to create or remove one.
 *
 * A sheet comes in as CSV (read here, exactly) or as a PDF/photo (read by
 * Claude into the same row shape). Login columns are never read.
 */
import { db } from '../config/db';
import { encryptOptional } from '../crypto/encrypt';

export const PAYMENT_METHODS = ['AUTOPAY', 'ONLINE', 'CHECK', 'ZELLE', 'BANK_DEPOSIT', 'CASH', 'WIRE', 'DEDUCTED', 'OTHER'] as const;

export interface SheetRow {
  lender: string;
  accountNumber: string | null;
  paymentAmount: number | null;
  propertyAddress: string | null;
  dueDay: number | null;
  gracePeriodDays: number | null;
  paymentMethods: string[];
  paymentInstructions: string | null;
  mailingAddress: string | null;
  payeeBankName: string | null;
  payeeAccountLast4: string | null;
  paymentUrl: string | null;
}

const str = (v: unknown): string | null => (v == null ? null : String(v).trim() || null);
const num = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const n = parseFloat(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const URL_RE = /https?:\/\/\S+/i;

/** The methods a free-text "payment method" cell names. */
export function methodsFrom(text: string | null): string[] {
  if (!text) return [];
  const t = text.toLowerCase();
  const out: string[] = [];
  if (/auto-?pay/.test(t)) out.push('AUTOPAY');
  if (/online|https?:/.test(t)) out.push('ONLINE');
  if (/check|cheque/.test(t)) out.push('CHECK');
  if (/zelle/.test(t)) out.push('ZELLE');
  if (/deposit/.test(t)) out.push('BANK_DEPOSIT');
  if (/\bcash\b/.test(t)) out.push('CASH');
  if (/\bwire\b/.test(t)) out.push('WIRE');
  if (/deduct|withh[eo]ld/.test(t)) out.push('DEDUCTED');
  return out;
}

const BANKS: [RegExp, string][] = [
  [/\bboa\b|bank of america/i, 'Bank of America'], [/\bchase\b/i, 'Chase'], [/wells\s*fargo/i, 'Wells Fargo'],
  [/\bciti(bank)?\b/i, 'Citibank'], [/\bus bank\b/i, 'U.S. Bank'], [/navy federal/i, 'Navy Federal'],
];
function bankFrom(text: string | null): string | null {
  if (!text) return null;
  for (const [re, name] of BANKS) if (re.test(text)) return name;
  return null;
}

/**
 * One row, cleaned: a URL goes to paymentUrl wherever it was typed, the
 * lender's account keeps its last four, a due or grace cell that is not a
 * plain number becomes a note, and an account "number" that is really a
 * label ("VVW $150k") is dropped.
 */
export function cleanRow(r: Record<string, unknown>): SheetRow | null {
  const lender = str(r.lender);
  if (!lender || /^total|^number of/i.test(lender)) return null;
  let mailing = str(r.mailingAddress);
  let methodText = str(r.paymentMethod) ?? str(r.paymentInstructions);
  let url = str(r.paymentUrl);
  for (const cell of [mailing, methodText]) { const m = cell?.match(URL_RE); if (m && !url) url = m[0]; }
  if (mailing && URL_RE.test(mailing)) mailing = str(mailing.replace(URL_RE, '')) ;
  const methods = Array.isArray(r.paymentMethods) ? (r.paymentMethods as unknown[]).map(String).filter(m => (PAYMENT_METHODS as readonly string[]).includes(m)) : [];
  for (const m of methodsFrom(methodText)) if (!methods.includes(m)) methods.push(m);
  if (url && !methods.includes('ONLINE') && !methods.includes('AUTOPAY')) methods.push('ONLINE');
  if (methodText && URL_RE.test(methodText)) methodText = str(methodText.replace(URL_RE, ''));

  const notes: string[] = [];
  const dueCell = str(r.dueDay);
  let dueDay: number | null = null;
  if (dueCell) {
    const m = dueCell.match(/^(\d{1,2})(?:st|nd|rd|th)?$/i);
    if (m && +m[1] >= 1 && +m[1] <= 31) dueDay = +m[1];
    else {
      const lead = dueCell.match(/^(\d{1,2})\b/);
      if (lead && +lead[1] >= 1 && +lead[1] <= 31) dueDay = +lead[1];
      notes.push(`Due: ${dueCell}`);
    }
  }
  const graceCell = str(r.gracePeriodDays);
  let grace: number | null = null;
  if (graceCell) {
    if (/^\d{1,3}$/.test(graceCell)) grace = +graceCell;
    else notes.push(`Grace: ${graceCell}`);
  }
  const instructions = [methodText, ...notes].filter(Boolean).join(' · ') || null;

  const payeeDigits = str(r.payeeAccount)?.replace(/[^0-9A-Za-z]/g, '') ?? '';
  const acct = str(r.accountNumber);
  return {
    lender,
    // A real loan number is mostly digits; labels like "VVW $150k" are not.
    accountNumber: acct && /^[A-Za-z0-9-]{6,}$/.test(acct) && (acct.match(/\d/g)?.length ?? 0) >= 6 ? acct : null,
    paymentAmount: num(r.paymentAmount),
    propertyAddress: str(r.propertyAddress),
    dueDay,
    gracePeriodDays: grace,
    paymentMethods: methods,
    paymentInstructions: instructions,
    mailingAddress: mailing,
    payeeBankName: str(r.payeeBankName) ?? bankFrom(methodText),
    payeeAccountLast4: payeeDigits.length >= 4 ? payeeDigits.slice(-4) : null,
    paymentUrl: url,
  };
}

// ─── CSV ────────────────────────────────────────────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Header text → row field. The owner's sheet headers first; loose synonyms after.
const HEADERS: [RegExp, string][] = [
  [/^(mortgagee|lender|servicer|payee)/i, 'lender'],
  [/^account\s*(no|number|#)/i, 'accountNumber'],
  [/^payment amount(?!.*only)|^monthly payment/i, 'paymentAmount'],
  [/^property/i, 'propertyAddress'],
  [/^due/i, 'dueDay'],
  [/^grace/i, 'gracePeriodDays'],
  [/their bank|lender.*account|payee.*account/i, 'payeeAccount'],
  [/^mailing|^mail to|remit/i, 'mailingAddress'],
  [/^payment method|^how paid|^method/i, 'paymentMethod'],
  [/^(payment )?(url|website|portal)/i, 'paymentUrl'],
  // Login / password columns are never mapped, so never read.
];

export function rowsFromCsv(text: string): SheetRow[] {
  const table = parseCsv(text.replace(/^﻿/, ''));
  const headerAt = table.findIndex(r => r.some(c => /^(mortgagee|lender)/i.test(c.trim())));
  if (headerAt < 0) throw new Error('No header row with a "Mortgagee" or "Lender" column.');
  const cols = table[headerAt].map(h => HEADERS.find(([re]) => re.test(h.trim()))?.[1] ?? null);
  const out: SheetRow[] = [];
  for (const r of table.slice(headerAt + 1)) {
    const rec: Record<string, string> = {};
    cols.forEach((k, i) => { if (k && rec[k] == null) rec[k] = r[i] ?? ''; });
    const row = cleanRow(rec);
    if (row) out.push(row);
  }
  return out;
}

// ─── Matching rows to loans ─────────────────────────────

const STOP = new Set(['the', 'of', 'and', 'trust', 'trustee', 'family', 'living', 'revocable', 'inc', 'llc', 'corp', 'co', 'services', 'service',
  'servicing', 'financial', 'mortgage', 'home', 'loan', 'bank', 'i', 'ii', 'iii', 'k', 'dba']);
const words = (s: string | null | undefined) =>
  new Set((s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)));

/** "1536-1538 Hunsaker St." → { nums: [1536,1538], street: 'hunsaker' } */
function addressKey(a: string | null | undefined): { nums: number[]; street: string | null } {
  if (!a) return { nums: [], street: null };
  const m = a.match(/^\s*(\d+)(?:\s*[-–&]\s*(\d+))?\s+(?:[NSEW]\.?\s+)?([A-Za-z]+)/);
  if (!m) return { nums: [], street: null };
  return { nums: [+m[1], ...(m[2] ? [+m[2]] : [])], street: m[3].toLowerCase() };
}
function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = addressKey(a), y = addressKey(b);
  if (!x.street || !y.street || x.street !== y.street) return false;
  // Ranges overlap ("1536-1538" vs "1536 Hunsaker").
  const [x0, x1] = [x.nums[0], x.nums[x.nums.length - 1]], [y0, y1] = [y.nums[0], y.nums[y.nums.length - 1]];
  return x0 <= y1 && y0 <= x1;
}

export interface LoanForMatch {
  id: string; lender: string; accountLast4: string | null; monthlyPayment: number | null; escrowAmount: number | null;
  propertyAddress: string | null; propertyNickname: string | null;
}

export function scoreMatch(row: SheetRow, loan: LoanForMatch): number {
  let score = 0;
  const rw = words(row.lender), lw = words(loan.lender);
  const shared = [...rw].filter(w => lw.has(w)).length;
  if (shared) score += 3 + Math.min(shared, 3);
  if (row.accountNumber && loan.accountLast4 && row.accountNumber.endsWith(loan.accountLast4)) score += 6;
  if (sameAddress(row.propertyAddress, loan.propertyAddress) || sameAddress(row.propertyAddress, loan.propertyNickname)) score += 4;
  if (row.paymentAmount != null && loan.monthlyPayment != null) {
    const pay = loan.monthlyPayment, withEscrow = pay + (loan.escrowAmount ?? 0);
    if (Math.abs(row.paymentAmount - pay) < 1 || Math.abs(row.paymentAmount - withEscrow) < 1) score += 3;
  }
  return score;
}

/**
 * Each row gets at most one loan and each loan at most one row, best pairs
 * first. A pair needs the lender's name, the account number, or the
 * property and the payment together — an address alone is not enough when
 * one property carries several loans.
 */
export function matchRows(rows: SheetRow[], loans: LoanForMatch[]): (string | null)[] {
  const pairs: { r: number; l: number; s: number }[] = [];
  rows.forEach((row, r) => loans.forEach((loan, l) => { const s = scoreMatch(row, loan); if (s >= 6) pairs.push({ r, l, s }); }));
  pairs.sort((a, b) => b.s - a.s);
  const out: (string | null)[] = rows.map(() => null);
  const used = new Set<number>();
  for (const p of pairs) {
    if (out[p.r] != null || used.has(p.l)) continue;
    out[p.r] = loans[p.l].id; used.add(p.l);
  }
  return out;
}

export async function loansForMatch(userId: string): Promise<LoanForMatch[]> {
  const loans = await db.loan.findMany({
    where: { userId },
    select: { id: true, lender: true, accountLast4: true, monthlyPayment: true, escrowAmount: true, property: { select: { address: true, nickname: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return loans.map(l => ({
    id: l.id, lender: l.lender, accountLast4: l.accountLast4,
    monthlyPayment: l.monthlyPayment != null ? Number(l.monthlyPayment) : null,
    escrowAmount: l.escrowAmount != null ? Number(l.escrowAmount) : null,
    propertyAddress: l.property?.address ?? null, propertyNickname: l.property?.nickname ?? null,
  }));
}

/**
 * Write one row's payment details onto one of the owner's loans. Details the
 * sheet leaves blank keep what the loan has; the loan number is only filled
 * when the loan has none. Amounts, rates and terms are never touched.
 */
export async function applyRow(userId: string, loanId: string, row: SheetRow) {
  const loan = await db.loan.findFirst({ where: { id: loanId, userId }, select: { id: true, accountNumberEnc: true, accountLast4: true } });
  if (!loan) throw new Error('Loan not found');
  const data: Record<string, unknown> = {};
  if (row.dueDay != null) data.dueDay = row.dueDay;
  if (row.gracePeriodDays != null) data.gracePeriodDays = row.gracePeriodDays;
  if (row.paymentMethods.length) data.paymentMethods = row.paymentMethods.filter(m => (PAYMENT_METHODS as readonly string[]).includes(m));
  if (row.paymentInstructions) data.paymentInstructions = row.paymentInstructions;
  if (row.mailingAddress) data.mailingAddress = row.mailingAddress;
  if (row.payeeBankName) data.payeeBankName = row.payeeBankName;
  if (row.payeeAccountLast4) data.payeeAccountLast4 = row.payeeAccountLast4.replace(/[^0-9A-Za-z]/g, '').slice(-4);
  if (row.paymentUrl) data.paymentUrl = row.paymentUrl;
  if (row.accountNumber && !loan.accountNumberEnc && !loan.accountLast4) {
    data.accountNumberEnc = encryptOptional(row.accountNumber);
    data.accountLast4 = row.accountNumber.slice(-4);
  }
  if (!Object.keys(data).length) return 0;
  await db.loan.update({ where: { id: loan.id }, data });
  return Object.keys(data).length;
}
