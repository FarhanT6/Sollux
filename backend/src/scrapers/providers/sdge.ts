import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';

/**
 * SDGE (San Diego Gas & Electric) scraper
 * Portal: https://myaccount.sdge.com
 */
export class SDGEScraper extends BaseScraperProvider {
  readonly providerSlug = 'sdge';
  readonly providerName = 'SDGE';

  private readonly LOGIN_URL = 'https://myaccount.sdge.com/portal/Login/index';
  private readonly BILLING_URL = 'https://myaccount.sdge.com/portal/BillingHistory/index';

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      await this.page!.goto(this.LOGIN_URL, { waitUntil: 'networkidle' });
      await this.waitFor('#username', 8000);

      await this.page!.fill('#username', credentials.username);
      await this.page!.fill('#password', credentials.password);
      await this.page!.click('button[type="submit"]');

      // Wait for redirect to dashboard
      await this.page!.waitForURL(/dashboard|account/i, { timeout: 15000 });
      return true;
    } catch (err) {
      console.error('[SDGE] Login failed:', err);
      return false;
    }
  }

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const statements: ScrapedStatement[] = [];

    try {
      await this.page!.goto(this.BILLING_URL, { waitUntil: 'networkidle' });
      await this.waitFor('.billing-history-table, .bill-history', 10000);

      // Extract billing rows
      const rows = await this.page!.$$eval(
        '.billing-history-table tr:not(:first-child), .bill-row',
        (rows) => rows.map(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          return {
            date: cells[0]?.textContent?.trim(),
            dueDate: cells[1]?.textContent?.trim(),
            amount: cells[2]?.textContent?.trim(),
            balance: cells[3]?.textContent?.trim(),
            pdfUrl: (row.querySelector('a[href*=".pdf"]') as HTMLAnchorElement)?.href,
          };
        })
      );

      for (const row of rows.slice(0, 12)) { // Last 12 statements
        const statementDate = this.parseDate(row.date);
        if (!statementDate) continue;

        statements.push({
          statementDate,
          dueDate: this.parseDate(row.dueDate),
          amountDue: this.parseDollar(row.amount),
          balance: this.parseDollar(row.balance),
        });
      }
    } catch (err) {
      console.error('[SDGE] Statement scraping failed:', err);
    }

    return statements;
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
    const payments: ScrapedPayment[] = [];

    try {
      await this.page!.goto(`${this.BILLING_URL}?tab=payment-history`, { waitUntil: 'networkidle' });
      await this.waitFor('.payment-history, .payments-table', 10000);

      const rows = await this.page!.$$eval(
        '.payment-row, .payments-table tr:not(:first-child)',
        (rows) => rows.map(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          return {
            date: cells[0]?.textContent?.trim(),
            amount: cells[1]?.textContent?.trim(),
            confirmation: cells[2]?.textContent?.trim(),
            method: cells[3]?.textContent?.trim(),
          };
        })
      );

      for (const row of rows) {
        const paymentDate = this.parseDate(row.date);
        const amount = this.parseDollar(row.amount);
        if (!paymentDate || !amount) continue;

        payments.push({
          paymentDate,
          amount,
          confirmationNumber: row.confirmation || undefined,
          paymentMethod: row.method || undefined,
        });
      }
    } catch (err) {
      console.error('[SDGE] Payment scraping failed:', err);
    }

    return payments;
  }
}
