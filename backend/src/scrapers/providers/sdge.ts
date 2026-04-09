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

      // Try multiple username selector patterns — SDGE has changed their portal selectors before
      const usernameSel = '#username, #email, input[name="username"], input[type="email"]';
      const passwordSel = '#password, input[name="password"], input[type="password"]';
      const submitSel   = 'button[type="submit"], input[type="submit"], .login-btn';

      await this.waitFor(usernameSel, 10000);

      await this.page!.fill(usernameSel, credentials.username);
      await this.page!.fill(passwordSel, credentials.password);
      await this.page!.click(submitSel);

      // Wait for success URL or an error element, whichever comes first
      try {
        await Promise.race([
          this.page!.waitForURL(/dashboard|account/i, { timeout: 20000 }),
          this.page!.waitForSelector('.error-message, .login-error, [data-error]', { timeout: 20000 }),
        ]);
      } catch {
        // timeout — fall through to URL check below
      }

      const currentUrl = this.page!.url();

      // Check for MFA / phone verification screen before declaring success
      await this.throwIfMfaRequired();

      const success = /dashboard|account/i.test(currentUrl) && !/login|sign-in/i.test(currentUrl);

      if (!success) {
        console.error('[SDGE] Login failed — URL after submit:', currentUrl);
        await this.page!.screenshot({ path: '/tmp/sdge-login-fail.png' });
        return false;
      }

      return true;
    } catch (err) {
      console.error('[SDGE] Login failed:', err);
      try { await this.page!.screenshot({ path: '/tmp/sdge-login-fail.png' }); } catch { /* no-op */ }
      return false;
    }
  }

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const statements: ScrapedStatement[] = [];

    try {
      await this.page!.goto(this.BILLING_URL, { waitUntil: 'networkidle' });

      // Try multiple table selectors with fallbacks
      const tableSel = '.billing-history-table, table.bills, [data-testid="billing-history"], .bill-list';
      try {
        await this.waitFor(tableSel, 10000);
      } catch {
        // Fallback wait if selector never appears
        await this.page!.waitForTimeout(3000);
      }

      const rows = await this.page!.$$eval(
        '.billing-history-table tr:not(:first-child), table.bills tr:not(:first-child), ' +
        '[data-testid="billing-history"] tr:not(:first-child), .bill-list .bill-row, .bill-row',
        (rows: Element[]) => rows.map((row: Element) => {
          const cells = Array.from(row.querySelectorAll('td')) as HTMLElement[];

          // Try to find a kWh usage value from any cell containing "kWh"
          let usageText: string | null = null;
          for (const cell of cells) {
            const text = cell.textContent ?? '';
            if (/kwh/i.test(text)) {
              usageText = text.trim();
              break;
            }
          }

          // Try to find billing period — look for cells that contain a date range like "MM/DD - MM/DD"
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

      console.log(`[SDGE] Found ${rows.length} billing rows`);

      for (const row of rows.slice(0, 24)) {
        const statementDate = this.parseDate(row.date);
        if (!statementDate) continue;

        // Parse usage value: strip non-numeric chars except period, e.g. "345.2 kWh" → 345.2
        let usageValue: number | undefined;
        if (row.usageText) {
          const match = row.usageText.match(/([\d,]+\.?\d*)\s*kwh/i);
          if (match) {
            usageValue = parseFloat(match[1].replace(/,/g, ''));
          }
        }

        // Parse billing period start/end from "MM/DD/YYYY - MM/DD/YYYY" or similar
        let billingPeriodStart: Date | undefined;
        let billingPeriodEnd: Date | undefined;
        if (row.periodText) {
          const parts = row.periodText.split(/[-–—]/);
          if (parts.length >= 2) {
            billingPeriodStart = this.parseDate(parts[0].trim());
            billingPeriodEnd   = this.parseDate(parts[1].trim());
          }
        }

        // Attempt to download PDF if a URL was found in the row
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
          usageUnit: usageValue !== undefined ? 'kWh' : undefined,
          billingPeriodStart,
          billingPeriodEnd,
          pdfBuffer,
          pdfFilename: row.pdfUrl ? row.pdfUrl.split('/').pop()?.split('?')[0] : undefined,
        });
      }
    } catch (err) {
      console.error('[SDGE] Statement scraping failed:', err);
      try { await this.page!.screenshot({ path: '/tmp/sdge-statements-fail.png' }); } catch { /* no-op */ }
    }

    return statements;
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
    const payments: ScrapedPayment[] = [];

    try {
      await this.page!.goto(`${this.BILLING_URL}?tab=payment-history`, { waitUntil: 'networkidle' });

      const paymentSel = '.payment-history, .payments-table, [data-testid="payment-history"], .payment-list';
      try {
        await this.waitFor(paymentSel, 10000);
      } catch {
        await this.page!.waitForTimeout(3000);
      }

      const rows = await this.page!.$$eval(
        '.payment-row, .payments-table tr:not(:first-child), ' +
        '[data-testid="payment-history"] tr:not(:first-child), .payment-list .payment-row',
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

      console.log(`[SDGE] Found ${rows.length} payment rows`);

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
      try { await this.page!.screenshot({ path: '/tmp/sdge-payments-fail.png' }); } catch { /* no-op */ }
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
