/**
 * Cox Communications scraper
 * Login:   https://www.cox.com/content/dam/cox/okta/signin.html (Okta-based)
 * Billing: https://www.cox.com/ibill/home.html
 */
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';
import * as path from 'path';

export class CoxScraper extends BaseScraperProvider {
  readonly providerSlug = 'cox';
  readonly providerName = 'Cox';

  // Okta-based login that redirects to Cox's "Welcome back" page with User ID field
  private readonly LOGIN_URL = 'https://www.cox.com/content/dam/cox/okta/signin.html';

  private readonly BILLING_URL = 'https://www.cox.com/ibill/home.html';

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
          url => !url.toString().includes('content/dam/cox/okta/signin'),
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
          await this.page!.waitForURL(u => !u.toString().includes('intercept'), { timeout: 15000 });
        } catch {
          const continueBtn = await this.page!.$('button:has-text("Continue"), a:has-text("Continue"), button[type="submit"]');
          if (continueBtn) {
            await continueBtn.click();
            await this.page!.waitForURL(u => !u.toString().includes('intercept'), { timeout: 10000 }).catch(() => {});
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
      // Navigate directly to the real Cox billing page
      console.log(`[Cox] Navigating to billing page: ${this.BILLING_URL}`);
      await this.page!.goto(this.BILLING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(4000);
      await this.screenshot('cox-billing-ibill');

      // Verify we landed on a valid billing page (not 404)
      const is404 = await this.page!.evaluate(() =>
        /404|can't find that page|page not found/i.test(document.body.innerText || '')
      );
      if (is404) {
        console.error('[Cox] ibill/home.html returned 404 — dumping URL for debug');
        console.log('[Cox] Current URL:', this.page!.url());
        await this.screenshot('cox-billing-404');
        return [];
      }

      // ── Step 1: Scrape ibill/home.html for balance + PDF links ──────────────
      const ibillData = await this.page!.evaluate(() => {
        const allText = document.body.innerText || '';

        // "Total balance due April 16" pattern
        const dueDateM = allText.match(/Total balance due\s+(\w+ \d+)/i);
        const dueDate = dueDateM ? dueDateM[1] : null;

        // All dollar amounts — first one is usually total balance
        const dollarMatches = allText.match(/\$([\d,]+\.\d{2})/g) || [];
        const totalBalance = dollarMatches[0] ? dollarMatches[0].replace('$', '') : null;

        // "Due immediately: $132.00"
        const dueImmM = allText.match(/Due immediately[:\s]+\$([\d,]+\.\d{2})/i);
        const dueImmediately = dueImmM ? dueImmM[1] : null;

        // Collect PDF links with nearby date text
        const billEntries = [];
        const allLinks = Array.from(document.querySelectorAll('a'));
        for (let i = 0; i < allLinks.length; i++) {
          const link = allLinks[i];
          const linkText = (link.textContent || '').trim().toLowerCase();
          if (!linkText.includes('pdf')) continue;
          // Walk up ancestors to find a date
          let el = link.parentElement;
          let dateText = '';
          for (let j = 0; j < 5 && el; j++) {
            const t = el.textContent || '';
            const dm = t.match(/(\w{3,9}\s+\d{1,2}(?:,?\s*\d{4})?)/);
            if (dm) { dateText = dm[1].trim(); break; }
            el = el.parentElement;
          }
          billEntries.push({ date: dateText, pdfHref: (link).href || '' });
        }

        // Also grab th/td cells that look like "Feb 26" with a sibling PDF link
        const cells = Array.from(document.querySelectorAll('th, td'));
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i];
          const t = (cell.textContent || '').trim();
          const dm = t.match(/^(\w{3}\s+\d{1,2})$/);
          if (!dm) continue;
          const pdfA = cell.querySelector('a');
          if (pdfA) billEntries.push({ date: dm[1], pdfHref: pdfA.href || '' });
        }

        return { totalBalance, dueDate, dueImmediately, billEntries, rawText: allText.slice(0, 600) };
      });

      console.log('[Cox] ibill raw text sample:', ibillData.rawText.slice(0, 300));
      console.log('[Cox] ibill parsed — balance:', ibillData.totalBalance, '| dueDate:', ibillData.dueDate, '| dueImm:', ibillData.dueImmediately, '| pdfEntries:', ibillData.billEntries.length);

      // ── Step 2: Navigate to "View statements" for full history ─────────────
      const viewStatementsClicked = await this.page!.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        for (let i = 0; i < links.length; i++) {
          if (/view\s+statements?/i.test(links[i].textContent || '')) {
            links[i].click();
            return true;
          }
        }
        return false;
      });

      const historyRows: Array<{ date: string; amount: string; pdfHref: string }> = [];

      if (viewStatementsClicked) {
        await this.page!.waitForTimeout(4000);
        await this.screenshot('cox-view-statements');
        console.log('[Cox] View statements URL:', this.page!.url());

        const scraped = await this.page!.evaluate(() => {
          const results = [];
          const rows = Array.from(document.querySelectorAll('table tr, [class*="statement"], [class*="history"]'));
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const text = (row.textContent || '').trim();
            if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
            const dateM = text.match(/(\w{3,9}\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/);
            const amtM = text.match(/\$([\d,]+\.\d{2})/);
            if (!dateM || !amtM) continue;
            const pdfA = row.querySelector('a[href*=".pdf"]');
            results.push({ date: dateM[1], amount: amtM[1], pdfHref: pdfA ? pdfA.getAttribute('href') || '' : '' });
          }
          return results.slice(0, 24);
        });
        historyRows.push(...scraped);
        console.log(`[Cox] History rows found: ${historyRows.length}`);
      }

      // ── Step 3: Build statements ───────────────────────────────────────────
      if (historyRows.length > 0) {
        for (const row of historyRows) {
          const statementDate = this.parseDate(row.date);
          if (!statementDate) continue;
          const amountDue = parseFloat(row.amount.replace(/,/g, ''));
          let pdfBuffer: Buffer | undefined;
          if (row.pdfHref) pdfBuffer = await this.downloadPdf(row.pdfHref);
          statements.push({
            statementDate,
            amountDue,
            pdfBuffer,
            pdfFilename: row.pdfHref ? `cox_${statementDate.toISOString().slice(0, 10)}.pdf` : undefined,
          });
        }
      } else {
        // Fall back: use PDF links scraped from ibill/home.html
        for (const entry of ibillData.billEntries) {
          const statementDate = this.parseDate(entry.date + ' 2025') || this.parseDate(entry.date);
          if (!statementDate) continue;
          let pdfBuffer: Buffer | undefined;
          if (entry.pdfHref) pdfBuffer = await this.downloadPdf(entry.pdfHref);
          statements.push({
            statementDate,
            pdfBuffer,
            pdfFilename: entry.pdfHref ? `cox_${statementDate.toISOString().slice(0, 10)}.pdf` : undefined,
          });
        }

        // Last resort: save current balance as a statement
        if (statements.length === 0 && ibillData.totalBalance) {
          const totalBalance = parseFloat(ibillData.totalBalance.replace(/,/g, ''));
          const dueImmediately = ibillData.dueImmediately
            ? parseFloat(ibillData.dueImmediately.replace(/,/g, ''))
            : undefined;
          const currentCharge = dueImmediately != null
            ? Math.max(0, Math.round((totalBalance - dueImmediately) * 100) / 100)
            : totalBalance;
          const dueDateParsed = ibillData.dueDate ? this.parseDate(ibillData.dueDate + ' 2025') : undefined;
          statements.push({
            statementDate: new Date(),
            dueDate: dueDateParsed ?? undefined,
            amountDue: currentCharge,
            rawData: { accountBalance: totalBalance, pastDue: dueImmediately, currentCharge },
          });
        }
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
