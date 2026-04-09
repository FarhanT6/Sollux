import { BaseScraperProvider } from './base';
import { SDGEScraper } from './providers/sdge';
import { SoCalGasScraper } from './providers/socalgas';
import { WMScraper } from './providers/wm';
import { CoxScraper } from './providers/cox';
import { FPLScraper } from './providers/fpl';
import { IIDScraper } from './providers/iid';
import { RepublicServicesScraper } from './providers/republicServices';
import { GmailFallbackScraper } from './providers/gmailFallback';

const registry: Record<string, new () => BaseScraperProvider> = {
  'sdge': SDGEScraper,
  'socal-gas': SoCalGasScraper,
  'wm': WMScraper,
  'cox': CoxScraper,
  'fpl': FPLScraper,
  'iid': IIDScraper,
  'republic-services': RepublicServicesScraper,
  'gmail-fallback': GmailFallbackScraper,
};

export function getScraperProvider(slug: string): BaseScraperProvider | null {
  const Provider = registry[slug];
  if (!Provider) return null;
  return new Provider();
}
