/**
 * PDF Import Service
 *
 * Accepts raw PDF buffers, extracts billing data via Claude,
 * then auto-matches to the user's existing utility accounts by
 * account number (primary) or service address + provider name (fallback).
 */
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
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
  return new Anthropic({ apiKey: loadAnthropicKey() });
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

async function extractWithClaude(pdfBuffer: Buffer, filename: string): Promise<ExtractedBillData> {
  const anthropic = getAnthropic();

  // Try text extraction first (fast, cheap)
  let pdfText = '';
  try {
    const parsed = await pdfParse(pdfBuffer);
    pdfText = parsed.text?.trim() || '';
  } catch { /* fall through to vision */ }

  let content: Anthropic.MessageParam['content'];

  // pdf-parse often scrambles columnar layouts: labels appear but values are
  // stripped out. Detect this by checking that dollar amounts appear when
  // "amount due" labels are present — if not, fall back to vision.
  const hasAmountLabels = /amount\s*due|total\s*due|balance\s*due|amount\s*owed/i.test(pdfText);
  const hasDollarValues = /\$\s*[\d,]+\.\d{2}/.test(pdfText);
  const isScrambled     = pdfText.length > 80 && hasAmountLabels && !hasDollarValues;

  if (pdfText.length > 80 && !isScrambled) {
    // Text-based extraction — fast and accurate for digital PDFs
    content = [
      { type: 'text', text: `${EXTRACTION_PROMPT}\n\nDocument text:\n${pdfText.slice(0, 15000)}` },
    ];
  } else {
    // Scanned / image-based PDF, or pdf-parse lost the spatial layout — use vision
    if (isScrambled) {
      console.log(`[PDFImport] ${filename}: columnar layout scrambled by pdf-parse, using Claude vision`);
    } else {
      console.log(`[PDFImport] ${filename}: sparse text (${pdfText.length} chars), using Claude vision`);
    }
    content = [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: pdfBuffer.toString('base64'),
        },
      } as any,
      { type: 'text', text: EXTRACTION_PROMPT },
    ];
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';

  // Strip markdown fences if present
  const jsonStr = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const data = JSON.parse(jsonStr) as ExtractedBillData;

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
): Promise<ParsedBill> {
  try {
    const extracted = await extractWithClaude(buffer, filename);
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
