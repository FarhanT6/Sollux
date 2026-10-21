import { BaseScraperProvider } from './base';
import { SDGEScraper } from './providers/sdge';
import { SoCalGasScraper } from './providers/socalgas';
import { WMScraper } from './providers/wm';
import { CoxScraper } from './providers/cox';
import { FPLScraper } from './providers/fpl';
import { IIDScraper } from './providers/iid';
import { RepublicServicesScraper } from './providers/republicServices';
import { GmailFallbackScraper } from './providers/gmailFallback';
import { CityOceansideScraper } from './providers/city-oceanside';
import { CityOceansideInvoiceCloudScraper } from './providers/city-oceanside-ic';
import { CityBrawleyScraper } from './providers/city-brawley';

const registry: Record<string, new () => BaseScraperProvider> = {
  'sdge': SDGEScraper,
  'socal-gas': SoCalGasScraper,
  'wm': WMScraper,
  'cox': CoxScraper,
  'fpl': FPLScraper,
  'iid': IIDScraper,
  'republic-services': RepublicServicesScraper,
  'gmail-fallback': GmailFallbackScraper,
  'city-oceanside': CityOceansideScraper,
  'city-oceanside-ic': CityOceansideInvoiceCloudScraper,
  'city-brawley': CityBrawleyScraper,
};

/**
 * Built-in connectors that no longer get in, so the portal agent does these
 * sites instead. Every one of them failed on Oct 17 and handed over to the
 * agent — which means two sign-ins per Fetch, and the failed one counts
 * against the owner's login (IID rejected a correct password straight after
 * its old connector failed on selfservice.iid.com; IID now signs in at
 * myaccount.iid.com with an emailed two-factor code the old connector cannot
 * enter). SDG&E's and SoCal Gas's sites are behind bot protection that a second
 * sign-in a few seconds later only makes stricter.
 */
const RETIRED = new Set(['iid', 'sdge', 'socal-gas', 'wm',
  // Every other site too: the portal agent fetches the statement PDF itself,
  // where these read figures off the page. Republic Services' connector
  // reported "1 new statement" for a September row with no billing period
  // and no PDF. Only the Gmail reader (gmail-fallback) is not a website.
  'cox', 'fpl', 'republic-services', 'city-oceanside', 'city-oceanside-ic', 'city-brawley']);

export function getScraperProvider(slug: string): BaseScraperProvider | null {
  if (RETIRED.has(slug)) return null;
  const Provider = registry[slug];
  if (!Provider) return null;
  return new Provider();
}
