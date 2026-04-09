/**
 * Republic Services scraper
 * Portal: https://www.republicservices.com/my-account
 * Login:  https://myaccount.republicservices.com/login
 *
 * Structure is similar to WM — React SPA, multiple service accounts per login.
 * Uses accountNumber to filter when one login has multiple service addresses.
 */
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';
import * as path from 'path';

export class RepublicServicesScraper extends BaseScraperProvider {
  readonly providerSlug = 'republic-services';
  readonly providerName = 'Republic Services';

  private readonly LOGIN_URL = 'https://myaccount.republicservices.com/login';

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      await this.page!.goto(this.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(2000);
      await this.screenshot('rs-login-loaded');

      // Dismiss cookie banner if present
      try {
        await this.page!.waitForSelector('#onetrust-accept-btn-handler, button:has-text("Accept")', { timeout: 4000 });
        await this.page!.click('#onetrust-accept-btn-handler, button:has-text("Accept")');
        await this.page!.waitForTimeout(800);
      } catch { }

      const userSel = 'input[placeholder*="Email" i], input[type="email"], #email, input[name="email"], input[name="username"]';
      const passSel = 'input[type="password"], #password, input[name="password"]';
      const submitSel = 'button[type="submit"], form button:has-text("Log In"), form button:has-text("Sign In"), input[type="submit"]';

      await this.page!.waitForSelector(userSel, { timeout: 15000 });

      await this.page!.type(userSel, credentials.username, { delay: 60 });
      await this.page!.waitForTimeout(400);
      await this.page!.type(passSel, credentials.password, { delay: 60 });
      await this.page!.waitForTimeout(300);

      await this.screenshot('rs-before-submit');
      await this.page!.click(submitSel);

      try {
        await this.page!.waitForURL(/dashboard|my-account|overview/i, { timeout: 25000 });
      } catch { }

      const url = this.page!.url();
      await this.screenshot('rs-post-login');

      if (/login|sign-in/i.test(url)) {
        console.error('[RepublicServices] Login failed — URL:', url);
        return false;
      }

      console.log('[RepublicServices] Login successful, URL:', url);
      return true;
    } catch (err) {
      console.error('[RepublicServices] Login error:', err instanceof Error ? err.message : err);
      await this.screenshot('rs-login-error');
      return false;
    }
  }

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const filterAccountNumber = this.credentials?.accountNumber;
    const statements: ScrapedStatement[] = [];

    try {
      await this.page!.waitForTimeout(2000);

      // Navigate to billing / account overview
      await this.navigateToBilling();
      await this.screenshot('rs-billing-overview');

      // Scrape account rows — Republic Services uses a similar card layout to WM
      const rows = await this.page!.evaluate(() => {
        type Row = { text: string; accountNumber?: string; amountDue?: number; dueDate?: string };
        const results: Row[] = [];

        // Scan all elements with dollar amounts
        const candidates = Array.from(document.querySelectorAll('[class*="account" i], [class*="service" i], [class*="bill" i]'));
        for (const el of candidates) {
          const text = el.textContent?.trim() || '';
          if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
          if (el.children.length > 10) continue; // skip large containers

          const amountMatch = text.match(/\$\s*([\d,]+\.\d{2})/);
          const amountDue = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : undefined;

          // Account number patterns: RS uses formats like XXX-XXXXXX-X or similar
          const acctMatch = text.match(/(\d[\d-]{6,})/);
          const accountNumber = acctMatch ? acctMatch[1] : undefined;

          const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
          const dueDate = dateMatch ? dateMatch[1] : undefined;

          if (amountDue) results.push({ text, accountNumber, amountDue, dueDate });
        }

        return results.slice(0, 10);
      });

      console.log(`[RepublicServices] Found ${rows.length} account rows`);

      // Navigate to statement history for each relevant account
      await this.navigateToStatementHistory();
      await this.screenshot('rs-statement-history');

      const historyRows = await this.page!.evaluate(() => {
        type HistRow = { text: string; cells: string[]; pdfHref?: string };
        const results: HistRow[] = [];

        const tableRows = Array.from(document.querySelectorAll('table tr')).slice(1);
        for (const row of tableRows) {
          const text = row.textContent?.trim() || '';
          if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
          const pdfHref = (row.querySelector('a[href*=".pdf"], a[href*="statement"]') as HTMLAnchorElement | null)?.href;
          results.push({ text, cells, pdfHref });
        }

        if (results.length === 0) {
          const candidates = Array.from(document.querySelectorAll('[class*="bill" i], [class*="statement" i], [class*="invoice" i], [class*="history" i]'));
          for (const el of candidates) {
            const text = el.textContent?.trim() || '';
            if (!/\$[\d,]+\.\d{2}/.test(text) || !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(text)) continue;
            if (el.children.length > 6) continue;
            const cells = Array.from(el.querySelectorAll('span, div, td')).map(c => c.textContent?.trim() || '').filter(Boolean);
            const pdfHref = (el.querySelector('a[href*=".pdf"]') as HTMLAnchorElement | null)?.href;
            results.push({ text, cells, pdfHref });
          }
        }

        return results.slice(0, 24);
      });

      console.log(`[RepublicServices] Found ${historyRows.length} history rows`);

      for (const row of historyRows) {
        const text = row.text;
        const dates = [...text.matchAll(/(\d{1,2}\/\d{1,2}\/\d{2,4})/g)].map(m => m[1]);
        const statementDate = this.parseDate(dates[0] || null);
        if (!statementDate) continue;

        const amounts = [...text.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map(m => parseFloat(m[1].replace(/,/g, '')));

        let pdfBuffer: Buffer | undefined;
        if (row.pdfHref) {
          pdfBuffer = await this.downloadPdf(row.pdfHref);
        }

        statements.push({
          statementDate,
          dueDate: this.parseDate(dates[1] || null),
          amountDue: amounts[0],
          balance: amounts[1],
          usageUnit: 'pickup',
          pdfBuffer,
          pdfFilename: row.pdfHref ? `rs_${statementDate.toISOString().slice(0, 10)}.pdf` : undefined,
        });
      }

      // If history nav failed but we have overview data, use that as a fallback
      if (statements.length === 0 && rows.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        for (const row of rows) {
          if (filterAccountNumber && row.accountNumber) {
            const n = (s: string) => s.replace(/[-\s]/g, '');
            if (!n(row.accountNumber).includes(n(filterAccountNumber)) && !n(filterAccountNumber).includes(n(row.accountNumber))) continue;
          }
          const statementDate = this.parseDate(today);
          if (!statementDate) continue;
          statements.push({
            statementDate,
            dueDate: this.parseDate(row.dueDate || null),
            amountDue: row.amountDue,
            usageUnit: 'pickup',
          });
        }
      }
    } catch (err) {
      console.error('[RepublicServices] Statement scraping error:', err instanceof Error ? err.message : err);
      await this.screenshot('rs-statements-error');
    }

    console.log(`[RepublicServices] Total statements: ${statements.length}`);
    return statements;
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
    return [];
  }

  private async navigateToBilling(): Promise<void> {
    try {
      // Try SPA navigation first
      await this.page!.evaluate(() => {
        window.history.pushState({}, '', '/dashboard');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await this.page!.waitForTimeout(2000);

      // Click billing/pay bill link if present
      await this.page!.evaluate(() => {
        const link = Array.from(document.querySelectorAll('a, button'))
          .find(el => /billing|pay bill|my bills/i.test(el.textContent || ''));
        if (link) (link as HTMLElement).click();
      });
      await this.page!.waitForTimeout(2000);
    } catch { }
  }

  private async navigateToStatementHistory(): Promise<void> {
    try {
      await this.page!.evaluate(() => {
        const link = Array.from(document.querySelectorAll('a, button'))
          .find(el => /statement|bill history|billing history/i.test(el.textContent || ''));
        if (link) (link as HTMLElement).click();
      });
      await this.page!.waitForTimeout(2000);
    } catch { }
  }

  private async downloadPdf(url: string): Promise<Buffer | undefined> {
    try {
      const res = await this.page!.request.get(url, { timeout: 15000 });
      if (res.ok()) return Buffer.from(await res.body());
    } catch { }
    return undefined;
  }

  private async screenshot(name: string): Promise<void> {
    try {
      const p = path.join('/tmp', `${name}-${Date.now()}.png`);
      await this.page!.screenshot({ path: p, fullPage: true });
      console.log(`[RepublicServices] Screenshot: ${p}`);
    } catch { }
  }
}
