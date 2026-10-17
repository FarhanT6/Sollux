/**
 * Where each provider lives online: its website, and the sign-in page when
 * it has a known one. One table serves three things —
 *   - the "Open website" / "Pay online" link on an account (no typing it in);
 *   - where the portal agent starts when the owner has not set a login page;
 *   - telling which account a "your bill is ready" email is about, by the
 *     sender's domain.
 * A provider not listed here is learned from its own bills: the address a
 * statement prints ("Access your account online at nationwide.com") is
 * saved on the account the first time one is filed (learnProviderWebsite).
 *
 * Only addresses known to be right are listed; a wrong link is worse than
 * none. Add a provider by name pattern, site, and the domains its email
 * comes from.
 */
export interface ProviderSite {
  /** Matches the account's provider name (or slug). */
  match: RegExp;
  site: string;
  /** The sign-in or account page, when it differs from the site. */
  login?: string;
  /** Domains its websites and emails use. */
  domains: string[];
}

const DIRECTORY: ProviderSite[] = [
  // Electric and gas
  { match: /\bsdg\s*&?\s*e\b|san diego gas/i, site: 'https://www.sdge.com', login: 'https://myaccount.sdge.com', domains: ['sdge.com'] },
  { match: /socal\s*gas|southern california gas/i, site: 'https://www.socalgas.com', login: 'https://myaccount.socalgas.com', domains: ['socalgas.com'] },
  { match: /\biid\b|imperial irrigation/i, site: 'https://www.iid.com', login: 'https://myaccount.iid.com/Portal/default.aspx', domains: ['iid.com'] },
  { match: /\bfpl\b|florida power/i, site: 'https://www.fpl.com', domains: ['fpl.com'] },
  { match: /duke energy/i, site: 'https://www.duke-energy.com', domains: ['duke-energy.com'] },
  { match: /\bpg\s*&?\s*e\b|pacific gas/i, site: 'https://www.pge.com', domains: ['pge.com'] },
  { match: /\bsce\b|southern california edison/i, site: 'https://www.sce.com', domains: ['sce.com'] },
  // Internet and phone
  { match: /\bcox\b/i, site: 'https://www.cox.com', domains: ['cox.com', 'cox.net'] },
  { match: /t-?mobile/i, site: 'https://www.t-mobile.com', login: 'https://account.t-mobile.com', domains: ['t-mobile.com'] },
  { match: /\bat\s*&\s*t\b|\batt\b/i, site: 'https://www.att.com', login: 'https://www.att.com/my/', domains: ['att.com', 'att.net'] },
  { match: /spectrum|charter comm/i, site: 'https://www.spectrum.net', domains: ['spectrum.net', 'spectrum.com', 'charter.com'] },
  { match: /verizon/i, site: 'https://www.verizon.com', domains: ['verizon.com', 'verizonwireless.com'] },
  { match: /xfinity|comcast/i, site: 'https://www.xfinity.com', domains: ['xfinity.com', 'comcast.net'] },
  // Trash
  { match: /\bwm\b|waste management/i, site: 'https://www.wm.com', domains: ['wm.com'] },
  { match: /republic services/i, site: 'https://www.republicservices.com', domains: ['republicservices.com'] },
  { match: /\bedco\b/i, site: 'https://www.edcodisposal.com', domains: ['edcodisposal.com'] },
  // Water and cities
  { match: /vista irrigation/i, site: 'https://www.vidwater.org', domains: ['vidwater.org'] },
  { match: /city of oceanside|oceanside utilit/i, site: 'https://www.ci.oceanside.ca.us', domains: ['ci.oceanside.ca.us', 'oceansideca.org'] },
  { match: /brevard county/i, site: 'https://www.brevardfl.gov', domains: ['brevardfl.gov'] },
  // Insurance
  { match: /nationwide/i, site: 'https://www.nationwide.com', login: 'https://www.nationwide.com/bill-pay', domains: ['nationwide.com'] },
  { match: /progressive/i, site: 'https://www.progressive.com', domains: ['progressive.com'] },
  { match: /safeco/i, site: 'https://www.safeco.com', domains: ['safeco.com'] },
  { match: /hartford/i, site: 'https://www.thehartford.com', domains: ['thehartford.com'] },
  { match: /bamboo/i, site: 'https://www.bambooinsurance.com', domains: ['bambooinsurance.com'] },
  { match: /blue\s*shield/i, site: 'https://www.blueshieldca.com', domains: ['blueshieldca.com'] },
  // HOAs and other
  { match: /prescott|river ranch/i, site: 'https://www.townsq.io', domains: ['townsq.io', 'prescottmgt.com'] },
  { match: /eternal hills|dignity memorial/i, site: 'https://www.dignitymemorial.com', domains: ['dignitymemorial.com'] },
  // Loans and banks
  { match: /mohela/i, site: 'https://www.mohela.com', domains: ['mohela.com'] },
  { match: /nelnet/i, site: 'https://www.nelnet.com', domains: ['nelnet.com', 'nelnet.net'] },
  { match: /\bsdccu\b|san diego county credit/i, site: 'https://www.sdccu.com', domains: ['sdccu.com'] },
  { match: /service finance/i, site: 'https://www.svcfin.com', domains: ['svcfin.com'] },
];

export function findProvider(name: string | null | undefined, slug?: string | null): ProviderSite | null {
  const hay = `${name ?? ''} ${slug ?? ''}`;
  return DIRECTORY.find(p => p.match.test(hay)) ?? null;
}

/** Where to send the owner (and the agent): their own saved page, else the directory's. */
export function websiteFor(account: { providerName: string; providerSlug?: string | null; loginUrl?: string | null }): { url: string; source: 'saved' | 'directory' } | null {
  if (account.loginUrl) return { url: account.loginUrl, source: 'saved' };
  const p = findProvider(account.providerName, account.providerSlug);
  return p ? { url: p.login ?? p.site, source: 'directory' } : null;
}

/** The provider a sender's address belongs to, by domain (bills@e.sdge.com → SDG&E). */
export function providerForEmail(from: string): ProviderSite | null {
  const domain = (from.match(/@([\w.-]+)/)?.[1] ?? '').toLowerCase();
  if (!domain) return null;
  return DIRECTORY.find(p => p.domains.some(d => domain === d || domain.endsWith(`.${d}`))) ?? null;
}

/**
 * A provider's web address as its own statement prints it: "Access your
 * account online at nationwide.com", "Visit our website www.dignitymemorial.com",
 * "visit www.townsq.io". Only a bare domain or an https URL near words about
 * paying or an account online — never an email address, never a PO box.
 */
export function websiteFromText(text: string): string | null {
  if (!text) return null;
  const near = /(online|website|visit|pay|account|log ?in|sign ?in|manage)/i;
  const re = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|gov|io|us|coop))(\/[\w\-./?=&%]*)?/gi;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (text[i - 1] === '@') continue;                      // part of an email address
    const around = text.slice(Math.max(0, i - 80), i + m[0].length + 20);
    if (!near.test(around)) continue;
    let host = m[1].replace(/^https?:\/\//i, '').toLowerCase();
    if (/^(gmail|yahoo|outlook|hotmail|icloud)\./.test(host)) continue;
    // A text layer that runs words together turns "Access your account
    // online at nationwide.com" into one long "domain". A real name is short
    // and does not carry the sentence around it.
    const label = host.replace(/^www\./, '').split('.')[0];
    if (label.length > 24 || /(account|online|visit|website|youraccount)/.test(label)) continue;
    if (!host.startsWith('www.') && host.split('.').length === 2) host = `www.${host}`;
    return `https://${host}${(m[2] ?? '').replace(/[.,)]+$/, '')}`;
  }
  return null;
}
