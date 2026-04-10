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

      // ── Step 1: Scrape the current bill summary from ibill/home.html ──────
      // The page shows: Total balance ($252), due date (April 16), due immediately ($132)
      // and a "Bill summary" table with per-statement rows and "view PDF" links.
      const ibillData = await this.page!.evaluate(() => {
        const txt = (el: Element | null) => el?.textContent?.trim() || '';

        // Total balance
        const balanceEl = document.querySelector('.total-balance, [class*="total-balance"], [class*="totalBalance"]');
        let totalBalance: string | null = null;
        let dueDate: string | null = null;
        let dueImmediately: string | null = null;

        // Scan all text nodes for the key amounts — ibill uses its own CSS classes
        const allText = document.body.innerText || '';

        // "Total balance due April 16" pattern
        const dueDateM = allText.match(/Total balance due\s+(\w+ \d+)/i);
        if (dueDateM) dueDate = dueDateM[1];

        // First large dollar on page is usually total balance
        const dollarMatches = [...allText.matchAll(/\$([\d,]+\.\d{2})/g)];
        if (dollarMatches[0]) totalBalance = dollarMatches[0][1];
        // "Due immediately: $132.00"
        const dueImmM = allText.match(/Due immediately[:\s]+\$([\d,]+\.\d{2})/i);
        if (dueImmM) dueImmediately = dueImmM[1];

        // Bill summary table — each column header is a statement date (e.g. "Feb 26", "Mar 26")
        // Each has a "view PDF" link
        type BillEntry = { date: string; pdfHref?: string };
        const billEntries: BillEntry[] = [];

        // Look for "view PDF" links — they're typically <a> elements near date text
        const pdfLinks = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
        for (const link of pdfLinks) {
          const linkText = link.textContent?.trim().toLowerCase() || '';
          if (!linkText.includes('pdf') && !linkText.includes('view pdf')) continue;
          // Walk up to find the nearest date text
          let el: Element | null = link;
          let dateText = '';
          for (let i = 0; i < 5 && el; i++) {
            const t = el.textContent || '';
            const dm = t.match(/(\w{3}\s+\d{1,2}(?:,?\s*\d{4})?)/);
            if (dm) { dateText = dm[1]; break; }
            el = el.parentElement;
          }
          billEntries.push({ date: dateText || '', pdfHref: link.href || undefined });
        }

        // Also check table header cells for dates paired with PDF links
        if (billEntries.length === 0) {
          const ths = Array.from(document.querySelectorAll('th, td'));
          for (const th of ths) {
            const t = th.textContent?.trim() || '';
            const dm = t.match(/^(\w{3}\s+\d{1,2})$/);
            if (!dm) continue;
            const pdfLink = th.querySelector('a') as HTMLAnchorElement | null;
            billEntries.push({ date: dm[1], pdfHref: pdfLink?.href });
          }
        }

        return { totalBalance, dueDate, dueImmediately, billEntries, rawText: allText.slice(0, 800) };
      });

      console.log('[Cox] ibill data:', JSON.stringify({ ...ibillData, rawText: ibillData.rawText.slice(0, 200) }));

      // ── Step 2: Navigate to "View statements" for full history ─────────────
      // Click the "View statements" link on ibill/home.html
      const viewStatementsClicked = await this.page!.evaluate(() => {
        const link = Array.from(document.querySelectorAll('a'))
          .find(a => /view\s+statements?/i.test(a.textContent || ''));
        if (link) { (link as HTMLAnchorElement).click(); return true; }
        return false;
      });

      let historyRows: Array<{ date: string; amount: string; pdfHref?: string }> = [];

      if (viewStatementsClicked) {
        await this.page!.waitForTimeout(4000);
        await this.screenshot('cox-view-statements');
        console.log('[Cox] View statements URL:', this.page!.url());

        historyRows = await this.page!.evaluate(() => {
          type HRow = { date: string; amount: string; pdfHref?: string };
          const results: HRow[] = [];
          // Table rows with date + amount + optional PDF link
          const rows = Array.from(document.querySelectorAll('table tr, [class*="statement" i], [class*="history" i]'));
          for (const row of rows) {
            const text = row.textContent?.trim() || '';
            if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
            const dateM = text.match(/(\w{3}\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/);
            const amtM = text.match(/\$([\d,]+\.\d{2})/);
            if (!dateM || !amtM) continue;
            const pdfHref = (row.querySelector('a[href*=".pdf"], a:has-text("PDF"), a:has-text("pdf")') as HTMLAnchorElement | null)?.href;
            results.push({ date: dateM[1], amount: amtM[1], pdfHref });
          }
          return results.slice(0, 24);
        });
        console.log(`[Cox] History rows found: ${historyRows.length}`);
      }

      // ── Step 3: Build statements ───────────────────────────────────────────
      if (historyRows.length > 0) {
        // Use full statement history
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
        // Fall back: use bill summary PDF links from ibill/home.html + current balance
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

        // If we got nothing from PDF links, at minimum save the current bill
        if (statements.length === 0 && ibillData.totalBalance) {
          const totalBalance = parseFloat(ibillData.totalBalance.replace(/,/g, ''));
          const dueImmediately = ibillData.dueImmediately
            ? parseFloat(ibillData.dueImmediately.replace(/,/g, ''))
            : undefined;
          // Current month charge = total balance - past due
          const currentCharge = dueImmediately != null
            ? Math.max(0, Math.round((totalBalance - dueImmediately) * 100) / 100)
            : totalBalance;
          const dueDate = ibillData.dueDate ? this.parseDate(ibillData.dueDate + ' 2025') : undefined;
          statements.push({
            statementDate: new Date(),
            dueDate: dueDate ?? undefined,
            amountDue: currentCharge,
            rawData: {
              accountBalance: totalBalance,
              pastDue: dueImmediately,
              currentCharge,
            },
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
