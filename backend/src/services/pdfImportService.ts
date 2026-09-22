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
import { syncLoanFromComponents } from './loanComponents';
import { Prisma } from '@prisma/client';

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
  /** The single figure the bill asks to be paid now — its "Total Amount Due"
   *  box — negative when the account is in credit. Kept apart from
   *  amountDue (this period's charges) so the two can be reconciled. */
  statedTotalDue?:    number | null;
  /** Everything owed including what a payment arrangement has deferred
   *  ("Total Account Balance" on an SDG&E bill). */
  totalAccountBalance?: number | null;
  /** What an insurance billing statement says about the policy it bills:
   *  which policy, its coverage term, the term premium, the installment.
   *  A new policy number with a later coverage start is a renewal. */
  insurance?: {
    policyNumber: string | null;
    coverageStart: string | null;   // YYYY-MM-DD
    coverageEnd: string | null;
    termPremium: number | null;     // the policy's full premium for the term
    installment: number | null;     // per-installment amount, before service charge
    serviceCharge: number | null;
    installmentsRemaining: number | null;
    renewedOn: string | null;       // date the renewal posted, when the statement says
    /** What is insured — the same shape for every carrier and every kind of
     *  cover, read off a bill, a renewal offer, a declarations page, a
     *  welcome letter or an ID card alike. */
    insuranceType?: 'PROPERTY' | 'AUTO' | 'RENTERS' | 'LIABILITY' | 'FLOOD' | 'UMBRELLA' | 'HEALTH' | 'DENTAL' | 'VISION' | 'LIFE' | 'BUSINESS' | 'OTHER' | null;
    carrier?: string | null;        // the underwriter when it differs from the brand
    autoPay?: boolean | null;       // payments are taken automatically on the dates below
    totalCost?: number | null;      // term premium plus billing fees, when printed
    /** Every installment the document lists, date and amount. */
    paymentSchedule?: { date: string; amount: number; principal?: number | null; interest?: number | null }[] | null;
    /** Vehicles, addresses or people covered, as printed. */
    insuredItems?: string[] | null;
    /** The number was printed under a "Policy Number" label, so it stands
     *  even when it is also the billing account number (Progressive). */
    policyNumberExplicit?: boolean;
  } | null;
  /** A premium finance agreement: a lender (Capital Premium Financing,
   *  IPFS, First Insurance Funding) pays the carrier the term premium and is
   *  repaid in equal monthly payments with interest. Its "Loan Summary"
   *  describes the loan; a "Notice of Acceptance" bills nothing itself. */
  premiumFinance?: {
    lender: string | null;
    loanNumber: string | null;
    totalPremiums: number | null;     // the premiums financed plus the down payment
    amountFinanced: number | null;
    downPayment: number | null;
    financeCharge: number | null;     // total interest over the term
    payment: number | null;           // one monthly payment
    apr: number | null;               // percent
    numberOfPayments: number | null;
    effectiveDate: string | null;     // YYYY-MM-DD
    firstDueDate: string | null;      // YYYY-MM-DD
    loanBalance: number | null;       // payments still to come, as stated
    /** Fees the lender's ledger charged (late fee, convenience fee), each
     *  on its date; a waived fee is listed with a negative amount. */
    fees?: { date: string; amount: number; label: string }[] | null;
  } | null;
  /** The individual loans a servicer bills together on one statement
   *  (a federal student-loan "Account Snapshot": Group AA Direct Subsidized,
   *  Group BB Direct Unsubsidized), each with its own principal and rate. */
  loanGroups?: {
    label: string;                      // "Group AA"
    loanKind: string | null;            // "DIRECT SUB"
    originalPrincipal: number | null;
    outstandingPrincipal: number | null;
    interestRate: number | null;        // percent
    monthlyPayment: number | null;
    accruedInterest: number | null;     // unpaid interest outstanding
    disbursedOn: string | null;         // YYYY-MM-DD
    payoffDate: string | null;          // YYYY-MM-DD
  }[] | null;
  /** A payment arrangement the bill itself reports, as SDG&E's "Pay
   *  Agreement Plan" box does. The remaining balance is owed but not due;
   *  one installment is billed each cycle inside the charges. */
  paymentPlan?: {
    original: number | null;
    remaining: number | null;
    installment: number | null;
    installmentsTotal: number | null;
    installmentsRemaining: number | null;
    began: string | null;
    agreementNumber: string | null;
  } | null;
  /** Payments a running-ledger statement lists one by one (HOA managers
   *  such as Seabreeze / CINC), each on its own date. Recorded as separate
   *  payments rather than one lump "payments received". */
  ledgerPayments?:    { date: string; amount: number; description: string }[] | null;
  /** Net-metering (solar) accounts: energy charges accrue monthly but are
   *  settled once a year at the true-up. `deferred` is the part of this
   *  period's charges not billed now; `ytdBalance` the deferred balance after
   *  this bill. Payable now = amountDue − deferred + previousBalance. */
  netMetering?: {
    deferred: number;
    previousYtd: number | null;
    ytdBalance: number | null;
    trueUpDate: string | null;   // YYYY-MM-DD
    periodStart: string | null;  // YYYY-MM-DD
  } | null;
  // When a late penalty applies, and what the bill becomes then.
  penaltyDate:        string | null;
  amountAfterDueDate: number | null;
  // How the provider ages the balance, when it prints buckets.
  agingBuckets:       { current?: number; days30?: number; days60?: number; days90plus?: number } | null;
  /** 'past_due_notice' when the document is a dunning/disconnection notice
   *  rather than a bill — it demands an existing balance and bills nothing
   *  new, so it must never become a statement row. */
  documentKind?:      'bill' | 'past_due_notice' | 'policy_document';
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
  /** When more than one account could be the bill's, the ones to choose between. */
  candidates?:      { utilityAccountId: string; label: string }[];
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
  "accountNumber": "string or null — the ACCOUNT or customer number. A 'Bill number', 'Statement #' or 'Invoice #' is the bill's own serial and is NOT the account number; if the bill prints no account number, return null rather than the bill number",
  "statementDate": "YYYY-MM-DD — the date the bill itself carries: 'Bill Date', 'Statement Date', 'Invoice Date', 'Date Mailed'. NOT an 'As of' or 'Printed' date — that is the day the copy was generated, often months after the bill (a Tyler 'Bill Detail' reading 'As of 08/13/2026 / Bill Date 6/25/2026' has statementDate 2026-06-25)",
  "dueDate": "YYYY-MM-DD — the date payment for THIS bill is due. Bills often print several other dates: a next meter-read date, a service-period end, a solar/net-metering true-up date, an autopay draft date. None of those are the due date — use only a date explicitly labelled as when payment is due,
  "billingPeriodStart": "YYYY-MM-DD — start of billing period if shown",
  "billingPeriodEnd": "YYYY-MM-DD — end of billing period if shown. Bills often print the period without a year (e.g. \"SERVICE PERIOD: 11/19 - 12/19\" means Nov 19 to Dec 19 — those are days, never years). Take the year from the bill's own issue date: the period ends on or shortly before it, and a cycle that spans New Year starts the year before it ends.",
  "amountDue": number or null — THIS period's charges only, including any late fee or penalty added this period, but EXCLUDING any balance carried forward from earlier bills. If the bill shows only one grand total and that total includes a prior balance, do NOT put the grand total here — put the prior balance in previousBalance and this period's charges here,
  "previousBalance": number or null — how much from EARLIER bills is still unpaid, after applying any payments the bill shows. A CREDIT carried in is a NEGATIVE previousBalance and must be reported: "Previous Balance -$5.30 / Credit Balance -$5.30 / Current Charges +12.94 / Total Amount Due $7.64" → previousBalance -5.30, amountDue 12.94 (the credit is what makes the total 7.64, so dropping it overstates what is owed). If the bill lists 'Previous Balance' then 'Payments Received' then 'Balance Forward', report the Balance Forward figure, not the Previous Balance. Never include this period's charges. Use null, not 0, when nothing is carried forward,
  "paymentsReceived": number or null — payments or credits applied since last bill (enter as a positive number),
  "currentCharges": number or null — what this period BILLED, before any payment or credit is applied. This is the figure to report even when the bill was settled and shows nothing owing: a bill listing Billed $240.03, Payments/Adjustments -$240.03, Due $0.00 has currentCharges 240.03, amountDue 0. Recording only the zero loses what the period actually cost,
  "lateFee": number or null — late fee, penalty, or overdue charge added THIS period. This is a component of amountDue, not the carried-forward balance,
  "usageValue": number or null — consumption quantity if applicable (kWh, CCF, gallons, etc.),
  "usageUnit": "string or null — kWh | CCF | therms | gallons | HCF | pickup | other",
  "ratePlan": "string or null — rate schedule, plan name, or tier",
  "isPaid": boolean — true ONLY if balance is $0.00 or document shows 'Paid in Full' / paid stamp. A bill-detail layout with columns Billed / Payments and adjustments / Due where Due and TOTAL DUE are $0.00 is paid: report currentCharges and amountDue as the Billed figure and isPaid true,
  "utilityType": "electric | gas | water | sewer | trash | solar | internet | phone | other",
  "insurance": object or null — for ANY insurance document, whatever the carrier or kind of cover (auto, homeowners, renters, health, dental, vision, life, umbrella, flood, business) and whatever the document is (billing statement, renewal offer, declarations page, welcome letter, ID card, payment schedule): {"policyNumber": "string", "insuranceType": "PROPERTY | AUTO | RENTERS | LIABILITY | FLOOD | UMBRELLA | HEALTH | DENTAL | VISION | LIFE | BUSINESS | OTHER", "carrier": "underwriter when it differs from the brand, else null", "coverageStart": "YYYY-MM-DD", "coverageEnd": "YYYY-MM-DD", "termPremium": n, "installment": n, "serviceCharge": n, "installmentsRemaining": n, "renewedOn": "YYYY-MM-DD", "autoPay": boolean, "totalCost": n, "paymentSchedule": [{"date": "YYYY-MM-DD", "amount": n}], "insuredItems": ["2022 Land Rover Discovery Sport", ...]}. insuranceType from what is covered (vehicles/VINs → AUTO; a dwelling → PROPERTY; medical/dental/vision plan → HEALTH/DENTAL/VISION). coverageStart/End are the "Policy Period" / "Coverage period" dates. termPremium is the premium for the whole term excluding billing fees ("Your 6-month policy premium excluding billing fees is $2,752.28"; on a billing statement the "Renewal" line or Full Balance). installment is one regular payment; serviceCharge the per-payment installment/billing fee ("We included an installment fee of $4.00 in each payment"); totalCost the term total including fees ("$2,776.28 Total Cost"). paymentSchedule is EVERY dated payment line the document prints ("Automatic Payments Schedule", "Payment schedule", "Your Installment Schedule"), in order, including ones already past. autoPay true when payments are drafted automatically. On a billing statement's policy table ("Policy / Coverage period / Balance / Installment") the policy number is the alphanumeric code on that row. A different policy number with a later coverage start than earlier documents is a renewal onto a new policy,
  "premiumFinance": object or null — ONLY for a premium finance agreement or its notices (a lender such as Capital Premium Financing, IPFS or First Insurance Funding pays the carrier and is repaid monthly with interest; the document has a "Loan Summary" with Amount Financed, Finance Charge, Annual % Rate): {"lender": "Capital Premium Financing", "loanNumber": "string", "totalPremiums": n, "amountFinanced": n, "downPayment": n, "financeCharge": n, "payment": n, "apr": n, "numberOfPayments": n, "effectiveDate": "YYYY-MM-DD", "firstDueDate": "YYYY-MM-DD", "loanBalance": n}. Put the loan number in accountNumber and the lender in providerName. A "Notice of Acceptance" or the agreement itself bills nothing: documentKind 'policy_document', the notice date in statementDate, amountDue and dueDate null. A screenshot of the lender's portal ("Payment Schedule & History" / "Payment History" table with Date, Pmt #, Description, Total, Principal, Interest, Late Charge columns) is the same thing read off a ledger: documentKind 'policy_document'; loanNumber from "Account #"; lender from the page header (Capital Premium Financing); EVERY "Scheduled Payment Due" row into insurance.paymentSchedule as {"date", "amount", "principal", "interest"}; every payment received ("Insured: Installment eCheck", "Installment Credit Card") into ledgerPayments as {"date", "amount", "description"}; every fee row (Late Fee, Convenience Fee, Cancel Fee, NSF Fee) into premiumFinance.fees as {"date", "amount", "label"}, a waived or reversed fee ("($50.00)") as a negative amount; leave amountFinanced, apr and numberOfPayments null when the page does not print them (they are derived from the columns); statementDate is the page's own date if shown, else null,
  "ledgerPayments": array or null — ONLY for a document that lists payments received one by one on their own dates (an HOA ledger, a premium finance portal's payment history): [{"date": "YYYY-MM-DD", "amount": n, "description": "as printed"}]. A single "payments received" figure on an ordinary bill goes in paymentsReceived instead,
  "loanGroups": array or null — ONLY for a loan servicer statement that lists MORE THAN ONE loan under the account (a federal student-loan "Account Snapshot" with columns Group AA / Group BB, or "Loan 1-01 / Loan 1-02"): one entry per loan column, [{"label": "Group AA", "loanKind": "DIRECT SUB", "originalPrincipal": n, "outstandingPrincipal": n, "interestRate": n, "monthlyPayment": n, "accruedInterest": n, "disbursedOn": "YYYY-MM-DD", "payoffDate": "YYYY-MM-DD"}]. Read each column: loanKind from the "Loan Type" row, originalPrincipal from "Original Principal Amount", outstandingPrincipal from "Outstanding Principal Balance", interestRate as a percent from "Interest Rate", monthlyPayment from "Regular Monthly Payment Amount" (the Monthly Payment section, not the Account Snapshot's zeros), accruedInterest from "Accrued Interest" / "Estimated Interest Outstanding", disbursedOn from "First Disbursement Date", payoffDate from "Estimated Payoff Date". A statement for a single loan reports null,
  "statedTotalDue": number or null — the ONE figure the bill asks to be paid now: its "Total Amount Due" / "Amount Due" box. Negative when the account is in credit ("No payment is due. Your account has a credit balance of $0.82" → -0.82). This is the grand total AFTER previous balance, payments, credits and any payment-arrangement deferral; report it exactly as printed,
  "totalAccountBalance": number or null — "Total Account Balance" when printed: everything owed including a balance a payment arrangement has deferred,
  "paymentPlan": object or null — when the bill prints a payment-arrangement box (SDG&E "Pay Agreement Plan": Original Pay Agreement, Down Payment, Installments Billed to Date, Remaining PA Balance, Agreement began, Agreement number, Total Installments, Remaining Installments, Installment amount), report {"original": n, "remaining": n, "installment": n, "installmentsTotal": n, "installmentsRemaining": n, "began": "YYYY-MM-DD", "agreementNumber": "string"}. On such a bill the account summary reads "Previous Balance / Payment Received / Remaining Pay Agreement Balance (subtracted) / Current Charges / Total Amount Due": the Remaining Pay Agreement Balance is NOT past due — it is deferred — so do NOT put it in previousBalance. Report currentCharges as the "Current Charges" line, paymentPlanAmount as the installment amount, statedTotalDue as the Total Amount Due, and leave previousBalance to be derived,
  "paymentPlanAmount": number or null — an installment on an arrears or payment-plan arrangement charged within this bill, when the bill itemises one (a line reading "Payment Plan", "Installment", "Arrears Payment" or similar). This is repayment of an older debt carried inside a current bill, not this period's service, so report it separately as well as leaving it in the total,
  "penaltyDate": "YYYY-MM-DD" or null — the date a penalty or late fee applies if the bill is unpaid, when the bill states one ("Penalty Date", "Late after", "Penalty applies after"). This is often a day or two later than the due date; report what the bill says, not the due date,
  "amountAfterDueDate": number or null — what the bill says is payable if paid after the due date ("Amount due after 09/15/2026", "After Due Date Pay"). The difference between this and the amount due is the late fee this provider will charge,
  "agingBuckets": object or null — when the bill prints an aging table (commonly "Past Due | 30 Days | 60 Days | 90+ Days"), report it as {"current": n, "days30": n, "days60": n, "days90plus": n}, omitting any bucket the bill does not show. Report each bucket's own figure, not a running total,
  "documentKind": "bill | past_due_notice | policy_document — 'policy_document' when the document describes an insurance policy and how it will be billed but does not itself bill a period: a renewal offer ('Your Auto Renewal Is All Set Up'), a welcome letter, a declarations page, an ID card, a payment-schedule notice. For it: fill 'insurance' (above) in full, put the document's own date in statementDate, and leave amountDue, currentCharges, previousBalance and dueDate null — its installments are in insurance.paymentSchedule. 'past_due_notice' ONLY when the document bills nothing new: it demands an already-overdue balance, shows no service period and no new charges. A regular invoice that carries a PAST DUE or suspension banner but also bills a new period's service is a 'bill', never a notice ('PAST DUE STATEMENT', 'FINAL NOTICE', 'service will be locked/disconnected'). For a notice: the demanded amount goes in previousBalance, currentCharges is null, any stated lock-up/disconnection or penalty date goes in penaltyDate, and its aging table in agingBuckets. Everything else is 'bill'",
  "chargeBreakdown": { "line item name": dollar_amount, ... } or null — every individual charge the bill itemises, using the bill's own wording as the key ({"Water": 118.53, "Sewer": 121.50} for a bill splitting the two). Include credits and discounts as negative values. This is how a total is explained later, so itemise whenever the bill does,
  "alerts": ["string", ...] — notable flags: past due, late fees, NSF, payment plan, high usage, leak, outage credit, SCRA, debt collection notice, legal action warning, etc.
}

Important extraction tips:
- For amountDue: look for the largest prominently displayed dollar amount labeled as due or payable. On debt collection statements it may be labeled 'Current Balance' or 'Total Balance'.
- If this is a debt collection or management statement (not a direct utility bill), still fill in all fields you can find.
- serviceAddress: if multiple addresses appear, pick the one labeled 'Service Address', 'Property Address', or that matches a street address format for a building (not a PO Box).
- accountNumber: include dashes and spaces as they appear; do not normalize.
- statementDate: if not explicit, infer from postmark, billing period end, or document date.
- Some statements (HOA management companies such as Seabreeze / CINC) are a running LEDGER: a DATE / DESCRIPTION / CHARGES / CREDITS / BALANCE table opening with BALANCE FORWARD and listing several months of assessments, fees and payments, with a header box giving Billing Date and Amount Due. Read it as follows: amountDue (this period's charges) = the CHARGES dated in the billing-date month (the last dated group, e.g. the 09/01 assessment lines for a Sep 1 billing date); previousBalance = the header's Amount Due MINUS those current charges (the running BALANCE just before them); paymentsReceived = the sum of the CREDITS column; chargeBreakdown = only the current period's lines, never the earlier months' and never the payments; billingPeriodStart/End = the billing-date month. Do NOT add every charge line on the page together — that counts two or three months as one bill.
- Bills printed in two columns often place the prior balance and this period's charges side by side. Read the labels, not the position: a figure next to 'Past Due' is previousBalance even when it sits where current charges usually appear.
- Copy every figure's sign exactly as the bill prints it. A leading minus, a parenthesised amount, or a trailing "CR" all mean negative ("$361.44CR" is -361.44). Never flip a bill's signs to make its lines read like ordinary charges, and never report an absolute value.
- A credit memo is a bill whose CURRENT charges are negative — service cancelled mid-cycle, an over-payment, a refund. Its currentCharges and amountDue are negative, its balance is the negative credit balance, and "Do Not Pay" or "Credit Balance" does NOT mean isPaid. Its chargeBreakdown lines keep their printed signs and must sum to the printed (negative) total.
- Credits are negative, and the sign matters. A bill reading "Total Account Balance -$91.67" or "Your account has a credit balance of $91.67" is money the provider owes you, not money you owe: report amountDue as the negative figure, never its absolute value. Likewise a California Climate Credit or any line that reduces the bill belongs in chargeBreakdown as a negative number. A credit reported as positive turns a refund into a payment demand.
- Carried balance is worded differently by every provider, and missing it makes a two-month bill look like a one-month bill. All of these mean the same thing: "Previous Balance", "Balance Forward", "Amount of Last Bill", "Past Due on <date>", "Previous Amount Due", "Amount Past Due". Report it net of any payment the bill shows against it. On an installment or pre-need plan statement ("Payment Plan Amount Due $913.95 / Amount Past Due $5,483.70 / Total Payment Due $6,397.65"), amountDue is the installment (913.95), previousBalance the past-due figure (5,483.70), and the plan's total sale / current balance goes in totalAccountBalance, never in amountDue. Two worked examples:
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
  // "[\\d,]*" rather than "+": SDG&E prints a sub-dollar credit as "-$.82".
  // "(-?)\\s*\\$?": SoCalGas prints "- $47.34" with a space after the minus.
  const suffix = '[\\s\\S]{0,80}?(-?)\\s*\\$?\\s*(-?)([\\d,]*\\.\\d{2})\\s*(CR)?';
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
  // The spelled-out form must start with a month name: "Due\n073603497319"
  // once matched as a word, two digits and four more, and swallowed the
  // real "Sep 1, 2026" behind it.
  const suffix = '[\\s\\S]{0,60}?(\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-](?:\\d{4}|\\d{2})(?!\\d)|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s*\\d{1,2},?\\s*\\d{4})';
  for (const label of labels) {
    const m = text.match(new RegExp(label.source + suffix, label.flags));
    if (m) {
      // "April20,2026" — pdf-parse drops the spaces on some statements.
      const d = parseDate(m[1].replace(/([A-Za-z])(\d)/, '$1 $2').replace(/,(\d)/, ', $1'));
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

export async function extractWithRegex(pdfBuffer: Buffer, filename: string): Promise<ExtractedBillData> {
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
      // Premium finance
      'Capital Premium Financing','IPFS','First Insurance Funding',
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
  // A bill's own serial ("Bill number 1949585", "Statement #") is not the
  // account. A Tyler "Bill Detail" prints no account number at all, and the
  // bare-digits fallback below used to take the bill number for one — then
  // every re-import was refused as "a bill for account ending 9585".
  const billSerials = new Set<string>();
  for (const m of text.matchAll(/(?:bill|statement|document|receipt)\s+(?:number|no\.?|#)\s*:?\s*(\d{5,20})/gi)) billSerials.add(m[1]);
  if (accountNumber && billSerials.has(accountNumber.replace(/\D/g, ''))) accountNumber = null;
  // Fallback: grouped or contiguous digit strings
  if (!accountNumber) {
    const candidates = scanAccountNumbers(text).filter(c => !billSerials.has(c.replace(/\D/g, '')));
    if (candidates.length > 0) {
      accountNumber = candidates.sort((a, b) => b.length - a.length)[0];
    }
  }
  if (!accountNumber && fnHints.accountHint) {
    accountNumber = fnHints.accountHint;
  }

  // ── Statement date ────────────────────────────────────────────────────────
  // A date the bill labels as its own ("Bill Date", "Statement Date") beats
  // everything else. A date in the filename is next: reliable on garbled
  // PDFs, but on a portal export it is often the day the file was
  // downloaded. "As of" is a print date — a Tyler "Bill Detail" printed on
  // Aug 13 for a bill dated Jun 25 says "As of 08/13/2026" — so it comes
  // last, and only when nothing better is printed.
  let statementDate: string | null = null;
  if (!garbled) {
    // "Date mailed" before "Bill date": an SDG&E statement prints its own
    // DATE MAILED on every page and a CCA supplier's "Bill Date" (the read
    // date) deep inside; the statement is dated by the former.
    statementDate = findDateNear(text, [
      /statement\s+date/i,
      /date\s+(?:issued|generated|prepared|mailed)/i,
      /(?:bill|invoice|billing)\s+date/i,
      /prepared\s+(?:on|date)/i,
      /issued\s+(?:on|date)/i,
    ]);
  }
  if (!statementDate) statementDate = fnHints.date ?? null;
  if (!statementDate && !garbled) {
    statementDate = findDateNear(text, [/effective\s+date/i, /as\s+of(?:\s+date)?/i]) || findDateNear(text, [/^date[:\s]/im]);
  }
  // Carrier billing statements come through with their spaces stripped, so
  // the garbled path never tried the label; "Date prepared" is unambiguous.
  if (!statementDate) statementDate = findDateNear(text, [/date\s*prepared/i, /date\s*mailed/i]);
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
  // Unspaced carrier statements: "Pleasepay$243.23by … 05/09/26".
  if (!dueDate) dueDate = findDateNear(text, [/please\s*pay\s*(?:\$[\d,.]+\s*)?by/i, /pay\s*by/i]);
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
    // The bill's own grand-total line, read tightly so a sentence elsewhere
    // that happens to say "amount due" cannot win over it.
    /total\s+amount\s+due(?=\s*:?\s*-?\$?\s*-?[\d,]*\.\d{2})/i,
    // Dignity Memorial / pre-need plans: "Total Payment Due $6,397.65" is the
    // grand total; "Payment Plan Amount Due $913.95" above it is the
    // installment and must not win as the total.
    /total\s+payment\s+due(?=\s*:?\s*-?\$?\s*-?[\d,]*\.\d{2})/i,
    // Generic
    /(?:total\s+)?amount\s+due/i,
    /please\s*pay\s*\$/i,              // "Please pay $243.23 by …" (carrier statements, often unspaced)
    /minimum\s*amount\s*due/i,
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
  // Tyler Technologies "Bill Detail" (City of El Centro): a table of Billed /
  // Payments and adjustments / Due, whose SUBTOTAL row reads
  // "$390.43 $380.43 $0.00". The charge is the first figure; the second is
  // what was paid against it; "TOTAL DUE $0.00" is not the bill amount.
  const tylerRow = /payments\s+and\s+adjustments/i.test(text)
    ? text.match(/SUBTOTAL\s+\$?([\d,]+\.\d{2})\s+\(?\$?([\d,]+\.\d{2})\)?\s+\$?([\d,]+\.\d{2})/i)
    : null;
  const tyler = tylerRow
    ? { billed: parseFloat(tylerRow[1].replace(/,/g, '')), paid: parseFloat(tylerRow[2].replace(/,/g, '')), due: parseFloat(tylerRow[3].replace(/,/g, '')) }
    : null;
  if (tyler) amountDue = tyler.billed;
  if (amountDue == null) amountDue = guessAmountDue(scanAllAmounts(text));

  // ── Previous balance ──────────────────────────────────────────────────────
  const previousBalance: number | null = findDollarNear(text, [
    /previous\s+balance/i,
    /prior\s+balance/i,
    /balance\s+forward/i,
    /balance\s+from\s+(?:last|previous)/i,
    /(?:last|prior)\s+(?:month['s]?\s+)?balance/i,
    /amount\s+from\s+previous\s+bill/i,
    // SoCalGas: "Amount of Last Bill - $52.60"
    /amount\s+of\s+(?:your\s+)?(?:last|previous)\s+bill/i,
    /(?:last|previous)\s+bill\s+amount/i,
    /previous\s+(?:amount\s+due|charges)/i,
    /(?:outstanding|past\s+due)\s+balance/i,
    /amount\s+past\s+due/i,
  ]);

  // ── Payments received ─────────────────────────────────────────────────────
  // Reported as a positive amount whatever sign the bill prints it with.
  const paymentsReceivedRaw: number | null = findDollarNear(text, [
    /payments?\s+received/i,
    /payments?\s+(?:&|and)\s+(?:adjustments?|credits?)/i,
    /credits?\s+applied/i,
    /payment\s+(?:amount|total|received)/i,
    /(?:last|recent)\s+payment/i,
    /thank\s+you\s+for\s+(?:your\s+)?payment/i,
    /payment\s+posted/i,
    /payment\s+applied/i,
    /auto.?pay\s+(?:amount|payment)/i,
  ]);
  // On a Tyler bill the payment column settles THIS bill (isPaid carries
  // that), not the one before it, so it must not read as a prior-cycle
  // payment.
  const paymentsReceived = tyler ? null : paymentsReceivedRaw != null ? Math.abs(paymentsReceivedRaw) : null;

  // ── Late fee / penalty ────────────────────────────────────────────────────
  const lateFee: number | null = findDollarNear(text, [
    /late\s+fee/i,
    /late\s+(?:payment\s+)?(?:charge|penalty)/i,
    /penalty\s+(?:amount|charge)/i,
    /overdue\s+charge/i,
    /nsf\s+fee/i,
  ]);

  // ── Payment arrangement (SDG&E "Pay Agreement Plan") ──────────────────────
  const paRemainingRaw = findDollarNear(text, [/remaining\s+pa\s+balance/i, /remaining\s+pay\s+agreement\s+balance/i]);
  // The summary prints it subtracted ("- 2,025.11"); the plan box prints it
  // plain. It is a balance either way.
  const paRemaining = paRemainingRaw != null ? Math.abs(paRemainingRaw) : null;
  const paInstallment = findDollarNear(text, [/installment\s+amount/i]);
  const paOriginal = findDollarNear(text, [/original\s+pay\s+agreement/i]);
  const paTotalInst = text.match(/total\s+installments\s*:?\s*(\d{1,3})/i);
  const paRemInst = text.match(/remaining\s+installments\s*:?\s*(\d{1,3})/i);
  const paBegan = findDateNear(text, [/agreement\s+began/i]);
  const paNumber = text.match(/agreement\s+number\s*:?\s*([0-9-]{6,})/i);
  // "Current Balance" under an "Account Balance" heading (Dignity pre-need
  // plans) is the whole contract balance, not this month's payment.
  const totalAccountBalance = findDollarNear(text, [/total\s+account\s+balance/i, /account\s+balance[\s\S]{0,120}?current\s+balance/i]);
  const paymentPlan = paRemaining != null ? {
    original: paOriginal, remaining: paRemaining, installment: paInstallment,
    installmentsTotal: paTotalInst ? Number(paTotalInst[1]) : null,
    installmentsRemaining: paRemInst ? Number(paRemInst[1]) : null,
    began: paBegan, agreementNumber: paNumber ? paNumber[1] : null,
  } : null;

  // ── Insurance billing statement: which policy, which term ─────────────────
  // pdf-parse often strips the spaces from these carrier statements, so the
  // patterns tolerate none. The policy row reads "<type> <start>-$<balance>
  // $<installment>" then "<policy number><end>" on the next line.
  const insurance = (() => {
    if (!/coverage\s*period|policy\s*number|insuring\s*company/i.test(text)) return null;
    // The policy row: "<start>-$<balance>$<installment>" then, on the next
    // line, "<policy number><end>" with no separator at all.
    const row = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*\$?([\d,]*\.\d{2})\s*\$?([\d,]*\.\d{2})[\s\S]{0,60}?([A-Z]{2,6}\d{9,16}?)(?=\s*\d{1,2}\/\d{1,2}\/\d{2,4})\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    const policyNo = row?.[4] ?? text.match(/\b([A-Z]{2,6}\d{9,16}?)(?=\d{1,2}\/\d{1,2}\/|\b)/)?.[1] ?? null;
    const coverageStart = row ? parseDate(row[1]) : null;
    const coverageEnd = row ? parseDate(row[5]) : null;
    const installment = row ? parseFloat(row[3].replace(/,/g, '')) : findDollarNear(text, [/monthly\s*installment/i]);
    const renewal = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*renewal\s*\$?([\d,]*\.\d{2})/i);
    // The term premium is the renewal amount; failing that the full balance,
    // but only when it plainly is a term and not a last installment.
    const fullBalance = findDollarNear(text, [/full\s*balance/i]);
    const termPremium = renewal
      ? parseFloat(renewal[2].replace(/,/g, ''))
      : (fullBalance != null && installment != null && fullBalance > installment * 1.5 ? fullBalance : null);
    // "$6.00 Service Charge" and "Service Charge … $6.00" both occur; either
    // way the figure sits within a few characters of the words.
    const sc = text.match(/\$([\d,]*\.\d{2})\s*service\s*charge/i) ?? text.match(/service\s*charge[^$\n]{0,40}\$([\d,]*\.\d{2})/i);
    const serviceCharge = sc ? parseFloat(sc[1].replace(/,/g, '')) : null;
    const schedule = text.match(/installment\s*schedule[\s\S]{0,1200}/i)?.[0] ?? '';
    const remaining = (schedule.match(/\$[\d,]*\.\d{2}\s*\d{1,2}\/\d{1,2}\/\d{4}/g) ?? []).length || null;
    if (!policyNo && !coverageStart) return null;
    return {
      policyNumber: policyNo, coverageStart, coverageEnd, termPremium, installment, serviceCharge,
      installmentsRemaining: remaining, renewedOn: renewal ? parseDate(renewal[1]) : null,
    };
  })();

  // ── Current charges ───────────────────────────────────────────────────────
  let currentCharges: number | null = findDollarNear(text, [
    /current\s+charges?/i,
    // An installment plan's own line: this period's payment, before arrears.
    /payment\s+plan\s+amount\s+due/i,
    /(?:monthly\s+)?installment\s+(?:amount\s+)?due/i,
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
  if (tyler) currentCharges = tyler.billed;

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
  // "TOTAL DUE $0.00" (Tyler "Bill Detail" exports print Billed, Payments and
  // adjustments, Due — a settled bill shows its charge with nothing owed).
  const isPaid = /paid\s+in\s+full|balance\s+is\s+\$?0\.00|\$0\.00\s+(?:due|balance)|zero\s+balance|no\s+payment\s+due/i.test(text)
    || /total\s+(?:amount\s+)?due\s*:?\s*\$?\s*0\.00(?!\d)/i.test(text)
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
    // The regex path's amountDue is the bill's grand total; keep it as such
    // so the reconciliation below can split it the same way for every path.
    // Unless the bill says outright that nothing is owed: "No payment is
    // due. Your account has a credit balance of $47.34" is a total of
    // −47.34 whatever charge line the label search happened to land on,
    // and so is a negative "Total Account Balance" with no arrangement.
    statedTotalDue: (() => {
      const credit = text.match(/credit\s+balance\s+of\s+-?\$?\s*([\d,]*\.\d{2})/i);
      if (credit) return -parseFloat(credit[1].replace(/,/g, ''));
      if (totalAccountBalance != null && totalAccountBalance < 0 && !paymentPlan) return totalAccountBalance;
      return amountDue;
    })(),
    totalAccountBalance,
    paymentPlan,
    insurance,
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

/** The image type of a scanned or photographed bill, or null for anything else. */
export function imageMediaType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | null {
  const h = buffer.subarray(0, 12);
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg';
  if (h[0] === 0x89 && h.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (h.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  return null;
}

async function extractWithClaude(pdfBuffer: Buffer, filename: string): Promise<ExtractedBillData> {
  const anthropic = getAnthropic();

  // A photographed or scanned bill (JPG, PNG, WebP) is read as an image;
  // the layout is what matters and Claude reads it directly.
  const image = imageMediaType(pdfBuffer);
  if (image) {
    console.log(`[PDFImport] ${filename}: ${image} ${Math.round(pdfBuffer.length / 1024)}KB`);
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: image, data: pdfBuffer.toString('base64') } },
        { type: 'text', text: EXTRACTION_PROMPT },
      ] }],
    });
    const raw = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Claude returned no JSON for ${filename}. Response (first 400 chars): ${raw.slice(0, 400)}`);
    return normaliseExtracted(JSON.parse(jsonMatch[0]), filename);
  }

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
  return normaliseExtracted(JSON.parse(jsonMatch[0]), filename);
}

function normaliseExtracted(data: ExtractedBillData, _filename: string): ExtractedBillData {
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

export function normalizeAcct(s: string): string {
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
  serviceLabel: string | null;
  /** The masked form kept for display ("****9734"); the full number is encrypted. */
  accountNumber: string | null;
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
          // Two SDG&E accounts at one address — a main meter and a unit —
          // and the bill's account number matched neither on file. Picking
          // the first sent every bill for the property to the same account,
          // where it overwrote the other account's statement for the same
          // period. Nothing here can tell them apart; the reviewer can.
          const first = withProvider[0];
          return {
            confidence: 'low',
            method: 'address_and_provider_ambiguous',
            utilityAccountId: null,
            propertyId: first.propertyId,
            propertyName: first.property.nickname || first.property.address,
            providerName: first.providerName,
            candidates: withProvider.map(a => ({
              utilityAccountId: a.id,
              label: [a.serviceLabel, a.accountNumber].filter(Boolean).join(' · ') || a.providerName,
            })),
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
/**
 * A late fee is a small number printed next to a big one. Waste Management
 * writes "a late fee will be assessed on balances unpaid after 12/05 …
 * Total Due $870.53", and the figure nearest the words "late fee" is the
 * bill, not the fee — so an account's fee history showed $870.53, $487.28
 * and $367.75 in months where the real fee was a few dollars or nothing.
 *
 * The bill's own itemisation is the authority when it has one: a line the
 * bill itself calls a late fee or penalty is the fee. Failing that, a fee
 * that matches the bill's total, its current charges, its carried balance
 * or its overall balance is that figure misread, and one larger than the
 * charges it was supposedly added to is not a fee either.
 */
/**
 * This period's charges cannot exceed what the bill asks for. Regex reads
 * "current charges" off whatever number sits nearest the words — on a
 * Fallbrook water bill that was 1,204.31 against a 72.65 bill, and the fees
 * summary then reported a month of water at sixteen times the bill. When
 * the figure is larger than the amount due plus anything carried in, it is
 * not the charges; the amount due less any fee is the honest fallback.
 */
export function sanitiseCurrentCharges(ex: ExtractedBillData): void {
  if (ex.currentCharges == null || ex.amountDue == null) return;
  if (ex.currentCharges < 0 || ex.amountDue < 0) return;   // credit memos keep their signs
  const ceiling = ex.amountDue + Math.max(ex.previousBalance ?? 0, 0) + 0.01;
  if (ex.currentCharges > ceiling) {
    ex.currentCharges = Number(Math.max(ex.amountDue - (ex.lateFee ?? 0), 0).toFixed(2));
  }
}

/**
 * Make the figures agree with the bill's own arithmetic.
 *
 * An SDG&E bill under a pay agreement reads: Previous Balance 1,936.25 ·
 * Payment Received .00 · Remaining Pay Agreement Balance −1,849.03 · Current
 * Charges +281.01 · Total Amount Due 368.23 · Total Account Balance 2,217.26,
 * with an 88.04 installment billed each cycle. Read naively, the 1,849.03
 * became "past due" and the 0.82 credit and the installment vanished, so
 * Sollux said 2,130.04 was owed when the bill asked for 368.23.
 *
 * The identity that holds on every bill is: what is asked for now = this
 * period's charges (installment included) + whatever was carried in (a
 * credit when negative). So when the bill states its total, the carried
 * balance is derived from it rather than read off a line that may include
 * deferred money; and a stated installment joins this period's charges.
 */
export function reconcileWithStatedTotal(ex: ExtractedBillData): void {
  const total = ex.statedTotalDue;
  if (total == null) return;
  const plan = ex.paymentPlan;
  const installment = plan?.installment ?? ex.paymentPlanAmount ?? null;
  // On a net-metering account part of the charge is deferred to the true-up:
  // what the bill asks for now is charge − deferred + carried.
  const deferred = ex.netMetering?.deferred ?? 0;

  if (plan && plan.remaining != null) {
    plan.remaining = Math.abs(plan.remaining);
    // Under an arrangement: charges = current + installment; carried = total − (charges − deferred).
    const current = ex.currentCharges ?? (ex.amountDue != null && installment != null && ex.amountDue > installment ? ex.amountDue - installment : ex.amountDue);
    if (current != null) {
      ex.currentCharges = Number(current.toFixed(2));
      ex.amountDue = Number((current + (installment ?? 0)).toFixed(2));
      ex.paymentPlanAmount = installment;
      ex.previousBalance = Number((total - (ex.amountDue - deferred)).toFixed(2));
      if (ex.totalAccountBalance == null) ex.totalAccountBalance = Number((total + plan.remaining + (ex.netMetering?.ytdBalance ?? 0)).toFixed(2));
    }
    return;
  }

  // A statement with a stated total but no period charge — an insurance
  // installment bill, where nothing reads as a "charge" — still asks for a
  // figure. What it asks for, less anything it says was carried in, is
  // this period's charge; leaving it empty made the bill unpayable.
  if (ex.amountDue == null) {
    const carried = ex.previousBalance ?? 0;
    const derived = Number((total - carried).toFixed(2));
    ex.amountDue = ex.currentCharges ?? (derived !== 0 || carried === 0 ? derived : null);
    if (ex.amountDue != null && ex.previousBalance == null && Math.abs(total - ex.amountDue) > 0.01) {
      ex.previousBalance = Number((total - ex.amountDue).toFixed(2));
    }
    return;
  }

  // No arrangement: the carried balance is what the total does not explain.
  // Only fill a gap or repair a contradiction; a consistent bill is left alone.
  if (ex.amountDue != null) {
    // The text path reads the grand total as amountDue. When the bill's own
    // carried balance and its current charges add up to that total, the
    // charge is the period's charge — not the total. SDG&E: Previous
    // Balance 993.81 + (511.12 − 560.48 deferred) = 944.45.
    if (ex.currentCharges != null && ex.previousBalance != null
        && Math.abs(ex.amountDue - total) < 0.01
        && Math.abs((ex.previousBalance + ex.currentCharges - deferred) - total) < 0.01) {
      ex.amountDue = ex.currentCharges;
      return;
    }
    const payableCharge = ex.amountDue - deferred;
    const derived = Number((total - payableCharge).toFixed(2));
    const stated = ex.previousBalance;
    if (stated == null || Math.abs((stated + payableCharge) - total) > 0.01) {
      // A stated previous balance that does not add up is usually the gross
      // figure before a payment the bill also lists; the derived one is net.
      ex.previousBalance = Math.abs(derived) < 0.005 ? null : derived;
    }
  }
}

/**
 * Keep the account's payment plan in step with what its newest bill says.
 * SDG&E restates the arrangement on every bill — original amount, what is
 * left, how many installments remain — so there is nothing to type in and
 * nothing to fall out of date. Only the newest bill may write it; an older
 * bill imported later must not roll the plan backwards.
 */
export async function syncPaymentPlanFromBill(utilityAccountId: string, ex: ExtractedBillData): Promise<void> {
  const plan = ex.paymentPlan;
  if (!plan || plan.remaining == null) return;
  const billDate = ex.statementDate ? new Date(ex.statementDate) : new Date();
  const newer = await db.statement.findFirst({
    where: { utilityAccountId, statementDate: { gt: billDate }, isDownPayment: false },
    select: { id: true },
  });
  if (newer) return;
  const installment = plan.installment ?? ex.paymentPlanAmount ?? 0;
  const original = plan.original ?? plan.remaining;
  const parts: string[] = [];
  if (plan.agreementNumber) parts.push(`Agreement ${plan.agreementNumber}`);
  if (plan.installmentsRemaining != null && plan.installmentsTotal != null) parts.push(`${plan.installmentsRemaining} of ${plan.installmentsTotal} installments left`);
  parts.push('from the bill');
  const data = {
    totalAmount: original,
    monthlyAmount: installment,
    remainingBalance: plan.remaining,
    startDate: plan.began ? new Date(plan.began) : billDate,
    endDate: plan.installmentsRemaining != null
      ? new Date(billDate.getFullYear(), billDate.getMonth() + plan.installmentsRemaining, billDate.getDate())
      : null,
    description: parts.join(' · '),
    status: plan.remaining <= 0.005 ? 'COMPLETED' as const : 'ACTIVE' as const,
  };
  await db.paymentPlan.upsert({
    where: { utilityAccountId },
    create: { utilityAccountId, ...data },
    update: data,
  });
}

/**
 * How often an installment is paid: from the schedule's spacing when there
 * are several, else from the term when there is one payment for the whole
 * of it. A single $5,069.67 payment on a 12-month policy is annual, not
 * "monthly" as every installment used to be labelled.
 */
function cadenceOf(ins: NonNullable<ExtractedBillData['insurance']>, start: Date | null, end: Date | null): 'MONTHLY' | 'SEMI_ANNUAL' | 'ANNUAL' {
  const sched = (ins.paymentSchedule ?? []).map(p => new Date(p.date).getTime()).sort((a, b) => a - b);
  if (sched.length >= 2) {
    const gaps = sched.slice(1).map((t, i) => (t - sched[i]!) / 86400000);
    const typical = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
    return typical <= 45 ? 'MONTHLY' : typical <= 200 ? 'SEMI_ANNUAL' : 'ANNUAL';
  }
  const termDays = start && end ? (end.getTime() - start.getTime()) / 86400000 : null;
  if (sched.length === 1 || (ins.installmentsRemaining ?? 0) <= 1) {
    return termDays != null && termDays <= 200 ? 'SEMI_ANNUAL' : 'ANNUAL';
  }
  return 'MONTHLY';
}

/**
 * Keep the account's insurance policy in step with what its billing
 * statements say. A carrier's billing account outlives any one policy: the
 * April statement bills the last installment of policy …3130444825
 * (09/09/25–09/09/26) and the August one the first of …3140444825
 * (09/09/26–09/09/27), posted as a "Renewal" of 2,198.00. When the newest
 * statement names a policy the account is not linked to, the old policy is
 * closed at its coverage end and kept as history, and the new one is
 * created and linked with its term, premium and installment. The same
 * policy re-billed merely refreshes those figures.
 */
export async function syncInsurancePolicyFromBill(utilityAccountId: string, ex: ExtractedBillData): Promise<void> {
  const ins = ex.insurance;
  const account = await db.utilityAccount.findUnique({
    where: { id: utilityAccountId },
    select: { id: true, propertyId: true, providerName: true, category: true, insurancePolicy: { select: { id: true, policyNumber: true, effectiveDate: true, expirationDate: true, premiumAmount: true } } },
  });
  if (!account || account.category !== 'INSURANCE') return;
  const billDate = ex.statementDate ? new Date(ex.statementDate) : new Date();
  const newer = await db.statement.findFirst({ where: { utilityAccountId, statementDate: { gt: billDate }, isDownPayment: false }, select: { id: true } });
  if (newer) {
    // An older bill of the current term still knows what the term costs:
    // only the renewal bill prints "Renewal $5,323.00", and a later bill
    // read before that line was understood left the running balance
    // ($4,879.42) standing as the premium. The term premium does not change
    // within a term, so the older bill may correct it.
    const cur = account.insurancePolicy;
    const start = ins?.coverageStart ? new Date(ins.coverageStart) : null;
    if (ins?.termPremium != null && cur?.effectiveDate && start && Math.abs(cur.effectiveDate.getTime() - start.getTime()) < 45 * 86400000) {
      await db.insurancePolicy.update({ where: { id: cur.id }, data: { termPremium: ins.termPremium } });
    }
    return;
  }

  if (!ins || (!ins.policyNumber && !ins.coverageStart)) {
    // A plain premium bill (Blue Shield's monthly dental/health invoice) names
    // no policy number or term. It still says what one payment is and how
    // long it covers, which is all the policy card needs; fill a premium the
    // policy doesn't yet have rather than leaving "$0.00 / annual".
    const current = account.insurancePolicy;
    if (!current || Number(current.premiumAmount) !== 0) return;
    const charge = ex.currentCharges ?? ex.amountDue;
    if (charge == null || charge <= 0) return;
    const s = ex.billingPeriodStart ? new Date(ex.billingPeriodStart) : null;
    const e = ex.billingPeriodEnd ? new Date(ex.billingPeriodEnd) : null;
    const days = s && e ? (e.getTime() - s.getTime()) / 86400000 : null;
    const premiumFrequency = days == null || days <= 45 ? 'MONTHLY' : days <= 200 ? 'SEMI_ANNUAL' : 'ANNUAL';
    await db.insurancePolicy.update({ where: { id: current.id }, data: { premiumAmount: charge, premiumFrequency } });
    return;
  }

  // Carriers' policy numbers are read with drifting letters ("ACP BP01" vs
  // "ACP EP01"); the digits are the identity. The billing account number is
  // never a policy number, and a policy needs a coverage term to be one.
  const norm = (v: string | null | undefined) => (v ?? '').replace(/[^0-9]/g, '');
  const acctDigits = (ex.accountNumber ?? '').replace(/[^0-9]/g, '');
  if (ins.policyNumber && acctDigits && norm(ins.policyNumber) === acctDigits && !ins.policyNumberExplicit) ins.policyNumber = null;
  if (!ins.coverageStart) return;
  const start = ins.coverageStart ? new Date(ins.coverageStart) : null;
  const end = ins.coverageEnd ? new Date(ins.coverageEnd) : null;
  const perInstallment = ins.installment != null ? ins.installment + (ins.serviceCharge ?? 0) : null;
  const figures = {
    ...(ins.policyNumber ? { policyNumber: ins.policyNumber } : {}),
    ...(start ? { effectiveDate: start } : {}),
    ...(end ? { expirationDate: end } : {}),
    ...(ins.termPremium != null ? { termPremium: ins.termPremium } : {}),
    ...(perInstallment != null ? { premiumAmount: perInstallment, premiumFrequency: cadenceOf(ins, start, end) } : {}),
    ...(ins.insuranceType ? { policyType: ins.insuranceType as any } : {}),
    isActive: true,
  };

  const current = account.insurancePolicy;
  const sameTerm = (eff: Date | null) => !!(start && eff && Math.abs(eff.getTime() - start.getTime()) < 45 * 86400000);
  const samePolicy = current && (
    (ins.policyNumber && current.policyNumber && norm(current.policyNumber) === norm(ins.policyNumber))
    || sameTerm(current.effectiveDate)
  );

  if (current && samePolicy) {
    await db.insurancePolicy.update({ where: { id: current.id }, data: figures });
    return;
  }

  // The policy may already exist unlinked — an earlier statement of the same
  // term, or a renewal read twice with different letters. Reuse it rather
  // than minting another.
  const unlinked = await db.insurancePolicy.findMany({ where: { propertyId: account.propertyId, utilityAccountId: null } });
  const twin = unlinked.find(p => (ins.policyNumber && p.policyNumber && norm(p.policyNumber) === norm(ins.policyNumber)) || sameTerm(p.effectiveDate)) ?? null;
  // Only a genuinely later term is a renewal; an older statement of a prior
  // term must not push the current policy aside.
  const isLater = !current?.effectiveDate || (start != null && start.getTime() > current.effectiveDate.getTime() + 45 * 86400000);
  if (current && !isLater) {
    if (twin) await db.insurancePolicy.update({ where: { id: twin.id }, data: { ...figures, isActive: false } });
    return;
  }
  if (current && !samePolicy) {
    // A different policy on the same billing account: the old one has run its
    // term. Close it where its own coverage ended (or where the new one
    // begins), keep it as history, and free the account link for the new one.
    const closedOn = current.expirationDate ?? start ?? billDate;
    await db.insurancePolicy.update({
      where: { id: current.id },
      data: {
        isActive: false, expirationDate: closedOn, utilityAccountId: null,
        notes: `Renewed onto ${ins.policyNumber ?? 'a new policy'}${ins.renewedOn ? ` on ${ins.renewedOn}` : ''} (from the billing statement)`,
      },
    });
  }
  if (twin) {
    await db.insurancePolicy.update({ where: { id: twin.id }, data: { ...figures, utilityAccountId: account.id, carrier: account.providerName } });
    return;
  }
  await db.insurancePolicy.create({
    data: {
      propertyId: account.propertyId,
      utilityAccountId: account.id,
      carrier: account.providerName,
      policyType: (ins.insuranceType as any) ?? 'PROPERTY',
      premiumAmount: perInstallment ?? ins.termPremium ?? 0,
      premiumFrequency: perInstallment != null ? cadenceOf(ins, start, end) : 'ANNUAL',
      ...figures,
      notes: `Created from the ${ex.statementDate ?? ''} billing statement${ins.installmentsRemaining != null ? ` · ${ins.installmentsRemaining} installments remaining` : ''}`,
    },
  });
}

/**
 * Read a multi-loan "Account Snapshot" from the statement text when the
 * model did not. The table has one column per loan ("Group AA  Group BB")
 * and one row per figure; pdf-parse keeps each row on its own line with the
 * columns' values in order. Only tables with two or more loans count.
 */
export function applyLoanGroupsFromText(ex: ExtractedBillData, text: string): void {
  if (ex.loanGroups && ex.loanGroups.length > 0) return;
  const header = text.match(/((?:\bGroup\s+[A-Z]{1,3}\b[ \t]*){2,})/);
  if (!header) return;
  const labels = Array.from(header[1].matchAll(/Group\s+([A-Z]{1,3})/g)).map(m => `Group ${m[1]}`);
  if (labels.length < 2) return;

  const rowValues = (label: RegExp, kind: 'money' | 'pct' | 'date' | 'text'): (string | null)[] => {
    const line = text.split(/\r?\n/).find(l => label.test(l));
    if (!line) return labels.map(() => null);
    const rest = line.replace(label, '');
    const pattern = kind === 'money' ? /-?\$?\s*[\d,]+\.\d{2}/g
      : kind === 'pct' ? /\d+(?:\.\d+)?\s*%/g
      : kind === 'date' ? /\d{1,2}\/\d{1,2}\/\d{2,4}/g
      : /DIRECT\s+(?:UNSUBSIDIZED|UNSUB|SUBSIDIZED|SUB|PLUS|CONSOLIDATION)\b|PARENT\s+PLUS|GRAD\s+PLUS|PERKINS|FFEL\S*|PRIVATE/gi;
    const found = Array.from(rest.matchAll(pattern)).map(m => m[0].trim());
    return labels.map((_, i) => found[i] ?? null);
  };
  const money = (s: string | null) => (s == null ? null : parseFloat(s.replace(/[$,\s]/g, '')));
  const pct = (s: string | null) => (s == null ? null : parseFloat(s.replace(/[%\s]/g, '')));
  const date = (s: string | null) => (s == null ? null : parseDate(s));

  const kinds = rowValues(/^\s*Loan\s+Type/i, 'text');
  const originals = rowValues(/^\s*Original\s+Principal\s+Amount/i, 'money');
  const outstanding = rowValues(/^\s*Outstanding\s+Principal\s+Balance[^$]*/i, 'money');
  const rates = rowValues(/^\s*Interest\s+Rate/i, 'pct');
  const payments = rowValues(/^\s*Regular\s+Monthly\s+Payment\s+Amount/i, 'money');
  const accrued = rowValues(/^\s*(?:Accrued|Estimated)\s+Interest\s+(?:Outstanding)?/i, 'money');
  const disbursed = rowValues(/^\s*First\s+Disbursement\s+Date/i, 'date');
  const payoff = rowValues(/^\s*Estimated\s+Payoff\s+Date/i, 'date');

  const groups = labels.map((label, i) => ({
    label,
    loanKind: kinds[i] ? kinds[i]!.replace(/\s+/g, ' ').toUpperCase() : null,
    originalPrincipal: money(originals[i] ?? null),
    outstandingPrincipal: money(outstanding[i] ?? null),
    interestRate: pct(rates[i] ?? null),
    monthlyPayment: money(payments[i] ?? null),
    accruedInterest: money(accrued[i] ?? null),
    disbursedOn: date(disbursed[i] ?? null),
    payoffDate: date(payoff[i] ?? null),
  }));
  if (groups.some(g => g.originalPrincipal != null || g.outstandingPrincipal != null)) ex.loanGroups = groups;
}

/**
 * Keep the account's linked loan in step with the individual loans its
 * statement lists. Each printed group becomes (or refreshes) a component,
 * matched by label; the parent loan's totals are recomputed from them. An
 * older statement never overwrites what a newer one has already set.
 */
export async function syncLoanComponentsFromBill(utilityAccountId: string, ex: ExtractedBillData): Promise<void> {
  const groups = (ex.loanGroups ?? []).filter(g => g && g.label);
  if (groups.length === 0) return;
  const loan = await db.loan.findUnique({ where: { utilityAccountId }, select: { id: true, components: { select: { id: true, label: true, loanKind: true } } } });
  if (!loan) return;
  const billDate = ex.statementDate ? new Date(ex.statementDate) : new Date();
  const newer = await db.statement.findFirst({ where: { utilityAccountId, statementDate: { gt: billDate }, isDownPayment: false }, select: { id: true } });
  if (newer) return;

  const norm = (s: string | null | undefined) => (s ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  for (const [i, g] of groups.entries()) {
    const figures = {
      ...(g.loanKind ? { loanKind: g.loanKind } : {}),
      ...(g.originalPrincipal != null ? { originalAmount: g.originalPrincipal } : {}),
      ...(g.outstandingPrincipal != null ? { currentBalance: g.outstandingPrincipal } : {}),
      ...(g.interestRate != null ? { interestRate: g.interestRate } : {}),
      ...(g.monthlyPayment != null ? { monthlyPayment: g.monthlyPayment } : {}),
      ...(g.accruedInterest != null ? { accruedInterest: g.accruedInterest } : {}),
      ...(g.disbursedOn ? { originationDate: new Date(g.disbursedOn) } : {}),
      ...(g.payoffDate ? { maturityDate: new Date(g.payoffDate) } : {}),
    };
    const existing = loan.components.find(c => norm(c.label) === norm(g.label))
      ?? loan.components.find(c => g.loanKind && norm(c.loanKind) === norm(g.loanKind) && !groups.some(o => o !== g && norm(o.loanKind) === norm(c.loanKind)));
    if (existing) {
      await db.loanComponent.update({ where: { id: existing.id }, data: figures });
    } else {
      await db.loanComponent.create({ data: { loanId: loan.id, label: g.label, sortOrder: loan.components.length + i, ...figures } });
    }
  }
  await syncLoanFromComponents(loan.id);
}

// ── Insurance policy documents ───────────────────────────────────────────────
// Insurance arrives as more than bills: renewal offers, welcome letters,
// declarations pages, ID cards. They all say the same few things — which
// policy, what it covers, the term, the premium, and when each installment is
// taken — in different words. One reader for all of them, whatever the
// carrier or the kind of cover.

const INSURANCE_KIND_HINTS: [RegExp, NonNullable<NonNullable<ExtractedBillData['insurance']>['insuranceType']>][] = [
  [/\b(?:dental|orthodont)/i, 'DENTAL'],
  [/\bvision\b|\beyewear\b/i, 'VISION'],
  [/\b(?:health|medical)\s+(?:plan|insurance|coverage)|\bhmo\b|\bppo\b|blue\s*shield|kaiser|anthem|aetna|cigna|united\s*health/i, 'HEALTH'],
  [/\blife\s+insurance\b|\bterm\s+life\b|\bwhole\s+life\b|\bbeneficiar/i, 'LIFE'],
  [/business\s*owners?|\bBOP\b/i, 'BUSINESS'],
  [/\bumbrella\b/i, 'UMBRELLA'],
  [/\bflood\b/i, 'FLOOD'],
  [/\brenters?\b/i, 'RENTERS'],
  [/\bauto\b|\bvehicle|\bvin\b|\bdriver|\bcollision\b|\bcomprehensive\b/i, 'AUTO'],
  [/\bhomeowner|\bdwelling\b|\bhome\s+insurance|\bcondo\b|\blandlord\b|\bDP-?[13]\b|\bHO-?[3568]\b/i, 'PROPERTY'],
  [/\bgeneral\s+liability\b|\bliability\s+policy\b/i, 'LIABILITY'],
  [/business\s*owners?|\bcommercial\s+(?:package|property)\b|\bBOP\b|general\s*liability/i, 'BUSINESS'],
];

/** The kind of cover a document describes, from its wording. */
export function inferInsuranceType(text: string): NonNullable<NonNullable<ExtractedBillData['insurance']>['insuranceType']> | null {
  for (const [re, kind] of INSURANCE_KIND_HINTS) if (re.test(text)) return kind;
  return null;
}

/**
 * Fill in the policy from the text when the model did not, or did only in
 * part — and recognise a document that describes the policy rather than
 * billing a period. A Progressive renewal offer reads "Policy Period: Sep 27,
 * 2026 - Mar 27, 2027 … 6-month policy premium excluding billing fees is
 * $2,752.28 … Automatic Payments Schedule … Sep 27, 2026 $467.21 …
 * installment fee of $4.00 in each payment".
 */
export function applyInsuranceFromText(ex: ExtractedBillData, text: string): void {
  // No word boundaries: pdf-parse renders some carriers' statements with the
  // spaces stripped ("PolicyCoverageperiodBalanceInstallment").
  const looksInsurance = /policy\s*(?:number|no\.?|#|period|type)|coverage\s*period|premium|underwritten\s*by|declarations?|insured\b|insuring\s*company|installment\s*schedule/i.test(text);
  if (!looksInsurance) return;
  const ins: NonNullable<ExtractedBillData['insurance']> = {
    policyNumber: null, coverageStart: null, coverageEnd: null, termPremium: null, installment: null,
    serviceCharge: null, installmentsRemaining: null, renewedOn: null,
    ...(ex.insurance ?? {}),
  };
  const money = (s: string) => parseFloat(s.replace(/[$,\s]/g, ''));

  ins.policyNumber ??= text.match(/policy\s*(?:number|no\.?|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\- ]{5,24}?)(?=\s*(?:\n|underwritten|policy\s+period|$))/i)?.[1]?.trim() ?? null;
  const period = text.match(/(?:policy|coverage)\s*period\s*[:\-]?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:-|–|to|through)\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i)
    ?? text.match(/(?:renewal offer is\s+for the policy period|for the policy period)\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\s+through\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i);
  if (period) { ins.coverageStart ??= parseDate(period[1]); ins.coverageEnd ??= parseDate(period[2]); }
  ins.carrier ??= text.match(/underwritten\s+by\s*[:\-]?\s*([A-Z][A-Za-z&.,' ]{3,60}?)(?=\s*\n)/i)?.[1]?.trim() ?? null;
  ins.termPremium ??= (() => {
    const m = text.match(/(\d{1,2})-?\s*month\s+(?:policy\s+)?premium[^$\n]{0,60}\$\s*([\d,]+\.\d{2})/i)
      ?? text.match(/(?:total|term|policy)\s+premium[^$\n]{0,40}\$\s*([\d,]+\.\d{2})/i);
    return m ? money(m[m.length - 1]!) : null;
  })();
  ins.totalCost ??= (() => { const m = text.match(/\$\s*([\d,]+\.\d{2})\s*total\s+cost/i) ?? text.match(/total\s+cost[^$\n]{0,20}\$\s*([\d,]+\.\d{2})/i); return m ? money(m[1]!) : null; })();
  ins.serviceCharge ??= (() => {
    const m = text.match(/(?:installment|billing|service)\s*fee\s*of\s*\$\s*([\d,]+\.\d{2})/i)
      ?? text.match(/includes\s*a\s*\$\s*([\d,]+\.\d{2})\s*(?:installment|billing|service)\s*fee/i)
      ?? text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}\s*\$\s*([\d,]+\.\d{2})\s*installment\s*fee/i);
    return m ? money(m[1]!) : null;
  })();
  ins.autoPay ??= /\bautomatic\s+payments?\b|\bauto-?pay\b|\bEFT\b|\bwill be (?:drafted|withdrawn|deducted)\b/i.test(text) ? true : null;
  ins.insuranceType ??= inferInsuranceType(text);

  if (!ins.paymentSchedule || ins.paymentSchedule.length === 0) {
    // Dated payment lines: "Sep 27, 2026 $467.21", "Oct 27, 2025 .......$408.80",
    // "10/27/2025 $408.80". Read from the schedule block when the document
    // has one, so "$467.21 on September 27, 2026 / $2,776.28 Total Cost" in
    // the prose above it is not taken for a second payment on that date.
    // The block ends at the fee footnote ("*Includes a $8.00 Installment
    // fee", "We included an installment fee") — not at a parenthetical
    // like "(Includes amount from current policy)" under the heading.
    // Only a schedule block counts. Without one, the dated amounts on a
    // bill are its due line, a late-fee line and a payment received — a
    // "schedule" read off those made the $10 late fee the regular installment.
    const block = text.match(/(?:automatic\s*)?payments?\s*schedule[\s\S]{0,2500}?(?=\*\s*includes|we\s*included|installment\s*fee|you\s*may\s*avoid|form\s+[A-Z0-9]+\s*\(|$)/i)?.[0]
      ?? text.match(/(?:installment\s*schedule|upcoming\s*bill\s*installments)[\s\S]{0,2500}?(?=\*\s*includes|installment\s*fee|you\s*may\s*avoid|important\s*messages|$)/i)?.[0]
      ?? '';
    // A leading minus is a payment received, not a payment to come. Dates
    // come before amounts ("Sep 27, 2026 $467.21") or after ("$283.34
    // 03/21/2026", Nationwide's schedule).
    const dateFirst = Array.from(block.matchAll(/([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\s*[.\s…:]*\$\s*([\d,]+\.\d{2})/g)).map(m => ({ d: m[1]!, a: m[2]! }));
    const amountFirst = Array.from(block.matchAll(/\$\s*([\d,]+\.\d{2})\s*(\d{1,2}\/\d{1,2}\/\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/g)).map(m => ({ d: m[2]!, a: m[1]! }));
    const lines = dateFirst.length >= 2 ? dateFirst : amountFirst;
    const seen = new Set<string>();
    const schedule = lines
      .map(m => ({ date: parseDate(m.d), amount: money(m.a) }))
      .filter((x): x is { date: string; amount: number } => !!x.date && x.amount > 0)
      .filter(x => ins.totalCost == null || Math.abs(x.amount - ins.totalCost) > 0.005)
      .filter(x => (seen.has(x.date) ? false : (seen.add(x.date), true)));
    // Keep only a run of at least two — a lone "date $amount" is a due line
    // on a bill, not a schedule.
    if (schedule.length >= 2) ins.paymentSchedule = schedule;
  }
  if (ins.installment == null && ins.paymentSchedule && ins.paymentSchedule.length) {
    // The regular installment is the amount most of the schedule repeats.
    // Schedule amounts include the per-payment fee; `installment` is kept
    // before the fee, as a billing statement's policy row prints it.
    const counts = new Map<number, number>();
    for (const p of ins.paymentSchedule) counts.set(p.amount, (counts.get(p.amount) ?? 0) + 1);
    const usual = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
    ins.installment = Number((usual - (ins.serviceCharge ?? 0)).toFixed(2));
  }
  if (ins.installmentsRemaining == null && ins.paymentSchedule) {
    const today = new Date().toISOString().slice(0, 10);
    ins.installmentsRemaining = ins.paymentSchedule.filter(p => p.date >= today).length || null;
  }
  const vehicles = Array.from(text.matchAll(/\b((?:19|20)\d{2}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z0-9-]+){1,4})\s+[A-HJ-NPR-Z0-9]{17}\b/g)).map(m => m[1]!.trim());
  if ((!ins.insuredItems || ins.insuredItems.length === 0) && vehicles.length) ins.insuredItems = [...new Set(vehicles)];

  // A policy number has letters and digits; "PolicyNumberPolicyType" (a
  // table header read with no spaces) and the billing account number are
  // not it. The policy table row reads "$2,137.50 03/20/26-03/20/27 $213.75
  // 57SBAAZ9S8E Active 12Pay", spaces or not.
  const acctDigits = (ex.accountNumber ?? '').replace(/\D/g, '');
  const wellFormed = (v: string | null | undefined) => !!v && v.length >= 6 && /\d{2}/.test(v) && !/^policy/i.test(v);
  // Printed under its own label ("Policy Number: 863646930") it stands, even
  // when the carrier bills under the same number; found anywhere else, a
  // number that is the billing account's is not the policy's.
  const labelled = text.match(/policy\s*(?:number|no\.?|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9-]{5,20})(?![A-Za-z])/i)?.[1] ?? null;
  const plausible = (v: string | null | undefined) => wellFormed(v) && v!.replace(/\D/g, '') !== acctDigits;
  if (wellFormed(labelled)) {
    ins.policyNumber = labelled!;
    ins.policyNumberExplicit = true;
  } else if (!plausible(ins.policyNumber)) {
    const row = text.match(/\$[\d,]+\.\d{2}\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*\$[\d,]+\.\d{2}\s*([0-9A-Z]{7,16})\s*(?:Active|Past\s*Due|Cancel|Pending|Expired)/i);
    ins.policyNumber = row && plausible(row[3]) ? row[3]! : (plausible(ins.policyNumber) ? ins.policyNumber : null);
    if (row) { ins.coverageStart ??= parseDate(row[1]!); ins.coverageEnd ??= parseDate(row[2]!); }
  }
  {
    // Hartford: "$2,137.50 03/20/26-03/20/27 $213.75 57SBAAZ9S8E Active";
    // Nationwide / Safeco: "05/21/25- 05/21/26 $832.02 $277.34".
    const row = text.match(/\$[\d,]+\.\d{2}\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*\$[\d,]+\.\d{2}\s*[0-9A-Z]{7,16}\s*(?:Active|Past\s*Due|Cancel|Pending|Expired)/i)
      ?? text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*\$\s*[\d,]+\.\d{2}\s*\$\s*[\d,]+\.\d{2}/);
    if (row) { ins.coverageStart ??= parseDate(row[1]!); ins.coverageEnd ??= parseDate(row[2]!); }
  }

  // An installment bill on a policy billed in equal payments (The Hartford's
  // "12Pay"): "Minimum Due" is what this bill asks for, "Balance" is what is
  // left of the policy — owed over the term, not now. Read with no spaces
  // ("MinimumDue", "PayTheMinimumByTheDueDate") as pdf-parse renders it.
  // The same three figures under different words:
  //   Hartford:   "TOTALS $2,145.50 $221.75" / "Pay The Minimum By The Due Date $221.75 05/20/26 15106186 $2,145.50"
  //   Nationwide: "Please pay $283.34 by 02/21/26." / "Current full account balance $838.02" / "Minimum amount due $283.34"
  const first = (...res: RegExp[]) => { for (const re of res) { const m = text.match(re); if (m) return m; } return null; };
  const totals = text.match(/TOTALS\s*\$\s*([\d,]+\.\d{2})\s*\$\s*([\d,]+\.\d{2})/i);
  const stub = text.match(/pay\s*the\s*minimum\s*by\s*the\s*due\s*date\s*\$\s*([\d,]+\.\d{2})\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(\d{6,12})?\s*\$\s*([\d,]+\.\d{2})/i);
  const minM = totals ? { v: totals[2]! } : stub ? { v: stub[1]! } : (() => {
    // "Please pay $449.58 by" first; "Minimum amount due (includes a $6.00
    // Service Charge) $449.58" names the fee before the figure.
    const m = first(/please\s*pay\s*\$\s*([\d,]+\.\d{2})\s*by/i, /minimum\s*(?:amount\s*)?due\s*(?:\([^)]{0,80}\))?\s*:?\s*\$\s*([\d,]+\.\d{2})/i);
    return m ? { v: m[1]! } : null;
  })();
  const balM = totals ? { v: totals[1]! } : stub ? { v: stub[4]! } : (() => {
    const m = first(/current\s*full\s*account\s*balance\s*\$?\s*([\d,]+\.\d{2})/i, /full\s*balance\s*\$?\s*([\d,]+\.\d{2})/i, /account\s*balance\s*\$?\s*([\d,]+\.\d{2})/i);
    return m ? { v: m[1]! } : null;
  })();
  const installmentBill = /minimum\s*(?:amount\s*)?due/i.test(text)
    && /upcoming\s*bill\s*installments|bill\s*plan|installment\s*fee|installment\s*schedule|service\s*charge|monthly\s*installment/i.test(text)
    && minM && balM;
  if (installmentBill) {
    const minimumDue = money(minM!.v);
    const balance = money(balM!.v);
    const due = stub ? parseDate(stub[2]!) : (() => {
      const m = first(/please\s*pay\s*\$\s*[\d,]+\.\d{2}\s*by\s*(?:payment\s*options\s*)?\.?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i, /please\s*pay\s*by\s*([A-Za-z]{3,9}\s*\d{1,2},?\s*\d{4})/i);
      return m ? parseDate(m[1]!) : findDateNear(text, [/due\s*date\s*:?/i]);
    })();
    const fee = ins.serviceCharge ?? 0;
    const sched = ins.paymentSchedule ?? [];
    // A late fee actually charged: a dated transaction line ("05/27/26
    // $35.00 Late Fee") or "Late Fee for Last Payment Due on 02/21/26 …
    // $10.00". "You'll be charged a $35.00 late fee" is a warning, not a fee.
    const lateFee = (() => {
      const m = first(/\d{1,2}\/\d{1,2}\/\d{2,4}\s*\$\s*([\d,]+\.\d{2})\s*late\s*fee/i, /late\s*fee\s*for[^$]{0,120}\$\s*([\d,]+\.\d{2})/i);
      return m ? money(m[1]!) : null;
    })();
    // The regular installment is the amount the upcoming schedule repeats;
    // with no schedule left (the last installment), the minimum less any
    // late fee. A past-due bill's minimum is that plus the missed one.
    const counts = new Map<number, number>();
    for (const p of sched) counts.set(p.amount, (counts.get(p.amount) ?? 0) + 1);
    const regular = counts.size ? [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0] : Number((minimumDue - (lateFee ?? 0)).toFixed(2));
    // Payments received, less any that bounced ("Protested Payment").
    const received = Array.from(text.matchAll(/-\s*\$\s*([\d,]+\.\d{2})\s*payment\s*received/gi)).reduce((t, m) => t + money(m[1]!), 0)
      + Array.from(text.matchAll(/payment\(?s?\)?\s*of\s*\$\s*([\d,]+\.\d{2})\s*received/gi)).reduce((t, m) => t + money(m[1]!), 0)
      - Array.from(text.matchAll(/\$\s*([\d,]+\.\d{2})\s*(?:protested|returned|reversed|nsf)\s*payment/gi)).reduce((t, m) => t + money(m[1]!), 0);
    // The billing account, not the bill's serial number from the remittance
    // line: "Bill Account Number … 15106186", "Billing account 288454435".
    const acct = stub?.[3] ?? first(/billing\s*account\s*(?:number)?\s*:?\s*(\d{6,12})\b/i, /account\s*number\s*:?\s*(\d{6,12})\b/i)?.[1] ?? null;
    if (acct) ex.accountNumber = acct;
    // A term premium is what the policy costs for the term ("Renewal
    // $5,323.00"); the running full balance an earlier read took for it is not.
    const renewal = text.match(/renewal\s*\$?\s*([\d,]+\.\d{2})/i);
    ins.termPremium = renewal ? money(renewal[1]!) : null;
    // What the minimum asks beyond a regular installment is arrears: a missed
    // installment, and the late fee it drew. The fee is this bill's own
    // charge; the missed installment is carried from the bill before.
    const extra = Math.max(0, Number((minimumDue - regular).toFixed(2)));
    const carried = Math.max(0, Number((extra - (lateFee ?? 0)).toFixed(2)));
    const thisBill = Number((minimumDue - carried).toFixed(2));
    ex.documentKind = 'bill';
    ex.statedTotalDue = minimumDue;
    ex.totalAccountBalance = balance;
    // The row is filed under its period charge, and the late fee is this
    // bill's own charge: "Please pay $293.34" is the installment plus the
    // fee. Filing the installment alone showed $283.34 for a bill that
    // asked $293.34, and the fee was only ever visible on the fees tab.
    ex.currentCharges = thisBill;
    ex.amountDue = thisBill;
    // Zero, not null: a re-import must clear a carried figure an earlier
    // read put there (the policy balance, taken for arrears).
    ex.previousBalance = carried;
    ex.lateFee = lateFee;
    ex.paymentsReceived = received > 0 ? Number(received.toFixed(2)) : ex.paymentsReceived ?? null;
    if (due) ex.dueDate = due;
    ex.isPaid = false;
    // One installment covers a month, not the policy's whole term; the bill
    // is filed under the month it was issued, like any other monthly bill.
    ex.billingPeriodStart = null;
    ex.billingPeriodEnd = null;
    // The regular installment before the fee — not "Monthly Installment
    // $293.34" on a past-due bill, which has the late fee inside it.
    ins.installment = Number((regular - fee).toFixed(2));
    ins.installmentsRemaining = sched.length || ins.installmentsRemaining;
    if (!ex.chargeBreakdown || Object.keys(ex.chargeBreakdown).length === 0) {
      ex.chargeBreakdown = {
        'Premium installment': Number((regular - fee).toFixed(2)),
        ...(fee ? { 'Installment fee': fee } : {}),
        ...(carried > 0 ? { 'Past due installment': carried } : {}),
        ...(lateFee ? { 'Late fee': lateFee } : {}),
      };
    }
  }

  if (!ins.policyNumber && !ins.coverageStart && !ins.paymentSchedule) return;
  ex.insurance = ins;
  if (installmentBill) return;

  // A document with a term and a payment schedule but no "amount due" of its
  // own describes the policy; it is not a bill for a period.
  // A bill prints a figure against its demand ("Amount Due $463.54"); a
  // letter that merely mentions "the amount due" in passing does not.
  const billsSomething = /\b(?:total\s+)?amount\s+(?:now\s+)?due\b[^$\n]{0,12}\$\s*[\d,]+\.\d{2}|\bminimum\s+(?:amount\s+)?due\b[^$\n]{0,12}\$|\bplease\s+pay\b|\bpay\s+this\s+amount\b|\bbalance\s+due\b[^$\n]{0,12}\$/i.test(text);
  const describesPolicy = /renewal|welcome|declarations?\s+page|id\s+cards?|payment\s+schedule|your\s+policy\s+documents/i.test(text);
  if ((ex.documentKind == null || ex.documentKind === 'bill') && ins.paymentSchedule && ins.paymentSchedule.length >= 2 && describesPolicy && !billsSomething) {
    ex.documentKind = 'policy_document';
  }
  if (ex.documentKind === 'policy_document') {
    // The document's own date, not a bill date; nothing is billed by it.
    ex.amountDue = null; ex.currentCharges = null; ex.previousBalance = null; ex.dueDate = null;
    ex.statedTotalDue = null; ex.paymentsReceived = null; ex.lateFee = null;
    ex.billingPeriodStart = ins.coverageStart ?? ex.billingPeriodStart;
    ex.billingPeriodEnd = ins.coverageEnd ?? ex.billingPeriodEnd;
    ex.isPaid = false;
  }
}

/**
 * File a policy document: bring the policy up to date and put each
 * scheduled installment on the account as a bill-to-come, so the account
 * shows what is due and when before the carrier's own statement arrives.
 * A real bill later takes the scheduled row's place (routes/import.ts).
 * Installments already taken by auto-pay read as paid. Returns how many
 * installments were filed.
 */
export async function applyPolicyDocument(utilityAccountId: string, ex: ExtractedBillData, pdfS3Key?: string | null): Promise<number> {
  const ins = ex.insurance;
  if (!ins) return 0;
  const account = await db.utilityAccount.findUnique({ where: { id: utilityAccountId }, select: { id: true, category: true } });
  if (!account) return 0;
  await syncInsurancePolicyFromBill(utilityAccountId, ex);
  await syncLoanFromPremiumFinance(utilityAccountId, ex);

  // A premium finance notice read as a bill earlier filed the whole
  // premium as one charge. Nothing was ever paid against it; it goes.
  const pf = ex.premiumFinance;
  if (pf && (pf.totalPremiums != null || pf.amountFinanced != null)) {
    await db.statement.deleteMany({
      where: {
        utilityAccountId, isScheduled: false, isDownPayment: false, payments: { none: {} },
        amountDue: { in: [pf.totalPremiums, pf.amountFinanced].filter((v): v is number => v != null) },
      },
    });
  }

  // This same document, imported earlier as if it were a bill, left a
  // statement dated the day the letter was written and covering the whole
  // term. Nothing was ever paid against it — it was never a bill — so it
  // goes, and the schedule below stands in its place.
  if (ex.statementDate) {
    const docDay = new Date(ex.statementDate);
    await db.statement.deleteMany({
      where: {
        utilityAccountId,
        isScheduled: false,
        isDownPayment: false,
        statementDate: { gte: docDay, lt: new Date(docDay.getTime() + 86400000) },
        payments: { none: {} },
        ...(ins.coverageStart ? { billingPeriodStart: { gte: new Date(new Date(ins.coverageStart).getTime() - 3 * 86400000), lte: new Date(new Date(ins.coverageStart).getTime() + 3 * 86400000) } } : {}),
      },
    });
  }

  const schedule = (ins.paymentSchedule ?? []).filter(p => p.date && p.amount > 0);
  if (schedule.length === 0) return 0;
  const sorted = [...schedule].sort((a, b) => a.date.localeCompare(b.date));
  const today = new Date().toISOString().slice(0, 10);
  const docDate = ex.statementDate ? new Date(ex.statementDate) : new Date();
  // A lender's ledger says exactly which installments were paid and what
  // fees were charged. Each fee belongs to the last installment due on or
  // before its date; a waived fee (negative) nets against that one.
  const ledger = ex.ledgerPayments ?? [];
  const fromLedger = ledger.length > 0 || (ex.premiumFinance?.fees?.length ?? 0) > 0;
  const feesByRow = new Map<number, { label: string; amount: number }[]>();
  for (const f of ex.premiumFinance?.fees ?? []) {
    if (!f.date || !f.amount) continue;
    let idx = -1;
    for (const [j, p] of sorted.entries()) if (p.date <= f.date) idx = j;
    if (idx < 0) idx = 0;
    feesByRow.set(idx, [...(feesByRow.get(idx) ?? []), { label: f.label || 'Fee', amount: f.amount }]);
  }
  const rowIds: { idx: number; id: string; due: string; amount: number }[] = [];
  let filed = 0;
  for (const [i, p] of sorted.entries()) {
    const due = new Date(p.date);
    const window = 5 * 86400000;
    const existing = await db.statement.findFirst({
      where: { utilityAccountId, dueDate: { gte: new Date(due.getTime() - window), lte: new Date(due.getTime() + window) }, isDownPayment: false },
      select: { id: true, isScheduled: true },
    });
    // The carrier's own bill for this installment is already here; leave it.
    if (existing && !existing.isScheduled) { rowIds.push({ idx: i, id: existing.id, due: p.date, amount: p.amount }); continue; }
    // What the ledger charged on top of this installment, netted.
    const feeLines = (feesByRow.get(i) ?? []).reduce<Record<string, number>>((acc, f) => { acc[f.label] = Number(((acc[f.label] ?? 0) + f.amount).toFixed(2)); return acc; }, {});
    for (const k of Object.keys(feeLines)) if (Math.abs(feeLines[k]!) < 0.005) delete feeLines[k];
    const feeTotal = Number(Object.values(feeLines).reduce((t, v) => t + v, 0).toFixed(2));
    const rowTotal = Number((p.amount + feeTotal).toFixed(2));
    const breakdown: Record<string, number> = p.principal != null && p.interest != null
      ? { Principal: p.principal, Interest: p.interest }
      : ins.serviceCharge != null ? { Premium: Number((p.amount - ins.serviceCharge).toFixed(2)), 'Installment fee': ins.serviceCharge } : { Premium: p.amount };
    Object.assign(breakdown, feeLines);
    // An installment is the payment for the month that ends on its due date
    // (the Sep 27 payment is September's), so its period runs from the day
    // after the previous due date to this one, and it is filed under the
    // month it falls due. Each row is "issued" at the start of its period,
    // so the rows stagger a month apart and the next one due is the newest
    // that is not still in the future.
    const prev = sorted[i - 1]?.date ? new Date(sorted[i - 1]!.date) : null;
    const periodStart = prev
      ? new Date(prev.getTime() + 86400000)
      : (ins.coverageStart && new Date(ins.coverageStart) < due ? new Date(ins.coverageStart) : new Date(due.getFullYear(), due.getMonth() - 1, due.getDate() + 1));
    const periodEnd = due;
    // An installment already taken by auto-pay is paid. One well in the past
    // on a schedule that says nothing about auto-pay is assumed paid too —
    // the policy continued, so it was — and "↺ Unpaid" is there if not.
    // A ledger is the record: an installment is paid when it lists the
    // payment (recorded below), and nothing is assumed.
    const longPast = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    const taken = !fromLedger && p.date < today && (ins.autoPay === true || p.date < longPast);
    const data = {
      statementDate: periodStart,
      dueDate: due,
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      amountDue: rowTotal,
      balance: rowTotal,
      chargesExcludingFees: ins.serviceCharge != null ? Number((p.amount - ins.serviceCharge).toFixed(2)) : p.amount,
      penaltiesFees: feeTotal > 0 ? feeTotal : null,
      amountPaid: taken ? rowTotal : null,
      pastDueCarried: null,
      isScheduled: true,
      sourceType: 'MANUAL' as const,
      notes: `Installment ${i + 1} of ${sorted.length} from the ${ex.statementDate ?? ''} ${fromLedger ? "lender's payment history" : ins.autoPay ? 'automatic payments schedule' : 'payment schedule'}${ins.serviceCharge != null ? ` (includes ${ins.serviceCharge.toFixed(2)} installment fee)` : ''}`,
      rawDataJson: { scheduled: true, fromDocument: ex.statementDate ?? null, installmentFee: ins.serviceCharge ?? null, chargeBreakdown: breakdown } as Prisma.InputJsonValue,
      ...(pdfS3Key ? { pdfS3Key } : {}),
    };
    const row = existing
      ? await db.statement.update({ where: { id: existing.id }, data, select: { id: true } })
      : await db.statement.create({ data: { utilityAccountId, ...data }, select: { id: true } });
    rowIds.push({ idx: i, id: row.id, due: p.date, amount: rowTotal });
    filed++;
  }

  // The ledger's payments, each against the installment it settled: the
  // last one due on or before the payment date (a payment made early, before
  // its own due date, goes to the next one still open).
  if (ledger.length) {
    const DAY = 86400000;
    const key = ex.premiumFinance?.loanNumber ?? ex.accountNumber ?? 'ledger';
    const paidSoFar = new Map<string, number>();
    for (const [n, l] of ledger.entries()) {
      if (!l.date || !(l.amount > 0)) continue;
      const paymentDate = new Date(`${l.date}T12:00:00Z`);
      let target = [...rowIds].filter(r => r.due <= l.date).sort((a, b) => b.due.localeCompare(a.due))
        .find(r => (paidSoFar.get(r.id) ?? 0) < r.amount - 0.01)
        ?? [...rowIds].filter(r => r.due > l.date).sort((a, b) => a.due.localeCompare(b.due))[0]
        ?? null;
      if (!target) continue;
      const marker = `[ledger:${key}#${n + 1}]`;
      const existingPay = await db.payment.findFirst({ where: { utilityAccountId, notes: { contains: marker } }, select: { id: true } });
      const dup = existingPay ? null : await db.payment.findFirst({
        where: {
          utilityAccountId,
          amount: { gte: l.amount - 0.01, lte: l.amount + 0.01 },
          paymentDate: { gte: new Date(paymentDate.getTime() - 3 * DAY), lte: new Date(paymentDate.getTime() + 3 * DAY) },
        },
        select: { id: true, statementId: true },
      });
      const payData = {
        amount: l.amount,
        paymentDate,
        status: 'PAID' as const,
        statementId: target.id,
        paymentMethod: /e-?check|ach/i.test(l.description ?? '') ? 'CHECK' : /credit\s*card|card/i.test(l.description ?? '') ? 'CREDIT_CARD' : undefined,
        notes: `${l.description ?? 'Payment'} — from the lender's payment history. ${marker}`,
      };
      if (existingPay) await db.payment.update({ where: { id: existingPay.id }, data: payData });
      else if (dup) { if (!dup.statementId) await db.payment.update({ where: { id: dup.id }, data: { statementId: target.id } }); }
      else await db.payment.create({ data: { utilityAccountId, ...payData } });
      paidSoFar.set(target.id, (paidSoFar.get(target.id) ?? 0) + l.amount);
    }
    // An installment the ledger shows settled reads as paid.
    for (const r of rowIds) {
      const paid = paidSoFar.get(r.id) ?? 0;
      if (paid >= r.amount - 0.01) await db.statement.update({ where: { id: r.id }, data: { amountPaid: Number(paid.toFixed(2)) } });
    }
  }
  return filed;
}

// ── Premium finance agreements ───────────────────────────────────────────────
// A carrier that wants the term premium up front is paid by a premium
// finance company, which then bills the owner monthly with interest. The
// agreement's "Notice of Acceptance" reads like a loan, because it is one:
//
//   Notice Date: 4/24/2026        Loan Number: 6547326
//   Total Premiums: $5,769.34     Amount Financed: $4,064.34
//   Down Payment: $1,705.00       Finance Charge: $381.57
//   Payment: $493.99              Annual % Rate: 22%
//   Number of Payments: 8         Effective Date: 3/15/2026
//   First Due Date: 5/15/2026     Loan Balance: $3,951.92
//
// Read as a bill it became a $5,769.34 charge from "NOTICE OF ACCEPTANCE".
// It is filed instead the way a policy's payment schedule is: nothing is
// billed by it, each monthly payment goes on the account as a bill to come,
// and the account's loan carries the amount, rate, term and balance.

/** Reads the loan summary off a premium finance document into
 *  `ex.premiumFinance`, and shapes the rest of the extraction around it. */
export function applyPremiumFinanceFromText(ex: ExtractedBillData, text: string): void {
  const isFinance = /premium\s*financ|insurance\s*premium\s*finance\s*agreement|financing\s*your\s*insurance\s*premiums/i.test(text);
  const hasSummary = /amount\s*financed/i.test(text) && /(?:annual\s*%?\s*rate|APR|finance\s*charge)/i.test(text);
  if (!isFinance && !(hasSummary && /premium/i.test(text))) return;
  const money = (re: RegExp) => { const m = text.match(re); return m ? parseFloat(m[1]!.replace(/[$,\s]/g, '')) : null; };
  const date = (re: RegExp) => { const m = text.match(re); return m ? parseDate(m[1]!) : null; };
  const pf: NonNullable<ExtractedBillData['premiumFinance']> = {
    lender: null, loanNumber: null, totalPremiums: null, amountFinanced: null, downPayment: null, financeCharge: null,
    payment: null, apr: null, numberOfPayments: null, effectiveDate: null, firstDueDate: null, loanBalance: null,
    ...(ex.premiumFinance ?? {}),
  };
  pf.lender ??= text.match(/(?:financing\s*your\s*insurance\s*premiums?\s*through|thank\s*you\s*for\s*choosing)\s*([A-Z][A-Za-z&' ]{3,50}?)(?:,?\s*(?:LLC|Inc\.?|Corp\.?|Company))?\s*(?:\n|$)/im)?.[1]?.trim()
    ?? text.match(/\b(Capital\s+Premium\s+Financing|IPFS|First\s+Insurance\s+Funding|Imperial\s+PFS|AFCO|BankDirect)\b/i)?.[1]?.replace(/\s+/g, ' ') ?? null;
  pf.loanNumber ??= text.match(/(?:loan|account)\s*(?:number|no\.?|#)\s*:?\s*([A-Z0-9-]{5,16})\b/i)?.[1] ?? null;
  pf.totalPremiums ??= money(/total\s*premiums?\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
  pf.amountFinanced ??= money(/amount\s*financed\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
  pf.downPayment ??= money(/down\s*payment\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
  pf.financeCharge ??= money(/finance\s*charge\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
  pf.payment ??= money(/(?:^|\n)\s*(?:monthly\s*)?payment\s*(?:amount)?\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
  pf.apr ??= (() => { const m = text.match(/annual\s*(?:%|percentage)\s*rate\s*:?\s*([\d.]+)\s*%/i) ?? text.match(/\bAPR\s*:?\s*([\d.]+)\s*%/i); return m ? parseFloat(m[1]!) : null; })();
  pf.numberOfPayments ??= (() => { const m = text.match(/number\s*of\s*payments\s*:?\s*(\d{1,3})\b/i); return m ? parseInt(m[1]!, 10) : null; })();
  pf.effectiveDate ??= date(/effective\s*date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i);
  pf.firstDueDate ??= date(/first\s*(?:payment\s*)?due\s*(?:date)?\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i);
  pf.loanBalance ??= money(/loan\s*balance\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
  if (pf.amountFinanced == null && pf.payment == null) return;
  ex.premiumFinance = pf;
  const noticeDate = date(/(?:notice|statement|agreement)\s*date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i);
  if (noticeDate) ex.statementDate = noticeDate;

  // The agreement and its acceptance notice bill nothing: the payments are
  // the schedule. A monthly billing statement from the lender ("Amount Due",
  // "Please pay") is a bill and is left as one.
  const billsSomething = /\b(?:total\s+)?amount\s+(?:now\s+)?due\b[^$\n]{0,12}\$\s*[\d,]+\.\d{2}|\bplease\s+pay\b|\bpay\s+this\s+amount\b|\bminimum\s+(?:amount\s+)?due\b[^$\n]{0,12}\$/i.test(text);
  const describesLoan = /notice\s*of\s*acceptance|premium\s*finance\s*agreement|loan\s*summary|welcome|payment\s*(?:schedule\s*&?\s*)?history/i.test(text);
  shapePremiumFinance(ex, describesLoan && !billsSomething);
}

/**
 * Shapes an extraction that carries a premium finance loan, whether the
 * loan summary came off a PDF's text or Claude read it from a screenshot
 * of the lender's portal (which has no text layer at all). Fills what the
 * document implied but did not print, and, when it bills nothing, files it
 * as a schedule rather than a bill.
 */
export function shapePremiumFinance(ex: ExtractedBillData, isSchedule?: boolean): void {
  const pf = ex.premiumFinance;
  if (!pf) return;
  const listed = (ex.insurance?.paymentSchedule ?? []).filter(p => p.date && p.amount > 0).sort((a, b) => a.date.localeCompare(b.date));

  // The portal's ledger lists every scheduled payment with its principal
  // and interest: the loan is the sum of those columns, and the rate is
  // what the first month's interest says it is.
  const principal = listed.reduce((t, p) => t + (p.principal ?? 0), 0);
  const interest = listed.reduce((t, p) => t + (p.interest ?? 0), 0);
  if (pf.amountFinanced == null && principal > 0) pf.amountFinanced = Number(principal.toFixed(2));
  if (pf.financeCharge == null && interest > 0) pf.financeCharge = Number(interest.toFixed(2));
  if (pf.payment == null && listed.length) {
    const counts = new Map<number, number>();
    for (const p of listed) counts.set(p.amount, (counts.get(p.amount) ?? 0) + 1);
    pf.payment = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  }
  if (pf.numberOfPayments == null && listed.length) pf.numberOfPayments = listed.length;
  if (pf.firstDueDate == null && listed.length) pf.firstDueDate = listed[0]!.date;
  if (pf.apr == null && listed[0]?.interest != null && pf.amountFinanced) {
    pf.apr = Number(((listed[0].interest * 12) / pf.amountFinanced * 100).toFixed(2));
  }
  if (pf.totalPremiums == null && pf.amountFinanced != null && pf.downPayment != null) pf.totalPremiums = Number((pf.amountFinanced + pf.downPayment).toFixed(2));
  // A ledger prints no effective date; the loan began a month before its
  // first payment, which is where the balance projection needs to start.
  if (pf.effectiveDate == null && pf.firstDueDate) {
    const [y, m, d] = pf.firstDueDate.split('-').map(Number) as [number, number, number];
    pf.effectiveDate = new Date(Date.UTC(y, m - 2, d)).toISOString().slice(0, 10);
  }

  // The lender is the account's provider and the loan number its account
  // number — not the agent's name at the top of the page.
  if (pf.lender) ex.providerName = pf.lender;
  if (pf.loanNumber) ex.accountNumber = pf.loanNumber;
  ex.utilityType = 'other';

  const schedule = isSchedule ?? ex.documentKind === 'policy_document';
  if (!schedule) return;

  // Equal payments a month apart from the first due date, when the document
  // states the terms but lists no dates.
  const generated: { date: string; amount: number }[] = [];
  if (!listed.length && pf.firstDueDate && pf.payment && pf.numberOfPayments) {
    const [y, m, d] = pf.firstDueDate.split('-').map(Number) as [number, number, number];
    for (let i = 0; i < pf.numberOfPayments; i++) {
      const due = new Date(Date.UTC(y, m - 1 + i, 1));
      const last = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate();
      due.setUTCDate(Math.min(d, last));
      generated.push({ date: due.toISOString().slice(0, 10), amount: pf.payment });
    }
  }
  const effective = pf.effectiveDate;
  const termEnd = effective ? (() => { const [y, m, d] = effective.split('-').map(Number) as [number, number, number]; return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10); })() : null;
  ex.documentKind = 'policy_document';
  const prior = ex.insurance ?? ({} as Partial<NonNullable<ExtractedBillData['insurance']>>);
  ex.insurance = {
    policyNumber: prior.policyNumber ?? null,
    coverageStart: prior.coverageStart ?? effective,
    coverageEnd: prior.coverageEnd ?? termEnd,
    termPremium: prior.termPremium ?? pf.totalPremiums ?? pf.amountFinanced,
    installment: prior.installment ?? pf.payment,
    serviceCharge: prior.serviceCharge ?? null,
    installmentsRemaining: pf.numberOfPayments ?? prior.installmentsRemaining ?? null,
    renewedOn: prior.renewedOn ?? null,
    insuranceType: prior.insuranceType ?? null,
    carrier: prior.carrier ?? null,
    paymentSchedule: listed.length ? listed : generated.length ? generated : null,
    autoPay: prior.autoPay ?? null,
  };
  ex.amountDue = null; ex.currentCharges = null; ex.previousBalance = null; ex.dueDate = null;
  ex.statedTotalDue = null; ex.paymentsReceived = null; ex.lateFee = null; ex.totalAccountBalance = null;
  ex.billingPeriodStart = effective; ex.billingPeriodEnd = termEnd;
  ex.isPaid = false;
  ex.chargeBreakdown = null;
}

/**
 * Keep the account's loan in step with the premium finance agreement: the
 * premiums as the original amount (the amount financed is that less the
 * down payment, which is how the loan projection reads it), the rate, the
 * payment, the term and the balance. The loan is created when the account
 * has none — an account made by the importer has no loan yet, and an
 * INSTALLMENT_PLAN loan is what a premium finance agreement is.
 */
export async function syncLoanFromPremiumFinance(utilityAccountId: string, ex: ExtractedBillData): Promise<void> {
  const pf = ex.premiumFinance;
  if (!pf) return;
  const account = await db.utilityAccount.findUnique({
    where: { id: utilityAccountId },
    select: { id: true, propertyId: true, providerName: true, isActive: true, property: { select: { userId: true } } },
  });
  if (!account) return;
  const schedule = ex.insurance?.paymentSchedule ?? [];
  const lastDue = schedule.length ? [...schedule].sort((a, b) => a.date.localeCompare(b.date))[schedule.length - 1]!.date : null;
  const dueDay = pf.firstDueDate ? Number(pf.firstDueDate.slice(8, 10)) : null;
  const figures = {
    ...(pf.totalPremiums != null ? { originalAmount: pf.totalPremiums } : pf.amountFinanced != null ? { originalAmount: Number((pf.amountFinanced + (pf.downPayment ?? 0)).toFixed(2)) } : {}),
    ...(pf.downPayment != null ? { downPayment: pf.downPayment } : {}),
    ...(pf.apr != null ? { interestRate: pf.apr } : {}),
    ...(pf.payment != null ? { monthlyPayment: pf.payment } : {}),
    ...(pf.effectiveDate ? { originationDate: new Date(pf.effectiveDate) } : {}),
    ...(lastDue ? { maturityDate: new Date(lastDue) } : {}),
    ...(dueDay ? { dueDay } : {}),
    ...(pf.loanNumber ? { accountLast4: pf.loanNumber.slice(-4) } : {}),
  };
  const existing = await db.loan.findUnique({ where: { utilityAccountId }, select: { id: true, currentBalance: true, loanType: true } });
  if (existing) {
    await db.loan.update({
      where: { id: existing.id },
      data: {
        ...figures,
        ...(existing.loanType === 'OTHER' ? { loanType: 'INSTALLMENT_PLAN' } : {}),
        // The stated balance only fills a blank; payments logged since the
        // notice have moved it on, and the projection tracks that.
        ...(existing.currentBalance == null && pf.loanBalance != null ? { currentBalance: pf.loanBalance } : {}),
      },
    });
    return;
  }
  await db.loan.create({
    data: {
      userId: account.property.userId,
      propertyId: account.propertyId,
      utilityAccountId,
      lender: pf.lender ?? account.providerName,
      loanType: 'INSTALLMENT_PLAN',
      isActive: account.isActive,
      isPersonal: false,
      ...(pf.loanBalance != null ? { currentBalance: pf.loanBalance } : {}),
      notes: `Premium finance agreement${pf.loanNumber ? ` #${pf.loanNumber}` : ''}${pf.financeCharge != null ? ` — finance charge $${pf.financeCharge.toFixed(2)} over the term` : ''}`,
      ...figures,
    },
  });
}

export function sanitiseLateFee(ex: ExtractedBillData): void {
  const FEE_LINE = /late\s*(?:fee|charge|payment\s*(?:fee|charge|penalty))|penalt|overdue\s*charge|nsf|returned\s*(?:check|payment)|finance\s*charge|interest\s*charge/i;
  if (ex.chargeBreakdown) {
    let fromLines = 0, seen = false;
    for (const [label, value] of Object.entries(ex.chargeBreakdown)) {
      if (FEE_LINE.test(label)) { fromLines += Number(value) || 0; seen = true; }
    }
    if (seen) { ex.lateFee = fromLines > 0 ? Number(fromLines.toFixed(2)) : null; return; }
  }
  if (ex.lateFee == null) return;
  const fee = Math.abs(ex.lateFee);
  if (fee === 0) { ex.lateFee = null; return; }
  const same = (v: number | null | undefined) => v != null && Math.abs(Math.abs(v) - fee) < 0.01;
  const grand = ex.amountDue != null && ex.previousBalance != null ? ex.amountDue + ex.previousBalance : null;
  if (same(ex.amountDue) || same(ex.currentCharges) || same(ex.previousBalance) || same(grand)) { ex.lateFee = null; return; }
  const charges = ex.currentCharges ?? ex.amountDue;
  if (charges != null && charges > 0 && fee > charges) ex.lateFee = null;
}

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
  if (ex.ledgerPayments && ex.ledgerPayments.length > 0) {
    await recordLedgerPayments(utilityAccountId, statementId, ex);
    return;
  }
  const amount = Math.abs(Number(ex.paymentsReceived ?? 0));
  if (!amount || amount <= 0.01) return;

  const marker = `[from-statement:${statementId}]`;
  // Dated the day BEFORE the statement that confirms it, not the same day.
  // The bill says the payment had already arrived when it was issued, and the
  // paid check counts payments from a statement's own date onward — dated
  // equal, the prior cycle's payment was counted against the very bill that
  // reported it, and every freshly imported bill read Paid.
  const confirmedOn = ex.statementDate ? new Date(ex.statementDate) : new Date();
  const paymentDate = new Date(confirmedOn.getTime() - 24 * 60 * 60 * 1000);
  // Which earlier bill did this payment settle? The one whose charge (or
  // open balance) matches the amount, newest first — not simply the bill
  // before this one. CR&R's Sep 1 statement confirmed $272.52 received; the
  // bill before it was the Aug 31 one for $278.26, and the $272.52 was the
  // July bill's. Position filed it under August; amount files it under July.
  const priors = await db.statement.findMany({
    where: { utilityAccountId, statementDate: { lt: confirmedOn }, id: { not: statementId }, isDownPayment: false },
    orderBy: { statementDate: 'desc' },
    take: 6,
    select: { id: true, statementDate: true, amountDue: true, pastDueCarried: true },
  });
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.05, b * 0.005);
  const prior = priors.find(p => p.amountDue != null && near(amount, Number(p.amountDue)))
    ?? priors.find(p => p.amountDue != null && near(amount, Number(p.amountDue) + Number(p.pastDueCarried ?? 0)))
    ?? priors[0]
    ?? null;

  const existing = await db.payment.findFirst({
    where: { utilityAccountId, notes: { contains: marker } },
  });

  // The owner may already have logged this payment by hand on the day they
  // made it. Recording it again from the bill would count the same money
  // twice in Total Paid — so a hand-logged payment of the same amount, made
  // between the prior bill and this one, is taken as the record and the
  // bill's confirmation is not duplicated.
  if (!existing) {
    const priorDate = prior?.statementDate ?? null;
    const handLogged = await db.payment.findFirst({
      where: {
        utilityAccountId,
        amount: { gte: amount - 0.01, lte: amount + 0.01 },
        paymentDate: { ...(priorDate ? { gte: priorDate } : {}), lte: confirmedOn },
        NOT: { notes: { contains: '[from-statement:' } },
      },
    });
    if (handLogged) return;
  }

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

/**
 * A ledger statement lists each payment on its own date. Each becomes its
 * own payment record, dated as printed and linked to the newest bill issued
 * on or before that date, since that is the bill the money answered. A
 * payment the owner already logged by hand for the same amount within a
 * few days is taken as the record. Re-imports update the same records, and
 * an earlier lump "payments received" record for this statement is
 * replaced, not doubled.
 */
async function recordLedgerPayments(utilityAccountId: string, statementId: string, ex: ExtractedBillData): Promise<void> {
  const rows = ex.ledgerPayments ?? [];
  const lumpMarker = `[from-statement:${statementId}]`;
  await db.payment.deleteMany({ where: { utilityAccountId, notes: { contains: lumpMarker } } });

  const bills = await db.statement.findMany({
    where: { utilityAccountId, isDownPayment: false },
    orderBy: { statementDate: 'desc' },
    select: { id: true, statementDate: true },
  });
  const DAY = 24 * 60 * 60 * 1000;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const marker = `[from-statement:${statementId}#${i + 1}]`;
    const paymentDate = new Date(`${row.date}T12:00:00Z`);
    const existing = await db.payment.findFirst({ where: { utilityAccountId, notes: { contains: marker } } });
    if (!existing) {
      // The same payment may already be on file: logged by hand, or
      // confirmed by an earlier statement that listed the same ledger line.
      const dup = await db.payment.findFirst({
        where: {
          utilityAccountId,
          amount: { gte: row.amount - 0.01, lte: row.amount + 0.01 },
          paymentDate: { gte: new Date(paymentDate.getTime() - 3 * DAY), lte: new Date(paymentDate.getTime() + 3 * DAY) },
        },
      });
      if (dup) continue;
    }
    const bill = bills.find(b => b.statementDate.getTime() <= paymentDate.getTime() && b.id !== statementId) ?? null;
    const data = {
      amount: row.amount,
      paymentDate,
      status: 'PAID' as const,
      statementId: bill?.id ?? null,
      paymentMethod: /e-?check/i.test(row.description) ? 'CHECK' : undefined,
      notes: `${row.description} — listed on the ${ex.statementDate ?? 'imported'} statement. ${marker}`,
    };
    if (existing) await db.payment.update({ where: { id: existing.id }, data });
    else await db.payment.create({ data: { utilityAccountId, ...data } });
  }
}

/**
 * A bill that says in words that the account is in credit is in credit,
 * whatever sign the extractor gave its figures. "No payment is due. Your
 * account has a credit balance of $47.34" fixes the stated total at −47.34
 * and the account balance at −47.34; a "Total Account Balance - $47.34"
 * printed with a space after the minus does the same. Read from the PDF's
 * own text layer, so it corrects the AI path as well as the regex one —
 * the AI returned the credit as a positive 47.34, and the bill filed as a
 * $5.26 charge with no credit against it.
 */
export function applyCreditFromText(text: string, ex: ExtractedBillData): void {
  if (!text) return;
  let credit: number | null = null;
  const phrase = text.match(/credit\s+balance\s+of\s+-?\$?\s*([\d,]*\.\d{2})/i);
  if (phrase) credit = parseFloat(phrase[1].replace(/,/g, ''));
  if (credit == null) {
    const tab = findDollarNear(text, [/total\s+account\s+balance/i]);
    if (tab != null && tab < 0 && !ex.paymentPlan) credit = -tab;
  }
  if (credit == null || !(credit > 0)) return;
  ex.statedTotalDue = -credit;
  if (ex.totalAccountBalance == null || Math.abs(Math.abs(ex.totalAccountBalance) - credit) < 0.01) ex.totalAccountBalance = -credit;
  // The charge itself stays positive: the credit, not the charge, is what
  // makes nothing due.
  if (ex.amountDue != null && ex.amountDue < 0 && Math.abs(ex.amountDue + credit) < 0.01) {
    ex.amountDue = ex.currentCharges != null && ex.currentCharges > 0 ? ex.currentCharges : null;
  }
}

/**
 * A running-ledger statement (Seabreeze / CINC HOA managers): a DATE /
 * DESCRIPTION / CHARGES / CREDITS / BALANCE table opening with BALANCE
 * FORWARD, listing two or three months of assessments, fees and payments,
 * with a header box giving the Billing Date and the Amount Due. Read
 * naively it became a bill for every charge on the page, with the running
 * balance after the first payment taken as "past due" — 5,444.51 owed on
 * a statement that asked for 4,331.32.
 *
 * Read as a ledger: this period's charges are the lines dated in the
 * billing month (the 09/01 assessments for a Sep 1 billing date); the
 * carried balance is the Amount Due less those; the CREDITS column is the
 * payments, each kept on its own date. The ledger's own arithmetic — the
 * last running balance equals the Amount Due — is checked before any of
 * it is trusted.
 */
export function applyLedgerFromText(text: string, ex: ExtractedBillData): void {
  if (!text || !/balance\s+forward/i.test(text) || !/credits?/i.test(text) || !/balance/i.test(text)) return;
  const amountDue = findDollarNear(text, [/amount\s+due/i, /pay\s+this\s+amount/i]);
  const billingDate = findDateNear(text, [/billing\s+date/i]);
  if (amountDue == null || !billingDate) return;

  const money = /\(?-?\$?\s*[\d,]+\.\d{2}\)?/g;
  type Row = { date: string; desc: string; charge: number; credit: number; balance: number };
  const rows: Row[] = [];
  let forward: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const dm = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.*)$/);
    if (!dm) continue;
    const date = parseDate(dm[1]);
    if (!date) continue;
    const rest = dm[2];
    const tokens = rest.match(money) ?? [];
    if (tokens.length === 0) continue;
    const num = (t: string) => parseFloat(t.replace(/[^\d.]/g, ''));
    const first = tokens[0]!;
    const desc = rest.slice(0, rest.indexOf(first)).trim();
    const balance = num(tokens[tokens.length - 1]!);
    if (/balance\s+forward/i.test(desc) && tokens.length === 1) { forward = balance; continue; }
    if (tokens.length < 2) continue;
    const isCredit = /^\(/.test(first) || /^-/.test(first.replace(/^\$/, ''));
    rows.push({ date, desc, charge: isCredit ? 0 : num(first), credit: isCredit ? num(first) : 0, balance });
  }
  if (forward == null || rows.length === 0) return;

  // The ledger must add up to what it asks for, or it is not being read right.
  let running = forward;
  for (const r of rows) running = Number((running + r.charge - r.credit).toFixed(2));
  if (Math.abs(running - amountDue) > 0.01 || Math.abs(rows[rows.length - 1].balance - amountDue) > 0.01) return;

  const billMonth = billingDate.slice(0, 7);
  const current = rows.filter(r => r.charge > 0 && r.date.slice(0, 7) === billMonth);
  const currentTotal = Number(current.reduce((s, r) => s + r.charge, 0).toFixed(2));
  if (currentTotal <= 0) return;
  const credits = rows.filter(r => r.credit > 0);

  ex.statementDate = billingDate;
  ex.billingPeriodStart = `${billMonth}-01`;
  ex.billingPeriodEnd = new Date(Date.UTC(Number(billMonth.slice(0, 4)), Number(billMonth.slice(5, 7)), 0)).toISOString().slice(0, 10);
  ex.currentCharges = currentTotal;
  ex.amountDue = currentTotal;
  ex.statedTotalDue = amountDue;
  ex.previousBalance = Number((amountDue - currentTotal).toFixed(2));
  ex.paymentsReceived = credits.length > 0 ? Number(credits.reduce((s, r) => s + r.credit, 0).toFixed(2)) : null;
  ex.ledgerPayments = credits.map(r => ({ date: r.date, amount: r.credit, description: r.desc }));
  ex.chargeBreakdown = Object.fromEntries(current.map((r, i) => [current.filter((o, j) => j < i && o.desc === r.desc).length ? `${r.desc} (${i + 1})` : r.desc, r.charge]));
  ex.lateFee = null;
  ex.isPaid = amountDue <= 0.01;
  ex.documentKind = 'bill';
}

/**
 * A net-metering (solar) bill bills almost nothing month to month. SDG&E's
 * account summary reads "Current Charges − 49.36 / Total Amount Due $944.45"
 * while the "Net Metering Account Summary" beside it carries the real
 * energy cost: "Previous NEM YTD Balance $659.62 / Current Charges + 560.48
 * / NEM Year-to-Date Balance $1,220.10 — Payment not required for NEM
 * charges. Your account will true up on Dec 3, 2026." Read as an ordinary
 * bill, the $511.12 of charges and the $944.45 asked for could not be
 * reconciled, and the carried balance came out wrong every month.
 *
 * The energy cost stays as this period's charge (it is what the month cost,
 * and what the true-up will collect); the deferred part is recorded so what
 * is payable now is charge − deferred + carried.
 */
export function applyNetMeteringFromText(text: string, ex: ExtractedBillData): void {
  if (!text || !/net\s+metering|NEM\s+year/i.test(text)) return;
  const ytd = findDollarNear(text, [/NEM\s+year-?to-?date\s+balance/i]);
  const prevYtd = findDollarNear(text, [/previous\s+NEM\s+YTD\s+balance/i]);
  // The deferred charge is the line between them: "Current Charges + 560.48".
  let deferred: number | null = null;
  const block = text.match(/previous\s+NEM\s+YTD\s+balance[\s\S]{0,120}?current\s+charges\s*([+-]?)\s*\$?\s*([\d,]*\.\d{2})/i);
  if (block) deferred = (block[1] === '-' ? -1 : 1) * parseFloat(block[2]!.replace(/,/g, ''));
  if (deferred == null && ytd != null && prevYtd != null) deferred = Number((ytd - prevYtd).toFixed(2));
  if (deferred == null) return;

  const trueUp = findDateNear(text, [/true[\s-]*up\s+on/i, /true[\s-]*up\s+date\s*:?/i, /will\s+true[\s-]*up\s+on/i]);
  const start = findDateNear(text, [/start\s+date\s*:?/i]);
  ex.netMetering = {
    deferred: Number(deferred.toFixed(2)),
    previousYtd: prevYtd,
    ytdBalance: ytd,
    trueUpDate: trueUp,
    periodStart: start,
  };
  // What the account summary bills this month is the charge less the
  // deferred part — the California Climate Credit alone on a high-solar
  // month. If the charge came out as that billed figure, restore the cost.
  const billedNow = findDollarNear(text, [/account\s+summary[\s\S]{0,200}?current\s+charges/i]);
  if (ex.currentCharges != null && billedNow != null && Math.abs(ex.currentCharges - billedNow) < 0.01) {
    ex.currentCharges = Number((billedNow + deferred).toFixed(2));
  }
  if (ex.amountDue != null && billedNow != null && Math.abs(ex.amountDue - billedNow) < 0.01) {
    ex.amountDue = Number((billedNow + deferred).toFixed(2));
  }
  if (ex.currentCharges == null && ex.amountDue != null) ex.currentCharges = ex.amountDue;
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
    // A photo or scan has no text layer to parse: it is always read by
    // Claude, whatever extraction method was chosen.
    const isImage = imageMediaType(buffer) != null;
    if (isImage) {
      extractedBy = 'ai';
      if (method === 'regex') extractionNote = 'Images are always read by Claude; text extraction needs a PDF.';
      extracted = await extractWithClaude(buffer, filename);
    } else if (method === 'regex') {
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
    // A document with new charges is a bill, whatever banner it wears. EDCO
    // prints "PAST DUE — SUBJECT TO SUSPENSION" across a regular invoice that
    // also bills the next two months of service; classified as a notice it
    // was attached instead of filed, and the cycle went missing. The
    // classification is only trusted when the document truly bills nothing.
    if (extracted.documentKind === 'past_due_notice'
        && ((extracted.currentCharges ?? 0) > 0 || extracted.billingPeriodStart || extracted.billingPeriodEnd)) {
      extracted.documentKind = 'bill';
    }
    repairMisreadPeriodYear(extracted);
    // The text layer settles what the figures cannot: a bill in credit.
    try {
      const { text } = await pdfParse(buffer);
      applyLedgerFromText(text, extracted);
      applyNetMeteringFromText(text, extracted);
      applyCreditFromText(text, extracted);
      applyLoanGroupsFromText(extracted, text);
      applyInsuranceFromText(extracted, text);
      applyPremiumFinanceFromText(extracted, text);
    } catch { /* an unreadable text layer changes nothing */ }
    // A screenshot has no text layer; what Claude read of a premium finance
    // ledger is shaped here.
    shapePremiumFinance(extracted);
    reconcileWithStatedTotal(extracted);
    sanitiseLateFee(extracted);
    sanitiseCurrentCharges(extracted);
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
        paymentsReceived: null, currentCharges: null, paymentPlanAmount: null, statedTotalDue: null, totalAccountBalance: null, paymentPlan: null, insurance: null,
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
