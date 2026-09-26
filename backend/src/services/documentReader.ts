/**
 * Reads a document into the fields of the record it belongs to: a city's
 * citation or order to comply, a county property-tax bill, or the receipt
 * for money sent abroad. One document can be several files — a citation
 * photographed page by page on a phone — so every page goes to Claude in
 * one request, and the answer describes the whole document.
 *
 * Nothing is saved here. The caller shows the fields for the owner to check
 * and saves what they confirm.
 */
import Anthropic from '@anthropic-ai/sdk';
import { imageMediaType, trimPdfForClaude } from './pdfImportService';
import { matchProperty, type DocumentMatch } from './documentClassifyService';

export type ReadKind = 'citation' | 'tax_bill' | 'transfer_receipt';

export interface ReadFile { name: string; data: string } // base64

const PROMPTS: Record<ReadKind, string> = {
  citation: `This is a notice about one property from a city, county or fire department: an administrative citation, a code-enforcement warning, an order to comply, a permit, or an inspection notice. The pages may be photos of a folded paper, in any order. Read every page.

Return ONLY valid JSON, no markdown:
{
  "kind": "CITATION | NOTICE | PERMIT | INSPECTION — CITATION when it imposes or threatens a fine as an administrative citation; NOTICE for an order to comply, warning letter or overdue notice that is not itself a citation",
  "title": "short title, e.g. 'Redlands administrative citation — weeds, trash, fence' or 'Hood suppression system overdue'",
  "agency": "issuing department, e.g. 'City of Redlands Code Enforcement', 'Oceanside Fire Department'",
  "caseNumber": "case number or null",
  "referenceNumber": "citation / notice number or null",
  "level": "WARNING | FIRST | SECOND | THIRD | FOURTH | null — for a citation, which level is checked",
  "violationAddress": "the address of the violation or of the property concerned — NOT the mailing address of the person cited",
  "apn": "assessor's parcel number or null",
  "violationDate": "YYYY-MM-DD the violation was observed, or null",
  "issuedDate": "YYYY-MM-DD the citation/notice was issued or dated",
  "dueDate": "YYYY-MM-DD by which the violations must be corrected ('Correction required by', 'Compliance date'); for an order to comply that gives a number of days, the date that many days after the letter date",
  "paymentDueDate": "YYYY-MM-DD by which the fine must be paid, computed from the rule printed ('within 15 days of the date of this citation'), or null",
  "fineAmount": number or null — the total fine ('TOTAL FINE'), or the sum of the per-violation fines, or the checked level's amount; null for a warning or a notice with no fine yet,
  "escalation": "what happens if ignored, in one sentence of the notice's own terms, or null",
  "violations": [{ "code": "code section as printed", "description": "what it says is wrong", "correction": "what must be done", "fine": number or null }],
  "contactName": "officer or contact person, or null",
  "contactPhone": "phone or null",
  "contactEmail": "email or null",
  "notes": "anything else that matters: a required inspection, a contractor of record, how to contest — or null"
}`,
  tax_bill: `This is a property-tax bill, statement or assessment notice from a county or other taxing authority. The pages may be scans or photos. Read every page.

Return ONLY valid JSON, no markdown:
{
  "propertyAddress": "the situs / property address the tax is on — NOT the owner's mailing address",
  "apn": "assessor's parcel number / parcel ID / account number of the parcel",
  "taxYear": "the fiscal or tax year as printed, e.g. '2026-2027' or '2026'",
  "taxingAuthority": "e.g. 'San Diego County Treasurer-Tax Collector', 'Brevard County Tax Collector'",
  "assessedValue": number or null — the net taxable / assessed value,
  "annualTaxAmount": number — the total tax for the year,
  "installment1Amount": number or null,
  "installment1Due": "YYYY-MM-DD or null — the date it is due or becomes delinquent, as printed",
  "installment2Amount": number or null,
  "installment2Due": "YYYY-MM-DD or null",
  "paidStatus": "UNPAID | PAID | PARTIALLY_PAID | DELINQUENT — PAID only when the bill says it is paid",
  "installment1PaidDate": "YYYY-MM-DD or null",
  "installment2PaidDate": "YYYY-MM-DD or null",
  "notes": "exemptions, penalties, special assessments or anything unusual, or null"
}
A bill with a single annual amount (Florida, Texas, West Virginia) reports it as installment1 and leaves installment2 null.`,
  transfer_receipt: `This is a receipt or confirmation for money sent abroad: a bank wire, Remitly, Wise, Western Union, Xoom or similar. Read every page.

Return ONLY valid JSON, no markdown:
{
  "date": "YYYY-MM-DD the money was sent",
  "amountUsd": number — what was sent in US dollars, before fees,
  "feeUsd": number or null — transfer fee in US dollars,
  "exchangeRate": number or null — units of the destination currency per 1 USD,
  "amountLocal": number or null — what the recipient receives in the destination currency,
  "currency": "destination currency code, e.g. 'BDT'",
  "method": "the service or 'Bank wire'",
  "recipient": "who receives it",
  "reference": "confirmation / tracking / reference number, or null",
  "notes": null
}`,
};

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — reading documents needs it.');
    client = new Anthropic({ apiKey });
  }
  return client;
}

async function blockFor(file: ReadFile): Promise<Anthropic.ContentBlockParam> {
  let buf: Buffer = Buffer.from(file.data, 'base64');
  const image = imageMediaType(buf);
  if (image) return { type: 'image', source: { type: 'base64', media_type: image, data: file.data } };
  const at = buf.indexOf('%PDF-');
  if (at < 0) throw new Error(`${file.name} is neither a PDF nor an image.`);
  if (at > 0) buf = buf.subarray(at);
  buf = await trimPdfForClaude(buf, file.name);
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } } as Anthropic.DocumentBlockParam;
}

/** The fields of one document read from all its pages, and the property it concerns. */
export async function readDocument(kind: ReadKind, files: ReadFile[], userId: string): Promise<{ fields: Record<string, any>; match: DocumentMatch | null }> {
  if (!files.length) throw new Error('Add at least one page.');
  if (files.length > 12) throw new Error('At most 12 pages or photos per document.');
  const content: Anthropic.ContentBlockParam[] = [];
  for (const f of files) content.push(await blockFor(f));
  content.push({ type: 'text', text: PROMPTS[kind] });

  const res = await anthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content }],
  });
  const raw = res.content.map(c => (c.type === 'text' ? c.text : '')).join('');
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) throw new Error(`Could not read the document (no fields came back). ${raw.slice(0, 200)}`);
  const fields = shape(kind, JSON.parse(json[0]));

  const address = kind === 'citation' ? fields.violationAddress : kind === 'tax_bill' ? fields.propertyAddress : null;
  const match = address ? await matchProperty(address, userId) : null;
  return { fields, match };
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Normalise what came back so the form gets clean values. Exported for tests. */
export function shape(kind: ReadKind, d: any): Record<string, any> {
  if (kind === 'citation') {
    const violations = Array.isArray(d.violations)
      ? d.violations.map((v: any) => ({ code: str(v?.code), description: str(v?.description), correction: str(v?.correction), fine: num(v?.fine) }))
          .filter((v: any) => v.code || v.description)
      : [];
    const summed = violations.reduce((t: number, v: any) => t + (v.fine ?? 0), 0);
    const kindOk = ['CITATION', 'NOTICE', 'PERMIT', 'INSPECTION'].includes(d.kind) ? d.kind : 'CITATION';
    const level = ['WARNING', 'FIRST', 'SECOND', 'THIRD', 'FOURTH'].includes(d.level) ? d.level : null;
    return {
      kind: kindOk, title: str(d.title) ?? 'Citation', agency: str(d.agency),
      caseNumber: str(d.caseNumber), referenceNumber: str(d.referenceNumber), level,
      violationAddress: str(d.violationAddress), apn: str(d.apn),
      violationDate: day(d.violationDate), issuedDate: day(d.issuedDate), dueDate: day(d.dueDate), paymentDueDate: day(d.paymentDueDate),
      // The printed total wins; the itemised fines stand in when none is printed.
      fineAmount: num(d.fineAmount) ?? (summed > 0 ? Number(summed.toFixed(2)) : null),
      escalation: str(d.escalation), violations,
      contactName: str(d.contactName), contactPhone: str(d.contactPhone), contactEmail: str(d.contactEmail), notes: str(d.notes),
    };
  }
  if (kind === 'tax_bill') {
    const status = ['UNPAID', 'PAID', 'PARTIALLY_PAID', 'DELINQUENT'].includes(d.paidStatus) ? d.paidStatus : 'UNPAID';
    const i1 = num(d.installment1Amount), i2 = num(d.installment2Amount);
    return {
      propertyAddress: str(d.propertyAddress), apn: str(d.apn), taxYear: str(d.taxYear), taxingAuthority: str(d.taxingAuthority),
      assessedValue: num(d.assessedValue),
      annualTaxAmount: num(d.annualTaxAmount) ?? (i1 != null || i2 != null ? Number(((i1 ?? 0) + (i2 ?? 0)).toFixed(2)) : null),
      installment1Amount: i1, installment1Due: day(d.installment1Due), installment2Amount: i2, installment2Due: day(d.installment2Due),
      status, installment1Paid: day(d.installment1PaidDate), installment2Paid: day(d.installment2PaidDate), notes: str(d.notes),
    };
  }
  const amountUsd = num(d.amountUsd), rate = num(d.exchangeRate);
  return {
    date: day(d.date), amountUsd, feeUsd: num(d.feeUsd), exchangeRate: rate,
    amountLocal: num(d.amountLocal) ?? (amountUsd != null && rate != null ? Number((amountUsd * rate).toFixed(2)) : null),
    currency: str(d.currency), method: str(d.method), recipient: str(d.recipient), reference: str(d.reference), notes: str(d.notes),
  };
}
