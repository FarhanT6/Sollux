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

        // "Total balance due April 16" — the due date line
        const dueDateM = allText.match(/Total balance due\s+(\w+\s+\d+)/i);
        const dueDate = dueDateM ? dueDateM[1] : null;

        // Total balance: extract the section between "Total balance" and "Due immediately"
        // to avoid the greedy regex grabbing the Due immediately amount instead
        let totalBalance: string | null = null;
        const betweenM = allText.match(/Total balance([\s\S]*?)Due immediately/i);
        if (betweenM) {
          const m = betweenM[1].match(/\$([\d,]+\.\d{2})/);
          if (m) totalBalance = m[1];
        }
        // Fallback: first dollar amount on page
        if (!totalBalance) {
          const m = allText.match(/\$([\d,]+\.\d{2})/);
          if (m) totalBalance = m[1];
        }

        // Due immediately (past due from prior month)
        const dueImmM = allText.match(/Due immediately[\s\S]{0,20}\$([\d,]+\.\d{2})/i);
        const dueImmediately = dueImmM ? dueImmM[1] : null;

        return { totalBalance, dueDate, dueImmediately, rawText: allText.slice(0, 800) };
      });

      console.log('[Cox] ibill — balance:', ibillData.totalBalance, '| dueDate:', ibillData.dueDate, '| pastDue:', ibillData.dueImmediately);
      console.log('[Cox] ibill raw text:', ibillData.rawText.slice(0, 400));

      // ── Step 2: Click "View statements" from ibill/home.html ───────────────
      // We are already on ibill/home.html — find and click the link, then wait
      // for the actual statements page to load with invoice history rows.
      const statementsHref = await this.page!.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        for (let i = 0; i < links.length; i++) {
          if (/view\s+statements?/i.test(links[i].textContent || '')) {
            return (links[i] as HTMLAnchorElement).href || null;
          }
        }
        return null;
      });

      if (statementsHref) {
        console.log('[Cox] Navigating to statements URL:', statementsHref);
        await this.page!.goto(statementsHref, { waitUntil: 'domcontentloaded', timeout: 25000 });
      } else {
        // Fallback: click directly
        await this.page!.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a'));
          for (let i = 0; i < links.length; i++) {
            if (/view\s+statements?/i.test(links[i].textContent || '')) {
              (links[i] as HTMLAnchorElement).click(); return;
            }
          }
        });
      }

      await this.page!.waitForTimeout(5000);
      await this.screenshot('cox-statements-page');
      console.log('[Cox] Statements page URL:', this.page!.url());

      // ── Step 3: Scrape statement history ──────────────────────────────────────
      // Cox's statements page format (from actual portal text):
      //   Statement date   Total due   Billing period
      //   Mar 26, 2026   View bill (PDF)   $120.00   Mar 26, 2026 - Apr 25, 2026
      //   Feb 25, 2026   View bill (PDF)   $132.00   Feb 26, 2026 - Mar 25, 2026
      //
      // Pay buttons are rendered as DOM elements but do NOT appear in innerText.
      // Instead, we use the totalBalance + dueImmediately from ibill/home.html to
      // determine paid status: walk newest-to-oldest, subtract from totalBalance.
      // When remaining balance hits 0, the rest are paid.
      const stmtRows = await this.page!.evaluate(() => {
        const results = [];
        const pageText = document.body.innerText || '';

        // Collect all PDF link hrefs in order so we can attach them to rows
        const pdfLinks = Array.from(document.querySelectorAll('a[href*="pdf"], a[href*="PDF"], a[href*="view-bill"], a[href*="viewbill"]'));
        const pdfHrefs = pdfLinks.map(function(a) { return (a as HTMLAnchorElement).href || ''; });

        // Parse text lines — each statement line starts with "Month DD, YYYY"
        const lines = pageText.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
        let pdfIdx = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Statement date: "Mar 26, 2026"
          const dateM = line.match(/^(\w{3}\s+\d{1,2},\s+\d{4})/);
          if (!dateM) continue;
          const statementDate = dateM[1];

          // Dollar amount on same line or next few lines
          let amount = '';
          const amtOnLine = line.match(/\$([\d,]+\.\d{2})/);
          if (amtOnLine) {
            amount = amtOnLine[1];
          } else {
            for (let j = 1; j <= 3 && i + j < lines.length; j++) {
              const nextAmt = lines[i + j].match(/^\$([\d,]+\.\d{2})$/);
              if (nextAmt) { amount = nextAmt[1]; break; }
            }
          }
          if (!amount) continue;

          // Billing period: "Mar 26, 2026 - Apr 25, 2026" on same or adjacent line
          let billingStart = '';
          let billingEnd = '';
          const periodM = line.match(/(\w{3}\s+\d{1,2},\s+\d{4})\s*[-–]\s*(\w{3}\s+\d{1,2},\s+\d{4})/);
          if (periodM) {
            billingStart = periodM[1];
            billingEnd = periodM[2];
          } else {
            for (let j = 1; j <= 3 && i + j < lines.length; j++) {
              const pm = lines[i + j].match(/(\w{3}\s+\d{1,2},\s+\d{4})\s*[-–]\s*(\w{3}\s+\d{1,2},\s+\d{4})/);
              if (pm) { billingStart = pm[1]; billingEnd = pm[2]; break; }
            }
          }

          results.push({
            statementDate: statementDate,
            amount: amount,
            billingStart: billingStart,
            billingEnd: billingEnd,
            pdfHref: pdfHrefs[pdfIdx] || '',
          });
          pdfIdx++;
        }

        return { rows: results.slice(0, 24), debugText: results.length === 0 ? pageText.slice(0, 600) : '' };
      }) as { rows: Array<{ statementDate: string; amount: string; billingStart: string; billingEnd: string; pdfHref: string }>; debugText: string };

      if (stmtRows.debugText) {
        console.log('[Cox] No statement rows parsed, page text:', stmtRows.debugText);
      }
      console.log(`[Cox] Statement rows found: ${stmtRows.rows.length}`, JSON.stringify(stmtRows.rows.slice(0, 3)));

      // ── Step 4: Build statements ────────────────────────────────────────────
      const totalBalance = ibillData.totalBalance
        ? parseFloat(ibillData.totalBalance.replace(/,/g, ''))
        : null;
      const pastDueAmt = ibillData.dueImmediately
        ? parseFloat(ibillData.dueImmediately.replace(/,/g, ''))
        : null;
      // Current charge = total balance minus past due
      const currentCharge = (totalBalance != null && pastDueAmt != null)
        ? Math.max(0, Math.round((totalBalance - pastDueAmt) * 100) / 100)
        : totalBalance;
      const totalDueDateParsed = ibillData.dueDate
        ? this.parseDate(ibillData.dueDate + ' 2026') ?? this.parseDate(ibillData.dueDate + ' 2025')
        : undefined;

      console.log(`[Cox] Balance breakdown — total: ${totalBalance}, pastDue: ${pastDueAmt}, current: ${currentCharge}, dueDate: ${ibillData.dueDate}`);

      if (stmtRows.rows.length > 0) {
        // Paid detection: walk statements newest-first, subtract from totalBalance.
        // Once remaining balance hits 0, all older statements are paid.
        // This is reliable even when multiple months are past due.
        let remainingUnpaid = totalBalance ?? 0;

        for (const row of stmtRows.rows) {
          const statementDate = this.parseDate(row.statementDate);
          if (!statementDate) continue;
          const amountDue = parseFloat(row.amount.replace(/,/g, ''));
          if (isNaN(amountDue) || amountDue <= 0) continue;

          const isPaid = remainingUnpaid <= 0.01; // paid once balance is exhausted
          if (!isPaid) remainingUnpaid = Math.round((remainingUnpaid - amountDue) * 100) / 100;

          // Determine due date and rawData for unpaid rows
          let rowDueDate: Date | undefined;
          let rowRawData: Record<string, unknown> = { isPaid };

          if (!isPaid) {
            // First unpaid (newest) = current charge, due on the overall due date
            // Subsequent unpaid = past due, due immediately (already overdue)
            const isCurrentCharge = remainingUnpaid <= 0.01 && pastDueAmt == null
              ? true
              : amountDue === currentCharge && statements.filter(s => !(s.rawData?.isPaid)).length === 0;

            // Simpler: if this is the most recent unpaid statement, it's current
            const isFirst = statements.filter(s => !(s.rawData as any)?.isPaid).length === 0;

            if (isFirst) {
              rowDueDate = totalDueDateParsed;
              rowRawData = {
                isPaid: false,
                accountBalance: totalBalance,
                pastDue: pastDueAmt,
                currentCharge: amountDue,
              };
            } else {
              // Older unpaid = past due, no due date (already past due)
              rowRawData = { isPaid: false, isPastDue: true };
            }
          }

          let pdfBuffer: Buffer | undefined;
          if (row.pdfHref) pdfBuffer = await this.downloadPdf(row.pdfHref).catch(() => undefined);

          statements.push({
            statementDate,
            dueDate: rowDueDate,
            billingPeriodStart: this.parseDate(row.billingStart) ?? undefined,
            billingPeriodEnd: this.parseDate(row.billingEnd) ?? undefined,
            amountDue,
            pdfBuffer,
            pdfFilename: row.pdfHref ? `cox_${statementDate.toISOString().slice(0, 10)}.pdf` : undefined,
            rawData: rowRawData,
          });
        }
      } else {
        // Fallback: create a single current-charge statement from ibill data only
        // (no full history available — at least show the current amount)
        if (currentCharge != null && currentCharge > 0) {
          statements.push({
            statementDate: new Date(),
            dueDate: totalDueDateParsed ?? undefined,
            amountDue: currentCharge,
            rawData: {
              isPaid: false,
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
    const payments: ScrapedPayment[] = [];
    try {
      // Navigate directly to the transaction history page
      // URL observed from browser: /ibill/transaction-history.html?selectedStatementCode=001
      const TXN_URL = 'https://www.cox.com/ibill/transaction-history.html?selectedStatementCode=001';
      console.log('[Cox] Navigating to transaction history:', TXN_URL);
      await this.page!.goto(TXN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(5000);
      await this.screenshot('cox-txn-history');
      console.log('[Cox] Transaction history URL:', this.page!.url());

      // Check for 404 or redirect away
      const is404 = await this.page!.evaluate(() =>
        /404|can't find that page/i.test(document.body.innerText || '')
      );
      if (is404 || !this.page!.url().includes('transaction-history')) {
        // Fallback: go to ibill/home.html and click "View transaction history"
        console.log('[Cox] Direct nav failed, trying from billing home...');
        await this.page!.goto(this.BILLING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.page!.waitForTimeout(4000);

        const txnHref = await this.page!.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a'));
          const a = links.find(el => /transaction\s*history/i.test(el.textContent || ''));
          return a ? (a as HTMLAnchorElement).href : null;
        });

        if (!txnHref) {
          console.warn('[Cox] No transaction history link found');
          return payments;
        }
        console.log('[Cox] Found transaction history link:', txnHref);
        await this.page!.goto(txnHref, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await this.page!.waitForTimeout(5000);
        await this.screenshot('cox-txn-history-2');
      }

      // ── Expand date range to pull full history ────────────────────────────
      // The page uses a calendar date-picker widget. We use evaluate() to set
      // values directly on the inputs and fire change events, then press Escape
      // to close any calendar popup before clicking Submit.
      console.log('[Cox] Setting date range to get full history...');
      try {
        const today = new Date();
        const endDateStr = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;

        // Set dates via evaluate to bypass the calendar picker
        await this.page!.evaluate(({ start, end }) => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="date"], input:not([type])'));
          const startInput = inputs.find(el => {
            const id = (el.id || '').toLowerCase();
            const name = ((el as HTMLInputElement).name || '').toLowerCase();
            const label = document.querySelector(`label[for="${el.id}"]`)?.textContent?.toLowerCase() || '';
            return id.includes('start') || name.includes('start') || label.includes('start');
          }) as HTMLInputElement | undefined;
          const endInput = inputs.find(el => {
            const id = (el.id || '').toLowerCase();
            const name = ((el as HTMLInputElement).name || '').toLowerCase();
            const label = document.querySelector(`label[for="${el.id}"]`)?.textContent?.toLowerCase() || '';
            return id.includes('end') || name.includes('end') || label.includes('end');
          }) as HTMLInputElement | undefined;

          const setValue = (el: HTMLInputElement, val: string) => {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            nativeInputValueSetter?.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };

          if (startInput) setValue(startInput, start);
          if (endInput) setValue(endInput, end);

          return { startId: startInput?.id, endId: endInput?.id };
        }, { start: '01/01/2019', end: endDateStr });

        console.log('[Cox] Set date range 01/01/2019 →', endDateStr);
        await this.page!.waitForTimeout(500);

        // Press Escape to close any open calendar popup
        await this.page!.keyboard.press('Escape');
        await this.page!.waitForTimeout(500);

        // Click Submit using evaluate to bypass visibility checks
        const clicked = await this.page!.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
          const submit = btns.find(el => /submit/i.test(el.textContent || '') || (el as HTMLInputElement).value === 'Submit') as HTMLElement | undefined;
          if (submit) { submit.click(); return true; }
          return false;
        });
        console.log('[Cox] Submit clicked via evaluate:', clicked);
        await this.page!.waitForTimeout(6000);
        await this.screenshot('cox-txn-full-range');
        console.log('[Cox] After submit URL:', this.page!.url());

        // Log how many rows are now showing
        const listingText = await this.page!.evaluate(() => {
          const el = Array.from(document.querySelectorAll('*')).find(e => /Listing\s+\d/.test(e.textContent || ''));
          return el?.textContent?.match(/Listing[^\n]*/)?.[0] || '';
        });
        console.log('[Cox] Listing count after expand:', listingText);

      } catch (err) {
        console.warn('[Cox] Date range expansion failed:', err instanceof Error ? err.message : err);
      }

      // Wait for the table rows to appear
      try {
        await this.page!.waitForFunction(
          () => document.querySelectorAll('table tr, [class*="transaction"], [class*="payment-row"]').length > 1,
          { timeout: 15000 }
        );
      } catch {
        console.warn('[Cox] Transaction rows did not appear in 15s');
      }

      // Dump raw page text for diagnostics
      const rawText = await this.page!.evaluate(() => (document.body.innerText || ''));
      console.log('[Cox] Transaction history raw text:\n', rawText.slice(0, 2000));

      // ── Expand each row by clicking the ▶ arrow, then scrape details ──────
      // The table has expand toggles (▶ buttons or clickable rows) next to each date.
      // After clicking, the row expands to reveal confirmation # and payment method.
      const expandButtons = await this.page!.$$('table tbody tr td:first-child button, table tbody tr td:first-child [role="button"], table tbody tr.expandable, button[aria-label*="expand"], td[class*="expand"] button, td[class*="toggle"]');
      console.log(`[Cox] Found ${expandButtons.length} expand buttons`);

      // Click all expand buttons to reveal details
      for (const btn of expandButtons) {
        try {
          await btn.click();
          await this.page!.waitForTimeout(800);
        } catch { /* ignore */ }
      }

      // If no dedicated expand buttons found, try clicking the first cell of each data row
      if (expandButtons.length === 0) {
        const rows = await this.page!.$$('table tbody tr:not([class*="detail"]):not([class*="expand"])');
        console.log(`[Cox] Trying to click ${rows.length} table rows to expand`);
        for (const row of rows) {
          try {
            await row.click();
            await this.page!.waitForTimeout(800);
          } catch { /* ignore */ }
        }
      }

      await this.screenshot('cox-txn-expanded');

      // Now scrape the full page text with all expanded rows
      const expandedText = await this.page!.evaluate(() => document.body.innerText || '');
      console.log('[Cox] Expanded transaction text:\n', expandedText.slice(0, 2000));

      // Parse rows: date format is MM/DD/YYYY from the table
      // Each row: date | description ("Payment") | status ("Successful") | amount
      // Expanded detail: confirmation #, payment method, etc.
      const parsed = await this.page!.evaluate(() => {
        const results: Array<{
          date: string;
          amount: string;
          status: string;
          confirmationNumber: string;
          paymentMethod: string;
          rawDetail: string;
        }> = [];

        // Walk all table rows
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        for (let i = 0; i < rows.length; i++) {
          const cells = Array.from(rows[i].querySelectorAll('td'));
          const rowText = (rows[i].textContent || '').replace(/\s+/g, ' ').trim();

          // Main data row: has a date (MM/DD/YYYY) and a dollar amount
          const dateM = rowText.match(/(\d{2}\/\d{2}\/\d{4})/);
          const amtM  = rowText.match(/\$([\d,]+\.\d{2})/);
          if (!dateM || !amtM) continue;

          const statusM = rowText.match(/(Successful|Pending|Failed|Reversed)/i);

          // Look for expanded detail — check the full row text first (detail may be inline),
          // then check adjacent rows
          let confirmationNumber = '';
          let paymentMethod = '';
          // The expanded detail is inline in rowText after clicking the toggle
          const detailSources = [rowText];
          for (let j = 1; j <= 5 && i + j < rows.length; j++) {
            const next = (rows[i + j].textContent || '').replace(/\s+/g, ' ').trim();
            if (/\d{2}\/\d{2}\/\d{4}/.test(next) && /\$[\d,]+\.\d{2}/.test(next)) break;
            detailSources.push(next);
          }
          let rawDetail = detailSources.join(' ');
          for (const detailText of detailSources) {

                // Match "Confirmation Number: XXXXX" or "Conf#: XXXXX" or "Reference: XXXXX"
            // Require a colon or # separator to avoid capturing label words like "Number"
            const confM = detailText.match(/(?:confirm(?:ation)?(?:\s+number)?|reference|auth(?:orization)?(?:\s+code)?|transaction\s*id)\s*[:#]\s*([A-Z0-9\-]{4,30})/i);
            if (confM && !confirmationNumber) confirmationNumber = confM[1];

            // Cox expanded format: "Paid With: Visa ending in 5854" or "Paid With: Bank ending in 0705"
            const paidWithM = detailText.match(/paid\s+with\s*:\s*(.+?)(?:\s+Statement:|$)/i);
            if (paidWithM && !paymentMethod) {
              paymentMethod = paidWithM[1].trim();
            } else {
              const methodM = detailText.match(/(visa|mastercard|amex|discover|bank\s+ending|checking\s+ending|credit\s+card|debit\s+card|e-?check|autopay|auto\s+pay)/i);
              if (methodM && !paymentMethod) paymentMethod = methodM[1];
            }
          }

          results.push({
            date: dateM[1],
            amount: amtM[1],
            status: statusM ? statusM[1] : '',
            confirmationNumber: confirmationNumber.trim(),
            paymentMethod: paymentMethod.trim(),
            rawDetail: rawDetail.trim().slice(0, 300),
          });
        }
        return results;
      });

      console.log(`[Cox] Parsed payment rows: ${parsed.length}`, JSON.stringify(parsed));

      for (const row of parsed) {
        // Skip non-payment or failed transactions
        if (row.status && /failed|reversed/i.test(row.status)) continue;

        const paymentDate = this.parseDate(row.date);
        if (!paymentDate) continue;
        const amount = parseFloat(row.amount.replace(/,/g, ''));
        if (isNaN(amount) || amount <= 0) continue;

        payments.push({
          paymentDate,
          amount,
          confirmationNumber: row.confirmationNumber || undefined,
          paymentMethod: row.paymentMethod || undefined,
        });
      }

    } catch (err) {
      console.error('[Cox] Payment scraping error:', err instanceof Error ? err.message : err);
      await this.screenshot('cox-payments-error');
    }

    console.log(`[Cox] Total payments found: ${payments.length}`);
    return payments;
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
