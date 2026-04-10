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

      // ── Step 1: Scrape ibill/home.html — total balance, past due, due date ──
      const ibillData = await this.page!.evaluate(() => {
        const allText = document.body.innerText || '';

        // "Total balance due April 16" pattern
        const dueDateM = allText.match(/Total balance due\s+(\w+\s+\d+)/i);
        const dueDate = dueDateM ? dueDateM[1] : null;

        // Total balance — the large dollar figure (e.g. $252.00)
        const totalBalM = allText.match(/Total balance[\s\S]{0,40}\$([\d,]+\.\d{2})/i);
        const totalBalance = totalBalM ? totalBalM[1] : null;

        // Due immediately (past due from prior month)
        const dueImmM = allText.match(/Due immediately[\s\S]{0,10}\$([\d,]+\.\d{2})/i);
        const dueImmediately = dueImmM ? dueImmM[1] : null;

        return { totalBalance, dueDate, dueImmediately, rawText: allText.slice(0, 800) };
      });

      console.log('[Cox] ibill — balance:', ibillData.totalBalance, '| dueDate:', ibillData.dueDate, '| pastDue:', ibillData.dueImmediately);
      console.log('[Cox] ibill raw text:', ibillData.rawText.slice(0, 400));

      // ── Step 2: Navigate to View statements page for full history ───────────
      // Try direct URL first (most reliable), then fallback to clicking the link
      const stmtUrls = [
        'https://www.cox.com/ibill/statements.html',
        'https://www.cox.com/ibill/statementhistory.html',
      ];
      let onStatementsPage = false;

      for (const url of stmtUrls) {
        await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await this.page!.waitForTimeout(3000);
        const valid = await this.page!.evaluate(() =>
          !/404|page not found/i.test(document.body.innerText || '') &&
          /\$[\d,]+\.\d{2}/.test(document.body.innerText || '')
        );
        if (valid) { onStatementsPage = true; break; }
      }

      if (!onStatementsPage) {
        // Fallback: go back to ibill and click View statements
        await this.page!.goto(this.BILLING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await this.page!.waitForTimeout(3000);
        const clicked = await this.page!.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a'));
          for (let i = 0; i < links.length; i++) {
            if (/view\s+statements?/i.test(links[i].textContent || '')) {
              links[i].click(); return true;
            }
          }
          return false;
        });
        if (clicked) {
          await this.page!.waitForTimeout(4000);
          onStatementsPage = true;
        }
      }

      await this.screenshot('cox-statements-page');
      console.log('[Cox] Statements page URL:', this.page!.url());

      // ── Step 3: Scrape the full statement history with paid detection ────────
      const stmtRows = await this.page!.evaluate(() => {
        const results = [];

        // Cox statements page typically has a table with rows per statement period
        // Each row: date | amount | payment status | Pay button (if unpaid)
        const allRows = Array.from(document.querySelectorAll('table tr, [class*="statement-row"], [class*="bill-row"], [class*="invoice-row"]'));

        for (let i = 0; i < allRows.length; i++) {
          const row = allRows[i];
          const text = (row.textContent || '').trim();
          if (!text || !/\$[\d,]+\.\d{2}/.test(text)) continue;

          // Must have a date
          const dateM = text.match(/(\w{3,9}\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/);
          if (!dateM) continue;

          const amtM = text.match(/\$([\d,]+\.\d{2})/);
          if (!amtM) continue;

          // Detect paid status: no "Pay" / "Make a payment" button in this row = paid
          const allBtns = Array.from(row.querySelectorAll('a, button'));
          const hasPayBtn = allBtns.some(function(b) {
            return /\bpay\b/i.test(b.textContent || '') || /\bpayment\b/i.test(b.textContent || '');
          });

          const pdfA = row.querySelector('a[href*=".pdf"]') as HTMLAnchorElement | null;

          results.push({
            date: dateM[1],
            amount: amtM[1],
            hasPayBtn: hasPayBtn,
            pdfHref: pdfA ? pdfA.href : '',
          });
        }

        // Fallback: broad text scan if table didn't work
        if (results.length === 0) {
          const lines = (document.body.innerText || '').split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const dateM = line.match(/(\w{3,9}\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/);
            const amtM = line.match(/\$([\d,]+\.\d{2})/);
            if (dateM && amtM) {
              results.push({ date: dateM[1], amount: amtM[1], hasPayBtn: true, pdfHref: '' });
            }
          }
        }

        return results.slice(0, 24);
      });

      console.log(`[Cox] Statement rows found: ${stmtRows.length}`, stmtRows.slice(0, 3));

      // ── Step 4: Build statements ────────────────────────────────────────────
      // Parse out total balance and past due from ibill/home.html data
      const totalBalance = ibillData.totalBalance
        ? parseFloat(ibillData.totalBalance.replace(/,/g, ''))
        : null;
      const pastDueAmt = ibillData.dueImmediately
        ? parseFloat(ibillData.dueImmediately.replace(/,/g, ''))
        : null;
      const currentCharge = (totalBalance != null && pastDueAmt != null)
        ? Math.max(0, Math.round((totalBalance - pastDueAmt) * 100) / 100)
        : totalBalance;
      const dueDateParsed = ibillData.dueDate
        ? this.parseDate(ibillData.dueDate + ' 2026')
          ?? this.parseDate(ibillData.dueDate + ' 2025')
        : undefined;

      if (stmtRows.length > 0) {
        // First row with a Pay button = most recent unpaid (current or past due)
        // Rows without a Pay button = paid
        let unpaidCount = 0;
        for (const row of stmtRows) {
          const statementDate = this.parseDate(row.date);
          if (!statementDate) continue;
          const amountDue = parseFloat(row.amount.replace(/,/g, ''));

          // Determine paid/unpaid status from Pay button presence
          const isPaid = !row.hasPayBtn;

          // For the unpaid statements, annotate with past due / current charge split
          let rowRawData: Record<string, unknown> = { isPaid };
          if (!isPaid) {
            if (unpaidCount === 0) {
              // Most recent unpaid = current charge
              rowRawData = {
                isPaid: false,
                accountBalance: totalBalance,
                pastDue: pastDueAmt,
                currentCharge: currentCharge ?? amountDue,
              };
            } else {
              // Older unpaid = past due portion
              rowRawData = { isPaid: false, isPastDue: true };
            }
            unpaidCount++;
          }

          let pdfBuffer: Buffer | undefined;
          if (row.pdfHref) pdfBuffer = await this.downloadPdf(row.pdfHref);

          statements.push({
            statementDate,
            dueDate: !isPaid && unpaidCount === 1 ? dueDateParsed : undefined,
            amountDue,
            pdfBuffer,
            pdfFilename: row.pdfHref ? `cox_${statementDate.toISOString().slice(0, 10)}.pdf` : undefined,
            rawData: rowRawData,
          });
        }
      } else {
        // Fallback: create statements from ibill data only
        // Current month statement
        if (currentCharge != null && currentCharge > 0) {
          statements.push({
            statementDate: new Date(),
            dueDate: dueDateParsed ?? undefined,
            amountDue: currentCharge,
            rawData: {
              accountBalance: totalBalance,
              pastDue: pastDueAmt,
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
