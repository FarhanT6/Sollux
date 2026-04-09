/**
 * Cox Communications scraper
 * Login:   https://www.cox.com/content/dam/cox/okta/signin.html (Okta-based)
 * Billing: https://www.cox.com/residential/billing.html
 */
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';
import * as path from 'path';

export class CoxScraper extends BaseScraperProvider {
  readonly providerSlug = 'cox';
  readonly providerName = 'Cox';

  private readonly LOGIN_URL   = 'https://www.cox.com/content/dam/cox/okta/signin.html';
  private readonly BILLING_URL = 'https://www.cox.com/residential/billing.html';

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      await this.page!.goto(this.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(2000);
      await this.screenshot('cox-login-loaded');

      // Cox uses Okta — standard Okta widget selectors
      const userSel = '#okta-signin-username, input[name="identifier"], input[type="email"], #username, [placeholder*="Email" i], [placeholder*="Username" i]';
      const passSel = '#okta-signin-password, input[name="credentials.passcode"], input[type="password"], #password';
      const submitSel = '#okta-signin-submit, input[type="submit"], button[type="submit"], button:has-text("Sign In")';

      await this.page!.waitForSelector(userSel, { timeout: 15000 });

      await this.page!.type(userSel, credentials.username, { delay: 60 });
      await this.page!.waitForTimeout(400);
      await this.page!.type(passSel, credentials.password, { delay: 60 });
      await this.page!.waitForTimeout(300);

      await this.screenshot('cox-before-submit');
      await this.page!.click(submitSel);

      // Okta may redirect or show MFA — wait for either success or error
      try {
        await Promise.race([
          this.page!.waitForURL(/myaccount|overview|residential(?!.*signin)/i, { timeout: 25000 }),
          this.page!.waitForSelector('.okta-form-infobox-error, [class*="error" i]', { timeout: 25000 }),
        ]);
      } catch { /* timeout */ }

      const url = this.page!.url();
      await this.screenshot('cox-post-login');
      await this.throwIfMfaRequired();

      if (/signin|login/i.test(url)) {
        console.error('[Cox] Login failed — still on login page:', url);
        return false;
      }

      console.log('[Cox] Login successful, URL:', url);
      return true;
    } catch (err) {
      console.error('[Cox] Login error:', err instanceof Error ? err.message : err);
      await this.screenshot('cox-login-error');
      return false;
    }
  }

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const statements: ScrapedStatement[] = [];
    try {
      await this.page!.goto(this.BILLING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(3000);
      await this.screenshot('cox-billing');

      const tableSel = [
        '[class*="bill-history" i]',
        '[class*="statement" i]',
        '[class*="billing-history" i]',
        'table',
      ].join(', ');

      try {
        await this.page!.waitForSelector(tableSel, { timeout: 10000 });
      } catch {
        await this.page!.waitForTimeout(2000);
      }

      const rows = await this.page!.evaluate(() => {
        type Row = { text: string; cells: string[]; pdfHref?: string };
        const results: Row[] = [];

        // Table rows
        const tableRows = Array.from(document.querySelectorAll('table tr')).slice(1);
        for (const row of tableRows) {
          const text = row.textContent?.trim() || '';
          if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
          const pdfHref = (row.querySelector('a[href*=".pdf"], a[href*="bill"], a[href*="statement"]') as HTMLAnchorElement | null)?.href;
          results.push({ text, cells, pdfHref });
        }

        if (results.length === 0) {
          const candidates = Array.from(document.querySelectorAll('[class*="bill" i], [class*="statement" i], [class*="invoice" i]'));
          for (const el of candidates) {
            const text = el.textContent?.trim() || '';
            if (!/\$[\d,]+\.\d{2}/.test(text) || !/\d{1,2}\/\d{1,2}\/\d{2,4}|\w{3}\s+\d{1,2},\s+\d{4}/.test(text)) continue;
            if (el.children.length > 5) continue; // skip containers
            const cells = Array.from(el.querySelectorAll('span, div, td')).map(c => c.textContent?.trim() || '').filter(Boolean);
            const pdfHref = (el.querySelector('a[href*=".pdf"]') as HTMLAnchorElement | null)?.href;
            results.push({ text, cells, pdfHref });
          }
        }

        return results.slice(0, 24);
      });

      console.log(`[Cox] Found ${rows.length} billing rows`);

      for (const row of rows) {
        const text = row.text;
        const dates = [...text.matchAll(/(\d{1,2}\/\d{1,2}\/\d{2,4})/g)].map(m => m[1]);
        const statementDate = this.parseDate(dates[0] || null);
        if (!statementDate) continue;

        const amountDue = this.parseDollarFromText(text);
        const dueDate   = this.parseDate(dates[1] || null);

        let pdfBuffer: Buffer | undefined;
        if (row.pdfHref) {
          pdfBuffer = await this.downloadPdf(row.pdfHref);
        }

        statements.push({
          statementDate,
          dueDate,
          amountDue,
          pdfBuffer,
          pdfFilename: row.pdfHref ? `cox_${statementDate.toISOString().slice(0, 10)}.pdf` : undefined,
        });
      }
    } catch (err) {
      console.error('[Cox] Statement scraping error:', err instanceof Error ? err.message : err);
      await this.screenshot('cox-statements-error');
    }

    console.log(`[Cox] Total statements: ${statements.length}`);
    return statements;
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
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
      console.log(`[Cox] Screenshot: ${p}`);
    } catch { }
  }
}
