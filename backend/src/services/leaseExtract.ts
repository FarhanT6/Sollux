import Anthropic from '@anthropic-ai/sdk';
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

export interface ExtractedLeaseTerms {
  startDate: string | null;      // YYYY-MM-DD
  endDate: string | null;        // YYYY-MM-DD, null for month-to-month
  rentAmount: number | null;
  securityDeposit: number | null;
  leaseType: 'FIXED_TERM' | 'MONTH_TO_MONTH' | null;
  rentDueDay: number | null;     // 1-31
  lateFeeAmount: number | null;
  lateFeePercent: number | null;
  lateFeeGraceDays: number | null;
  tenantNames: string[];
  businessName: string | null;
  notes: string | null;
}

const PROMPT = `You are reading a residential or commercial LEASE AGREEMENT. Extract the lease terms and return ONLY a JSON object with these exact keys:

{
  "startDate": "YYYY-MM-DD or null — the lease commencement date",
  "endDate": "YYYY-MM-DD or null — the lease expiration/termination date. null if month-to-month with no fixed end",
  "rentAmount": "number or null — the monthly rent",
  "securityDeposit": "number or null",
  "leaseType": "FIXED_TERM or MONTH_TO_MONTH or null",
  "rentDueDay": "number 1-31 or null — day of month rent is due",
  "lateFeeAmount": "number or null — flat late fee, if stated as a dollar amount",
  "lateFeePercent": "number or null — late fee as a percent, if stated as a percentage",
  "lateFeeGraceDays": "number or null — days after the due date before a late fee applies",
  "tenantNames": ["array of tenant full names on the lease; empty array if unclear"],
  "businessName": "string or null — for a commercial lease, the business/entity name",
  "notes": "string or null — anything notable about the term (e.g. renewal options)"
}

Rules:
- Use null when a value is not clearly stated. Do NOT guess.
- Dates must be YYYY-MM-DD.
- Amounts must be plain numbers (no $ or commas).
- Return ONLY the JSON object, no explanation.`;

// Read a lease PDF and pull out its terms. Used to pre-fill / suggest lease
// fields when a lease agreement is uploaded — the user confirms before saving.
export async function extractLeaseTerms(pdfBuffer: Buffer, filename: string): Promise<ExtractedLeaseTerms> {
  const anthropic = new Anthropic({
    apiKey: loadAnthropicKey(),
    defaultHeaders: { 'anthropic-beta': 'pdfs-2024-09-25' },
  });

  console.log(`[LeaseExtract] ${filename}: ${Math.round(pdfBuffer.length / 1024)}KB`);

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
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not read lease terms from that document.');

  const data = JSON.parse(jsonMatch[0]) as ExtractedLeaseTerms;
  if (!Array.isArray(data.tenantNames)) data.tenantNames = [];
  return data;
}
