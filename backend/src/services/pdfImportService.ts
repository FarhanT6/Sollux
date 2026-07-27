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
  "dueDate": "YYYY-MM-DD — payment due date",
  "billingPeriodStart": "YYYY-MM-DD — start of billing period if shown",
  "billingPeriodEnd": "YYYY-MM-DD — end of billing period if shown",
  "amountDue": number or null — total dollar amount currently owed (look for 'Amount Due', 'Total Due', 'Balance Due', 'Please Pay'),
  "previousBalance": number or null — prior balance carried forward,
  "paymentsReceived": number or null — payments or credits applied since last bill,
  "currentCharges": number or null — new charges this period,
  "usageValue": number or null — consumption quantity if applicable (kWh, CCF, gallons, etc.),
  "usageUnit": "string or null — kWh | CCF | therms | gallons | HCF | pickup | other",
  "ratePlan": "string or null — rate schedule, plan name, or tier",
  "isPaid": boolean — true ONLY if balance is $0.00 or document shows 'Paid in Full' / paid stamp,
  "utilityType": "electric | gas | water | sewer | trash | solar | internet | phone | other",
  "chargeBreakdown": { "line item name": dollar_amount, ... } or null — all individual charges listed,
  "alerts": ["string", ...] — notable flags: past due, late fees, NSF, payment plan, high usage, leak, outage credit, SCRA, debt collection notice, legal action warning, etc.
}

Important extraction tips:
- For amountDue: look for the largest prominently displayed dollar amount labeled as due or payable. On debt collection statements it may be labeled 'Current Balance' or 'Total Balance'.
- If this is a debt collection or management statement (not a direct utility bill), still fill in all fields you can find.
- serviceAddress: if multiple addresses appear, pick the one labeled 'Service Address', 'Property Address', or that matches a street address format for a building (not a PO Box).
- accountNumber: include dashes and spaces as they appear; do not normalize.
- statementDate: if not explicit, infer from postmark, billing period end, or document date.`;

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
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
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
  return null;
}

// Search the full text for a label and return the dollar amount near it
function findDollarNear(text: string, labels: RegExp[]): number | null {
  const suffix = '[\\s\\S]{0,80}?\\$?\\s*([\\d,]+\\.\\d{2})';
  for (const label of labels) {
    const m = text.match(new RegExp(label.source + suffix, label.flags));
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

function findDateNear(text: string, labels: RegExp[]): string | null {
  const suffix = '[\\s\\S]{0,60}?(\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}|\\w{3,9}\\s+\\d{1,2},?\\s+\\d{4})';
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

function detectUtilityType(text: string, provider: string | null): ExtractedBillData['utilityType'] {
  const t = (text + ' ' + (provider || '')).toLowerCase();
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

  // Provider name: first non-empty line that looks like a company name
  const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);
  let providerName: string | null = null;
  for (const line of lines.slice(0, 15)) {
    if (line.length < 3 || line.length > 80) continue;
    if (/^\d/.test(line)) continue;             // skip lines starting with numbers
    if (/account|invoice|statement|bill|date|customer/i.test(line)) continue;
    providerName = line;
    break;
  }

  // Service address: labeled "service address" or "property address"
  let serviceAddress: string | null = findTextNear(text, [
    /service\s+address/i, /property\s+address/i, /service\s+location/i, /premises\s+address/i,
  ]);
  // Fallback: look for a line that has a street number pattern after the provider name
  if (!serviceAddress) {
    const addrMatch = text.match(/\b(\d{2,6}\s+[A-Z][a-z]+\s+(?:St|Ave|Blvd|Dr|Rd|Way|Ln|Ct|Pl|Cir|Ter|Trail)[^\n]{0,40})/);
    if (addrMatch) serviceAddress = addrMatch[1].trim();
  }

  // Account number
  const accountNumber: string | null = findTextNear(text, [
    /account\s+(?:number|no\.?|#)/i, /customer\s+(?:number|no\.?|id)/i,
    /reference\s+(?:number|no\.?)/i, /invoice\s+(?:number|no\.?|#)/i,
  ]);

  // Statement date
  const statementDate: string | null = findDateNear(text, [
    /(?:statement|bill|invoice|billing)\s+date/i, /date\s+(?:issued|generated)/i, /billing\s+date/i,
  ]) || findDateNear(text, [/date[:\s]/i]);

  // Due date
  const dueDate: string | null = findDateNear(text, [
    /(?:payment\s+)?due\s+(?:date|by|on)/i, /please\s+pay\s+by/i, /pay\s+by/i,
  ]);

  // Billing period
  let billingPeriodStart: string | null = null;
  let billingPeriodEnd:   string | null = null;
  const periodMatch = text.match(
    /(?:billing|service)\s+period[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w{3,9}\s+\d{1,2},?\s+\d{4})\s*(?:to|through|[-–])\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w{3,9}\s+\d{1,2},?\s+\d{4})/i
  );
  if (periodMatch) {
    billingPeriodStart = parseDate(periodMatch[1]);
    billingPeriodEnd   = parseDate(periodMatch[2]);
  }

  // Financial fields
  const amountDue: number | null = findDollarNear(text, [
    /(?:total\s+)?amount\s+due/i, /total\s+due/i, /balance\s+due/i,
    /please\s+pay/i, /amount\s+enclosed/i, /pay\s+this\s+amount/i, /total\s+balance/i,
  ]);
  const previousBalance: number | null = findDollarNear(text, [
    /previous\s+balance/i, /prior\s+balance/i, /balance\s+forward/i, /balance\s+from\s+last/i,
  ]);
  const paymentsReceived: number | null = findDollarNear(text, [
    /payments?\s+received/i, /payments?\s+&\s+credits?/i, /credits?\s+applied/i,
  ]);
  const currentCharges: number | null = findDollarNear(text, [
    /current\s+charges?/i, /new\s+charges?/i, /charges?\s+this\s+period/i,
  ]);

  // Usage
  let usageValue: number | null = null;
  let usageUnit:  string | null = null;
  const usagePatterns: [RegExp, string][] = [
    [/(\d[\d,]*\.?\d*)\s*kWh/i, 'kWh'],
    [/(\d[\d,]*\.?\d*)\s*CCF/i, 'CCF'],
    [/(\d[\d,]*\.?\d*)\s*therms?/i, 'therms'],
    [/(\d[\d,]*\.?\d*)\s*HCF/i, 'HCF'],
    [/(\d[\d,]*\.?\d*)\s*(?:hundred\s+cubic\s+feet)/i, 'HCF'],
    [/(\d[\d,]*\.?\d*)\s*gallons?/i, 'gallons'],
  ];
  for (const [pattern, unit] of usagePatterns) {
    const m = text.match(pattern);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(n)) { usageValue = n; usageUnit = unit; break; }
    }
  }

  // Rate plan
  const ratePlan: string | null = findTextNear(text, [/rate\s+(?:plan|schedule|class)/i, /tariff/i]);

  // Paid status
  const isPaid = /paid\s+in\s+full|balance\s+is\s+\$?0\.00|\$0\.00\s+(?:due|balance)/i.test(text)
    || (amountDue === 0);

  // Utility type
  const utilityType = detectUtilityType(text, providerName);

  // Charge breakdown: look for lines matching "  Label  $amount"
  const chargeBreakdown: Record<string, number> = {};
  const chargeLineRe = /^(.{3,50}?)\s{2,}\$\s*([\d,]+\.\d{2})$/gm;
  let cm: RegExpExecArray | null;
  let breakdownCount = 0;
  while ((cm = chargeLineRe.exec(text)) !== null && breakdownCount < 20) {
    const label = cm[1].trim();
    const amount = parseFloat(cm[2].replace(/,/g, ''));
    if (!isNaN(amount) && label.length > 2) {
      chargeBreakdown[label] = amount;
      breakdownCount++;
    }
  }

  // Alerts
  const alerts: string[] = [];
  if (/past\s+due/i.test(text)) alerts.push('Past due balance');
  if (/late\s+(?:fee|charge|payment)/i.test(text)) alerts.push('Late fee');
  if (/disconnect|shut.?off|termination/i.test(text)) alerts.push('Disconnect notice');
  if (/leak\s+(?:alert|detect)/i.test(text)) alerts.push('Leak detected');
  if (/high\s+usage/i.test(text)) alerts.push('High usage');
  if (/nsf|returned\s+(?:check|payment)/i.test(text)) alerts.push('Returned payment');
  if (/debt\s+collection|collections?\s+agency/i.test(text)) alerts.push('Debt collection');

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
    paymentsReceived,
    currentCharges,
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

async function extractWithClaude(pdfBuffer: Buffer, filename: string): Promise<ExtractedBillData> {
  const anthropic = getAnthropic();

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
        if (
          stored === normExtracted ||
          stored.includes(normExtracted) ||
          normExtracted.includes(stored)
        ) {
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
        const normProvider = extracted.providerName.toLowerCase();
        const withProvider = addrMatches.filter(a =>
          a.providerName.toLowerCase().includes(normProvider) ||
          normProvider.includes(a.providerName.toLowerCase())
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
  }

  // ── 3. Provider name only (single account for this provider) ──────────────
  if (extracted.providerName) {
    const normProvider = extracted.providerName.toLowerCase();
    const providerMatches = accounts.filter(a =>
      a.providerName.toLowerCase().includes(normProvider) ||
      normProvider.includes(a.providerName.toLowerCase())
    );
    if (providerMatches.length === 1) {
      const acct = providerMatches[0];
      return {
        confidence: 'low',
        method: 'provider_only',
        utilityAccountId: acct.id,
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

// ── Main entry point ──────────────────────────────────────────────────────────

export async function parseBill(
  buffer: Buffer,
  filename: string,
  userId: string,
  method: 'ai' | 'regex' = 'ai',
): Promise<ParsedBill> {
  try {
    const extracted = method === 'regex'
      ? await extractWithRegex(buffer, filename)
      : await extractWithClaude(buffer, filename);
    const match     = await matchToAccount(extracted, userId);
    return { filename, extracted, match };
  } catch (err) {
    console.error(`[PDFImport] Error parsing ${filename}:`, err instanceof Error ? err.message : err);
    return {
      filename,
      extracted: {
        providerName: null, serviceAddress: null, accountNumber: null,
        statementDate: null, dueDate: null, billingPeriodStart: null,
        billingPeriodEnd: null, amountDue: null, previousBalance: null,
        paymentsReceived: null, currentCharges: null, usageValue: null,
        usageUnit: null, ratePlan: null, isPaid: false,
        utilityType: 'other', chargeBreakdown: null, alerts: [],
      },
      match: {
        confidence: 'none', method: 'parse_error',
        utilityAccountId: null, propertyId: null,
        propertyName: null, providerName: null,
      },
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
