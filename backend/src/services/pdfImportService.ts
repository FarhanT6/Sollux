/**
 * PDF Import Service
 *
 * Accepts raw PDF buffers, extracts billing data via Claude,
 * then auto-matches to the user's existing utility accounts by
 * account number (primary) or service address + provider name (fallback).
 */
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { providersLookAlike } from './providerMatch';
import { db } from '../config/db';
import { decrypt } from '../crypto/encrypt';

// Read the API key directly from the .env file — reliable regardless of
// process.cwd() or ESM vs CJS module context (dotenv uses cwd which can vary).
function loadAnthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // Walk up from this file's directory until we find a .env with the key
  const candidates = [
    path.resolve('/Users/farhan/Sollux/backend/.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../backend/.env'),
  ];

  for (const envPath of candidates) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      const match   = content.match(/^ANTHROPIC_API_KEY\s*=\s*(.+)$/m);
      if (match?.[1]?.trim()) {
        const key = match[1].trim();
        process.env.ANTHROPIC_API_KEY = key; // cache for subsequent calls
        return key;
      }
    } catch { /* file not found, try next */ }
  }

  throw new Error('ANTHROPIC_API_KEY not found in environment or .env file');
}

function getAnthropic() {
  return new Anthropic({
    apiKey: loadAnthropicKey(),
    defaultHeaders: { 'anthropic-beta': 'pdfs-2024-09-25' },
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractedBillData {
  providerName:       string | null;
  serviceAddress:     string | null;
  accountNumber:      string | null;
  statementDate:      string | null;   // YYYY-MM-DD
  dueDate:            string | null;
  billingPeriodStart: string | null;
  billingPeriodEnd:   string | null;
  amountDue:          number | null;
  previousBalance:    number | null;
  paymentsReceived:   number | null;
  currentCharges:     number | null;
  // An arrears installment charged inside this bill, itemised by some
  // providers as its own line ("Payment Plan" on a City of Brawley bill).
  paymentPlanAmount:  number | null;
  // When a late penalty applies, and what the bill becomes then.
  penaltyDate:        string | null;
  amountAfterDueDate: number | null;
  // How the provider ages the balance, when it prints buckets.
  agingBuckets:       { current?: number; days30?: number; days60?: number; days90plus?: number } | null;
  /** 'past_due_notice' when the document is a dunning/disconnection notice
   *  rather than a bill — it demands an existing balance and bills nothing
   *  new, so it must never become a statement row. */
  documentKind?:      'bill' | 'past_due_notice';
  lateFee:            number | null;
  usageValue:         number | null;
  usageUnit:          string | null;   // kWh, CCF, therms, gallons, etc.
  ratePlan:           string | null;
  isPaid:             boolean;
  utilityType:        'electric' | 'gas' | 'water' | 'sewer' | 'trash' | 'solar' | 'internet' | 'phone' | 'other';
  chargeBreakdown:    Record<string, number> | null;
  alerts:             string[];        // leak warning, high usage, outage credit, etc.
}

export type MatchConfidence = 'high' | 'medium' | 'low' | 'none';

export interface MatchResult {
  confidence:       MatchConfidence;
  method:           string;
  utilityAccountId: string | null;
  propertyId:       string | null;
  propertyName:     string | null;
  providerName:     string | null;
}

export interface ParsedBill {
  filename:  string;
  extracted: ExtractedBillData;
  match:     MatchResult;
  error?:    string;
  /**
   * Which extractor actually produced this, which is not always the one that
   * was asked for: AI extraction falls back to reading the text layer when the
   * API cannot open a PDF. The two are not equivalent — the text path cannot
   * produce a charge breakdown at all and reads totals far less reliably — so
   * a silent downgrade leaves a bill that looks extracted and is quietly worse.
   */
  extractedBy: 'ai' | 'text';
  /** Why the fallback happened, when it did. */
  extractionNote?: string;
}

// ── Claude extraction ─────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are extracting structured data from a property-related bill or statement. This could be a utility bill, HOA statement, property management fee, insurance premium notice, debt collection notice, or any other bill associated with a property.

Extract every piece of available information. Return ONLY valid JSON — no markdown fences, no explanation.

Schema (use null for any field not present in the document):

{
  "providerName": "string — company or organization name sending this bill",
  "serviceAddress": "string — the property/service address (NOT the mailing/remittance address)",
  "accountNumber": "string — account, customer, or reference number",
  "statementDate": "YYYY-MM-DD — date the bill was issued or generated",
  "dueDate": "YYYY-MM-DD — the date payment for THIS bill is due. Bills often print several other dates: a next meter-read date, a service-period end, a solar/net-metering true-up date, an autopay draft date. None of those are the due date — use only a date explicitly labelled as when payment is due,
  "billingPeriodStart": "YYYY-MM-DD — start of billing period if shown",
  "billingPeriodEnd": "YYYY-MM-DD — end of billing period if shown. Bills often print the period without a year (e.g. \"SERVICE PERIOD: 11/19 - 12/19\" means Nov 19 to Dec 19 — those are days, never years). Take the year from the bill's own issue date: the period ends on or shortly before it, and a cycle that spans New Year starts the year before it ends.",
  "amountDue": number or null — THIS period's charges only, including any late fee or penalty added this period, but EXCLUDING any balance carried forward from earlier bills. If the bill shows only one grand total and that total includes a prior balance, do NOT put the grand total here — put the prior balance in previousBalance and this period's charges here,
  "previousBalance": number or null — how much from EARLIER bills is still unpaid, after applying any payments the bill shows. If the bill lists 'Previous Balance' then 'Payments Received' then 'Balance Forward', report the Balance Forward figure, not the Previous Balance. Never include this period's charges. Use null, not 0, when nothing is carried forward,
  "paymentsReceived": number or null — payments or credits applied since last bill (enter as a positive number),
  "currentCharges": number or null — what this period BILLED, before any payment or credit is applied. This is the figure to report even when the bill was settled and shows nothing owing: a bill listing Billed $240.03, Payments/Adjustments -$240.03, Due $0.00 has currentCharges 240.03, amountDue 0. Recording only the zero loses what the period actually cost,
  "lateFee": number or null — late fee, penalty, or overdue charge added THIS period. This is a component of amountDue, not the carried-forward balance,
  "usageValue": number or null — consumption quantity if applicable (kWh, CCF, gallons, etc.),
  "usageUnit": "string or null — kWh | CCF | therms | gallons | HCF | pickup | other",
  "ratePlan": "string or null — rate schedule, plan name, or tier",
  "isPaid": boolean — true ONLY if balance is $0.00 or document shows 'Paid in Full' / paid stamp,
  "utilityType": "electric | gas | water | sewer | trash | solar | internet | phone | other",
  "paymentPlanAmount": number or null — an installment on an arrears or payment-plan arrangement charged within this bill, when the bill itemises one (a line reading "Payment Plan", "Installment", "Arrears Payment" or similar). This is repayment of an older debt carried inside a current bill, not this period's service, so report it separately as well as leaving it in the total,
  "penaltyDate": "YYYY-MM-DD" or null — the date a penalty or late fee applies if the bill is unpaid, when the bill states one ("Penalty Date", "Late after", "Penalty applies after"). This is often a day or two later than the due date; report what the bill says, not the due date,
  "amountAfterDueDate": number or null — what the bill says is payable if paid after the due date ("Amount due after 09/15/2026", "After Due Date Pay"). The difference between this and the amount due is the late fee this provider will charge,
  "agingBuckets": object or null — when the bill prints an aging table (commonly "Past Due | 30 Days | 60 Days | 90+ Days"), report it as {"current": n, "days30": n, "days60": n, "days90plus": n}, omitting any bucket the bill does not show. Report each bucket's own figure, not a running total,
  "documentKind": "bill | past_due_notice — 'past_due_notice' when this is a delinquency, past-due, or disconnection/shut-off notice rather than a bill: it demands an already-overdue balance, shows no service period and no new charges ('PAST DUE STATEMENT', 'FINAL NOTICE', 'service will be locked/disconnected'). For a notice: the demanded amount goes in previousBalance, currentCharges is null, any stated lock-up/disconnection or penalty date goes in penaltyDate, and its aging table in agingBuckets. Everything else is 'bill'",
  "chargeBreakdown": { "line item name": dollar_amount, ... } or null — every individual charge the bill itemises, using the bill's own wording as the key ({"Water": 118.53, "Sewer": 121.50} for a bill splitting the two). Include credits and discounts as negative values. This is how a total is explained later, so itemise whenever the bill does,
  "alerts": ["string", ...] — notable flags: past due, late fees, NSF, payment plan, high usage, leak, outage credit, SCRA, debt collection notice, legal action warning, etc.
}

Important extraction tips:
- For amountDue: look for the largest prominently displayed dollar amount labeled as due or payable. On debt collection statements it may be labeled 'Current Balance' or 'Total Balance'.
- If this is a debt collection or management statement (not a direct utility bill), still fill in all fields you can find.
- serviceAddress: if multiple addresses appear, pick the one labeled 'Service Address', 'Property Address', or that matches a street address format for a building (not a PO Box).
- accountNumber: include dashes and spaces as they appear; do not normalize.
- statementDate: if not explicit, infer from postmark, billing period end, or document date.
- Bills printed in two columns often place the prior balance and this period's charges side by side. Read the labels, not the position: a figure next to 'Past Due' is previousBalance even when it sits where current charges usually appear.
- Copy every figure's sign exactly as the bill prints it. A leading minus, a parenthesised amount, or a trailing "CR" all mean negative ("$361.44CR" is -361.44). Never flip a bill's signs to make its lines read like ordinary charges, and never report an absolute value.
- A credit memo is a bill whose CURRENT charges are negative — service cancelled mid-cycle, an over-payment, a refund. Its currentCharges and amountDue are negative, its balance is the negative credit balance, and "Do Not Pay" or "Credit Balance" does NOT mean isPaid. Its chargeBreakdown lines keep their printed signs and must sum to the printed (negative) total.
- Credits are negative, and the sign matters. A bill reading "Total Account Balance -$91.67" or "Your account has a credit balance of $91.67" is money the provider owes you, not money you owe: report amountDue as the negative figure, never its absolute value. Likewise a California Climate Credit or any line that reduces the bill belongs in chargeBreakdown as a negative number. A credit reported as positive turns a refund into a payment demand.
- Carried balance is worded differently by every provider, and missing it makes a two-month bill look like a one-month bill. All of these mean the same thing: "Previous Balance", "Balance Forward", "Amount of Last Bill", "Past Due on <date>", "Previous Amount Due". Report it net of any payment the bill shows against it. Two worked examples:
  · "Amount of Last Bill 13.40 / Payment Received .00 / Current Charges 18.73 / Total Amount Due 32.13" → previousBalance 13.40, amountDue 18.73. Nothing was paid, so the whole prior bill is still carried.
  · "Past Due on 08/20/26 716.10 / Payments/Adjustments -449.58 / Current Invoice Charges 326.38 / Total Amount Due 592.90" → previousBalance 266.52 (716.10 less the 449.58 paid), amountDue 326.38, and 266.52 + 326.38 = 592.90 as the bill's own total confirms.
- Sanity-check yourself before answering: previousBalance + amountDue should equal the grand total the bill asks for, because previousBalance is already net of payments. If it does not, you have most likely put a carried-forward balance into amountDue. Re-read and split them.
- Some bills show several totals (this period, total with past due, budget-billing amount, minimum payment). amountDue is always this period's charges alone.`;

// ── Regex-based extraction (free, no API calls) ───────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;

function parseDollar(s: string): number | null {
  const m = s.match(/\$?\s*([\d,]+\.?\d*)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

const MONTH_MAP: Record<string, string> = {
  jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12',
};

function parseDate(s: string): string | null {
  // MM/DD/YYYY or M/D/YY
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/);
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  // Month DD, YYYY  or  DD Month YYYY
  m = s.match(/(\w{3,9})\s+(\d{1,2}),?\s+(\d{4})/i) || s.match(/(\d{1,2})\s+(\w{3,9})\s+(\d{4})/i);
  if (m) {
    const [, a, b, c] = m;
    const moName = isNaN(Number(a)) ? a : b;
    const day    = isNaN(Number(a)) ? b : a;
    const yr     = c;
    const mo     = MONTH_MAP[moName.slice(0,3).toLowerCase()];
    if (mo) return `${yr}-${mo}-${day.padStart(2,'0')}`;
  }
  // YYYY-MM-DD
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // YYYYMMDD (compact, e.g. in filenames)
  m = s.match(/\b(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// Search the full text for a label and return the dollar amount near it
function findDollarNear(text: string, labels: RegExp[]): number | null {
  // The sign travels with the figure. Bills write a credit three ways — a
  // leading minus, a trailing CR, or both — and dropping it turns money the
  // provider owes into money demanded: a -$361.44 credit memo read unsigned
  // becomes a $361.44 bill.
  const suffix = '[\\s\\S]{0,80}?(-?)\\$?\\s*(-?)([\\d,]+\\.\\d{2})\\s*(CR)?';
  for (const label of labels) {
    const m = text.match(new RegExp(label.source + suffix, label.flags));
    if (m) {
      const n = parseFloat(m[3].replace(/,/g, ''));
      if (!isNaN(n)) return (m[1] || m[2] || m[4]) ? -n : n;
    }
  }
  return null;
}

function findDateNear(text: string, labels: RegExp[]): string | null {
  const suffix = '[\\s\\S]{0,60}?(\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-](?:\\d{4}|\\d{2})(?!\\d)|\\w{3,9}\\s+\\d{1,2},?\\s+\\d{4})';
  for (const label of labels) {
    const m = text.match(new RegExp(label.source + suffix, label.flags));
    if (m) {
      const d = parseDate(m[1]);
      if (d) return d;
    }
  }
  return null;
}

function findTextNear(text: string, labels: RegExp[]): string | null {
  const suffix = '[:\\s]+([^\\n\\r]{2,60})';
  for (const label of labels) {
    const m = text.match(new RegExp(label.source + suffix, label.flags));
    if (m) return m[1].trim();
  }
  return null;
}

// ── Label-free fallback scanners ──────────────────────────────────────────────

interface AmountHit { amount: number; position: number; context: string }

/** Find every $X.XX pattern in the text with surrounding context. */
function scanAllAmounts(text: string): AmountHit[] {
  const re = /(-?)\$\s*(-?)([\d,]+\.\d{2})\s*(CR)?/g;
  const hits: AmountHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let amount = parseFloat(m[3].replace(/,/g, ''));
    if (isNaN(amount)) continue;
    if (m[1] || m[2] || m[4]) amount = -amount;
    const start = Math.max(0, m.index - 60);
    hits.push({ amount, position: m.index, context: text.slice(start, m.index + m[0].length + 20) });
  }
  return hits;
}

/** Pick the best amount-due candidate from a label-free scan. */
function guessAmountDue(hits: AmountHit[]): number | null {
  if (hits.length === 0) return null;
  // Never treat $0.00 as the amount due — it means the balance was cleared/paid
  const nonZero = hits.filter(h => h.amount > 0);
  if (nonZero.length === 0) return null;
  // Exclude amounts clearly tied to principal/remaining balance
  const notPrincipal = nonZero.filter(h =>
    !/unpaid\s+principal|principal\s+balance|remaining\s+balance|loan\s+balance/i.test(h.context)
  );
  // Prefer hits whose context contains payment-due keywords (not just "balance")
  const paymentPrio = notPrincipal.filter(h =>
    /amount\s+due|payment\s+due|monthly\s+payment|pay\s+this|please\s+pay|due\s+(?:date|by|on)/i.test(h.context)
  );
  // Secondary priority: general due/pay/total (but not principal)
  const generalPrio = notPrincipal.filter(h =>
    /due|pay|total|owed|amount/i.test(h.context)
  );
  const pool = paymentPrio.length > 0 ? paymentPrio
    : generalPrio.length > 0 ? generalPrio
    : notPrincipal.length > 0 ? notPrincipal
    : nonZero;
  // Prefer the smallest non-zero amount — monthly payments are smaller than principal balances
  return pool.reduce((min, h) => h.amount < min ? h.amount : min, pool[0].amount);
}

interface DateHit { date: string; position: number; context: string }

/** Find every recognisable date pattern in the text. */
function scanAllDates(text: string): DateHit[] {
  const patterns = [
    /\b(\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}))(?!\d)\b/g,
    /\b(\d{4}-\d{2}-\d{2})\b/g,
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/gi,
    /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})\b/gi,
  ];
  const hits: DateHit[] = [];
  const seen = new Set<string>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const date = parseDate(m[1]);
      if (!date) continue;
      const key = `${date}:${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const start = Math.max(0, m.index - 60);
      hits.push({ date, position: m.index, context: text.slice(start, m.index + m[0].length + 20) });
    }
  }
  return hits.sort((a, b) => a.position - b.position);
}

/** Detect if pdf-parse output is likely garbled (words run together, low whitespace ratio). */
function isGarbledText(text: string): boolean {
  if (!text || text.length < 50) return false;
  const spaceRatio = (text.match(/\s/g) || []).length / text.length;
  const longWords  = (text.match(/\b\w{25,}\b/g) || []).length;
  return spaceRatio < 0.08 || longWords >= 3;
}

/** Extract hints from the filename itself (date and partial account number). */
function hintsFromFilename(filename: string): { date: string | null; accountHint: string | null } {
  const base = filename.replace(/\.pdf$/i, '');
  // YYYYMMDD pattern anywhere in filename
  const dateMatch = base.match(/\b(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/);
  const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;
  // Last 4 digits of account number often appear as -NNNN- or -NNNN at end
  const acctMatch = base.match(/[-_](\d{4,})[-_.]?$/);
  const accountHint = acctMatch ? acctMatch[1] : null;
  return { date, accountHint };
}

/** Scan for likely account numbers: contiguous 8–20 digit strings, or space/dash-grouped digits. */
function scanAccountNumbers(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  // Contiguous digits
  const re1 = /\b(\d{8,20})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(text)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); candidates.push(m[1]); }
  }
  // Grouped digits separated by spaces or dashes (e.g. "1220 7321 0619 02" or "1234-5678-9012")
  const re2 = /\b(\d{3,6}[\s\-]\d{3,6}(?:[\s\-]\d{3,6})+)\b/g;
  while ((m = re2.exec(text)) !== null) {
    const normalized = m[1].replace(/[\s\-]/g, '');
    if (normalized.length >= 8 && !seen.has(normalized)) {
      seen.add(normalized);
      candidates.push(normalized);
    }
  }
  return candidates;
}

function detectUtilityType(text: string, provider: string | null): ExtractedBillData['utilityType'] {
  const t = (text + ' ' + (provider || '')).toLowerCase();
  // Financial/loan statements — check first so keywords like "gas" in legal boilerplate don't misfire
  if (/auto\s+loan|vehicle\s+loan|car\s+(?:loan|payment)|mortgage|home\s+loan|personal\s+loan|installment\s+loan/.test(t)) return 'other';
  // Named financial institutions — any statement from these is non-utility
  if (/land\s+rover\s+financial|bmw\s+financial|ford\s+motor\s+credit|toyota\s+financial|honda\s+financial|chase\s+(?:auto|bank|financial)|chase\s+bank|\bchase\b.*(?:loan|auto|vehicle)|\bally\s+(?:financial|bank)|capital\s+one\s+(?:auto|bank)|wells\s+fargo|bank\s+of\s+america|citibank|\brushmore\b|\bcarrington\b|select\s+portfolio|\bsps\b|\busaa\b/.test(t)) return 'other';
  if (/insurance\s+premium|homeowner['s]*\s+insurance|renters\s+insurance|policy\s+(?:number|no\.)|safeco|bamboo|lemonade/.test(t)) return 'other';
  if (/\bhoa\b|homeowner.*association|association\s+fee|keystone/.test(t)) return 'other';
  // Utility types
  if (/electric|kwh|kilo.?watt|sdge|fpl|pg&e|pge|edison|sce|aps|xcel/.test(t)) return 'electric';
  if (/natural gas|therms?|socal gas|atmos|southwest gas|piedmont gas/.test(t)) return 'gas';
  if (/water|ccf|hcf|gallons?|irrigation|aqua|cal water/.test(t)) return 'water';
  if (/sewer|wastewater/.test(t)) return 'sewer';
  if (/trash|garbage|waste management|republic services|recology/.test(t)) return 'trash';
  if (/solar|sunrun|vivint solar|sunnova/.test(t)) return 'solar';
  if (/internet|broadband|fiber|cox|comcast|spectrum|att|at&t|charter/.test(t)) return 'internet';
  if (/mobile|wireless|t.?mobile|verizon|sprint|phone/.test(t)) return 'phone';
  return 'other';
}

async function extractWithRegex(pdfBuffer: Buffer, filename: string): Promise<ExtractedBillData> {
  console.log(`[PDFImport/regex] ${filename}: ${Math.round(pdfBuffer.length / 1024)}KB`);
  const { text } = await pdfParse(pdfBuffer);
  const garbled  = isGarbledText(text);
  const fnHints  = hintsFromFilename(filename);
  if (garbled) console.log(`[PDFImport/regex] ${filename}: garbled text detected, using fallback scanners`);

  // ── Provider name ─────────────────────────────────────────────────────────
  const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);
  let providerName: string | null = null;
  if (!garbled) {
    for (const line of lines.slice(0, 20)) {
      if (line.length < 3 || line.length > 100) continue;
      if (/^\d/.test(line)) continue;
      if (/^(account|invoice|statement|bill|date|customer|service|payment|page\s+\d)/i.test(line)) continue;
      providerName = line;
      break;
    }
  }
  if (!providerName) {
    const knownProviders = [
      // Auto/financial
      'Land Rover Financial','Chase Auto','Chase Bank','Wells Fargo','Bank of America',
      'Citi','Capital One','Ally Financial','Toyota Financial','Honda Financial',
      'BMW Financial','Ford Motor Credit',
      // Electric
      'SDGE','SDG&E','San Diego Gas & Electric','FPL','Florida Power & Light',
      'Southern California Edison','SCE','IID','Imperial Irrigation District',
      'Pacific Gas','PG&E','Arizona Public Service','APS','Xcel Energy',
      // Gas
      'SoCal Gas','Southern California Gas','Atmos Energy','Southwest Gas','Piedmont Gas',
      // Water
      'Vista Irrigation','Cal Water','California Water','Brevard County Water',
      // Trash / waste
      'Waste Management','Republic Services','Recology',
      // Internet / cable
      'Cox','Comcast','Xfinity','Spectrum','Charter','AT&T Internet','CenturyLink','Frontier',
      // Phone
      'AT&T','T-Mobile','Verizon','Sprint',
      // Solar / finance
      'Service Finance','Sunrun','SunPower','Vivint Solar','Sunnova',
      // Insurance
      'Safeco','Bamboo','Lemonade','State Farm','Allstate','Farmers',
      // HOA
      'Keystone','First Service','HOA Management',
      // City utilities
      'City of Oceanside','City of Imperial','City of El Centro','City of Brawley',
      // Mortgage servicers
      'Carrington','Rushmore','Citadel','SPS','Select Portfolio Servicing',
    ];
    for (const p of knownProviders) {
      if (text.toLowerCase().includes(p.toLowerCase())) { providerName = p; break; }
    }
  }

  // ── Service address ───────────────────────────────────────────────────────
  let serviceAddress: string | null = garbled ? null : findTextNear(text, [
    /service\s+address/i, /property\s+address/i, /service\s+location/i,
    /premises\s+(?:address)?/i, /installation\s+address/i, /site\s+address/i,
    /delivered\s+to/i, /service\s+for/i,
  ]);
  if (!serviceAddress) {
    const addrMatch = text.match(/\b(\d{2,6}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Dr(?:ive)?|Rd|Way|Ln|Ct|Pl|Cir|Ter(?:race)?|Trail|Pkwy|Hwy)[^\n]{0,50})/);
    if (addrMatch) serviceAddress = addrMatch[1].trim();
  }

  // ── Account number ────────────────────────────────────────────────────────
  let accountNumber: string | null = garbled ? null : findTextNear(text, [
    /account\s+(?:number|no\.?|#)/i,
    /customer\s+(?:number|no\.?|id)/i,
    /reference\s+(?:number|no\.?)/i,
    /invoice\s+(?:number|no\.?|#)/i,
    /contract\s+(?:number|no\.?|#)/i,
    /policy\s+(?:number|no\.?|#)/i,    // insurance
    /policy\s+no/i,
    /subscriber\s+(?:id|number)/i,     // phone
    /service\s+(?:id|number)/i,
    /meter\s+(?:number|no\.?)/i,       // utility meters
    /loan\s+(?:number|no\.?|#)/i,      // loans
    /unit\s+(?:number|no\.?|#)/i,      // HOA
  ]);
  // Fallback: grouped or contiguous digit strings
  if (!accountNumber) {
    const candidates = scanAccountNumbers(text);
    if (candidates.length > 0) {
      accountNumber = candidates.sort((a, b) => b.length - a.length)[0];
    }
  }
  if (!accountNumber && fnHints.accountHint) {
    accountNumber = fnHints.accountHint;
  }

  // ── Statement date ────────────────────────────────────────────────────────
  // Filename date is the most reliable source for statement date on garbled PDFs.
  let statementDate: string | null = fnHints.date ?? null;
  if (!statementDate && !garbled) {
    statementDate = findDateNear(text, [
      /(?:statement|bill|invoice|billing)\s+date/i,
      /date\s+(?:issued|generated|prepared|mailed)/i,
      /billing\s+date/i,
      /(?:as\s+of|effective)\s+date/i,
      /prepared\s+(?:on|date)/i,
      /issued\s+(?:on|date)/i,
    ]) || findDateNear(text, [/^date[:\s]/im]);
  }
  if (!statementDate) {
    const allDates = scanAllDates(text);
    const nonDue = allDates.filter(d => !/due|pay\s+by/i.test(d.context));
    statementDate = nonDue.length > 0 ? nonDue[0].date : (allDates[0]?.date ?? null);
  }

  // ── Due date ──────────────────────────────────────────────────────────────
  let dueDate: string | null = garbled ? null : findDateNear(text, [
    /(?:payment\s+)?due\s+(?:date|by|on)/i,
    /please\s+pay\s+by/i,
    /pay\s+by/i,
    /payment\s+deadline/i,
    /(?:amount\s+)?due\s+(?:by|on)/i,
    /remit\s+by/i,
  ]);
  if (!dueDate) {
    const allDates = scanAllDates(text);
    const dueDates = allDates.filter(d => /due|pay\s+by|payment\s+(?:date|deadline)/i.test(d.context));
    if (dueDates.length > 0) {
      dueDate = dueDates[0].date;
    } else {
      const distinct = [...new Set(allDates.map(d => d.date))].filter(d => d !== statementDate);
      if (distinct.length > 0) dueDate = distinct[0];
    }
  }

  // ── Billing period ────────────────────────────────────────────────────────
  let billingPeriodStart: string | null = null;
  let billingPeriodEnd:   string | null = null;
  const DATE_PAT = '(\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}|\\w{3,9}\\s+\\d{1,2},?\\s+\\d{4})';
  const SEP      = '\\s*(?:to|through|thru|–|-|—)\\s*';
  const periodPatterns = [
    /(?:billing|service)\s+period[:\s]+/i,
    /for\s+service\s+(?:from|period)[:\s]+/i,
    /service\s+dates?[:\s]+/i,
    /period\s+of\s+service[:\s]+/i,
    /your\s+billing\s+period[:\s]+/i,
    /coverage\s+period[:\s]+/i,       // insurance
    /policy\s+period[:\s]+/i,         // insurance
    /term[:\s]+/i,
  ];
  for (const pfx of periodPatterns) {
    const m = text.match(new RegExp(pfx.source + DATE_PAT + SEP + DATE_PAT, 'i'));
    if (m) {
      billingPeriodStart = parseDate(m[1]);
      billingPeriodEnd   = parseDate(m[2]);
      if (billingPeriodStart && billingPeriodEnd) break;
    }
  }

  // Some bills print the period as a bare pair of dates in a meter-reading row,
  // with nothing between them for the patterns above to key on. IID prints:
  //
  //   IID-2B6B-200425  05/29/2025 06/26/2025  29  8,275
  //
  // — meter, from, to, days, kWh. Every pattern above needs a "to"/"through"/
  // dash separator, so IID's period was never extracted in text mode at all,
  // and the importer fell back to inferring the period from the issue month.
  // That is worse than it sounds: a cycle issued on the 1st and again on the
  // 31st then infers the *same* month for both bills, making two distinct
  // statements indistinguishable.
  //
  // A bare pair of dates is too weak a shape to trust on its own, so this
  // requires the day count printed after them to agree with the span they
  // describe. That is what makes it a billing period rather than two dates
  // that happen to sit next to a number.
  if (!billingPeriodStart || !billingPeriodEnd) {
    const bare = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,3})\b/g;
    for (const m of text.matchAll(bare)) {
      const start = parseDate(m[1]);
      const end   = parseDate(m[2]);
      const days  = Number(m[3]);
      if (!start || !end || !days) continue;
      const span = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000);
      // Providers count the days inclusively or exclusively depending on the
      // provider, hence the tolerance rather than an exact equality.
      if (span > 0 && Math.abs(span - days) <= 2) {
        billingPeriodStart = start;
        billingPeriodEnd   = end;
        break;
      }
    }
  }

  // Some bills date the period without a year, because on paper the year is
  // obvious from the rest of the page. City of Imperial prints
  // "SERVICE PERIOD: 05/23 - 06/23". Every pattern above requires a year, so
  // the period was never found and the importer inferred a calendar month
  // instead — which is why these bills read as "Jan 1 – Jan 31" rather than
  // the cycle they actually cover. The year comes from the statement date: a
  // period cannot end after the bill that reports it.
  if ((!billingPeriodStart || !billingPeriodEnd) && statementDate) {
    const m = text.match(
      /(?:service|billing)\s+period[:\s]+(\d{1,2})\/(\d{1,2})\s*(?:to|through|thru|[-–—])\s*(\d{1,2})\/(\d{1,2})(?!\s*[\/-]\s*\d)/i
    );
    if (m) {
      const issued = new Date(statementDate);
      const [sMon, sDay, eMon, eDay] = [+m[1], +m[2], +m[3], +m[4]];
      const iso = (y: number, mo: number, d: number) =>
        `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

      // The period ends on or before the day the bill was issued, so a month
      // later than the issue month belongs to the previous year.
      let endYear = issued.getUTCFullYear();
      if (eMon > issued.getUTCMonth() + 1) endYear -= 1;
      // A start month after the end month means the cycle crossed New Year.
      const startYear = sMon > eMon ? endYear - 1 : endYear;

      billingPeriodStart = iso(startYear, sMon, sDay);
      billingPeriodEnd   = iso(endYear, eMon, eDay);
    }
  }

  // ── Amount due ────────────────────────────────────────────────────────────
  const amountDueLabels: RegExp[] = [
    // Generic
    /(?:total\s+)?amount\s+due/i,
    /total\s+due/i,
    /balance\s+due/i,
    /please\s+pay/i,
    /amount\s+enclosed/i,
    /pay\s+this\s+amount/i,
    /amount\s+to\s+pay/i,
    /(?:net\s+)?amount\s+payable/i,
    /your\s+bill\s+(?:is|total)/i,
    /total\s+(?:amount\s+)?(?:of\s+)?(?:your\s+)?(?:charges?|bill)/i,
    /new\s+charges?\s+total/i,
    /total\s+new\s+charges?/i,
    // Electric
    /total\s+electric(?:ity)?\s+charges?/i,
    /total\s+energy\s+charges?/i,
    /electric\s+charges?\s+total/i,
    // Gas
    /total\s+gas\s+charges?/i,
    /gas\s+charges?\s+total/i,
    // Water / sewer
    /total\s+water(?:\s+&\s+sewer)?\s+charges?/i,
    /water\s+(?:&\s+sewer\s+)?charges?\s+total/i,
    /total\s+sewer\s+charges?/i,
    // Trash
    /total\s+(?:service|waste|trash|garbage)\s+charges?/i,
    // Internet / phone
    /total\s+monthly\s+charges?/i,
    /total\s+(?:account\s+)?charges?/i,
    // Insurance
    /(?:total\s+)?premium\s+(?:due|amount)/i,
    /total\s+premium/i,
    /installment\s+(?:amount|due)/i,
    // HOA
    /assessment\s+(?:due|amount)/i,
    /total\s+assessment/i,
    /monthly\s+assessment/i,
    // Loans / mortgage
    /payment\s+amount\s+due/i,
    /(?:total\s+)?amount\s+(?:of\s+)?(?:this\s+)?payment/i,
  ];
  let amountDue: number | null = findDollarNear(text, amountDueLabels);
  // $0.00 from a label means the balance was cleared (auto-pay applied, etc.) — treat as
  // "not found" so the fallback scanner can find the actual billing amount instead.
  if (amountDue === 0) amountDue = null;
  if (amountDue == null) amountDue = guessAmountDue(scanAllAmounts(text));

  // ── Previous balance ──────────────────────────────────────────────────────
  const previousBalance: number | null = findDollarNear(text, [
    /previous\s+balance/i,
    /prior\s+balance/i,
    /balance\s+forward/i,
    /balance\s+from\s+(?:last|previous)/i,
    /(?:last|prior)\s+(?:month['s]?\s+)?balance/i,
    /amount\s+from\s+previous\s+bill/i,
    /(?:outstanding|past\s+due)\s+balance/i,
  ]);

  // ── Payments received ─────────────────────────────────────────────────────
  const paymentsReceived: number | null = findDollarNear(text, [
    /payments?\s+received/i,
    /payments?\s+&\s+(?:adjustments?|credits?)/i,
    /credits?\s+applied/i,
    /payment\s+(?:amount|total|received)/i,
    /(?:last|recent)\s+payment/i,
    /thank\s+you\s+for\s+(?:your\s+)?payment/i,
    /payment\s+posted/i,
    /payment\s+applied/i,
    /auto.?pay\s+(?:amount|payment)/i,
  ]);

  // ── Late fee / penalty ────────────────────────────────────────────────────
  const lateFee: number | null = findDollarNear(text, [
    /late\s+fee/i,
    /late\s+(?:payment\s+)?(?:charge|penalty)/i,
    /penalty\s+(?:amount|charge)/i,
    /overdue\s+charge/i,
    /nsf\s+fee/i,
  ]);

  // ── Current charges ───────────────────────────────────────────────────────
  let currentCharges: number | null = findDollarNear(text, [
    /current\s+charges?/i,
    /new\s+charges?/i,
    /charges?\s+this\s+(?:period|month|statement)/i,
    /this\s+(?:month['s]?\s+)?charges?/i,
    /monthly\s+(?:charge|payment|service\s+fee)/i,
    /payment\s+amount/i,
    /regular\s+(?:monthly\s+)?payment/i,
    /service\s+charge\s+total/i,
    /total\s+(?:service|monthly)\s+charges?/i,
    // Electric-specific
    /electric(?:ity)?\s+charges?\s+(?:this\s+period)?/i,
    /energy\s+charges?\s+(?:this\s+period)?/i,
    // Gas-specific
    /gas\s+charges?\s+(?:this\s+period)?/i,
    // Water-specific
    /water\s+charges?\s+(?:this\s+period)?/i,
  ]);
  // Loan: monthly payment IS the current charge
  if (currentCharges == null && amountDue != null && /loan|mortgage|installment|auto|vehicle/i.test(text)) {
    currentCharges = amountDue;
  }

  // Bills that lay their totals out in a table put the label and its figure in
  // separate cells, which the text layer can emit far apart — so "TOTAL CURRENT
  // CHARGES" is present but no dollar amount sits near it, and the label-based
  // search comes back empty. "TOTAL AMOUNT DUE" is easier to find, so the bill
  // gets recorded at its whole balance and every month of arrears is counted
  // again as if it were this month's cost.
  //
  // The bill states enough to recover the figure without finding it: what this
  // period charged is the balance owed less what was carried in. City of
  // Imperial prints 2,272.98 due against a 1,538.32 previous balance — 734.66,
  // exactly the current charges it also prints.
  if (currentCharges == null && amountDue != null && previousBalance != null) {
    const derived = amountDue - previousBalance;
    // A negative or absurd result means the two figures are not what they were
    // taken for, and a wrong number here is worse than none.
    if (derived > 0 && derived <= amountDue) currentCharges = Number(derived.toFixed(2));
  }

  // ── Usage ─────────────────────────────────────────────────────────────────
  let usageValue: number | null = null;
  let usageUnit:  string | null = null;
  const usagePatterns: [RegExp, string][] = [
    // Electric
    [/total\s+usage[:\s]+([\d,]+\.?\d*)\s*kWh/i, 'kWh'],
    [/([\d,]+\.?\d*)\s*kWh\s*(?:used|consumed|total|billed)/i, 'kWh'],
    [/([\d,]+\.?\d*)\s*kWh/i, 'kWh'],
    [/([\d,]+\.?\d*)\s*MWh/i, 'MWh'],
    // Gas
    [/([\d,]+\.?\d*)\s*therms?\b/i, 'therms'],
    [/([\d,]+\.?\d*)\s*CCF\b/i, 'CCF'],
    [/([\d,]+\.?\d*)\s*MCF\b/i, 'MCF'],
    [/([\d,]+\.?\d*)\s*HCF\b/i, 'HCF'],
    [/([\d,]+\.?\d*)\s*dekatherms?\b/i, 'dekatherms'],
    [/([\d,]+\.?\d*)\s*(?:hundred\s+cubic\s+feet)\b/i, 'HCF'],
    // Water
    [/([\d,]+\.?\d*)\s*(?:hundred\s+cubic\s+feet|HCF)\b/i, 'HCF'],
    [/([\d,]+\.?\d*)\s*gallons?\b/i, 'gallons'],
    [/([\d,]+\.?\d*)\s*(?:kilo.?gallons?|kgal)\b/i, 'kgal'],
    [/([\d,]+\.?\d*)\s*(?:cubic\s+feet|cu\.?\s*ft\.?)\b/i, 'cu ft'],
    // Trash (pickups)
    [/([\d,]+)\s*pickups?\s*(?:per\s*(?:week|month))?/i, 'pickups'],
    // Internet (data)
    [/([\d,]+\.?\d*)\s*GB\s*(?:used|data|of\s+data)/i, 'GB'],
  ];
  // Bills explain their own units, and the explanation looks exactly like a
  // reading. City of Imperial prints "Meter reads are in Cubic Feet (C.F.)
  // 1 C.F. = 7.65 gallons", which was recorded as 7.65 gallons of water used
  // for the month. Drop the conversion legends before scanning for a reading.
  const usageText = text
    .replace(/\b1\s*(?:C\.?F\.?|CCF|HCF|MCF|unit|therm)s?\s*[=≈]\s*[\d,.]+\s*\w+/gi, ' ')
    .replace(/\bmeter\s+reads?\s+are\s+in[^\n]*/gi, ' ');

  for (const [pattern, unit] of usagePatterns) {
    const m = usageText.match(pattern);
    if (m) {
      const val = m[1] || m[2];
      if (!val) continue;
      const n = parseFloat(val.replace(/,/g, ''));
      if (!isNaN(n) && n > 0) { usageValue = n; usageUnit = unit; break; }
    }
  }

  // ── Rate plan ─────────────────────────────────────────────────────────────
  const ratePlan: string | null = garbled ? null : findTextNear(text, [
    /rate\s+(?:plan|schedule|class|code)/i,
    /tariff\s*(?:code|schedule)?/i,
    /service\s+(?:class|code|type)/i,
    /plan\s+(?:name|type|code)/i,
    /pricing\s+plan/i,
  ]);

  // ── Paid status ───────────────────────────────────────────────────────────
  const isPaid = /paid\s+in\s+full|balance\s+is\s+\$?0\.00|\$0\.00\s+(?:due|balance)|zero\s+balance|no\s+payment\s+due/i.test(text)
    || (amountDue === 0);

  // ── Utility type ──────────────────────────────────────────────────────────
  const utilityType = detectUtilityType(text, providerName);

  // ── Charge breakdown ──────────────────────────────────────────────────────
  const chargeBreakdown: Record<string, number> = {};
  let cm: RegExpExecArray | null;
  let breakdownCount = 0;

  // Pattern 1: "Label ...... $X.XX"  (dot or space leaders, right-aligned)
  const leaderRe = /^(.{3,55}?)[\s\.]{2,}\$?\s*([\d,]+\.\d{2})\s*$/gm;
  while ((cm = leaderRe.exec(text)) !== null && breakdownCount < 25) {
    const label  = cm[1].trim().replace(/\.+$/, '').trim();
    const amount = parseFloat(cm[2].replace(/,/g, ''));
    if (!isNaN(amount) && label.length > 2 && !/^(page|account|date|total\s+amount\s+due)/i.test(label)) {
      chargeBreakdown[label] = amount;
      breakdownCount++;
    }
  }
  // Pattern 2: "Label\t$X.XX" or "Label   $X.XX"
  if (breakdownCount < 3) {
    const tabRe = /^(.{3,55}?)\s{2,}\$\s*([\d,]+\.\d{2})$/gm;
    while ((cm = tabRe.exec(text)) !== null && breakdownCount < 25) {
      const label  = cm[1].trim();
      const amount = parseFloat(cm[2].replace(/,/g, ''));
      if (!isNaN(amount) && label.length > 2 && !chargeBreakdown[label]) {
        chargeBreakdown[label] = amount;
        breakdownCount++;
      }
    }
  }
  // Pattern 3: "Label: $X.XX" inline
  if (breakdownCount < 3) {
    const colonRe = /^([A-Za-z][^:\n]{2,50}):\s*\$?\s*([\d,]+\.\d{2})/gm;
    while ((cm = colonRe.exec(text)) !== null && breakdownCount < 25) {
      const label  = cm[1].trim();
      const amount = parseFloat(cm[2].replace(/,/g, ''));
      if (!isNaN(amount) && !chargeBreakdown[label]) {
        chargeBreakdown[label] = amount;
        breakdownCount++;
      }
    }
  }

  // ── Alerts ────────────────────────────────────────────────────────────────
  const alerts: string[] = [];
  // Universal
  if (/past\s+due/i.test(text))                           alerts.push('Past due balance');
  if (/final\s+(?:notice|demand|warning)/i.test(text))    alerts.push('Final notice');
  if (/late\s+(?:fee|charge|penalty)/i.test(text))        alerts.push('Late fee');
  if (/disconnect|shut.?off|service\s+termination/i.test(text)) alerts.push('Disconnect notice');
  // NSF — require fee/charge context to avoid boilerplate false positives
  // Flag actual NSF events — avoid fee-schedule boilerplate ("if your payment is returned, a fee may apply")
  if (/\bnsf\b|your\s+(?:check|payment)\s+(?:was|has\s+been)\s+returned|payment\s+returned\s+(?:on|dated?|by)|returned\s+(?:check|payment)\s+fee\s*:\s*\$[\d]|\$[\d].*returned\s+payment\s+fee/i.test(text)) alerts.push('Returned payment');
  if (/debt\s+collection|collections?\s+agency|third.party\s+collect/i.test(text)) alerts.push('Debt collection');
  if (/account\s+is\s+current/i.test(text))               alerts.push('Account is current');
  // Electric
  if (/tier\s*2|above\s+baseline|baseline\s+exceeded/i.test(text)) alerts.push('Above baseline usage');
  if (/(?:critical\s+peak|flex\s+alert|demand\s+response)/i.test(text)) alerts.push('Peak demand event');
  if (/high\s+(?:usage|consumption)|usage\s+alert/i.test(text)) alerts.push('High usage');
  if (/outage\s+credit|service\s+interruption\s+credit/i.test(text)) alerts.push('Outage credit applied');
  if (/net\s+(?:metering|energy\s+metering)|solar\s+credit|excess\s+generation/i.test(text)) alerts.push('Solar net metering credit');
  // Gas
  if (/gas\s+(?:safety|leak|smell)|smell\s+gas/i.test(text)) alerts.push('Gas safety notice');
  // Water
  if (/leak\s+(?:alert|detect|warning)|possible\s+leak/i.test(text)) alerts.push('Possible leak detected');
  if (/water\s+(?:restriction|shortage|conservation)/i.test(text)) alerts.push('Water restriction notice');
  if (/drought/i.test(text))                              alerts.push('Drought surcharge applied');
  // Internet / phone
  if (/data\s+(?:overage|over\s+limit|cap\s+exceeded)/i.test(text)) alerts.push('Data overage');
  if (/service\s+(?:outage|disruption|interruption)\s+credit/i.test(text)) alerts.push('Service outage credit');
  // Insurance
  if (/cancell?ation\s+notice|policy\s+cancell?ed/i.test(text)) alerts.push('Cancellation notice');
  if (/renewal\s+notice|policy\s+renew/i.test(text))      alerts.push('Policy renewal');
  if (/premium\s+(?:increase|change)/i.test(text))        alerts.push('Premium changed');
  // Loans / mortgage
  if (/auto\s+loan|vehicle\s+loan|car\s+loan/i.test(text))  alerts.push('Auto loan statement');
  if (/nearing\s+(?:end|payoff)|final\s+payment/i.test(text)) alerts.push('Nearing end of loan');
  if (/escrow\s+(?:shortage|deficiency)/i.test(text))     alerts.push('Escrow shortage');
  if (/prepayment\s+penalty/i.test(text))                  alerts.push('Prepayment penalty applies');
  // HOA
  if (/special\s+assessment/i.test(text))                  alerts.push('Special assessment');
  if (/violation\s+(?:fine|fee|notice)/i.test(text))       alerts.push('HOA violation');
  // Solar loan
  if (/solar\s+(?:loan|lease|ppa|power\s+purchase)/i.test(text)) alerts.push('Solar financing statement');

  return {
    providerName,
    serviceAddress,
    accountNumber,
    statementDate,
    dueDate,
    billingPeriodStart,
    billingPeriodEnd,
    amountDue,
    previousBalance,
    // The regex extractor reads the breakdown; a line named for a payment plan
    // is the installment. AI extraction reports it directly.
    // Regex side: a "penalty date" or "after due date" figure when the bill
    // prints one in a recognisable form.
    // The regex side does not attempt the aging table: it is a positional
    // layout, and a wrong bucket is worse than no bucket. AI extraction reads it.
    agingBuckets: null,
    penaltyDate: (() => {
      const m = text.match(/penalty\s*date[^\d]{0,20}(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      if (!m) return null;
      const d = new Date(m[1]);
      return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    })(),
    amountAfterDueDate: (() => {
      const m = text.match(/(?:amount\s+due\s+after|after\s+due\s+date\s+pay)[^$]{0,30}\$\s*([\d,]+\.\d{2})/i);
      return m ? parseFloat(m[1].replace(/,/g, '')) : null;
    })(),
    paymentPlanAmount: Object.entries(chargeBreakdown)
      .find(([label]) => /payment\s*plan|installment|arrears/i.test(label))?.[1] ?? null,
    paymentsReceived,
    currentCharges,
    lateFee,
    usageValue,
    usageUnit,
    ratePlan,
    isPaid,
    utilityType,
    chargeBreakdown: breakdownCount > 0 ? chargeBreakdown : null,
    alerts,
  };
}

// ── Claude AI extraction ───────────────────────────────────────────────────────

/**
 * Why this buffer cannot be sent to the API as a PDF, or null if it can.
 *
 * The API answers an unusable file with "The PDF specified was not valid",
 * which says nothing about which of several very different causes applied —
 * an empty download, an HTML error page saved under a .pdf name, a Drive
 * shortcut rather than the file itself, or a password-protected bill. Checking
 * locally names the cause and costs nothing.
 */
function pdfRejectionReason(buffer: Buffer): string | null {
  if (buffer.length === 0) return 'the file downloaded as 0 bytes';
  // Every PDF begins with %PDF- (allowing for junk bytes some producers emit
  // before the header, which readers tolerate).
  const head = buffer.subarray(0, 1024).toString('latin1');
  if (!head.includes('%PDF-')) {
    return head.trimStart().startsWith('<')
      ? 'the download returned a web page, not a PDF — the Drive link may point at a shortcut or a file you cannot read'
      : 'the file is not a PDF';
  }
  // Deliberately no /Encrypt check. Utility statements very often carry an
  // encryption dictionary with an empty user password — they open fine in any
  // reader, and the API reads them too. Refusing them here on the presence of
  // the keyword downgraded those bills to text extraction before Claude was
  // ever asked, and because that threw "Cannot read …" it matched the fallback
  // pattern and happened silently.
  //
  // A PDF the API genuinely cannot open still falls back, on the API's own
  // answer rather than a guess made locally. The two checks left are ones no
  // request could survive: nothing to send, or not a PDF at all.
  return null;
}

async function extractWithClaude(pdfBuffer: Buffer, filename: string): Promise<ExtractedBillData> {
  const anthropic = getAnthropic();

  const rejection = pdfRejectionReason(pdfBuffer);
  if (rejection) throw new Error(`Cannot read ${filename}: ${rejection}.`);

  // Some producers emit junk bytes before the %PDF- header — City of
  // Imperial's portal prepends a bare newline. Every PDF reader tolerates
  // that; the API's validator does not, and rejects the document as not a
  // valid PDF. That rejection message matches the fallback pattern below in
  // parseBill, so the bill silently dropped to text extraction — which is why
  // the same provider's bills split into cleanly-extracted and garbage rows
  // depending on nothing but which download produced the file. Trim to the
  // header before sending.
  const headerAt = pdfBuffer.indexOf('%PDF-');
  if (headerAt > 0) pdfBuffer = pdfBuffer.subarray(headerAt);

  // Send every PDF as a native document — Claude reads the actual layout,
  // not a text dump that loses column relationships.
  console.log(`[PDFImport] ${filename}: ${Math.round(pdfBuffer.length / 1024)}KB`);

  const content: Anthropic.MessageParam['content'] = [
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: pdfBuffer.toString('base64'),
      },
    } as Anthropic.DocumentBlockParam,
    { type: 'text', text: EXTRACTION_PROMPT },
  ];

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{ role: 'user', content }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';

  // Extract JSON object — Claude may include explanation text or markdown fences.
  // Grab the first {...} block regardless of surrounding text.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude returned no JSON. Response (first 400 chars): ${raw.slice(0, 400)}`);
  }
  const data = JSON.parse(jsonMatch[0]) as ExtractedBillData;

  // Normalise alerts: ensure it's always an array
  if (!Array.isArray(data.alerts)) data.alerts = [];

  return data;
}

// ── Address normalisation ─────────────────────────────────────────────────────

function normalizeAddress(addr: string): string {
  return addr
    .toLowerCase()
    .replace(/\b(street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|court|ct|lane|ln|way|wy|place|pl)\b/g, '')
    .replace(/\b(apt|unit|suite|ste|#)\s*[\w-]+/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAcct(s: string): string {
  return s.replace(/[-\s]/g, '').toLowerCase();
}

function addressMatch(a: string, b: string): boolean {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na || !nb) return false;

  // Extract street number
  const numA = na.match(/^\d+/)?.[0];
  const numB = nb.match(/^\d+/)?.[0];
  if (numA && numB && numA !== numB) return false;  // different street numbers — definitely not same

  // At least 60% of words in the shorter address appear in the longer
  const wordsA = na.split(' ').filter(w => w.length > 2);
  const wordsB = nb.split(' ').filter(w => w.length > 2);
  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longer  = wordsA.length <= wordsB.length ? wordsB : wordsA;
  if (shorter.length === 0) return false;
  const overlap = shorter.filter(w => longer.includes(w)).length;
  return overlap / shorter.length >= 0.6;
}

// ── Matching logic ────────────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  propertyId: string;
  providerName: string;
  accountNumberEnc: string | null;
  property: { address: string; nickname: string | null };
}

export async function matchToAccount(
  extracted: ExtractedBillData,
  userId: string,
): Promise<MatchResult> {
  const accounts = await db.utilityAccount.findMany({
    where: { property: { userId } },
    include: { property: { select: { address: true, nickname: true } } },
  }) as AccountRow[];

  const noMatch: MatchResult = {
    confidence: 'none', method: 'no_match',
    utilityAccountId: null, propertyId: null,
    propertyName: null, providerName: null,
  };

  // ── 1. Account number match (strongest signal) ────────────────────────────
  if (extracted.accountNumber) {
    const normExtracted = normalizeAcct(extracted.accountNumber);
    for (const acct of accounts) {
      if (!acct.accountNumberEnc) continue;
      try {
        const stored = normalizeAcct(decrypt(acct.accountNumberEnc));
        // Substring either way, because bills print the number with varying
        // prefixes and check digits — but only when the shorter side is long
        // enough to identify an account. Without the floor a short stored
        // value matches half the portfolio.
        const shorter = stored.length <= normExtracted.length ? stored : normExtracted;
        const longer = shorter === stored ? normExtracted : stored;
        if (stored === normExtracted || (shorter.length >= 6 && longer.includes(shorter))) {
          return {
            confidence: 'high',
            method: 'account_number',
            utilityAccountId: acct.id,
            propertyId: acct.propertyId,
            propertyName: acct.property.nickname || acct.property.address,
            providerName: acct.providerName,
          };
        }
      } catch { /* decryption failed, skip */ }
    }
  }

  // ── 2. Service address + provider name ────────────────────────────────────
  if (extracted.serviceAddress) {
    const addrMatches: AccountRow[] = [];
    for (const acct of accounts) {
      if (addressMatch(extracted.serviceAddress, acct.property.address)) {
        addrMatches.push(acct);
      }
    }

    if (addrMatches.length > 0) {
      // Also try to match provider name
      if (extracted.providerName) {
        // Shared matcher rather than substring: an account stored as
        // "San Diego Gas & Electric" has to match a bill saying "SDGE".
        const withProvider = addrMatches.filter(a =>
          providersLookAlike(a.providerName, extracted.providerName!)
        );
        if (withProvider.length === 1) {
          const acct = withProvider[0];
          return {
            confidence: 'high',
            method: 'address_and_provider',
            utilityAccountId: acct.id,
            propertyId: acct.propertyId,
            propertyName: acct.property.nickname || acct.property.address,
            providerName: acct.providerName,
          };
        }
        if (withProvider.length > 1) {
          // Multiple — still high confidence, pick first
          const acct = withProvider[0];
          return {
            confidence: 'medium',
            method: 'address_and_provider_ambiguous',
            utilityAccountId: acct.id,
            propertyId: acct.propertyId,
            propertyName: acct.property.nickname || acct.property.address,
            providerName: acct.providerName,
          };
        }
      }

      // Address match only
      if (addrMatches.length === 1) {
        const acct = addrMatches[0];
        return {
          confidence: 'medium',
          method: 'address_only',
          utilityAccountId: acct.id,
          propertyId: acct.propertyId,
          propertyName: acct.property.nickname || acct.property.address,
          providerName: acct.providerName,
        };
      }

      // Multiple address matches — suggest first property but flag for review
      return {
        confidence: 'low',
        method: 'address_multiple',
        utilityAccountId: null,
        propertyId: addrMatches[0].propertyId,
        propertyName: addrMatches[0].property.nickname || addrMatches[0].property.address,
        providerName: extracted.providerName,
      };
    }

    // The bill names a service address and none of the properties are it.
    // That is positive evidence this bill belongs somewhere else, so stop
    // here rather than falling through to the provider-only rule below.
    //
    // Falling through is what moved a whole account's history: with one IID
    // account on file, an IID bill for a different property matched it as
    // "the only IID account", and importing overwrote that account's
    // statements month by month. A wrong guess here silently destroys data,
    // so an unrecognised address must ask rather than assume.
    return {
      ...noMatch,
      method: 'address_not_recognised',
      providerName: extracted.providerName,
    };
  }

  // ── 3. Provider name only (single account for this provider) ──────────────
  if (extracted.providerName) {
    const providerMatches = accounts.filter(a =>
      providersLookAlike(a.providerName, extracted.providerName!)
    );
    if (providerMatches.length === 1) {
      const acct = providerMatches[0];
      // Suggest the property, but leave the account unset. "You have exactly
      // one account with this provider" is not evidence the bill belongs to
      // it — it is equally consistent with a second property you have not
      // added an account for yet. The reviewer confirms; the importer does
      // not decide.
      return {
        confidence: 'low',
        method: 'provider_only',
        utilityAccountId: null,
        propertyId: acct.propertyId,
        propertyName: acct.property.nickname || acct.property.address,
        providerName: acct.providerName,
      };
    }
  }

  // ── 4. Property exists but has no accounts yet ────────────────────────────
  // Check all properties by address — catches the case where a property was
  // added manually but no utility accounts have been set up for it yet.
  if (extracted.serviceAddress) {
    const allProperties = await db.property.findMany({
      where: { userId },
      select: { id: true, address: true, nickname: true },
    });
    for (const prop of allProperties) {
      if (addressMatch(extracted.serviceAddress, prop.address)) {
        return {
          confidence: 'medium',
          method: 'property_exists_no_account',
          utilityAccountId: null,
          propertyId: prop.id,
          propertyName: prop.nickname || prop.address,
          providerName: extracted.providerName,
        };
      }
    }
  }

  return noMatch;
}

/**
 * Repairs a billing period whose year was misread.
 *
 * Bills print the period without a year — "SERVICE PERIOD: 11/19 - 12/19"
 * means Nov 19 to Dec 19 — and an extractor sometimes takes those trailing
 * digits as a year, filing a January 2026 bill under December 2019. The
 * period's month and day are read reliably; it is only the invented year that
 * is wrong, so the repair keeps month and day and takes the year from the
 * bill's own issue date.
 *
 * Only a period ending implausibly far in the PAST is touched. A period
 * ending after the issue date is left alone: insurance premiums and other
 * bills issued in advance legitimately cover time that has not happened yet.
 */
export function repairMisreadPeriodYear(ex: ExtractedBillData): void {
  if (!ex.statementDate || !ex.billingPeriodEnd) return;
  const issued = new Date(ex.statementDate);
  const end = new Date(ex.billingPeriodEnd);
  if (isNaN(issued.getTime()) || isNaN(end.getTime())) return;

  const DAY = 24 * 60 * 60 * 1000;
  // Within 370 days is plausible even for an annual account; beyond that no
  // provider bills, and the gap can only be a misread year.
  if (issued.getTime() - end.getTime() <= 370 * DAY) return;

  const anchor = (d: Date): Date => {
    const sameYear = new Date(Date.UTC(issued.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    // The period ends on or shortly before the bill that reports it, so a
    // date landing after the issue date belongs to the previous year.
    return sameYear.getTime() > issued.getTime() + 5 * DAY
      ? new Date(Date.UTC(issued.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()))
      : sameYear;
  };

  const fixedEnd = anchor(end);
  ex.billingPeriodEnd = fixedEnd.toISOString().slice(0, 10);

  if (ex.billingPeriodStart) {
    const start = new Date(ex.billingPeriodStart);
    if (!isNaN(start.getTime())) {
      let fixedStart = anchor(start);
      // A cycle that crosses New Year starts the year before it ends.
      if (fixedStart.getTime() > fixedEnd.getTime()) {
        fixedStart = new Date(Date.UTC(fixedStart.getUTCFullYear() - 1, fixedStart.getUTCMonth(), fixedStart.getUTCDate()));
      }
      ex.billingPeriodStart = fixedStart.toISOString().slice(0, 10);
    }
  }

  console.warn(
    `[PDFImport] repaired misread billing period year: now covers ` +
    `${ex.billingPeriodStart ?? '?'} → ${ex.billingPeriodEnd} (issued ${ex.statementDate})`
  );
}

/**
 * Copies a payment-plan installment out of the charge breakdown when the
 * extractor did not fill the dedicated field.
 *
 * A City of Brawley bill itemises "Payment Plan 195.27" among its lines. That
 * installment repays months that were not paid, not this month's service, and
 * operating cost can only exclude it if paymentPlanAmount is set — a plan
 * that exists only as a breakdown line is invisible to the split. The bill
 * has already said which line it is; this just reads it.
 */
export function derivePaymentPlanFromBreakdown(ex: ExtractedBillData): void {
  if (ex.paymentPlanAmount != null || !ex.chargeBreakdown) return;
  const PLAN_LINE = /payment\s*plan|installment|arrears\s*(?:payment|repayment)?|payment\s*arrangement|deferred\s*payment/i;
  let plan = 0;
  for (const [label, value] of Object.entries(ex.chargeBreakdown)) {
    if (PLAN_LINE.test(label)) plan += Number(value) || 0;
  }
  if (plan > 0) ex.paymentPlanAmount = Number(plan.toFixed(2));
}

/**
 * Files a past-due / disconnection notice against an account without minting
 * a statement.
 *
 * A notice is not a bill: it demands a balance the real bills already carry,
 * states no service period, and bills nothing new. Imported as a statement it
 * becomes a fake month of spending and counts the same debt twice. What a
 * notice does carry that bills usually do not is an aging table and a
 * shut-off date — exactly what payment prioritisation needs — so those are
 * written onto the account's newest statement at or before the notice date.
 */
export async function applyPastDueNotice(utilityAccountId: string, ex: ExtractedBillData): Promise<boolean> {
  const noticeDate = ex.statementDate ? new Date(ex.statementDate) : new Date();
  const target = await db.statement.findFirst({
    where: { utilityAccountId, statementDate: { lte: noticeDate } },
    orderBy: { statementDate: 'desc' },
  });
  if (!target) return false;

  const raw = (target.rawDataJson ?? {}) as Record<string, unknown>;
  const alerts = new Set<string>([...(Array.isArray(raw.alerts) ? raw.alerts as string[] : []), ...(ex.alerts ?? [])]);
  alerts.add(`Past-due notice ${ex.statementDate ?? ''}`.trim());

  await db.statement.update({
    where: { id: target.id },
    data: {
      ...(ex.agingBuckets ? { agingBuckets: ex.agingBuckets as object } : {}),
      ...(ex.penaltyDate ? { penaltyDate: new Date(ex.penaltyDate) } : {}),
      rawDataJson: { ...raw, alerts: [...alerts] } as object,
    },
  });
  return true;
}

/**
 * Records the payment a bill confirms receiving.
 *
 * Nearly every statement prints the provider's own acknowledgement —
 * "Payments Received, Thank You  $716.10" — which is a payment record in all
 * but name: the provider confirming money arrived during the cycle. It was
 * extracted as paymentsReceived and then discarded, which is why every
 * account shows "Payments (0)" against years of settled bills.
 *
 * The payment is dated by the statement that confirms it (the provider had
 * received it by then) and linked to the newest earlier statement, since a
 * cycle's incoming payment is what settled the previous bill. A marker in the
 * notes makes re-imports update the same record rather than log the payment
 * twice.
 */
export async function recordConfirmedPayment(
  utilityAccountId: string,
  statementId: string,
  ex: ExtractedBillData,
): Promise<void> {
  const amount = Math.abs(Number(ex.paymentsReceived ?? 0));
  if (!amount || amount <= 0.01) return;

  const marker = `[from-statement:${statementId}]`;
  const paymentDate = ex.statementDate ? new Date(ex.statementDate) : new Date();
  const prior = await db.statement.findFirst({
    where: { utilityAccountId, statementDate: { lt: paymentDate }, id: { not: statementId } },
    orderBy: { statementDate: 'desc' },
    select: { id: true },
  });

  const existing = await db.payment.findFirst({
    where: { utilityAccountId, notes: { contains: marker } },
  });

  const data = {
    amount,
    paymentDate,
    status: 'PAID' as const,
    statementId: prior?.id ?? null,
    notes: `Confirmed by the ${ex.statementDate ?? 'imported'} statement ("Payments Received"). ${marker}`,
  };

  if (existing) {
    await db.payment.update({ where: { id: existing.id }, data });
  } else {
    await db.payment.create({ data: { utilityAccountId, ...data } });
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function parseBill(
  buffer: Buffer,
  filename: string,
  userId: string,
  method: 'ai' | 'regex' = 'ai',
): Promise<ParsedBill> {
  let extractedBy: 'ai' | 'text' = method === 'regex' ? 'text' : 'ai';
  let extractionNote: string | undefined;

  try {
    let extracted: ExtractedBillData;
    if (method === 'regex') {
      extracted = await extractWithRegex(buffer, filename);
    } else {
      try {
        extracted = await extractWithClaude(buffer, filename);
      } catch (aiErr) {
        // A PDF the API refuses to open can often still be read locally: the
        // regex extractor runs on the text layer and does not care about
        // encryption flags or producer quirks. Losing the bill entirely is a
        // worse outcome than extracting it less accurately, so fall back
        // rather than fail. Errors that are about credentials or quota are
        // rethrown — retrying those as regex would silently mask a broken key.
        const message = aiErr instanceof Error ? aiErr.message : String(aiErr);
        if (!/not valid|Cannot read |could not be processed|unsupported/i.test(message)) throw aiErr;
        console.warn(`[PDFImport] ${filename}: AI extraction unavailable (${message}) — falling back to text extraction.`);
        // Record the downgrade rather than only logging it. Until now this was
        // a server-side console line, so an import run with AI extraction on
        // could quietly file some bills through the text path — with no charge
        // breakdown, an inferred billing period, and the whole balance read as
        // the month's charge — and nothing on screen said which ones.
        extractedBy = 'text';
        extractionNote = message;
        extracted = await extractWithRegex(buffer, filename);
      }
    }
    // Some bills print no issue date at all — Fallbrook PUD gives only a due
    // date and a service period. Without this, the statement date fell back to
    // the day of import, so thirty statements imported together all read
    // "billed Sep 4" and sorted in arbitrary order. A cycle is billed when it
    // ends; the period end is the honest stand-in.
    if (!extracted.statementDate && extracted.billingPeriodEnd) {
      extracted.statementDate = extracted.billingPeriodEnd;
    }
    repairMisreadPeriodYear(extracted);
    derivePaymentPlanFromBreakdown(extracted);
    const match     = await matchToAccount(extracted, userId);
    return { filename, extracted, match, extractedBy, extractionNote };
  } catch (err) {
    console.error(`[PDFImport] Error parsing ${filename}:`, err instanceof Error ? err.message : err);
    return {
      filename,
      extracted: {
        providerName: null, serviceAddress: null, accountNumber: null,
        statementDate: null, dueDate: null, billingPeriodStart: null,
        billingPeriodEnd: null, amountDue: null, previousBalance: null,
        paymentsReceived: null, currentCharges: null, paymentPlanAmount: null,
        penaltyDate: null, amountAfterDueDate: null, agingBuckets: null,
        lateFee: null, usageValue: null,
        usageUnit: null, ratePlan: null, isPaid: false,
        utilityType: 'other', chargeBreakdown: null, alerts: [],
      },
      match: {
        confidence: 'none', method: 'parse_error',
        utilityAccountId: null, propertyId: null,
        propertyName: null, providerName: null,
      },
      extractedBy,
      extractionNote,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
