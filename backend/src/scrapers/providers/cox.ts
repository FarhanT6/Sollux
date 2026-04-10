/**
 * Cox Communications scraper
 * Login:   https://www.cox.com/content/dam/cox/okta/signin.html (Okta-based)
 * Billing: https://www.cox.com/resaccount/viewbill.html
 */
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';
import * as path from 'path';

export class CoxScraper extends BaseScraperProvider {
  readonly providerSlug = 'cox';
  readonly providerName = 'Cox';

  // Okta-based login that redirects to Cox's "Welcome back" page with User ID field
  private readonly LOGIN_URL = 'https://www.cox.com/content/dam/cox/okta/signin.html';

  // Candidate billing URLs — try in order until one loads billing data
  private readonly BILLING_URLS = [
    'https://www.cox.com/resaccount/viewbill.html',
    'https://www.cox.com/resaccount/billing.html',
    'https://www.cox.com/residential/account/billing.html',
    'https://www.cox.com/residential/billing.html',
  ];

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      await this.page!.goto(this.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(2000);

      // Dismiss cookie/privacy banner before interacting with the form
      try {
        const cookieBtn = await this.page!.$('button:has-text("Accept"), button:has-text("Confirm My Choices"), button:has-text("Close"), #onetrust-accept-btn-handler');
        if (cookieBtn) {
          await cookieBtn.click();
          await this.page!.waitForTimeout(800);
        }
      } catch { /* no banner */ }

      await this.screenshot('cox-login-loaded');

      // Cox "Welcome back" page after Okta redirect — broad selectors for the User ID field
      const userSel = 'input[name="userId"], #userId, input[name="username"], input[name="identifier"], input[type="email"], input[type="text"]';
      const passSel = 'input[type="password"], input[name="password"], #password';
      const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Sign in")';

      // Wait for the page to fully resolve after Okta redirect (can take a few seconds)
      await this.page!.waitForTimeout(3000);
      await this.screenshot('cox-login-after-wait');

      // Try to find the username field — wait up to 20s for Okta redirect to settle
      let userFound = false;
      for (const sel of userSel.split(', ')) {
        try {
          await this.page!.waitForSelector(sel.trim(), { timeout: 5000, state: 'visible' });
          userFound = true;
          break;
        } catch { /* try next */ }
      }
      if (!userFound) {
        // Last resort: any visible text input
        await this.page!.waitForSelector('input:visible', { timeout: 10000 });
      }

      // Click to focus then type (more reliable than fill for Cox's form)
      await this.page!.click(userSel);
      await this.page!.waitForTimeout(200);
      await this.page!.type(userSel, credentials.username, { delay: 60 });
      await this.page!.waitForTimeout(400);
      await this.page!.click(passSel);
      await this.page!.waitForTimeout(200);
      await this.page!.type(passSel, credentials.password, { delay: 60 });
      await this.page!.waitForTimeout(300);

      await this.screenshot('cox-before-submit');

      // Click the Sign In button specifically (avoid accidental matches)
      const signInBtn = await this.page!.$('button:has-text("Sign In"), button:has-text("Sign in"), button[type="submit"]');
      if (signInBtn) {
        await signInBtn.click();
      } else {
        await this.page!.click(submitSel);
      }

      // Wait up to 30s for navigation away from the Okta signin page
      try {
        await this.page!.waitForURL(
          url => !url.includes('content/dam/cox/okta/signin'),
          { timeout: 30000 }
        );
      } catch { /* timed out — page may still be on login */ }

      // Give any redirect chain time to settle
      await this.page!.waitForTimeout(3000);

      // Handle intercept redirect page
      let url = this.page!.url();
      if (url.includes('intercept')) {
        console.log('[Cox] On intercept page, waiting for redirect...');
        try {
          await this.page!.waitForURL(u => !u.includes('intercept'), { timeout: 15000 });
        } catch {
          const continueBtn = await this.page!.$('button:has-text("Continue"), a:has-text("Continue"), button[type="submit"]');
          if (continueBtn) {
            await continueBtn.click();
            await this.page!.waitForURL(u => !u.includes('intercept'), { timeout: 10000 }).catch(() => {});
          }
        }
        url = this.page!.url();
      }

      await this.screenshot('cox-post-login');

      // Capture any error message Okta/Cox shows on the page
      const pageError = await this.page!.evaluate(() => {
        const errSelectors = [
          '[class*="error" i]', '[class*="alert" i]', '[id*="error" i]',
          '.okta-form-infobox-error', '.o-form-error-container', '[data-se="o-form-error-container"]',
        ];
        for (const sel of errSelectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent?.trim()) return el.textContent.trim();
        }
        return null;
      });
      if (pageError) {
        console.error('[Cox] Login page error message:', pageError);
      }

      console.log('[Cox] Post-login URL:', url);
      await this.throwIfMfaRequired();

      if (url.includes('content/dam/cox/okta/signin') || /\/login|\/signin/i.test(url)) {
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
      // Try each billing URL until we find one with billing data
      let found = false;
      for (const billingUrl of this.BILLING_URLS) {
        console.log(`[Cox] Trying billing URL: ${billingUrl}`);
        await this.page!.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait for React/SPA to render billing content
        await this.page!.waitForTimeout(4000);
        await this.screenshot(`cox-billing-${billingUrl.split('/').pop()}`);

        // Check if this page has billing data
        const hasBilling = await this.page!.evaluate(() => {
          const text = document.body.innerText || '';
          return /bill|statement|amount due|balance/i.test(text) &&
            /\$[\d,]+\.\d{2}/.test(text);
        });

        if (hasBilling) {
          console.log(`[Cox] Found billing content at ${billingUrl}`);
          found = true;
          break;
        }

        // Also try clicking a billing nav link if present
        const navClicked = await this.page!.evaluate(() => {
          const link = Array.from(document.querySelectorAll('a, button'))
            .find(el => /bill|statement|payment/i.test(el.textContent || ''));
          if (link) { (link as HTMLElement).click(); return true; }
          return false;
        });

        if (navClicked) {
          await this.page!.waitForTimeout(3000);
          const hasBillingAfterNav = await this.page!.evaluate(() =>
            /\$[\d,]+\.\d{2}/.test(document.body.innerText || '')
          );
          if (hasBillingAfterNav) { found = true; break; }
        }
      }

      if (!found) {
        console.warn('[Cox] Could not find billing page — dumping page text for debugging');
        const pageText = await this.page!.evaluate(() => document.body.innerText?.slice(0, 500));
        console.log('[Cox] Page text:', pageText);
        await this.screenshot('cox-billing-notfound');
        return [];
      }

      // Wait a bit more for any lazy-loaded history rows
      await this.page!.waitForTimeout(2000);

      const rows = await this.page!.evaluate(() => {
        type Row = { text: string; cells: string[]; pdfHref?: string };
        const results: Row[] = [];

        // 1. Standard table rows
        const tableRows = Array.from(document.querySelectorAll('table tr')).slice(1);
        for (const row of tableRows) {
          const text = row.textContent?.trim() || '';
          if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
          const pdfHref = (row.querySelector('a[href*=".pdf"], a[href*="bill"], a[href*="statement"]') as HTMLAnchorElement | null)?.href;
          results.push({ text, cells, pdfHref });
        }

        // 2. React/component-based rows
        if (results.length === 0) {
          const candidates = Array.from(document.querySelectorAll(
            '[class*="bill" i], [class*="statement" i], [class*="invoice" i], [class*="history" i], [class*="payment" i]'
          ));
          for (const el of candidates) {
            const text = el.textContent?.trim() || '';
            if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
            if (!/\d{1,2}\/\d{1,2}\/\d{2,4}|\w{3}\s+\d{1,2},?\s+\d{4}/.test(text)) continue;
            if (el.children.length > 8) continue; // skip big containers
            const cells = Array.from(el.querySelectorAll('span, div, td, li'))
              .map(c => c.textContent?.trim() || '').filter(Boolean);
            const pdfHref = (el.querySelector('a[href*=".pdf"]') as HTMLAnchorElement | null)?.href;
            results.push({ text, cells, pdfHref });
          }
        }

        // 3. Broad text scan — pull any line that looks like a billing row
        if (results.length === 0) {
          const allText = document.body.innerText || '';
          const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            if (/\$[\d,]+\.\d{2}/.test(line) && /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(line)) {
              results.push({ text: line, cells: line.split(/\s{2,}|\t/) });
            }
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
        const dueDate = this.parseDate(dates[1] || null);

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
