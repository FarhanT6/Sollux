import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';

/**
 * Gmail Fallback Scraper
 * Used for any provider that emails bills — parses PDF attachments from Gmail.
 * The actual implementation lives in parsers/gmailParser.ts.
 * This stub satisfies the ScraperProvider interface for unknown providers.
 */
export class GmailFallbackScraper extends BaseScraperProvider {
  readonly providerSlug = 'gmail-fallback';
  readonly providerName = 'Gmail (email parsing)';
  async login(_c: ScraperCredentials): Promise<boolean> { return true; }
  async scrapeStatements(): Promise<ScrapedStatement[]> { return []; }
  async scrapePayments(): Promise<ScrapedPayment[]> { return []; }
}
