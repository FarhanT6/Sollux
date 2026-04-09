/**
 * IID (Imperial Irrigation District) scraper
 * Self-service portal: https://selfservice.iid.com/
 * Login:   https://selfservice.iid.com/
 * Billing: https://selfservice.iid.com/home (navigate to billing after login)
 */
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';
import * as path from 'path';

export class IIDScraper extends BaseScraperProvider {
  readonly providerSlug = 'iid';
  readonly providerName = 'IID (Imperial Irrigation District)';

  private readonly LOGIN_URL = 'https://selfservice.iid.com/';

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      await this.page!.goto(this.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(2000);
      await this.screenshot('iid-login-loaded');

      const userSel = '#userName, #email, input[name="username"], input[name="email"], input[type="email"], [placeholder*="User" i], [placeholder*="Email" i]';
      const passSel = '#password, input[name="password"], input[type="password"]';
      const submitSel = 'button[type="submit"], input[type="submit"], .login-btn, button:has-text("Log In"), button:has-text("Sign In")';

      await this.page!.waitForSelector(userSel, { timeout: 15000 });

      await this.page!.type(userSel, credentials.username, { delay: 60 });
      await this.page!.waitForTimeout(400);
      await this.page!.type(passSel, credentials.password, { delay: 60 });
      await this.page!.waitForTimeout(300);

      await this.screenshot('iid-before-submit');
      await this.page!.click(submitSel);

      try {
        await Promise.race([
          this.page!.waitForURL(/home|account|dashboard|my-account/i, { timeout: 20000 }),
          this.page!.waitForSelector('[class*="error" i], [class*="alert" i]', { timeout: 20000 }),
        ]);
      } catch { }

      const url = this.page!.url();
      await this.screenshot('iid-post-login');

      if (/login|signin/i.test(url) && !url.includes('home')) {
        console.error('[IID] Login failed — URL:', url);
        return false;
      }

      console.log('[IID] Login successful, URL:', url);
      return true;
    } catch (err) {
      console.error('[IID] Login error:', err instanceof Error ? err.message : err);
      await this.screenshot('iid-login-error');
      return false;
    }
  }

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const statements: ScrapedStatement[] = [];
    try {
      await this.page!.waitForTimeout(2000);
      await this.screenshot('iid-post-login-dashboard');

      // Navigate to billing history — try common patterns for utility self-service portals
      const navigated = await this.navigateToBilling();
      if (!navigated) {
        console.warn('[IID] Could not navigate to billing history');
        await this.screenshot('iid-billing-nav-failed');
        return [];
      }

      await this.page!.waitForTimeout(3000);
      await this.screenshot('iid-billing-history');

      const rows = await this.page!.evaluate(() => {
        type Row = { text: string; cells: string[]; pdfHref?: string };
        const results: Row[] = [];

        const tableRows = Array.from(document.querySelectorAll('table tr')).slice(1);
        for (const row of tableRows) {
          const text = row.textContent?.trim() || '';
          if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
          const pdfHref = (row.querySelector('a[href*=".pdf"], a[href*="bill"]') as HTMLAnchorElement | null)?.href;
          results.push({ text, cells, pdfHref });
        }

        if (results.length === 0) {
          const candidates = Array.from(document.querySelectorAll('[class*="bill" i], [class*="statement" i], [class*="history" i]'));
          for (const el of candidates) {
            const text = el.textContent?.trim() || '';
            if (!/\$[\d,]+\.\d{2}/.test(text) || !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(text)) continue;
            if (el.children.length > 8) continue;
            const cells = Array.from(el.querySelectorAll('span, td, div')).map(c => c.textContent?.trim() || '').filter(Boolean);
            const pdfHref = (el.querySelector('a[href*=".pdf"]') as HTMLAnchorElement | null)?.href;
            results.push({ text, cells, pdfHref });
          }
        }

        return results.slice(0, 24);
      });

      console.log(`[IID] Found ${rows.length} billing rows`);

      for (const row of rows) {
        const text = row.text;
        const dates = [...text.matchAll(/(\d{1,2}\/\d{1,2}\/\d{2,4})/g)].map(m => m[1]);
        const statementDate = this.parseDate(dates[0] || null);
        if (!statementDate) continue;

        const amounts = [...text.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map(m => parseFloat(m[1].replace(/,/g, '')));
        const amountDue = amounts[0];
        const balance   = amounts[1];
        const dueDate   = this.parseDate(dates[1] || null);

        const kwhMatch = text.match(/([\d,]+\.?\d*)\s*kWh/i);
        const usageValue = kwhMatch ? parseFloat(kwhMatch[1].replace(/,/g, '')) : undefined;

        let pdfBuffer: Buffer | undefined;
        if (row.pdfHref) {
          pdfBuffer = await this.downloadPdf(row.pdfHref);
        }

        statements.push({
          statementDate,
          dueDate,
          amountDue,
          balance,
          usageValue,
          usageUnit: usageValue !== undefined ? 'kWh' : undefined,
          pdfBuffer,
          pdfFilename: row.pdfHref ? `iid_${statementDate.toISOString().slice(0, 10)}.pdf` : undefined,
        });
      }
    } catch (err) {
      console.error('[IID] Statement scraping error:', err instanceof Error ? err.message : err);
      await this.screenshot('iid-statements-error');
    }

    console.log(`[IID] Total statements: ${statements.length}`);
    return statements;
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
    return [];
  }

  // Try to navigate to billing history using common link text patterns
  private async navigateToBilling(): Promise<boolean> {
    try {
      const clicked = await this.page!.evaluate(() => {
        const patterns = /billing|bill history|statements|payment history|account history/i;
        const links = Array.from(document.querySelectorAll('a, button'));
        const link = links.find(el => patterns.test(el.textContent || ''));
        if (link) { (link as HTMLElement).click(); return true; }
        return false;
      });
      if (clicked) {
        await this.page!.waitForTimeout(3000);
        return true;
      }
    } catch { }

    // Fallback: try common URL patterns for utility self-service portals
    for (const url of [
      'https://selfservice.iid.com/billing',
      'https://selfservice.iid.com/bill-history',
      'https://selfservice.iid.com/my-account/billing',
    ]) {
      try {
        await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await this.page!.waitForTimeout(2000);
        const hasTable = await this.page!.$('table, [class*="bill" i], [class*="statement" i]');
        if (hasTable) return true;
      } catch { }
    }

    return false;
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
      console.log(`[IID] Screenshot: ${p}`);
    } catch { }
  }
}
