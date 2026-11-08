/**
 * A credit card statement read from its own text, with no AI call.
 *
 * Card statements follow one federal layout (Regulation Z): an account
 * summary of Previous Balance, Payments/Credits, Purchases, Fees Charged,
 * Interest Charged and New Balance, a payment box with the Minimum Payment
 * Due and Payment Due Date, the credit limit, an APR table and a list of
 * transactions. Issuers word the labels a little differently (Apple Card:
 * "Previous Monthly Balance", "Total payments for this period", "Total
 * Balance"), so each figure has a few labels to look for.
 *
 * Nothing is guessed: the reading is returned only when the summary adds up
 * (previous − payments + purchases + fees + interest = new balance) and the
 * closing and due dates were found. Anything else returns null and the
 * statement is read by Claude as before.
 *
 * Input is the page text with each printed line on one line (`layoutText`).
 */

export interface CardTextTransaction {
  date: string;              // YYYY-MM-DD
  postDate: string | null;
  description: string;
  merchant: string | null;
  amount: number;            // + charge, − payment or credit
  kind: 'PURCHASE' | 'PAYMENT' | 'CREDIT' | 'FEE' | 'INTEREST' | 'CASH_ADVANCE' | 'BALANCE_TRANSFER';
  category: string | null;
  cardholder: string | null;
  /** The issuer's reference / confirmation number for the line ("P632139753156462"). */
  reference?: string | null;
}

/** A deferred-interest promotion: pay this balance in full by the date or the interest comes back. */
export interface CardPromotion { balance: number; payBy: string; description: string | null }

export interface CardTextReading {
  issuer: string | null; cardName: string | null; network: string | null; last4: string | null; cardholderName: string | null;
  periodStart: string | null; closingDate: string; dueDate: string | null;
  previousBalance: number; paymentsCredits: number; purchases: number; balanceTransfers: number | null; cashAdvances: number | null;
  feesCharged: number | null; interestCharged: number | null; newBalance: number; minimumPayment: number | null;
  creditLimit: number | null; cashAdvanceLimit: number | null; availableCredit: number | null;
  purchaseApr: number | null; cashAdvanceApr: number | null; balanceTransferApr: number | null; penaltyApr: number | null;
  introApr: number | null; introAprType: 'PURCHASE' | null; introAprEndDate: string | null;
  pastDueAmount: number | null; feesYtd: number | null; interestYtd: number | null;
  promotions: CardPromotion[];
  daysInCycle: number | null;
  lateFee: number | null; annualFee: number | null; foreignTransactionFee: number | null; balanceTransferFee: number | null; cashAdvanceFee: number | null;
  phone: string | null; loginUrl: string | null;
  rewardsProgram: string | null; rewardsType: 'POINTS' | 'MILES' | 'CASHBACK' | null; rewardsEarned: number | null; rewardsBalance: null;
  minPayoffMonths: number | null; minPayoffTotal: number | null;
  authorizedUsers: never[];
  transactions: CardTextTransaction[];
}

// A dollar figure: "$1,234.56", "-$620.00", "+$236.12", "$40.00 CR", "$20,100", "-.05".
// Never a percentage ("23.99%") or the start of a longer number.
const MONEY = String.raw`[-+]?[ \t]*\$[ \t]*-?[\d,]*\d(?:\.\d{2})?(?:[ \t]*CR\b)?|[-+]?[\d,]*\.\d{2}(?:[ \t]*CR\b)?`;
const MONEY_END = String.raw`(?![\d%.])`;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_NAME = String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?`;
const DATE = String.raw`\d{1,2}/\d{1,2}/\d{2,4}|${MONTH_NAME}\s+\d{1,2},?\s+\d{4}`;

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);

function money(s: string): number {
  const credit = /CR\b/i.test(s);
  const neg = /-/.test(s);
  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return NaN;
  return Number(((credit || neg ? -1 : 1) * n).toFixed(2));
}

function date(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return iso(y, Number(m[1]), Number(m[2]));
  }
  m = t.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)];
    return mo ? iso(Number(m[3]), mo, Number(m[2])) : null;
  }
  return null;
}

/** A label as a pattern: any run of spaces between its words (some issuers print two or three). */
const label = (l: string) => l.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(String.raw`\s+`);

/** The 30 characters before a match's label, to tell "Previous Total Balance" from "Total Balance". */
const before = (text: string, m: RegExpMatchArray) => {
  const at = (m.index ?? 0) + m[0].indexOf(m[1]);
  return text.slice(Math.max(0, at - 30), at);
};
// Words that make a label about another statement.
const OTHER_CYCLE = /(?:Previous|Prior|Last|Next)\s+(?:Monthly\s+|Statement\s+)?$/i;

/** The first figure printed right after one of the labels, on the same line, as printed ("-  $1,465.14", "+$29.00"). */
function printed(text: string, labels: string[], not?: RegExp): string | null {
  for (const l of labels) {
    const re = new RegExp(String.raw`(?:^|[^A-Za-z])(${label(l)})[ \t:]*(${MONEY})${MONEY_END}`, 'gim');
    for (const m of text.matchAll(re)) {
      if (not && not.test(before(text, m))) continue;
      if (Number.isFinite(money(m[2]))) return m[2];
    }
  }
  return null;
}
/** The first figure printed right after one of the labels, on the same line. */
function figure(text: string, labels: string[], not?: RegExp): number | null {
  const p = printed(text, labels, not);
  return p == null ? null : money(p);
}
/**
 * What a payments line did to the balance. Printed with a minus (or no sign)
 * it took the balance down; with a plus it put it up: a payment reversed in
 * the period (a returned check) outweighed the payments made.
 */
const paidEffect = (p: string | null) => (p == null ? 0 : /^\s*\+/.test(p) ? Math.abs(money(p)) : -Math.abs(money(p)));

/** The first date printed right after one of the labels, on the same line. */
function dateAfter(text: string, labels: string[], not?: RegExp): string | null {
  for (const l of labels) {
    const re = new RegExp(String.raw`(?:^|[^A-Za-z])(${label(l)})[ \t:]*(${DATE})`, 'gim');
    for (const m of text.matchAll(re)) {
      if (not && not.test(before(text, m))) continue;
      const d = date(m[2]);
      if (d) return d;
    }
  }
  return null;
}

/** A rate printed after a row label: "Purchases 23.99% (v)", "Annual Percentage Rate (APR) 19.49 %". */
function rate(text: string, labels: string[]): number | null {
  for (const l of labels) {
    const m = text.match(new RegExp(String.raw`(?:^|\n|[ \t]{2})${label(l)}[ \t:]+(\d{1,2}(?:\.\d{1,3})?)\s?%`, 'i'));
    if (m) return Number(m[1]);
  }
  return null;
}

const ISSUERS: [RegExp, string][] = [
  [/Apple Card is issued by Goldman Sachs/i, 'Goldman Sachs'],
  [/\bchase\.com\b|Chase Card Services|JPMorgan Chase/i, 'Chase'],
  [/Citibank|citicards\.com/i, 'Citi'],
  [/American Express|americanexpress\.com/i, 'American Express'],
  [/Capital One/i, 'Capital One'],
  [/Synchrony/i, 'Synchrony'],
  [/Discover Bank|discover\.com/i, 'Discover'],
  [/Wells Fargo/i, 'Wells Fargo'],
  [/Bank of America/i, 'Bank of America'],
  [/Barclays/i, 'Barclays'],
  [/U\.\s?S\.\s?Bank\b|usbank\.com/i, 'US Bank'],
];
// Product names, looked for on the first page only (transactions name stores too).
const CARD_NAMES: [RegExp, string][] = [
  [/\bApple Card\b/i, 'Apple Card'],
  [/HOME\s+DEPOT\s+CREDIT\s+SERVICES|homedepot\.com\/mycard/i, 'The Home Depot Consumer Credit Card'],
  [/Lowe'?s\s+(?:Advantage|Business|Commercial|Credit)/i, "Lowe's Advantage Card"],
  [/PayPal\s+Credit/i, 'PayPal Credit'],
  [/AEROPLAN/i, 'Aeroplan'],
  [/SAPPHIRE\s+RESERVE/i, 'Sapphire Reserve'],
  [/SAPPHIRE\s+PREFERRED/i, 'Sapphire Preferred'],
  [/FREEDOM\s+UNLIMITED/i, 'Freedom Unlimited'],
  [/FREEDOM\s+FLEX/i, 'Freedom Flex'],
  [/Costco\s+Anywhere/i, 'Costco Anywhere Visa'],
  [/Double\s+Cash/i, 'Double Cash'],
];

// A payment that came back (returned check, NSF): it puts the balance back up.
const REVERSAL = /PAYMENT\s+REVERS|REVERS\w*\s+(?:OF\s+)?PAYMENT|RETURNED\s+PAYMENT|PAYMENT\s+RETURN|\bNSF\b|DISHONOU?RED/i;

function kindOf(section: CardTextTransaction['kind'] | null, description: string, amount: number): CardTextTransaction['kind'] {
  const d = description.toUpperCase();
  if (amount < 0) return /PAYMENT|THANK YOU|AUTOPAY|ACH DEPOSIT|APPLE CASH/.test(d) && !/REVERSAL|REFUND|RETURN|CREDIT\b/.test(d) ? 'PAYMENT' : 'CREDIT';
  if (REVERSAL.test(d)) return 'PAYMENT';
  if (/INTEREST CHARGE|PURCHASE INTEREST|INTEREST CHARGED/.test(d) || section === 'INTEREST') return 'INTEREST';
  if (/\bFEE\b|\bCHG\b|RETURNED CHECK|RETURN(?:ED)? PAYMENT CHARGE/.test(d) || section === 'FEE') return 'FEE';
  if (section === 'CASH_ADVANCE') return 'CASH_ADVANCE';
  if (section === 'BALANCE_TRANSFER') return 'BALANCE_TRANSFER';
  return 'PURCHASE';
}

// Stores whose card statements name the department under each purchase.
const MERCHANTS: [RegExp, string, string][] = [
  [/^THE HOME DEPOT\b|^HOME DEPOT\b/i, 'The Home Depot', 'Home improvement'],
  [/^LOWE'?S\b/i, "Lowe's", 'Home improvement'],
];
// A reference / confirmation number at the end of a line: "P632139753156462", "F919600HK000QFAUT", "0533063".
const REF = /^(?:[A-Z]{1,2}\d[A-Z0-9]{5,}|\d{6,})$/;
const PAGE_NOISE = /^(?:TOTAL\b|CARD ENDING\b|Trans(?:action)? Date\b|Date\b|Reference\b|\.$|Page\b|Account number\b|Payment Due Date\b|New Balance\b|Past Due\b|Minimum Payment\b|HD \d|PLEASE SEE|Statement Enclosed)/i;

function transactionsOf(text: string, closing: string): CardTextTransaction[] {
  const [cy, cm] = closing.split('-').map(Number);
  const dated = (s: string): string | null => {
    const m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (!m) return null;
    if (m[3]) return date(s);
    const mo = Number(m[1]);
    // No year printed: the billing period's — a December charge on a January statement is the year before.
    return iso(mo > cm ? cy - 1 : cy, mo, Number(m[2]));
  };
  // Only a statement with a "Reference #" column ends its lines with one.
  const hasRefs = /Reference\s*#/i.test(text);
  const out: CardTextTransaction[] = [];
  let section: CardTextTransaction['kind'] | null = null;
  let last: CardTextTransaction | null = null;   // the purchase a department or promotion line under it belongs to
  // "05/26  THE HOME DEPOT EL CENTRO CA 0533063  $ 1,405.09", "06/15 … $ 200.00 -" (a credit), "04/26 Payment Thank You -620.00", "(12.00)".
  const row = new RegExp(String.raw`^(\d{1,2}/\d{1,2}(?:/\d{2,4})?)\s+(?:(\d{1,2}/\d{1,2}(?:/\d{2,4})?)\s+)?(.+?)\s+(\(?-?\$?\s?-?[\d,]*\.\d{2}\)?)(?:\s(-|CR))?$`);
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (/^(?:PAYMENTS(?: AND OTHER CREDITS)?|Payments)$/i.test(line)) { section = 'PAYMENT'; last = null; continue; }
    if (/^(?:PURCHASES?(?: AND (?:OTHER )?(?:ADJUSTMENTS|DEBITS))?|Transactions|STANDARD PURCHASES)$/i.test(line)) { section = 'PURCHASE'; last = null; continue; }
    if (/^FEES(?: CHARGED)?$/i.test(line)) { section = 'FEE'; last = null; continue; }
    if (/^INTEREST(?: CHARGED)?$/i.test(line)) { section = 'INTEREST'; last = null; continue; }
    if (/^CASH ADVANCES?$/i.test(line)) { section = 'CASH_ADVANCE'; last = null; continue; }
    if (/^BALANCE TRANSFERS?$/i.test(line)) { section = 'BALANCE_TRANSFER'; last = null; continue; }
    // The table on later pages and the promotions detail are not transactions.
    if (/^(?:ACTIVITY AND PROMOTIONS DETAIL|INTEREST CHARGE CALCULATION|\d{4} Totals Year-to-Date)/i.test(line)) { section = null; last = null; continue; }
    const m = line.match(row);
    if (!m) {
      if (!last) continue;
      // "PROMOTIONAL PURCHASE: To avoid interest charges, please pay the above in full by 12/08/2027."
      const promo = line.match(/PROMOTIONAL PURCHASE:.*?in full by (\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      if (promo) { const d = date(promo[1]); if (d) last.description += ` · promotional: no interest if paid in full by ${d}`; continue; }
      // The store department under a purchase: "PLUMBING", "HARDWARE SEASONAL/GARDEN".
      const dept = line.replace(/\s+FEES$/, '');
      if (/^[A-Z][A-Z &/,.'-]{2,40}$/.test(dept) && !PAGE_NOISE.test(dept) && !/^(?:FEES|INTEREST)/.test(dept)) { last.description += ` · ${dept}`; last = null; continue; }
      if (!PAGE_NOISE.test(line)) last = null;
      continue;
    }
    const day = dated(m[1]);
    if (!day) continue;
    let description = m[3].trim();
    // Apple Card prints the Daily Cash earned ("2% $22.00") between the description and the amount.
    description = description.replace(/\s+\d{1,2}%\s+\$[\d,]*\.\d{2}$/, '').trim();
    let reference: string | null = null;
    if (hasRefs) {
      const words = description.split(' ');
      if (words.length > 1 && REF.test(words[words.length - 1])) { reference = words.pop()!; description = words.join(' '); }
    }
    if (!/[A-Za-z]/.test(description) || /^Page\b/i.test(description)) continue;
    let amount = money(m[4].replace(/[()]/g, ''));
    if (/^\(.*\)$/.test(m[4]) || m[5]) amount = -Math.abs(amount);
    if (!Number.isFinite(amount) || amount === 0 && !/\.00$/.test(m[4])) continue;
    const kind = kindOf(section, description, amount);
    const store = MERCHANTS.find(([re]) => re.test(description));
    const t: CardTextTransaction = {
      date: day, postDate: m[2] ? dated(m[2]) : null, description, merchant: store?.[1] ?? null,
      // Payments and credits take the balance down; a reversed payment puts it back up.
      amount: kind === 'PAYMENT' && REVERSAL.test(description) ? Math.abs(amount) : ['PAYMENT', 'CREDIT'].includes(kind) ? -Math.abs(amount) : Math.abs(amount),
      kind, category: kind === 'FEE' || kind === 'INTEREST' ? 'Fees & interest' : kind === 'PURCHASE' ? store?.[2] ?? null : null, cardholder: null,
      reference,
    };
    out.push(t);
    last = kind === 'PURCHASE' ? t : null;
  }
  return out;
}

/**
 * The transactions, only when they account for the whole change in balance.
 * Apple Card prints the month's interest as a total with no dated line; it
 * is added on the closing date. A list that still doesn't add up is missing
 * rows (a layout the reader doesn't know), and a partial list would skew the
 * card's spending, so none are kept — the summary still is.
 */
function reconciled(rows: CardTextTransaction[], change: number, interest: number | null, closing: string): CardTextTransaction[] {
  const total = (r: CardTextTransaction[]) => r.reduce((t, x) => t + x.amount, 0);
  if (Math.abs(total(rows) - change) <= 0.02) return rows;
  const i = Math.abs(interest ?? 0);
  if (i > 0 && !rows.some(r => r.kind === 'INTEREST') && Math.abs(total(rows) + i - change) <= 0.02) {
    return [...rows, { date: closing, postDate: null, description: 'Interest charge', merchant: null, amount: i, kind: 'INTEREST', category: 'Fees & interest', cardholder: null }];
  }
  return [];
}

export function readCardStatementText(input: string): CardTextReading | null {
  if (!input || input.length < 200) return null;
  const text = input.replace(/\r/g, '').replace(/[\u00a0\u2009]/g, ' ').replace(/[\u2013\u2014]/g, '—');
  // A card statement prints a minimum payment and a credit limit or a card-style summary.
  if (!/Minimum\s+Payment|Payment\s+Due\s+By/i.test(text)) return null;
  if (!/New\s+Balance|Total\s+Balance|Your\s+\w+\s+Balance/i.test(text)) return null;

  const firstPage = text.slice(0, Math.max(3000, text.search(/Page\s+1\s*(?:\/|of)/i)));
  const issuer = ISSUERS.find(([re]) => re.test(text))?.[1] ?? null;
  const cardName = CARD_NAMES.find(([re]) => re.test(firstPage))?.[1] ?? null;

  const last4 = text.match(/\baccount\s+number\s*:?\s*(?:[X*•]{2,}[\s-]*){2,3}(\d{4})\b/i)?.[1]
    ?? text.match(/\baccount\s+number\s+ending\s+in\s+(\d{4})\b/i)?.[1]
    ?? text.match(/(?:^|\n)[ \t]*(?:card|account)\s+ending\s+in\s+(\d{4})\b/i)?.[1]
    ?? null;

  // Dates: "Opening/Closing Date 04/04/26 - 05/03/26", "Statement Closing Date 05/12/2025", Apple's "Sep 1 — Sep 30, 2026".
  let periodStart: string | null = null;
  let closingDate: string | null = null;
  const oc = text.match(/Opening\s*\/\s*Closing\s+Date[ \t:]*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-—]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (oc) { periodStart = date(oc[1]); closingDate = date(oc[2]); }
  if (!closingDate) closingDate = dateAfter(text, ['Statement Closing Date', 'Closing Date', 'Statement Date', 'Closing date of billing cycle'], OTHER_CYCLE);
  const apple = text.match(new RegExp(String.raw`(${MONTH_NAME})\s+(\d{1,2})\s*—\s*(${MONTH_NAME})\s+(\d{1,2}),\s*(\d{4})`));
  if (!closingDate && apple) {
    closingDate = date(`${apple[3]} ${apple[4]}, ${apple[5]}`);
    const startMonth = MONTHS[apple[1].toLowerCase().slice(0, 3)], endMonth = MONTHS[apple[3].toLowerCase().slice(0, 3)];
    periodStart = iso(startMonth > endMonth ? Number(apple[5]) - 1 : Number(apple[5]), startMonth, Number(apple[2]));
  }
  if (!closingDate) return null;

  let dueDate = dateAfter(text, ['Payment Due Date', 'Payment Due By', 'Due Date']);
  let newBalance = figure(text, ['New Balance', 'Total Balance', 'Statement Balance'], OTHER_CYCLE);
  let minimumPayment = figure(text, ['Minimum Payment Due', 'Minimum Amount Due', 'Total Minimum Payment Due', 'Minimum Payment']);
  // Apple Card: "Your September Balance / Minimum Payment Due / Payment Due By" over "$4,676.48  $122.00  Oct 31, 2026".
  const box = text.match(new RegExp(String.raw`Your\s+\w+\s+Balance[\s\S]{0,200}?\n[ \t]*(\$[\d,]+\.\d{2})\s+(\$[\d,]+\.\d{2})\s+(${DATE})`, 'i'));
  if (box) {
    newBalance ??= money(box[1]);
    minimumPayment ??= money(box[2]);
    dueDate ??= date(box[3]);
  }
  if (minimumPayment == null) minimumPayment = figure(text, ['Payment Due']);

  const previousBalance = figure(text, ['Previous Balance', 'Previous Monthly Balance', 'Previous Statement Balance']);
  const paymentsOnly = printed(text, ['Payment, Credits', 'Payments, Credits', 'Payments and Other Credits', 'Payments and Credits', 'Total payments for this period', 'Payments']);
  const otherCredits = printed(text, ['Other Credits']);
  const purchases = figure(text, ['Purchases/Other Debits', 'Purchases and Adjustments', 'Purchases', 'Total charges, credits and returns']);
  const cashAdvances = figure(text, ['Cash Advances']);
  const balanceTransfers = figure(text, ['Balance Transfers']);
  const feesCharged = figure(text, ['Fees Charged', 'Total fees for this period', 'Total fees charged this period']);
  const interestCharged = figure(text, ['Interest Charged', 'Total interest for this period', 'Total interest for this month', 'Interest Charge on Purchases']);

  if (newBalance == null || previousBalance == null || paymentsOnly == null || purchases == null) return null;
  // What came off the balance: payments and credits, less any payment reversed (negative when reversals outweigh them).
  const paymentsCredits = Number((-(paidEffect(paymentsOnly) + paidEffect(otherCredits))).toFixed(2));
  // The summary must add up, or the figures came from the wrong places.
  const sum = previousBalance - paymentsCredits + purchases + Math.abs(cashAdvances ?? 0) + Math.abs(balanceTransfers ?? 0) + Math.abs(feesCharged ?? 0) + Math.abs(interestCharged ?? 0);
  if (Math.abs(sum - newBalance) > 0.02) return null;
  // A statement with a balance owed has a due date.
  if (!dueDate && newBalance > 0 && (minimumPayment ?? 0) > 0) return null;

  // "Only the minimum payment 12 years $5,150", "… 8 months $221".
  const payoff = text.match(/Only\s+(?:the\s+)?minimum(?:\s+payment)?\s+(\d{1,3})\s+(years?|months?)\s+\$([\d,]+)/i);
  const days = text.match(/Days\s+in\s+Billing\s+(?:Cycle|Period)[ \t:]*(\d{2})\b/i)?.[1] ?? text.match(/\b(\d{2})\s+Days\s+in\s+Billing\s+(?:Cycle|Period)/i)?.[1];
  // "Days in Billing Cycle 31" with only the closing date printed: the cycle opened 30 days before it closed.
  if (!periodStart && days) periodStart = new Date(Date.parse(`${closingDate}T00:00:00Z`) - (Number(days) - 1) * 86_400_000).toISOString().slice(0, 10);
  const dailyCash = figure(text, ['Total Daily Cash this month']);
  const lateFee = text.match(/late\s+fee\s+(?:of\s+)?up\s+to\s+\$\s?([\d,]+(?:\.\d{2})?)/i);
  const annualFee = figure(text, ['Annual Fee', 'Annual Membership Fee'], /No\s+$/i);
  // Customer service: the number by its label; Apple Card's "Contact us … at 877-255-5923".
  const PHONE = String.raw`(?:1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}`;
  const phone = text.match(new RegExp(String.raw`(?:Customer\s+Service|Account\s+Inquiries|Call\s+Customer\s+Service)[^\d\n]{0,80}?(?:\n[^\d\n]{0,80}?)?(${PHONE})`, 'i'))?.[1]
    ?? text.match(new RegExp(String.raw`Contact\s+us[^\n]{0,60}?(${PHONE})`, 'i'))?.[1] ?? null;
  // Where to pay: "Make your payment at chase.com/paycard", else the first site on the first page (not an email address).
  const SITE = String.raw`(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net)(?:\/[a-z0-9]+)?`;
  const loginUrl = text.match(new RegExp(String.raw`(?:payment\s+at|pay\s+online\s+at|Manage\s+your\s+account\s+online:?)\s+(${SITE})\b`, 'i'))?.[1]
    ?? firstPage.match(new RegExp(String.raw`(?<![@\w.])(${SITE})\b`, 'i'))?.[1] ?? null;
  // Points: Chase's "Total points transferred to Aeroplan 237" / "Total points earned this period".
  const points = text.match(/Total\s+points\s+transferred\s+to[\s\S]{0,80}?\n[ \t]*[A-Za-z®]+[ \t]+([\d,]+)[ \t]*(?:\n|$)/i)
    ?? text.match(/Total\s+points\s+earned(?:\s+this\s+(?:period|month))?[ \t:]+([\d,]+)\b/i);
  const program = /AEROPLAN/i.test(firstPage) ? 'Aeroplan' : /Ultimate\s+Rewards/i.test(text) ? 'Chase Ultimate Rewards' : /Membership\s+Rewards/i.test(text) ? 'Membership Rewards' : null;
  // "You must pay your promotional balance of $1,405.09 in full by 12/08/27 to avoid paying deferred interest charges."
  const promotions: CardPromotion[] = [];
  for (const pm of text.matchAll(/promotional\s+balance\s+of\s+\$\s?([\d,]+\.\d{2})\s+in\s+full\s+by\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/gi)) {
    const payBy = date(pm[2]);
    if (payBy && !promotions.some(x => x.payBy === payBy)) promotions.push({ balance: money(`$${pm[1]}`), payBy, description: 'Deferred interest: pay in full by this date or the interest from the purchase date is charged' });
  }
  promotions.sort((a, b) => a.payBy.localeCompare(b.payBy));
  const soonest = promotions.find(x => x.payBy >= closingDate) ?? null;
  const year = closingDate.slice(0, 4);
  const feesYtd = figure(text, [`Total Fees Charged in ${year}`, 'Total fees charged in', 'Total Fees Charged Year-to-Date']);
  const interestYtd = figure(text, [`Total Interest Charged in ${year}`, `Total interest charged in ${year}`, 'Total Interest Charged Year-to-Date']);
  const penalty = text.match(/Penalty\s+APR\s+(?:of\s+)?(\d{1,2}(?:\.\d{1,3})?)\s?%/i);

  return {
    issuer, cardName, network: null, last4, cardholderName: null,
    periodStart, closingDate, dueDate,
    previousBalance, paymentsCredits, purchases, balanceTransfers: balanceTransfers == null ? null : Math.abs(balanceTransfers),
    cashAdvances: cashAdvances == null ? null : Math.abs(cashAdvances),
    feesCharged: feesCharged == null ? null : Math.abs(feesCharged), interestCharged: interestCharged == null ? null : Math.abs(interestCharged),
    newBalance, minimumPayment: minimumPayment == null ? null : Math.abs(minimumPayment),
    creditLimit: figure(text, ['Credit Limit', 'Total Credit Line', 'Credit Line']),
    cashAdvanceLimit: figure(text, ['Cash Access Line', 'Cash Advance Limit', 'Cash Credit Line']),
    availableCredit: figure(text, ['Available Credit', 'Total Available Credit']),
    purchaseApr: rate(text, ['Purchases', 'Standard Purchases', 'Revolving Balance', 'Annual Percentage Rate (APR)']),
    cashAdvanceApr: rate(text, ['Cash Advances', 'Standard Cash Advance', 'Cash Advance']),
    balanceTransferApr: rate(text, ['Balance Transfers', 'Balance Transfer']),
    penaltyApr: penalty ? Number(penalty[1]) : null,
    introApr: soonest ? 0 : null, introAprType: soonest ? 'PURCHASE' : null, introAprEndDate: soonest?.payBy ?? null,
    pastDueAmount: figure(text, ['Past Due Amount', 'Amount Past Due']), feesYtd, interestYtd, promotions,
    daysInCycle: days ? Number(days) : null,
    lateFee: lateFee ? Number(lateFee[1].replace(/,/g, '')) : null, annualFee: annualFee != null && annualFee > 0 ? annualFee : null,
    foreignTransactionFee: null, balanceTransferFee: null, cashAdvanceFee: null,
    phone, loginUrl: loginUrl ? loginUrl.replace(/^https?:\/\//, '').toLowerCase() : null,
    rewardsProgram: dailyCash != null ? 'Daily Cash' : program, rewardsType: dailyCash != null ? 'CASHBACK' : program ? 'POINTS' : null,
    rewardsEarned: dailyCash ?? (points ? Number(points[1].replace(/,/g, '')) : null), rewardsBalance: null,
    minPayoffMonths: payoff ? Number(payoff[1]) * (/^year/i.test(payoff[2]) ? 12 : 1) : null, minPayoffTotal: payoff ? money(`$${payoff[3]}`) : null,
    authorizedUsers: [],
    transactions: reconciled(transactionsOf(text, closingDate), newBalance - previousBalance, interestCharged, closingDate),
  };
}
