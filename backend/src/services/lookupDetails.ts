/**
 * Filling in what a bill lookup page asks for, from the bills already on
 * file: the customer number, the name on the bill and the pay-online
 * address. Bills read before these were captured carry none of them, so the
 * owner was asked to type what Sollux already holds. For each account with
 * no portal login that is missing them, the newest bill's PDF is read once
 * more for just these, and kept by learnProviderWebsite (never over what
 * is set). Runs in the background; a few cents an account.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';
import { askClaude, jsonIn, needsJson } from '../ai/models';
import { withAiContext, checkBudget } from '../ai/meter';
import { downloadDocument } from './s3Service';
import { fileBlockForClaude } from './pdfImportService';
import { learnProviderWebsite } from './providerWebsite';

const running = new Map<string, { total: number; done: number; filled: number }>();
export const lookupFillState = (userId: string) => running.get(userId) ?? null;

const PROMPT = `From this utility bill, read only what a biller's "find your bill" page asks for. Return ONLY JSON:
{"customerNumber": string or null — a Customer Number / Customer ID / Customer # printed separately from the account number; null when the bill prints only one number,
 "nameOnBill": string or null — the customer name the bill is addressed to, exactly as printed,
 "accountNumber": string or null — the account number as printed,
 "providerWebsite": string or null — the address printed for paying or viewing the bill online, exactly as printed}`;

/** Accounts that would fetch from a lookup page if these were known. */
async function candidates(userId: string) {
  const accounts = await db.utilityAccount.findMany({
    where: { property: { userId }, isActive: true, usernameEnc: null, escrowLoanId: null, OR: [{ lookupCustomerId: null }, { lookupName: null }, { loginUrl: null }] },
    select: { id: true, providerName: true, statements: { where: { pdfS3Key: { not: null } }, orderBy: { statementDate: 'desc' }, take: 1, select: { pdfS3Key: true, rawDataJson: true } } },
  });
  return accounts.filter(a => a.statements.length);
}

/** Starts filling in the background; the number of accounts it will read, or null when one is already running. */
export async function fillLookupDetails(userId: string): Promise<number | null> {
  const cur = running.get(userId);
  if (cur && cur.done < cur.total) return null;
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('AI is not configured.'), { status: 503 });
  await withAiContext({ userId }, () => checkBudget('lookup-details'));
  const list = await candidates(userId);
  const state = { total: list.length, done: 0, filled: 0 };
  running.set(userId, state);
  void withAiContext({ userId }, async () => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    try {
      for (const a of list) {
        try {
          const st = a.statements[0];
          // What the earlier reading already captured costs nothing.
          const known = (st.rawDataJson ?? {}) as { providerWebsite?: string | null; customerNumber?: string | null; nameOnBill?: string | null };
          let found = known;
          if (!known.customerNumber && !known.nameOnBill) {
            const buf = await downloadDocument(st.pdfS3Key!);
            const name = st.pdfS3Key!.split('/').pop() || 'bill.pdf';
            const { text } = await askClaude(client, {
              label: name, feature: 'lookup-details', maxTokens: 400, check: needsJson, effort: 'low',
              messages: [{ role: 'user', content: [await fileBlockForClaude(buf, name), { type: 'text', text: PROMPT }] }],
            });
            found = { ...known, ...(jsonIn(text) ?? {}) };
          }
          const before = await db.utilityAccount.findUnique({ where: { id: a.id }, select: { lookupCustomerId: true, lookupName: true, loginUrl: true } });
          await learnProviderWebsite(a.id, found);
          const after = await db.utilityAccount.findUnique({ where: { id: a.id }, select: { lookupCustomerId: true, lookupName: true, loginUrl: true } });
          if (JSON.stringify(before) !== JSON.stringify(after)) state.filled++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[LookupDetails] ${a.providerName}: ${msg}`);
          if (/budget|allowance/i.test(msg)) break;
        }
        state.done++;
      }
    } finally {
      // Kept a minute so the page can read the result, then cleared.
      setTimeout(() => running.delete(userId), 60_000);
    }
  });
  return list.length;
}
