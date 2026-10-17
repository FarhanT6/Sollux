import { db } from '../config/db';
import { websiteFromText } from '../lib/providerDirectory';

/**
 * Keep the provider's web address a filed bill printed, on an account that
 * has none: the owner's "Open website" link and the portal agent's starting
 * page then come for free. Never overwrites an address already set. What
 * the AI read as printed ("nationwide.com/bill-pay") goes through the same
 * check as the text reader's, so only a plausible https address is kept.
 */
export async function learnProviderWebsite(utilityAccountId: string, ex: { providerWebsite?: string | null }): Promise<void> {
  const url = ex.providerWebsite ? websiteFromText(`website ${ex.providerWebsite}`) : null;
  if (!url) return;
  await db.utilityAccount.updateMany({ where: { id: utilityAccountId, loginUrl: null }, data: { loginUrl: url } }).catch(() => {});
}
