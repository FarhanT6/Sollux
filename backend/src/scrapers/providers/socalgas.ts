/**
 * SoCal Gas scraper — https://www.socalgas.com/
 * Login URL:   https://www.socalgas.com/sign-in
 * Billing URL: https://www.socalgas.com/my-account/billing-and-payments/billing-history
 */
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';

export class SoCalGasScraper extends BaseScraperProvider {
  readonly providerSlug = 'socal-gas';
  readonly providerName = 'SoCal Gas';

  private readonly LOGIN_URL   = 'https://www.socalgas.com/sign-in';
  private readonly BILLING_URL = 'https://www.socalgas.com/my-account/billing-and-payments/billing-history';

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      await this.page!.goto(this.LOGIN_URL, { waitUntil: 'networkidle' });

      const usernameSel = '#userIdInput, #email, input[name="userId"]';
      const passwordSel = '#passwordInput, #password, input[name="password"]';
      const submitSel   = 'button[type="submit"], input[type="submit"], .login-btn';

      await this.waitFor(usernameSel, 10000);

      await this.page!.fill(usernameSel, credentials.username);
      await this.page!.fill(passwordSel, credentials.password);
      await this.page!.click(submitSel);

      // Wait for redirect into the my-account area
      try {
        await Promise.race([
          this.page!.waitForURL(/\/my-account\//i, { timeout: 20000 }),
          this.page!.waitForSelector('.error-message, .login-error, [data-error]', { timeout: 20000 }),
        ]);
      } catch {
        // timeout — fall through to URL check
      }

      const currentUrl = this.page!.url();
      const success = /\/my-account\//i.test(currentUrl);

      if (!success) {
        console.error('[SoCalGas] Login failed — URL after submit:', currentUrl);
        await this.page!.screenshot({ path: '/tmp/socalgas-login-fail.png' });
        return false;
      }

      return true;
    } catch (err) {
      console.error('[SoCalGas] Login failed:', err);
      try { await this.page!.screenshot({ path: '/tmp/socalgas-login-fail.png' }); } catch { /* no-op */ }
      return false;
    }
  }

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const statements: ScrapedStatement[] = [];

    try {
      await this.page!.goto(this.BILLING_URL, { waitUntil: 'networkidle' });

      const tableSel = '.billing-history, table, [data-testid="billing-table"], .statements-list';
      try {
        await this.waitFor(tableSel, 10000);
      } catch {
        await this.page!.waitForTimeout(3000);
      }

      const rows = await this.page!.$$eval(
        '.billing-history tr:not(:first-child), ' +
        '[data-testid="billing-table"] tr:not(:first-child), ' +
        '.statements-list .statement-row, ' +
        'table tr:not(:first-child)',
        (rows: Element[]) => rows.map((row: Element) => {
          const cells = Array.from(row.querySelectorAll('td')) as HTMLElement[];

          // Look for therms usage — cells containing "therm"
          let usageText: string | null = null;
          for (const cell of cells) {
            const text = cell.textContent ?? '';
            if (/therm/i.test(text)) {
              usageText = text.trim();
              break;
            }
          }

          // Look for billing period range "MM/DD - MM/DD" or "MM/DD/YYYY - MM/DD/YYYY"
          let periodText: string | null = null;
          for (const cell of cells) {
            const text = cell.textContent ?? '';
            if (/\d{1,2}\/\d{1,2}.*[-–—].*\d{1,2}\/\d{1,2}/.test(text)) {
              periodText = text.trim();
              break;
            }
          }

          return {
            date:      cells[0]?.textContent?.trim() ?? null,
            dueDate:   cells[1]?.textContent?.trim() ?? null,
            amount:    cells[2]?.textContent?.trim() ?? null,
            balance:   cells[3]?.textContent?.trim() ?? null,
            pdfUrl:    (row.querySelector('a[href*=".pdf"]') as HTMLAnchorElement | null)?.href ?? null,
            usageText,
            periodText,
          };
        })
      );

      console.log(`[SoCalGas] Found ${rows.length} billing rows`);

      for (const row of rows.slice(0, 24)) {
        const statementDate = this.parseDate(row.date);
        if (!statementDate) continue;

        // Parse therms usage value, e.g. "32 therms" → 32
        let usageValue: number | undefined;
        if (row.usageText) {
          const match = row.usageText.match(/([\d,]+\.?\d*)\s*therm/i);
          if (match) {
            usageValue = parseFloat(match[1].replace(/,/g, ''));
          }
        }

        // Parse billing period start/end
        let billingPeriodStart: Date | undefined;
        let billingPeriodEnd: Date | undefined;
        if (row.periodText) {
          const parts = row.periodText.split(/[-–—]/);
          if (parts.length >= 2) {
            billingPeriodStart = this.parseDate(parts[0].trim());
            billingPeriodEnd   = this.parseDate(parts[1].trim());
          }
        }

        // Download PDF if URL is present
        let pdfBuffer: Buffer | undefined;
        if (row.pdfUrl) {
          pdfBuffer = await this.downloadPdf(row.pdfUrl);
        }

        statements.push({
          statementDate,
          dueDate: this.parseDate(row.dueDate),
          amountDue: this.parseDollar(row.amount),
          balance: this.parseDollar(row.balance),
          usageValue,
          usageUnit: usageValue !== undefined ? 'therms' : undefined,
          billingPeriodStart,
          billingPeriodEnd,
          pdfBuffer,
          pdfFilename: row.pdfUrl ? row.pdfUrl.split('/').pop()?.split('?')[0] : undefined,
        });
      }
    } catch (err) {
      console.error('[SoCalGas] Statement scraping failed:', err);
      try { await this.page!.screenshot({ path: '/tmp/socalgas-statements-fail.png' }); } catch { /* no-op */ }
    }

    return statements;
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
    const payments: ScrapedPayment[] = [];

    try {
      // SoCal Gas surfaces payment history via a query param or a payment tab
      await this.page!.goto(`${this.BILLING_URL}?view=payments`, { waitUntil: 'networkidle' });

      const paymentSel = '.payment-history, .payments-table, [data-testid="payment-history"], ' +
                         '.payment-list, table';
      try {
        await this.waitFor(paymentSel, 10000);
      } catch {
        await this.page!.waitForTimeout(3000);
      }

      const rows = await this.page!.$$eval(
        '.payment-row, .payments-table tr:not(:first-child), ' +
        '[data-testid="payment-history"] tr:not(:first-child), ' +
        '.payment-list .payment-row, ' +
        'table tr:not(:first-child)',
        (rows: Element[]) => rows.map((row: Element) => {
          const cells = Array.from(row.querySelectorAll('td')) as HTMLElement[];
          return {
            date:         cells[0]?.textContent?.trim() ?? null,
            amount:       cells[1]?.textContent?.trim() ?? null,
            confirmation: cells[2]?.textContent?.trim() ?? null,
            method:       cells[3]?.textContent?.trim() ?? null,
          };
        })
      );

      console.log(`[SoCalGas] Found ${rows.length} payment rows`);

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
      console.error('[SoCalGas] Payment scraping failed:', err);
      try { await this.page!.screenshot({ path: '/tmp/socalgas-payments-fail.png' }); } catch { /* no-op */ }
    }

    return payments;
  }

  /** Download a PDF from a URL using the current page's authenticated session */
  private async downloadPdf(url: string): Promise<Buffer | undefined> {
    try {
      const response = await this.page!.request.get(url);
      if (response.ok()) {
        return Buffer.from(await response.body());
      }
    } catch { /* no-op */ }
    return undefined;
  }
}
