import { db } from '../config/db';
import { websiteFromText, isLookupPage } from '../lib/providerDirectory';

/**
 * What a filed bill tells Sollux about how to fetch the next one, kept on an
 * account that does not know it yet — never over what is already set:
 *  - the provider's web address the bill printed (the owner's "Open website"
 *    link and the portal agent's starting page); a bill lookup page it
 *    printed replaces a plain home page on an account with no login;
 *  - the customer number and the name on the bill, which bill lookup pages
 *    (InvoiceCloud, Tyler Munis) ask for beside the account number.
 * What the AI read as printed ("nationwide.com/bill-pay") goes through the
 * same check as the text reader's, so only a plausible https address is kept.
 */
export async function learnProviderWebsite(utilityAccountId: string, ex: { providerWebsite?: string | null; customerNumber?: string | null; nameOnBill?: string | null }): Promise<void> {
  const url = ex.providerWebsite ? websiteFromText(`website ${ex.providerWebsite}`) : null;
  const acct = await db.utilityAccount.findUnique({
    where: { id: utilityAccountId },
    select: { loginUrl: true, usernameEnc: true, lookupCustomerId: true, lookupName: true },
  }).catch(() => null);
  if (!acct) return;
  const data: { loginUrl?: string; lookupCustomerId?: string; lookupName?: string } = {};
  if (url && (!acct.loginUrl || (!acct.usernameEnc && isLookupPage(url) && !isLookupPage(acct.loginUrl)))) data.loginUrl = url;
  const customer = ex.customerNumber?.trim();
  if (customer && !acct.lookupCustomerId && /\d/.test(customer) && customer.length <= 40) data.lookupCustomerId = customer;
  const name = ex.nameOnBill?.trim();
  if (name && !acct.lookupName && name.length <= 120) data.lookupName = name;
  if (Object.keys(data).length) await db.utilityAccount.update({ where: { id: utilityAccountId }, data }).catch(() => {});
}
