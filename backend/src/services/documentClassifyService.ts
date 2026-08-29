/**
 * Document Classify Service
 *
 * Takes a scanned/uploaded PDF (mail, bills, insurance, tax notices, misc)
 * and asks Claude for a category + title + a property address guess, then
 * matches that guess against the user's properties the same way the
 * utility-bill importer does. Anything that doesn't confidently match a
 * property falls back to unlinked (the generic "Documents" bucket).
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';

function loadAnthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  throw new Error('ANTHROPIC_API_KEY not found in environment');
}

function getAnthropic() {
  return new Anthropic({
    apiKey: loadAnthropicKey(),
    defaultHeaders: { 'anthropic-beta': 'pdfs-2024-09-25' },
  });
}

export type DocumentCategory =
  | 'UTILITY' | 'INSURANCE' | 'TAX' | 'LEGAL' | 'HOA' | 'EXPENSE_RECEIPT' | 'LEASE' | 'OTHER';

export interface ClassifiedDocument {
  category:  DocumentCategory;
  title:     string;
  address:   string | null;
  vendor:    string | null;
  documentDate: string | null; // YYYY-MM-DD
}

export interface DocumentMatch {
  confidence:   'high' | 'medium' | 'low' | 'none';
  propertyId:   string | null;
  propertyName: string | null;
}

const CLASSIFY_PROMPT = `You are triaging a piece of scanned physical mail related to a real estate portfolio. It could be a utility bill, insurance notice, property tax assessment, legal/HOA notice, a receipt for a property expense, a lease document, or something else entirely.

Return ONLY valid JSON — no markdown fences, no explanation.

{
  "category": "UTILITY | INSURANCE | TAX | LEGAL | HOA | EXPENSE_RECEIPT | LEASE | OTHER",
  "title": "string — a short human-readable title, e.g. 'SDGE Electric Bill - July 2026' or 'Bamboo Insurance Renewal Notice'",
  "address": "string or null — the property/service address this document relates to, if any is printed on it",
  "vendor": "string or null — the company, court, agency, or person that sent this",
  "documentDate": "YYYY-MM-DD or null — the date printed on the document"
}

Notes:
- HOA notices, city/county correspondence, and lawsuits/notices go under LEGAL unless clearly a HOA due statement (then HOA).
- If nothing on the page points to any specific category, use OTHER.`;

async function classifyWithClaude(pdfBuffer: Buffer): Promise<ClassifiedDocument> {
  const anthropic = getAnthropic();

  const content: Anthropic.MessageParam['content'] = [
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') },
    } as Anthropic.DocumentBlockParam,
    { type: 'text', text: CLASSIFY_PROMPT },
  ];

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude returned no JSON. Response (first 400 chars): ${raw.slice(0, 400)}`);
  const data = JSON.parse(jsonMatch[0]) as ClassifiedDocument;

  const validCategories: DocumentCategory[] = ['UTILITY', 'INSURANCE', 'TAX', 'LEGAL', 'HOA', 'EXPENSE_RECEIPT', 'LEASE', 'OTHER'];
  if (!validCategories.includes(data.category)) data.category = 'OTHER';
  if (!data.title) data.title = 'Scanned document';

  return data;
}

function normalizeAddress(addr: string): string {
  return addr
    .toLowerCase()
    .replace(/\b(street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|court|ct|lane|ln|way|wy|place|pl)\b/g, '')
    .replace(/\b(apt|unit|suite|ste|#)\s*[\w-]+/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function addressMatch(a: string, b: string): boolean {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na || !nb) return false;
  const numA = na.match(/^\d+/)?.[0];
  const numB = nb.match(/^\d+/)?.[0];
  if (numA && numB && numA !== numB) return false;
  const wordsA = na.split(' ').filter(w => w.length > 2);
  const wordsB = nb.split(' ').filter(w => w.length > 2);
  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longer  = wordsA.length <= wordsB.length ? wordsB : wordsA;
  if (shorter.length === 0) return false;
  const overlap = shorter.filter(w => longer.includes(w)).length;
  return overlap / shorter.length >= 0.6;
}

async function matchProperty(address: string | null, userId: string): Promise<DocumentMatch> {
  const noMatch: DocumentMatch = { confidence: 'none', propertyId: null, propertyName: null };
  if (!address) return noMatch;

  const properties = await db.property.findMany({
    where: { userId },
    select: { id: true, address: true, nickname: true },
  });

  const matches = properties.filter(p => addressMatch(address, p.address));
  if (matches.length === 1) {
    return { confidence: 'high', propertyId: matches[0].id, propertyName: matches[0].nickname || matches[0].address };
  }
  if (matches.length > 1) {
    return { confidence: 'low', propertyId: matches[0].id, propertyName: matches[0].nickname || matches[0].address };
  }
  return noMatch;
}

export async function classifyDocument(
  buffer: Buffer,
  userId: string,
): Promise<{ classified: ClassifiedDocument; match: DocumentMatch }> {
  const classified = await classifyWithClaude(buffer);
  const match = await matchProperty(classified.address, userId);
  return { classified, match };
}
