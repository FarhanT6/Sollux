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

export type ReadKind = 'citation' | 'tax_bill' | 'transfer_receipt' | 'tax_form' | 'card_statement';

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
  tax_form: `This is a US income-tax document: a return (Form 1040, a state return such as California 540 or 540NR, West Virginia IT-140), an information form (1098 mortgage interest, 1098-E, 1099-NEC, 1099-MISC, 1099-INT, 1099-DIV, 1099-K, 1099-R, W-2, K-1), a W-9, an estimated-payment voucher, or a notice from the IRS or a state tax agency. Read every page.

NEVER return a full Social Security number, EIN or ITIN anywhere in the answer — only the last four digits, in tinLast4.

Return ONLY valid JSON, no markdown:
{
  "formType": "1040 | 540 | 540NR | IT-140 | W-9 | W-2 | 1099-NEC | 1099-MISC | 1099-INT | 1099-DIV | 1099-K | 1099-R | 1098 | 1098-E | K-1 | 1040-ES | NOTICE | OTHER — for a state return, the state's form number as printed",
  "taxYear": number — the tax year the form reports (a W-9 has none: the year it was signed),
  "jurisdiction": "FEDERAL, or the two-letter state code for a state form",
  "direction": "FILED for a return the taxpayer filed; RECEIVED for a form sent to the taxpayer (1098, 1099, W-2, K-1, a notice) or a W-9 someone gave the taxpayer; ISSUED for a 1099 or W-9 the taxpayer sent to someone",
  "issuerName": "the lender (1098), payer (1099), employer (W-2), partnership (K-1), agency (notice), or the person / business that filled in the W-9",
  "recipientName": "the borrower / recipient / employee / taxpayer named, or null",
  "businessName": "W-9 line 2 business name, or null",
  "entityType": "W-9 box 3 classification: Individual/sole proprietor, C corporation, S corporation, Partnership, Trust/estate, LLC (C/S/P), Other — or null",
  "tinLast4": "last 4 digits of the TIN of the recipient (1099/1098/W-2) or of the W-9 filer, or null",
  "address": "the W-9 filer's address, or the payer's, or null",
  "propertyAddress": "1098 box 8 address of the property securing the mortgage, or null",
  "amount": number or null — the main figure: 1098 box 1 mortgage interest; 1099-NEC box 1; 1099-MISC box 1 rents or the largest box; 1099-INT box 1; W-2 box 1 wages; a return's total tax; a notice's amount due,
  "federalWithheld": number or null,
  "stateWithheld": number or null,
  "refundOrDue": number or null — on a return: refund as a positive number, amount owed as a negative number,
  "filedDate": "YYYY-MM-DD the return was signed or filed, or null",
  "dueDate": "YYYY-MM-DD for a notice or voucher, or null",
  "boxes": { "Box 1 Mortgage interest": 12345.67, "Box 2 Outstanding principal": 250000, "Box 10 Property tax": 3456.78, … } — every other numbered box that has a value, labelled as printed; never a TIN,
  "notes": "anything that matters — e.g. a notice's reason — or null"
}`,
  card_statement: `This is a credit card statement. Read every page, including every transaction line.

NEVER return a full card number — only its last four digits.

Return ONLY valid JSON, no markdown:
{
  "issuer": "Chase, American Express, Capital One, Citi, Discover, Bank of America, Wells Fargo, US Bank, Barclays, …",
  "cardName": "the product name if printed (Sapphire Preferred, Blue Cash Everyday, Venture X), or null",
  "network": "Visa | Mastercard | American Express | Discover | null",
  "last4": "last 4 digits of the account / card number",
  "cardholderName": "the primary cardholder",
  "periodStart": "YYYY-MM-DD opening date of the billing period",
  "closingDate": "YYYY-MM-DD closing / statement date",
  "dueDate": "YYYY-MM-DD payment due date",
  "previousBalance": number, "paymentsCredits": number — payments and other credits as a positive number,
  "purchases": number, "balanceTransfers": number, "cashAdvances": number, "feesCharged": number, "interestCharged": number,
  "newBalance": number, "minimumPayment": number,
  "creditLimit": number or null, "cashAdvanceLimit": number or null, "availableCredit": number or null,
  "purchaseApr": number or null — percent, e.g. 24.99, "cashAdvanceApr": number or null, "balanceTransferApr": number or null, "penaltyApr": number or null,
  "introApr": number or null — a promotional rate in effect, "introAprType": "PURCHASE | BALANCE_TRANSFER | BOTH | null", "introAprEndDate": "YYYY-MM-DD or null",
  "daysInCycle": number or null,
  "rewardsProgram": "e.g. Chase Ultimate Rewards, Membership Rewards, or null", "rewardsType": "POINTS | MILES | CASHBACK | null",
  "rewardsEarned": number or null — earned this period, "rewardsBalance": number or null — total available,
  "minPayoffMonths": number or null, "minPayoffTotal": number or null — from the 'minimum payment warning' box,
  "authorizedUsers": [{ "name": "…", "last4": "1234" }],
  "transactions": [{ "date": "YYYY-MM-DD transaction date", "postDate": "YYYY-MM-DD or null", "description": "as printed", "merchant": "clean merchant name", "amount": number — positive for a charge, negative for a payment or credit, "kind": "PURCHASE | PAYMENT | CREDIT | FEE | INTEREST | CASH_ADVANCE | BALANCE_TRANSFER", "category": "Groceries | Dining | Gas | Travel | Shopping | Utilities | Home improvement | Insurance | Medical | Subscriptions | Entertainment | Services | Fees & interest | Other", "cardholder": "name when the statement groups by cardholder, else null" }]
}
Transaction dates without a year take the year of the billing period (a December charge on a January statement is the prior year).`,
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
    // A statement lists every transaction; it needs room.
    max_tokens: kind === 'card_statement' ? 32000 : 4096,
    messages: [{ role: 'user', content }],
  });
  const raw = res.content.map(c => (c.type === 'text' ? c.text : '')).join('');
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) throw new Error(`Could not read the document (no fields came back). ${raw.slice(0, 200)}`);
  const fields = shape(kind, JSON.parse(json[0]));

  const address = kind === 'citation' ? fields.violationAddress : kind === 'tax_bill' || kind === 'tax_form' ? fields.propertyAddress : null;
  const match = address ? await matchProperty(address, userId) : null;
  return { fields, match };
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
/** A full SSN / EIN / ITIN never leaves this function: anything shaped like
 *  one is cut to its last four digits. */
export function scrubTin(text: string): string {
  return text
    .replace(/\b\d{3}-\d{2}-(\d{4})\b/g, '•••-••-$1')
    .replace(/\b\d{2}-\d{3}(\d{4})\b/g, '••-•••$1')
    .replace(/\b\d{5}(\d{4})\b/g, '•••••$1');
}
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
  if (kind === 'card_statement') {
    const last4 = typeof d.last4 === 'string' || typeof d.last4 === 'number' ? String(d.last4).replace(/\D/g, '').slice(-4) : null;
    const kinds = ['PURCHASE', 'PAYMENT', 'CREDIT', 'FEE', 'INTEREST', 'CASH_ADVANCE', 'BALANCE_TRANSFER'];
    const txns = Array.isArray(d.transactions) ? d.transactions.map((t: any) => {
      const amount = num(t?.amount);
      const kind = kinds.includes(t?.kind) ? t.kind : amount != null && amount < 0 ? 'CREDIT' : 'PURCHASE';
      // Payments and credits reduce the balance: negative, whatever sign came back.
      const signed = amount == null ? null : ['PAYMENT', 'CREDIT'].includes(kind) ? -Math.abs(amount) : Math.abs(amount);
      return { date: day(t?.date), postDate: day(t?.postDate), description: str(t?.description) ? scrubTin(String(t.description)) : null, merchant: str(t?.merchant), amount: signed, kind, category: str(t?.category), cardholder: str(t?.cardholder) };
    }).filter((t: any) => t.date && t.description && t.amount != null) : [];
    const users = Array.isArray(d.authorizedUsers) ? d.authorizedUsers.map((u: any) => ({ name: str(u?.name), last4: u?.last4 ? String(u.last4).replace(/\D/g, '').slice(-4) : null })).filter((u: any) => u.name) : [];
    const pos = (v: unknown) => { const n = num(v); return n == null ? null : Math.abs(n); };
    return {
      issuer: str(d.issuer), cardName: str(d.cardName), network: str(d.network), last4: last4 && last4.length === 4 ? last4 : null, cardholderName: str(d.cardholderName),
      periodStart: day(d.periodStart), closingDate: day(d.closingDate), dueDate: day(d.dueDate),
      previousBalance: num(d.previousBalance), paymentsCredits: pos(d.paymentsCredits), purchases: pos(d.purchases), balanceTransfers: pos(d.balanceTransfers),
      cashAdvances: pos(d.cashAdvances), feesCharged: pos(d.feesCharged), interestCharged: pos(d.interestCharged), newBalance: num(d.newBalance), minimumPayment: pos(d.minimumPayment),
      creditLimit: pos(d.creditLimit), cashAdvanceLimit: pos(d.cashAdvanceLimit), availableCredit: num(d.availableCredit),
      purchaseApr: pos(d.purchaseApr), cashAdvanceApr: pos(d.cashAdvanceApr), balanceTransferApr: pos(d.balanceTransferApr), penaltyApr: pos(d.penaltyApr),
      introApr: num(d.introApr), introAprType: ['PURCHASE', 'BALANCE_TRANSFER', 'BOTH'].includes(d.introAprType) ? d.introAprType : null, introAprEndDate: day(d.introAprEndDate),
      daysInCycle: num(d.daysInCycle), rewardsProgram: str(d.rewardsProgram), rewardsType: ['POINTS', 'MILES', 'CASHBACK'].includes(d.rewardsType) ? d.rewardsType : null,
      rewardsEarned: num(d.rewardsEarned), rewardsBalance: num(d.rewardsBalance), minPayoffMonths: num(d.minPayoffMonths), minPayoffTotal: num(d.minPayoffTotal),
      authorizedUsers: users, transactions: txns,
    };
  }
  if (kind === 'tax_form') {
    const year = num(d.taxYear);
    const boxes: Record<string, number | string> = {};
    if (d.boxes && typeof d.boxes === 'object') {
      for (const [k, v] of Object.entries(d.boxes)) {
        if (/\b(ssn|tin|ein|itin|social security|identification number)\b/i.test(k)) continue;
        const n = num(v);
        if (n != null) boxes[k] = n;
        else if (typeof v === 'string' && v.trim()) boxes[k] = scrubTin(v.trim());
      }
    }
    const tin = typeof d.tinLast4 === 'string' ? d.tinLast4.replace(/\D/g, '').slice(-4) : null;
    return {
      formType: str(d.formType)?.toUpperCase() ?? 'OTHER',
      taxYear: year && year > 1990 && year < 2100 ? Math.trunc(year) : null,
      jurisdiction: /^[A-Z]{2}$/.test(String(d.jurisdiction ?? '').toUpperCase()) ? String(d.jurisdiction).toUpperCase() : 'FEDERAL',
      direction: ['RECEIVED', 'FILED', 'ISSUED'].includes(d.direction) ? d.direction : 'RECEIVED',
      issuerName: str(d.issuerName), recipientName: str(d.recipientName), businessName: str(d.businessName), entityType: str(d.entityType),
      tinLast4: tin && tin.length === 4 ? tin : null,
      address: str(d.address), propertyAddress: str(d.propertyAddress),
      amount: num(d.amount), federalWithheld: num(d.federalWithheld), stateWithheld: num(d.stateWithheld), refundOrDue: num(d.refundOrDue),
      filedDate: day(d.filedDate), dueDate: day(d.dueDate), boxes,
      notes: d.notes ? scrubTin(String(d.notes)) : null,
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
