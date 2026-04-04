import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';

export class FPLScraper extends BaseScraperProvider {
  readonly providerSlug = 'fpl';
  readonly providerName = 'FPL (Florida Power & Light)';
  async login(_c: ScraperCredentials): Promise<boolean> { return false; }
  async scrapeStatements(): Promise<ScrapedStatement[]> { return []; }
  async scrapePayments(): Promise<ScrapedPayment[]> { return []; }
}
