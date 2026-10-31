/**
 * What a file dropped on Add is, so it reaches the importer that reads it:
 * a utility bill (the bill importer, which also files card statements,
 * service invoices and insurance policies), a property tax bill, a property
 * manager's owner statement, or a loan payment sheet. Read from the PDF's
 * own text first, which costs nothing; a photo, or a PDF whose text says
 * nothing either way, is asked of Claude in one short, metered call. When
 * that is not possible it is treated as a bill, as Add always did.
 */
import Anthropic from '@anthropic-ai/sdk';
import { askClaude, jsonIn, needsJson } from '../ai/models';
import { withAiContext, checkBudget } from '../ai/meter';
import { fileBlockForClaude } from './pdfImportService';

const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;

export type UploadKind = 'bill' | 'tax' | 'manager' | 'loan-sheet';

const TAX = [/property tax/i, /tax collector|treasurer[- ]tax collector|tax assessor|county treasurer/i, /assessor'?s parcel|\bapn\b|parcel (number|no)/i, /(first|second|1st|2nd) installment/i, /secured (property )?tax/i];
const MANAGER = [/owner statement|statement for owner|owner'?s statement/i, /management fee/i, /owner (distribution|disbursement|draw)/i, /(beginning|ending) (cash )?balance/i, /rent (income|collected|received)/i];
const LOAN_SHEET = [/lender/i, /(due (day|date)|grace)/i, /(loan|mortgage)/i, /(payment method|pay(s)? by|mail(ing)? address|zelle|check)/i];

const hits = (text: string, rules: RegExp[]) => rules.filter(r => r.test(text)).length;

/** From the file's name, type and text alone; null when they do not settle it. Pure, for tests. */
export function kindFromText(name: string, mimeType: string, text: string): UploadKind | null {
  if (/\.(csv|xlsx?|numbers)$/i.test(name) || /csv|spreadsheet|excel/i.test(mimeType)) return 'loan-sheet';
  const t = text.slice(0, 8000);
  if (!t.trim()) return null;
  if (hits(t, TAX) >= 2) return 'tax';
  if (hits(t, MANAGER) >= 2) return 'manager';
  if (hits(t, LOAN_SHEET) >= 4 && !/amount due|total due|billing period/i.test(t)) return 'loan-sheet';
  // Anything with bill wording is a bill; the bill importer sorts cards, invoices and policies itself.
  if (/amount due|total due|due date|billing period|statement date|account (number|no)|premium|minimum payment/i.test(t)) return 'bill';
  return null;
}

const PROMPT = `What is this document? Answer ONLY JSON: {"kind": one of "bill" (a utility, phone, insurance, HOA or card bill or statement, or a service invoice), "tax" (a property tax bill from a county), "manager" (a property manager's monthly owner statement), "loan-sheet" (a list of loans with how and when each is paid)}`;

export async function classifyUpload(userId: string, buf: Buffer, name: string, mimeType: string): Promise<UploadKind> {
  let text = '';
  if (/pdf/i.test(mimeType) || buf.subarray(0, 5).toString() === '%PDF-') {
    try { text = (await pdfParse(buf)).text ?? ''; } catch { /* no text layer */ }
  } else if (/text|csv/i.test(mimeType)) text = buf.toString('utf8');
  const known = kindFromText(name, mimeType, text);
  if (known) return known;
  if (!process.env.ANTHROPIC_API_KEY) return 'bill';
  try {
    return await withAiContext({ userId }, async () => {
      await checkBudget('classify-upload');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const { text: answer } = await askClaude(client, {
        label: name, feature: 'classify-upload', maxTokens: 60, check: needsJson, effort: 'low',
        messages: [{ role: 'user', content: [await fileBlockForClaude(buf, name), { type: 'text', text: PROMPT }] }],
      });
      const k = jsonIn(answer)?.kind;
      return (['bill', 'tax', 'manager', 'loan-sheet'] as const).includes(k) ? k : 'bill';
    });
  } catch {
    return 'bill';
  }
}
