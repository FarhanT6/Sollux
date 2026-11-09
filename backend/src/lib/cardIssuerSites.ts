/**
 * Where a card's statements are online, when neither the owner nor a statement
 * gave a sign-in page: the issuer's home page (the portal agent finds Sign in
 * from there). Store cards go to the bank that issues them.
 */
const SITES: { match: RegExp; site: string }[] = [
  { match: /apple\s*card|goldman/i, site: 'https://card.apple.com' },
  { match: /paypal/i, site: 'https://www.paypal.com' },
  { match: /lowe'?s|synchrony|amazon\s+store|care\s*credit/i, site: 'https://www.mysynchrony.com' },
  { match: /chase|freedom|sapphire|amazon\s+prime/i, site: 'https://www.chase.com' },
  { match: /\bciti|home\s*depot|costco/i, site: 'https://www.citi.com' },
  { match: /wells\s*fargo/i, site: 'https://www.wellsfargo.com' },
  { match: /capital\s*one|quicksilver|venture/i, site: 'https://www.capitalone.com' },
  { match: /american\s+express|\bamex\b/i, site: 'https://www.americanexpress.com' },
  { match: /discover/i, site: 'https://www.discover.com' },
  { match: /bank\s+of\s+america|\bbofa\b/i, site: 'https://www.bankofamerica.com' },
  { match: /u\.?s\.?\s*bank/i, site: 'https://www.usbank.com' },
  { match: /barclay/i, site: 'https://www.barclaycardus.com' },
];

/** The issuer's site for a card, by its issuer and name; null when unknown. */
export function cardIssuerSite(card: { issuer?: string | null; name?: string | null }): string | null {
  const text = `${card.issuer ?? ''} ${card.name ?? ''}`;
  return SITES.find(s => s.match.test(text))?.site ?? null;
}

/** A web address as the owner typed it or a statement printed it ("www.homedepot.com/mycard"), made a full https link. */
export function asUrl(s: string | null | undefined): string | null {
  const t = String(s ?? '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    return /\./.test(u.hostname) ? u.toString() : null;
  } catch { return null; }
}

/** Where the agent starts for a card: the owner's saved page, else the one its statement prints, else the issuer's site. */
export function cardStartUrl(card: { issuer?: string | null; name?: string | null; loginUrl?: string | null }, saved?: string | null): string | null {
  return asUrl(saved) ?? asUrl(card.loginUrl) ?? cardIssuerSite(card);
}
