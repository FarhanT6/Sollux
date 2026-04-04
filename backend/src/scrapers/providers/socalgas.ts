/**
 * SoCal Gas scraper — https://www.socalgas.com/
 * TODO: Implement full scraping logic following the SDGE pattern.
 * Login URL: https://www.socalgas.com/sign-in
 * Billing URL: https://www.socalgas.com/my-account/billing-and-payments/billing-history
 */
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';

export class SoCalGasScraper extends BaseScraperProvider {
  readonly providerSlug = 'socal-gas';
  readonly providerName = 'SoCal Gas';

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      await this.page!.goto('https://www.socalgas.com/sign-in', { waitUntil: 'networkidle' });
      await this.waitFor('#userIdInput, #username', 8000);
      await this.page!.fill('#userIdInput, #username', credentials.username);
      await this.page!.fill('#passwordInput, #password', credentials.password);
      await this.page!.click('button[type="submit"]');
      await this.page!.waitForURL(/my-account|dashboard/i, { timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  }

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    // TODO: Implement SoCal Gas billing history scraping
    return [];
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
    // TODO: Implement SoCal Gas payment history scraping
    return [];
  }
}
