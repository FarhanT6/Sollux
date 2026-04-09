/**
 * FPL (Florida Power & Light) scraper
 * Login:   https://www.fpl.com/my-account/login.html
 * Billing: https://www.fpl.com/my-account/account-history.html
 */
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';
import * as path from 'path';

export class FPLScraper extends BaseScraperProvider {
  readonly providerSlug = 'fpl';
  readonly providerName = 'FPL (Florida Power & Light)';

  private readonly LOGIN_URL   = 'https://www.fpl.com/my-account/login.html';
  private readonly BILLING_URL = 'https://www.fpl.com/my-account/account-history.html';

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      await this.page!.goto(this.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(2000);
      await this.screenshot('fpl-login-loaded');

      // FPL login form selectors (multiple fallbacks)
      const userSel = '#loginEmail, input[name="email"], input[type="email"], #email, [placeholder*="Email" i], [placeholder*="User" i]';
      const passSel = '#loginPassword, input[name="password"], input[type="password"], #password';
      const submitSel = 'button[type="submit"], input[type="submit"], .login-btn, button:has-text("Sign In"), button:has-text("Log In")';

      await this.page!.waitForSelector(userSel, { timeout: 15000 });

      await this.page!.type(userSel, credentials.username, { delay: 60 });
      await this.page!.waitForTimeout(400);
      await this.page!.type(passSel, credentials.password, { delay: 60 });
      await this.page!.waitForTimeout(300);

      await this.screenshot('fpl-before-submit');
      await this.page!.click(submitSel);

      try {
        await Promise.race([
          this.page!.waitForURL(/my-account|account-summary|dashboard/i, { timeout: 25000 }),
          this.page!.waitForSelector('[class*="error" i], [class*="alert" i]', { timeout: 25000 }),
        ]);
      } catch { /* timeout — check URL */ }

      const url = this.page!.url();
      await this.screenshot('fpl-post-login');
      await this.throwIfMfaRequired();

      if (/login/i.test(url)) {
        console.error('[FPL] Login failed — still on login page:', url);
        return false;
      }

      console.log('[FPL] Login successful, URL:', url);
      return true;
    } catch (err) {
      console.error('[FPL] Login error:', err instanceof Error ? err.message : err);
      await this.screenshot('fpl-login-error');
      return false;
    }
  }

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const statements: ScrapedStatement[] = [];
    try {
      await this.page!.goto(this.BILLING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(3000);
      await this.screenshot('fpl-billing-history');

      // FPL shows up to 24 months — wait for rows to appear
      const tableSel = [
        'table.billing-history',
        '[data-testid*="bill" i]',
        '.bill-history',
        '.account-history',
        'table',
      ].join(', ');

      try {
        await this.page!.waitForSelector(tableSel, { timeout: 10000 });
      } catch {
        await this.page!.waitForTimeout(2000);
      }

      // Extract rows via DOM text scanning (robust across layout changes)
      const rows = await this.page!.evaluate(() => {
        type Row = { text: string; cells: string[]; pdfHref?: string };
        const results: Row[] = [];

        // Try table rows first
        const tableRows = Array.from(document.querySelectorAll('table tr')).slice(1); // skip header
        for (const row of tableRows) {
          const text = row.textContent?.trim() || '';
          if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
          const pdfHref = (row.querySelector('a[href*=".pdf"], a[href*="bill"], a[href*="statement"]') as HTMLAnchorElement | null)?.href;
          results.push({ text, cells, pdfHref });
        }

        // Fallback: scan any container rows with dollar amounts and dates
        if (results.length === 0) {
          const candidates = Array.from(document.querySelectorAll('[class*="bill" i], [class*="statement" i], [class*="history" i], [class*="row" i]'));
          for (const el of candidates) {
            const text = el.textContent?.trim() || '';
            if (!/\$[\d,]+\.\d{2}/.test(text) || !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(text)) continue;
            if (el.querySelectorAll('[class*="bill" i]').length > 0) continue; // skip parent containers
            const cells = Array.from(el.querySelectorAll('span, td, div')).map(c => c.textContent?.trim() || '').filter(Boolean);
            const pdfHref = (el.querySelector('a[href*=".pdf"], a[href*="bill"]') as HTMLAnchorElement | null)?.href;
            results.push({ text, cells, pdfHref });
          }
        }

        return results.slice(0, 24);
      });

      console.log(`[FPL] Found ${rows.length} billing rows`);

      for (const row of rows) {
        const text = row.text;

        // Extract dates
        const dates = [...text.matchAll(/(\d{1,2}\/\d{1,2}\/\d{2,4})/g)].map(m => m[1]);
        const statementDate = this.parseDate(dates[0] || null);
        if (!statementDate) continue;

        const amountDue  = this.parseDollarFromText(text);
        const dueDate    = this.parseDate(dates[1] || null);

        // kWh usage
        const kwhMatch = text.match(/([\d,]+\.?\d*)\s*kWh/i);
        const usageValue = kwhMatch ? parseFloat(kwhMatch[1].replace(/,/g, '')) : undefined;

        // PDF
        let pdfBuffer: Buffer | undefined;
        if (row.pdfHref) {
          pdfBuffer = await this.downloadPdf(row.pdfHref);
        }

        statements.push({
          statementDate,
          dueDate,
          amountDue,
          usageValue,
          usageUnit: usageValue !== undefined ? 'kWh' : undefined,
          pdfBuffer,
          pdfFilename: row.pdfHref ? `fpl_${statementDate.toISOString().slice(0, 10)}.pdf` : undefined,
        });
      }
    } catch (err) {
      console.error('[FPL] Statement scraping error:', err instanceof Error ? err.message : err);
      await this.screenshot('fpl-statements-error');
    }

    console.log(`[FPL] Total statements: ${statements.length}`);
    return statements;
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
    // FPL payment history is on the same billing history page or a tab
    return [];
  }

  private parseDollarFromText(text: string): number | undefined {
    const m = text.match(/\$\s*([\d,]+\.\d{2})/);
    if (!m) return undefined;
    return parseFloat(m[1].replace(/,/g, ''));
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
      console.log(`[FPL] Screenshot: ${p}`);
    } catch { }
  }
}
