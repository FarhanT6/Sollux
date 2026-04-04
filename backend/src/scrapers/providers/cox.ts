import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';

export class CoxScraper extends BaseScraperProvider {
  readonly providerSlug = 'cox';
  readonly providerName = 'Cox';
  async login(_c: ScraperCredentials): Promise<boolean> { return false; }
  async scrapeStatements(): Promise<ScrapedStatement[]> { return []; }
  async scrapePayments(): Promise<ScrapedPayment[]> { return []; }
}
