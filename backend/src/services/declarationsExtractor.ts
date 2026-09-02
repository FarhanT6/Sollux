import Anthropic from '@anthropic-ai/sdk';

/**
 * Reads an insurance declarations page.
 *
 * Separate from the bill extractor because the documents ask different
 * questions. A bill has an amount due, a due date and usage; a declarations
 * page has coverage limits, a term, and a premium that may be quoted for the
 * year while being paid monthly. Running a bill prompt over a dec page returns
 * an amount due of nothing and loses everything that matters.
 *
 * Policy packets are long — the sample was 16 pages, of which about two carry
 * data and the rest is statutory notice. The model is told to find the
 * declarations page rather than read sequentially.
 */

export interface ExtractedPolicyData {
  carrier: string | null;
  policyNumber: string | null;
  namedInsured: string | null;
  propertyAddress: string | null;
  policyType: 'PROPERTY' | 'LIABILITY' | 'FLOOD' | 'UMBRELLA' | 'OTHER' | null;

  effectiveDate: string | null;   // ISO
  expirationDate: string | null;  // ISO

  // What one bill asks for, and how often it comes.
  premiumAmount: number | null;
  premiumFrequency: 'MONTHLY' | 'SEMI_ANNUAL' | 'ANNUAL' | null;
  // The whole term's premium, when it differs from the installment.
  termPremium: number | null;

  dwellingLimit: number | null;
  otherStructuresLimit: number | null;
  personalPropertyLimit: number | null;
  lossOfUseLimit: number | null;
  liabilityLimit: number | null;
  medicalPaymentsLimit: number | null;
  deductible: number | null;
  windHailDeductible: string | null;
  replacementCostBasis: string | null;

  agentName: string | null;
  agentPhone: string | null;
  agentEmail: string | null;
  mortgageePayee: string | null;

  notes: string | null;
}

const PROMPT = `You are reading an insurance policy document to extract its declarations page.

Most of a policy packet is statutory notices and boilerplate. Find the declarations
page — the page listing coverages, limits, the policy period and the premium — and
read the values from there. Ignore the disclosure pages that merely describe what
coverage types mean.

Return ONLY a JSON object, no commentary:

{
  "carrier": string or null — the insurer's name, not the agency or broker,
  "policyNumber": string or null — exactly as printed, keep any dashes,
  "namedInsured": string or null,
  "propertyAddress": string or null — the insured location, not the mailing address, when they differ,
  "policyType": "PROPERTY" | "LIABILITY" | "FLOOD" | "UMBRELLA" | "OTHER" or null,

  "effectiveDate": "YYYY-MM-DD" or null,
  "expirationDate": "YYYY-MM-DD" or null,

  "premiumAmount": number or null — what ONE payment is. If the policy is billed monthly, this is the monthly figure; if paid once for the term, it is the term total,
  "premiumFrequency": "MONTHLY" | "SEMI_ANNUAL" | "ANNUAL" or null — how often a payment is made,
  "termPremium": number or null — the total premium for the whole policy term. When a policy is quoted as a year's total but paid monthly, put the year's total here and the monthly payment in premiumAmount. When the term is paid in one go, this may repeat premiumAmount. Include taxes and policy fees in the total the policyholder actually pays,

  "dwellingLimit": number or null — Coverage A / dwelling,
  "otherStructuresLimit": number or null — Coverage B,
  "personalPropertyLimit": number or null — Coverage C / contents,
  "lossOfUseLimit": number or null — Coverage D / loss of use / fair rental value,
  "liabilityLimit": number or null — personal or premises liability, per occurrence,
  "medicalPaymentsLimit": number or null,
  "deductible": number or null — the all-perils deductible as a dollar amount,
  "windHailDeductible": string or null — often a percentage rather than a dollar figure, so keep it as written ("2% of Coverage A"),
  "replacementCostBasis": string or null — "Guaranteed Replacement Cost", "Extended Replacement Cost", "Replacement Cost", or "Actual Cash Value", whichever the document indicates,

  "agentName": string or null,
  "agentPhone": string or null,
  "agentEmail": string or null,
  "mortgageePayee": string or null — the mortgagee or loss payee named on the policy,

  "notes": string or null — anything materially unusual: a vacancy clause, an exclusion added by endorsement, a scheduled item
}

Rules:
- Report dollar amounts as plain numbers: $898,000 is 898000. No currency symbols or commas.
- A premium quoted for a term and a premium billed monthly are different numbers. Do not put one where the other belongs — this decides whether the policy is reported as a monthly or an annual cost.
- Use null for anything not stated. Do not infer a limit from the property's value, or a deductible from what is typical.
- If the document contains several policies, read the one whose declarations page is most complete and note the others in "notes".`;

let client: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — declarations extraction needs it.');
    client = new Anthropic({ apiKey });
  }
  return client;
}

export async function extractDeclarations(
  pdfBuffer: Buffer,
  filename: string,
): Promise<ExtractedPolicyData> {
  const anthropic = getAnthropic();
  console.log(`[Declarations] ${filename}: ${Math.round(pdfBuffer.length / 1024)}KB`);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
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

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Could not read a declarations page from ${filename}.`);

  const parsed = JSON.parse(match[0]) as Partial<ExtractedPolicyData>;

  // Everything is optional: a dec page that omits a field is normal, and a
  // missing key must not become undefined-shaped data downstream.
  return {
    carrier: parsed.carrier ?? null,
    policyNumber: parsed.policyNumber ?? null,
    namedInsured: parsed.namedInsured ?? null,
    propertyAddress: parsed.propertyAddress ?? null,
    policyType: parsed.policyType ?? null,
    effectiveDate: parsed.effectiveDate ?? null,
    expirationDate: parsed.expirationDate ?? null,
    premiumAmount: parsed.premiumAmount ?? null,
    premiumFrequency: parsed.premiumFrequency ?? null,
    termPremium: parsed.termPremium ?? null,
    dwellingLimit: parsed.dwellingLimit ?? null,
    otherStructuresLimit: parsed.otherStructuresLimit ?? null,
    personalPropertyLimit: parsed.personalPropertyLimit ?? null,
    lossOfUseLimit: parsed.lossOfUseLimit ?? null,
    liabilityLimit: parsed.liabilityLimit ?? null,
    medicalPaymentsLimit: parsed.medicalPaymentsLimit ?? null,
    deductible: parsed.deductible ?? null,
    windHailDeductible: parsed.windHailDeductible ?? null,
    replacementCostBasis: parsed.replacementCostBasis ?? null,
    agentName: parsed.agentName ?? null,
    agentPhone: parsed.agentPhone ?? null,
    agentEmail: parsed.agentEmail ?? null,
    mortgageePayee: parsed.mortgageePayee ?? null,
    notes: parsed.notes ?? null,
  };
}
