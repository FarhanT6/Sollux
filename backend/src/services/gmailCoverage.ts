/**
 * Which bills reach Sollux from Gmail, and which do not.
 *
 * For every provider the owner has accounts with, over the last 45 days:
 *  - the emails from it that were filed;
 *  - the emails from it that were not: only on the provider's site, failed,
 *    waiting in review, or skipped (with the reason);
 *  - each of its accounts' newest bill and where that bill came from
 *    (email, upload, Drive, a portal, typed in).
 * And bill-like emails from senders that match no provider at all.
 *
 * An email is tied to a provider by what has already been filed from that
 * sender, else by its sender name, address or subject naming the provider.
 */
import { db } from '../config/db';
import { overdueAfterDays } from '../lib/billCadence';
import { providersLookAlike, compact } from './providerMatch';

const DAY = 24 * 60 * 60 * 1000;
const NOT_FILED = ['online', 'error', 'failed', 'review', 'skipped'];
// A skip that says the email was looked at and judged not a bill is not a missed bill.
const HARMLESS_SKIP = /payment confirmation|receipt|same email already read|not a bill|estimate|recorded as an expense/i;
// Bill platforms that send for many providers: their address says nothing about whose bill it is.
const PLATFORMS = /invoicecloud|onlinebiller|myonlinebill|municipalonlinepayments|paymentus|doxo|xpressbillpay|billmatrix|kubra|incode/i;

export type CoverageStatus = 'not_extracted' | 'partial' | 'no_email' | 'ok';

function senderParts(from: string | null) {
  const f = from ?? '';
  const address = (f.match(/<([^>]+)>/)?.[1] ?? f).trim().toLowerCase();
  // '"\\"Intuit E-Commerce Service\\"" <…>' → 'Intuit E-Commerce Service'
  const name = f.replace(/<[^>]*>/, '').replace(/[\\"']/g, '').replace(/\s+/g, ' ').trim();
  const domain = address.split('@')[1] ?? '';
  return { address, name, domain };
}

export async function gmailCoverage(userId: string) {
  const since = new Date(Date.now() - 45 * DAY);
  const [accounts, messages] = await Promise.all([
    db.utilityAccount.findMany({
      where: { property: { userId }, isActive: true },
      select: {
        id: true, providerName: true, billingCadence: true, escrowLoanId: true, propertyId: true,
        property: { select: { address: true, nickname: true } },
        statements: { where: { isScheduled: false }, orderBy: { statementDate: 'desc' }, take: 1, select: { statementDate: true, rawDataJson: true, sourceType: true } },
      },
    }),
    db.inboxMessage.findMany({
      where: { userId, OR: [{ receivedAt: { gte: since } }, { receivedAt: null, createdAt: { gte: since } }] },
      orderBy: { receivedAt: 'desc' }, take: 3000,
      select: { id: true, fromAddress: true, subject: true, receivedAt: true, outcome: true, detail: true, utilityAccountId: true, gmailToken: { select: { email: true } } },
    }),
  ]);

  // Providers, one group per name that looks alike ("SDGE" / "SDG&E").
  const groups: { provider: string; accountIds: Set<string> }[] = [];
  for (const a of accounts) {
    const g = groups.find(x => providersLookAlike(x.provider, a.providerName));
    if (g) g.accountIds.add(a.id); else groups.push({ provider: a.providerName, accountIds: new Set([a.id]) });
  }
  const groupOfAccount = new Map<string, number>();
  groups.forEach((g, i) => g.accountIds.forEach(id => groupOfAccount.set(id, i)));

  // Senders already tied to a provider by an email filed to one of its accounts.
  const learned = new Map<string, number>();
  for (const m of messages) {
    if (!m.utilityAccountId) continue;
    const gi = groupOfAccount.get(m.utilityAccountId);
    const { address } = senderParts(m.fromAddress);
    if (gi != null && address && !PLATFORMS.test(address)) learned.set(address, gi);
  }

  const groupFor = (m: typeof messages[number]): number | null => {
    if (m.utilityAccountId && groupOfAccount.has(m.utilityAccountId)) return groupOfAccount.get(m.utilityAccountId)!;
    const { address, name, domain } = senderParts(m.fromAddress);
    if (learned.has(address)) return learned.get(address)!;
    const subject = m.subject ?? '';
    const domainRoot = PLATFORMS.test(domain) ? '' : domain.split('.').slice(-2, -1)[0] ?? '';
    for (let i = 0; i < groups.length; i++) {
      const p = groups[i].provider;
      const cp = compact(p);
      if (name && providersLookAlike(name, p)) return i;
      if (domainRoot.length >= 3 && (providersLookAlike(domainRoot, p) || (cp.length >= 4 && (domainRoot.includes(cp) || cp.includes(domainRoot))))) return i;
      if (cp.length >= 5 && compact(subject).includes(cp)) return i;
    }
    return null;
  };

  type Msg = { id: string; receivedAt: Date | null; subject: string | null; from: string | null; mailbox: string; outcome: string; detail: string | null };
  const filed = groups.map(() => 0);
  const missed: Msg[][] = groups.map(() => []);
  const unmatched = new Map<string, { from: string; name: string; domain: string; count: number; latest: Msg }>();
  // The owner's own inboxes: mail from them is a forward or a note, not a provider.
  const ownInboxes = new Set(messages.map(m => m.gmailToken.email.toLowerCase()));
  for (const m of messages) {
    const gi = groupFor(m);
    const msg: Msg = { id: m.id, receivedAt: m.receivedAt, subject: m.subject, from: m.fromAddress, mailbox: m.gmailToken.email, outcome: m.outcome, detail: m.detail };
    const notFiled = NOT_FILED.includes(m.outcome) && !(m.outcome === 'skipped' && m.detail && HARMLESS_SKIP.test(m.detail));
    if (gi != null) {
      if (['filed', 'notice', 'policy'].includes(m.outcome)) filed[gi]++;
      else if (notFiled) missed[gi].push(msg);
    } else if (['online', 'error', 'failed', 'review'].includes(m.outcome)) {
      // Bill-like mail from someone who matches no account: maybe an account Sollux does not have.
      // Not a provider: the owner's own address, or something forwarded by hand ("Fwd:", "FW:").
      const { address, name, domain } = senderParts(m.fromAddress);
      if (ownInboxes.has(address) || /^\s*(fwd?|fw)\s*:/i.test(m.subject ?? '')) continue;
      const key = address || (m.fromAddress ?? '?');
      const u = unmatched.get(key);
      if (u) u.count++; else unmatched.set(key, { from: m.fromAddress ?? key, name: name || address, domain, count: 1, latest: msg });
    }
  }

  const sourceOf = (s: { rawDataJson: unknown; sourceType: string } | undefined) => {
    if (!s) return null;
    const src = (s.rawDataJson as any)?.source as string | undefined;
    if (src === 'email') return 'email';
    if (src === 'portal') return 'portal';
    if (src === 'drive_import') return 'Drive';
    if (src === 'pdf_import') return 'upload';
    if (s.sourceType === 'SCRAPER') return 'portal sync';
    return s.rawDataJson ? 'import' : 'typed in';
  };
  const cadenceDays = overdueAfterDays;

  const providers = groups.map((g, i) => {
    const accts = accounts.filter(a => g.accountIds.has(a.id)).map(a => {
      const last = a.statements[0];
      const limit = a.escrowLoanId ? null : cadenceDays(a.billingCadence);
      const days = last ? Math.floor((Date.now() - last.statementDate.getTime()) / DAY) : null;
      return {
        utilityAccountId: a.id, propertyId: a.propertyId, property: a.property.nickname || a.property.address,
        lastBill: last?.statementDate ?? null, lastBillSource: sourceOf(last), overdue: limit != null && (days == null || days > limit),
      };
    });
    const n = missed[i].length;
    const status: CoverageStatus = n && !filed[i] ? 'not_extracted' : n ? 'partial' : filed[i] ? 'ok' : 'no_email';
    return { provider: g.provider, status, filed: filed[i], notExtracted: missed[i].slice(0, 30), notExtractedCount: n, accounts: accts };
  });
  const order: Record<CoverageStatus, number> = { not_extracted: 0, partial: 1, no_email: 2, ok: 3 };
  providers.sort((a, b) => order[a.status] - order[b.status] || (b.accounts.some(x => x.overdue) ? 1 : 0) - (a.accounts.some(x => x.overdue) ? 1 : 0) || a.provider.localeCompare(b.provider));

  return {
    since,
    providers,
    unmatched: [...unmatched.values()].sort((a, b) => b.count - a.count).slice(0, 50),
  };
}
