import Anthropic from '@anthropic-ai/sdk';
import { askClaude, jsonIn, needsJson } from '../ai/models';
import fs from 'fs';
import path from 'path';

// Reuse the same key-loading approach as pdfImportService — reliable
// regardless of cwd or module context.
function loadAnthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../backend/.env'),
  ];
  for (const envPath of candidates) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      const match = content.match(/^ANTHROPIC_API_KEY\s*=\s*(.+)$/m);
      if (match?.[1]?.trim()) return match[1].trim().replace(/^["']|["']$/g, '');
    } catch { /* try next */ }
  }
  throw new Error('ANTHROPIC_API_KEY is not configured');
}

export interface LeasePerson {
  fullName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}

/** One change of rent written into the lease, after the first rent. */
export interface RentStep {
  effectiveDate: string;          // YYYY-MM-DD
  amount: number | null;          // the new monthly rent, when stated
  percent: number | null;         // or the increase, when stated as a percent
  recurring: boolean;             // "then 6% every year thereafter"
  note: string | null;
}

/** A utility the tenant pays the landlord monthly on top of rent. */
export interface UtilityChargeTerm {
  category: string;               // WATER | ELECTRIC | GAS | SEWER | TRASH | INTERNET | OTHER
  amount: number;
  note: string | null;
}

/** Everything else worth knowing from the agreement, kept as the lease's summary. */
export interface LeaseDetails {
  leaseDate: string | null;
  premises: string | null;
  unitLabel: string | null;
  use: string | null;
  landlord: { name: string | null; signer: string | null; payTo: string | null; payToAddress: string | null; phone: string | null; email: string | null } | null;
  guarantors: LeasePerson[];
  depositIncreasesWithRent: boolean | null;
  lateInterestPercent: number | null;
  nsfFee: number | null;
  utilities: string | null;
  operatingExpenses: string | null;
  propertyTaxes: string | null;
  maintenance: string | null;
  insurance: string | null;
  parking: string | null;
  storage: string | null;
  earlyPossession: string | null;
  renewal: string | null;
  afterTerm: string | null;
  condition: string | null;
  moveInCosts: { label: string; amount: number; dueDate: string | null }[];
  otherTerms: string[];
}

export interface ExtractedLeaseTerms {
  startDate: string | null;      // YYYY-MM-DD
  endDate: string | null;        // YYYY-MM-DD, null for month-to-month
  rentAmount: number | null;     // the first monthly rent of the term
  firstMonthRent: number | null; // rent for a partial first month, when the lease states or shows it
  securityDeposit: number | null;
  leaseType: 'FIXED_TERM' | 'MONTH_TO_MONTH' | null;
  rentDueDay: number | null;     // 1-31
  lateFeeAmount: number | null;
  lateFeePercent: number | null;
  lateFeeGraceDays: number | null;
  tenantNames: string[];
  tenants: LeasePerson[];
  businessName: string | null;
  rentSchedule: RentStep[];
  utilityCharges: UtilityChargeTerm[];
  details: LeaseDetails;
  notes: string | null;
}

const PROMPT = `You are reading a residential or commercial LEASE AGREEMENT (often a filled-in form such as the C.A.R. Commercial or Residential Lease, possibly scanned, with addenda). Read every page, including handwritten or typed-in blanks, checked boxes, small print typed into the margins, and addenda. Return ONLY a JSON object with these exact keys:

{
  "startDate": "YYYY-MM-DD or null — the term's commencement date",
  "endDate": "YYYY-MM-DD or null — the date the fixed term ends; null if the lease is month-to-month from the start",
  "leaseType": "FIXED_TERM if there is a fixed term (even if it continues month-to-month after), MONTH_TO_MONTH if not, or null",
  "rentAmount": "number or null — the monthly BASE rent for the FIRST period of the term (rent only, not utilities or other charges)",
  "rentSchedule": [
    { "effectiveDate": "YYYY-MM-DD — when this rent starts", "amount": "number or null — the new monthly base rent if stated", "percent": "number or null — the increase in percent if stated that way", "recurring": "true if it repeats every year after (e.g. 'then 6% each year thereafter'), else false", "note": "short source wording" }
  ],
  "firstMonthRent": "number or null — when the term starts partway through a month, the rent due for that first partial month if the lease states it or its payments table shows it (e.g. 'Rent from 10/15 to 11/30 $9,000' at $6,000/month means $3,000 for October). null if the term starts on the 1st or it is not stated",
  "securityDeposit": "number or null",
  "rentDueDay": "number 1-31 or null — day of month rent is due (e.g. 'payable in advance on the 1st' = 1)",
  "lateFeeAmount": "number or null — flat late fee in dollars",
  "lateFeePercent": "number or null — late fee as a percent of rent",
  "lateFeeGraceDays": "number or null — days after the due date before the late fee applies (e.g. 'not received within 5 calendar days after date due' = 5)",
  "tenants": [ { "fullName": "each PERSON or entity named as Tenant", "email": "string or null", "phone": "string or null", "address": "string or null — their mailing address from the notice or signature section" } ],
  "businessName": "string or null — the business or entity that is the tenant or that the tenant does business as",
  "utilityCharges": [ { "category": "WATER, ELECTRIC, GAS, SEWER, TRASH, INTERNET or OTHER", "amount": "number — dollars per month the tenant pays the LANDLORD for this utility on top of rent", "note": "short note, e.g. 'first six months; then $75'" } ],
  "details": {
    "leaseDate": "YYYY-MM-DD or null — the date of the agreement",
    "premises": "string or null — the premises as described",
    "unitLabel": "string or null — the unit or space name if the premises names one (e.g. 'Storefront', 'Unit B')",
    "use": "string or null — permitted use",
    "landlord": { "name": "string or null", "signer": "string or null — person signing for the landlord, with title", "payTo": "string or null — whom rent is paid to", "payToAddress": "string or null", "phone": "string or null", "email": "string or null" },
    "guarantors": [ { "fullName": "string", "email": "string or null", "phone": "string or null", "address": "string or null" } ],
    "depositIncreasesWithRent": "true, false or null — whether the deposit must increase in proportion to rent increases",
    "lateInterestPercent": "number or null — annual interest on late amounts",
    "nsfFee": "number or null",
    "utilities": "string or null — who pays which utilities and how (account holders, reimbursements)",
    "operatingExpenses": "string or null — tenant's share of operating expenses / CAM, or that it does not apply",
    "propertyTaxes": "string or null — who pays property taxes",
    "maintenance": "string or null — who maintains what, repair limits, replacement duties",
    "insurance": "string or null — required coverage amounts and additional-insured requirements",
    "parking": "string or null",
    "storage": "string or null",
    "earlyPossession": "string or null",
    "renewal": "string or null — renewal / extension / option terms",
    "afterTerm": "string or null — what happens when the term ends (month-to-month, holdover rent, increases)",
    "condition": "string or null — condition of premises and tenant improvements",
    "moveInCosts": [ { "label": "e.g. 'First month rent 10/15–11/30', 'Security deposit'", "amount": "number", "dueDate": "YYYY-MM-DD or null" } ],
    "otherTerms": ["each other notable term or addendum clause in one sentence, especially anything typed in"]
  },
  "notes": "string or null — a 2-4 sentence plain summary of the deal for the owner"
}

Rules:
- Use null (or an empty array) when a value is not stated. Do NOT guess.
- The rent schedule lists every rent change after the first rent: later periods in the base rent section, increases written in "Other" or addenda, and the rent after the fixed term ends. A recurring percent increase is ONE entry with recurring true, dated when it first applies.
- If one utility amount covers several utilities (e.g. "$100 per month for water and trash"), split it evenly across them and say so in each note. Only include utilities the tenant pays to the LANDLORD; utilities the tenant pays the provider directly go in details.utilities.
- Tenants are the parties named as Tenant. For a business tenant, list the person(s) named or signing as tenant, and put the business in businessName. Guarantors go in details.guarantors (a person can be both).
- Dates must be YYYY-MM-DD. Amounts are plain numbers (no $ or commas). Percents are numbers (6 for 6%).
- Return ONLY the JSON object, no explanation.`;

// Read a lease PDF and pull out its terms. Used to pre-fill / suggest lease
// fields when a lease agreement is uploaded — the user confirms before saving.
export async function extractLeaseTerms(pdfBuffer: Buffer, filename: string): Promise<ExtractedLeaseTerms> {
  const anthropic = new Anthropic({
    apiKey: loadAnthropicKey(),
    defaultHeaders: { 'anthropic-beta': 'pdfs-2024-09-25' },
  });

  console.log(`[LeaseExtract] ${filename}: ${Math.round(pdfBuffer.length / 1024)}KB`);

  const { text: raw } = await askClaude(anthropic, {
    label: filename, maxTokens: 8000, check: needsJson,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') },
        } as Anthropic.DocumentBlockParam,
        { type: 'text', text: PROMPT },
      ],
    }],
  });

  const data = jsonIn(raw) as ExtractedLeaseTerms | null;
  if (!data) throw new Error('Could not read lease terms from that document.');
  return normalize(data);
}

const CATEGORIES = ['WATER', 'ELECTRIC', 'GAS', 'SEWER', 'TRASH', 'INTERNET', 'OTHER'];
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const person = (p: any): LeasePerson | null => (str(p?.fullName) ? { fullName: str(p.fullName)!, email: str(p.email), phone: str(p.phone), address: str(p.address) } : null);

/** Whatever shape the model returned, the shape callers rely on. */
function normalize(d: any): ExtractedLeaseTerms {
  const det = d.details ?? {};
  const tenants = (Array.isArray(d.tenants) ? d.tenants : []).map(person).filter(Boolean) as LeasePerson[];
  const names = tenants.length ? tenants.map(t => t.fullName) : (Array.isArray(d.tenantNames) ? d.tenantNames.filter((x: unknown) => typeof x === 'string') : []);
  return {
    startDate: day(d.startDate), endDate: day(d.endDate),
    rentAmount: num(d.rentAmount), firstMonthRent: num(d.firstMonthRent), securityDeposit: num(d.securityDeposit),
    leaseType: d.leaseType === 'FIXED_TERM' || d.leaseType === 'MONTH_TO_MONTH' ? d.leaseType : null,
    rentDueDay: (() => { const n = num(d.rentDueDay); return n && n >= 1 && n <= 31 ? Math.round(n) : null; })(),
    lateFeeAmount: num(d.lateFeeAmount), lateFeePercent: num(d.lateFeePercent), lateFeeGraceDays: num(d.lateFeeGraceDays),
    tenantNames: names,
    tenants: tenants.length ? tenants : names.map((n: string) => ({ fullName: n, email: null, phone: null, address: null })),
    businessName: str(d.businessName),
    rentSchedule: (Array.isArray(d.rentSchedule) ? d.rentSchedule : [])
      .map((r: any) => ({ effectiveDate: day(r?.effectiveDate), amount: num(r?.amount), percent: num(r?.percent), recurring: r?.recurring === true, note: str(r?.note) }))
      .filter((r: any) => r.effectiveDate && (r.amount != null || r.percent != null))
      .sort((a: RentStep, b: RentStep) => a.effectiveDate.localeCompare(b.effectiveDate)),
    utilityCharges: (Array.isArray(d.utilityCharges) ? d.utilityCharges : [])
      .map((u: any) => ({ category: CATEGORIES.includes(String(u?.category).toUpperCase()) ? String(u.category).toUpperCase() : 'OTHER', amount: num(u?.amount) ?? 0, note: str(u?.note) }))
      .filter((u: UtilityChargeTerm) => u.amount > 0),
    details: {
      leaseDate: day(det.leaseDate), premises: str(det.premises), unitLabel: str(det.unitLabel), use: str(det.use),
      landlord: det.landlord ? { name: str(det.landlord.name), signer: str(det.landlord.signer), payTo: str(det.landlord.payTo), payToAddress: str(det.landlord.payToAddress), phone: str(det.landlord.phone), email: str(det.landlord.email) } : null,
      guarantors: (Array.isArray(det.guarantors) ? det.guarantors : []).map(person).filter(Boolean) as LeasePerson[],
      depositIncreasesWithRent: typeof det.depositIncreasesWithRent === 'boolean' ? det.depositIncreasesWithRent : null,
      lateInterestPercent: num(det.lateInterestPercent), nsfFee: num(det.nsfFee),
      utilities: str(det.utilities), operatingExpenses: str(det.operatingExpenses), propertyTaxes: str(det.propertyTaxes),
      maintenance: str(det.maintenance), insurance: str(det.insurance), parking: str(det.parking), storage: str(det.storage),
      earlyPossession: str(det.earlyPossession), renewal: str(det.renewal), afterTerm: str(det.afterTerm), condition: str(det.condition),
      moveInCosts: (Array.isArray(det.moveInCosts) ? det.moveInCosts : [])
        .map((m: any) => ({ label: str(m?.label) ?? 'Payment', amount: num(m?.amount) ?? 0, dueDate: day(m?.dueDate) }))
        .filter((m: { amount: number }) => m.amount > 0),
      otherTerms: (Array.isArray(det.otherTerms) ? det.otherTerms : []).map(str).filter(Boolean) as string[],
    },
    notes: str(d.notes),
  };
}
