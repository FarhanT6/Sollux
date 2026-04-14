/**
 * City of Brawley Utility Billing scraper
 * Portal: Tyler Technologies / MunicipalOnlinePayments
 *
 * Flow:
 *  1. Login → account.municipalonlinepayments.com (OIDC → redirects to brawleyca portal)
 *  2. Navigate directly to /brawleyca/utilities (skip app-launcher click)
 *  3. For each account number: go to /utilities/accounts/transactionhistory/{acct}
 *  4. Expand date range to 01/01/2019 → today, click Apply
 *  5. Parse all rows: Bill entries = statements, Payment entries = payments
 *  6. For each Bill row, click the bill link → download PDF → parse with pdf-parse
 */
import pdfParse from 'pdf-parse';
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';
import * as path from 'path';

export class CityBrawleyScraper extends BaseScraperProvider {
  readonly providerSlug = 'city-brawley';
  readonly providerName = 'City of Brawley';

  private readonly LOGIN_URL = 'https://account.municipalonlinepayments.com/Account/Login';
  private readonly APP_URL   = 'https://brawleyca.municipalonlinepayments.com/brawleyca/utilities';

  async login(credentials: ScraperCredentials): Promise<boolean> {
    // ── Strategy: raw HTTP POST via Playwright's API request context ──────────
    // The browser automation fingerprint (navigator.webdriver, etc.) causes the
    // Tyler Technologies portal to silently reject logins. Using context.request
    // makes a pure HTTP call with zero automation signals, sharing the same cookie
    // jar with the browser so subsequent page navigations are authenticated.
    try {
      const BASE = 'https://account.municipalonlinepayments.com';

      // 1. GET the login page — seeds session cookies + extracts CSRF token
      console.log('[Brawley] Fetching login page via API...');
      const getResp = await this.context!.request.get(`${BASE}/Account/Login`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const html = await getResp.text();

      // Extract ASP.NET anti-forgery token (present in some Tyler Tech deployments)
      const csrfMatch = html.match(/name="__RequestVerificationToken"[^>]+value="([^"]+)"/);
      const csrf = csrfMatch?.[1] ?? '';
      console.log('[Brawley] CSRF token:', csrf ? 'found' : 'not found');

      // 2. POST credentials — same as submitting the login form.
      // Must include ReturnUrl (even empty) and button=login — required by the server.
      const body = new URLSearchParams({
        Email:     credentials.username,
        Password:  credentials.password,
        ReturnUrl: '',
        button:    'login',
        ...(csrf ? { __RequestVerificationToken: csrf } : {}),
      });

      console.log('[Brawley] POSTing credentials via API...');
      const postResp = await this.context!.request.post(`${BASE}/Account/Login`, {
        data: body.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer':       `${BASE}/Account/Login`,
          'Origin':        BASE,
          'User-Agent':    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept':        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        maxRedirects: 15,  // follow the full OIDC redirect chain
      });

      const finalUrl = postResp.url();
      const status   = postResp.status();
      console.log('[Brawley] API POST result:', status, finalUrl);

      // Success = redirected away from the login page (302 → / or brawleyca portal)
      // Failure = 200 back on the login page
      if (postResp.status() === 200 && finalUrl.includes('Account/Login')) {
        const respHtml = await postResp.text().catch(() => '');
        const errMsg = respHtml.match(/class="[^"]*(?:error|validation)[^"]*"[^>]*>([^<]+)</i)?.[1]?.trim() ?? 'unknown';
        console.error('[Brawley] API login failed. Server message:', errMsg);
        return false;
      }

      // 3. Navigate browser page to the portal — cookies are already in the shared context
      console.log('[Brawley] API login succeeded, navigating browser to portal...');
      await this.page!.goto(this.APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(3000);
      await this.screenshot('brawley-post-login');

      const pageUrl = this.page!.url();
      console.log('[Brawley] Browser page URL after login:', pageUrl);

      if (pageUrl.includes('Account/Login')) {
        console.error('[Brawley] Browser still on login page after API auth — cookies not shared?');
        return false;
      }

      console.log('[Brawley] Login successful');
      return true;
    } catch (err) {
      console.error('[Brawley] Login error:', err instanceof Error ? err.message : err);
      await this.screenshot('brawley-login-error');
      return false;
    }
  }

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const statements: ScrapedStatement[] = [];
    const accountNumbers = this.getAccountNumbers();
    console.log('[Brawley] Scraping statements for accounts:', accountNumbers);

    for (const accountNumber of accountNumbers) {
      try {
        const acctStatements = await this.scrapeAccountStatements(accountNumber);
        statements.push(...acctStatements);
      } catch (err) {
        console.error(`[Brawley] Error scraping statements for ${accountNumber}:`, err instanceof Error ? err.message : err);
        await this.screenshot(`brawley-error-${accountNumber}`);
      }
    }

    console.log(`[Brawley] Total statements: ${statements.length}`);
    return statements;
  }

  private async navigateToTransactionHistory(accountNumber: string): Promise<void> {
    const txnUrl = `${this.APP_URL}/accounts/transactionhistory/${accountNumber}`;
    console.log(`[Brawley] Navigating to transaction history: ${txnUrl}`);

    // SPA route — navigate to base first so the app bootstraps, then push the route
    const currentUrl = this.page!.url();
    if (!currentUrl.includes('brawleyca.municipalonlinepayments.com')) {
      await this.page!.goto(this.APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(3000);
    }

    // Now navigate to the specific account route
    try {
      await this.page!.goto(txnUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err: any) {
      // ERR_ABORTED is common on SPA navigations — the app cancels the HTTP request
      // and handles routing client-side. If we're on the right page, proceed.
      if (!err.message?.includes('ERR_ABORTED')) throw err;
      console.log('[Brawley] Navigation aborted (SPA routing) — checking current URL...');
    }
    await this.page!.waitForTimeout(4000);
  }

  private async scrapeAccountStatements(accountNumber: string): Promise<ScrapedStatement[]> {
    const statements: ScrapedStatement[] = [];

    await this.navigateToTransactionHistory(accountNumber);
    await this.screenshot(`brawley-txn-${accountNumber}`);
    console.log(`[Brawley] Transaction page URL: ${this.page!.url()}`);

    // ── Expand date range to get full history ──────────────────────────────
    await this.expandDateRange();

    // ── Parse transaction table ────────────────────────────────────────────
    const rows = await this.parseTransactionTable();
    console.log(`[Brawley] ${accountNumber}: ${rows.length} transaction rows`);

    // Skip bills already in DB — compare against the per-account cutoff first,
    // falling back to the global latestStatementDate for single-account scrapers.
    // Using per-account dates ensures a brand-new account (no statements yet)
    // is never blocked by another account's already-stored date.
    const perAcct = this.credentials?.latestStatementDates?.[accountNumber];
    const latestKnown = perAcct
      ? new Date(perAcct)
      : this.credentials?.latestStatementDate
        ? new Date(this.credentials.latestStatementDate)
        : null;

    // Find all "Bill" rows newer than what's already stored.
    const billRows = rows.filter(r => {
      if (!r.description.toLowerCase().includes('bill')) return false;
      if (!r.billUrl && !r.isClickable) return false;
      if (latestKnown) {
        const rowDate = this.parseDate(r.date);
        if (rowDate && rowDate <= latestKnown) return false; // already have this one
      }
      return true;
    });
    console.log(`[Brawley] ${accountNumber}: ${billRows.length} new bill rows to scrape (latestKnown=${latestKnown?.toISOString().slice(0,10) ?? 'none'})`);

    for (const row of billRows) {
      try {
        const stmt = await this.scrapeBill(row, accountNumber);
        if (stmt) statements.push(stmt);
      } catch (err) {
        console.warn(`[Brawley] Error scraping bill ${row.date}:`, err instanceof Error ? err.message : err);
      }
    }

    return statements;
  }

  private async expandDateRange(): Promise<void> {
    const today = new Date();
    const endStr = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;

    try {
      // Pass as raw string — tsx/esbuild never transforms string arguments,
      // so __name() is never injected and the code runs cleanly in the browser.
      await this.page!.evaluate(`(function(start, end) {
        var inputs = Array.from(document.querySelectorAll('input'));
        var fromInput = inputs.find(function(el) {
          var p = (el.placeholder || '').toLowerCase();
          var lblEl = document.querySelector('label[for="' + el.id + '"]');
          var l = lblEl && lblEl.textContent ? lblEl.textContent.toLowerCase() : '';
          var id = (el.id || '').toLowerCase();
          return p.indexOf('from') >= 0 || l.indexOf('from') >= 0 || id.indexOf('from') >= 0
              || p.indexOf('start') >= 0 || l.indexOf('start') >= 0 || id.indexOf('start') >= 0;
        });
        var toInput = inputs.find(function(el) {
          var p = (el.placeholder || '').toLowerCase();
          var lblEl = document.querySelector('label[for="' + el.id + '"]');
          var l = lblEl && lblEl.textContent ? lblEl.textContent.toLowerCase() : '';
          var id = (el.id || '').toLowerCase();
          return p.indexOf('to') >= 0 || l.indexOf('to') >= 0 || id.indexOf('to') >= 0
              || p.indexOf('end') >= 0 || l.indexOf('end') >= 0 || id.indexOf('end') >= 0;
        });
        var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        var nativeSetter = desc && desc.set;
        if (fromInput && nativeSetter) {
          nativeSetter.call(fromInput, start);
          fromInput.dispatchEvent(new Event('input', { bubbles: true }));
          fromInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (toInput && nativeSetter) {
          nativeSetter.call(toInput, end);
          toInput.dispatchEvent(new Event('input', { bubbles: true }));
          toInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })('01/01/2019', '${endStr}')`);

      await this.page!.waitForTimeout(500);
      await this.page!.keyboard.press('Escape');
      await this.page!.waitForTimeout(300);

      // Click Apply button — also as string to avoid __name
      const applied = await this.page!.evaluate(`(function() {
        var btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        var applyBtn = btns.find(function(el) {
          return /apply/i.test(el.textContent || '') || /apply/i.test(el.value || '');
        });
        if (applyBtn) { applyBtn.click(); return true; }
        return false;
      })()`);

      if (applied) {
        console.log('[Brawley] Date range expanded, waiting for table reload...');
        await this.page!.waitForTimeout(5000);
        await this.screenshot('brawley-txn-full-range');
        const listing = await this.page!.evaluate(
          `document.body.innerText.match(/\\d+\\s*-\\s*\\d+\\s*of\\s*\\d+/)?.[0] || ''`
        );
        console.log('[Brawley] Listing after expand:', listing);
      }
    } catch (err) {
      console.warn('[Brawley] Date range expansion failed:', err instanceof Error ? err.message : err);
    }
  }

  private async parseTransactionTable(): Promise<Array<{
    date: string; description: string; amount: string; runningBalance: string;
    billUrl: string | null; rowIndex: number; isClickable: boolean;
  }>> {
    // Pass as string to avoid __name injection.
    // Key findings from debug:
    //  - Cells are <td class="forge-table-cell ..."> — use querySelectorAll('td') only
    //  - Text is inside <span class="forge-table-cell__container-text"> inside the td
    //  - Bill rows have role="link" on the <td> but NO <a> tag — must click to navigate
    return this.page!.evaluate(`(function() {
      var results = [];
      var rows = Array.from(document.querySelectorAll('table tbody tr'));
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 3) continue;

        // Extract text from the inner span if present, else fall back to textContent
        function cellText(td) {
          var span = td.querySelector('.forge-table-cell__container-text');
          return (span ? span.textContent : td.textContent).replace(/\\s+/g, ' ').trim();
        }

        var dateText = cellText(cells[0]);
        if (!/^\\d{1,2}\\/\\d{1,2}\\/\\d{4}$/.test(dateText)) continue;

        var descCell = cells[1];
        var descText = cellText(descCell);
        var amtText  = cellText(cells[2]);
        var balText  = cells[3] ? cellText(cells[3]) : '';

        // Bill rows: td has role="link" or class containing "forge-link"
        var isClickable = descCell.getAttribute('role') === 'link'
          || descCell.className.indexOf('forge-link') >= 0;

        // Anchor fallback (some deployments may use <a>)
        var anchor = descCell.querySelector('a');
        var billUrl = anchor ? anchor.href : null;

        results.push({
          date: dateText,
          description: descText,
          amount: amtText,
          runningBalance: balText,
          billUrl: billUrl,
          rowIndex: i,
          isClickable: isClickable,
        });
      }
      return results;
    })()`);
  }

  private async scrapeBill(row: {
    date: string; description: string; amount: string; runningBalance: string;
    billUrl: string | null; rowIndex: number; isClickable: boolean;
  }, accountNumber: string): Promise<ScrapedStatement | null> {

    const statementDate = this.parseDate(row.date);
    if (!statementDate) return null;

    const amountStr = row.amount.replace(/[($,)\s]/g, '');
    const billAmt = parseFloat(amountStr);

    console.log(`[Brawley] Scraping bill ${row.date} = $${billAmt} | clickable=${row.isClickable} url=${row.billUrl}`);

    let pdfBuffer: Buffer | undefined;
    let billDetails: Record<string, unknown> = {};

    try {
      if (row.billUrl) {
        // Anchor link — navigate directly
        await this.page!.goto(row.billUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      } else if (row.isClickable) {
        // Forge table cell with role="link" — click it and wait for SPA navigation
        const txnUrl = this.page!.url();
        await this.page!.evaluate(`(function(idx) {
          var rows = document.querySelectorAll('table tbody tr');
          var row = rows[idx];
          if (!row) return;
          var cells = Array.from(row.querySelectorAll('td'));
          var descCell = cells[1];
          if (descCell) descCell.click();
        })(${row.rowIndex})`);
        // Wait for URL to change (SPA routing)
        try {
          await this.page!.waitForURL(u => u.toString() !== txnUrl, { timeout: 10000 });
        } catch { /* may not change URL if it uses hash routing */ }
      } else {
        return null;
      }

      await this.page!.waitForTimeout(3000);
      await this.screenshot(`brawley-bill-${row.date.replace(/\//g, '-')}`);

      // Look for a Download link (PDF)
      const downloadHref = await this.page!.evaluate(`(function() {
        var links = Array.from(document.querySelectorAll('a'));
        var dl = links.find(function(l) {
          return /download/i.test(l.textContent || '') || /\\.pdf/i.test(l.getAttribute('href') || '');
        });
        return dl ? dl.href : null;
      })()`);

      if (downloadHref) {
        console.log(`[Brawley] Downloading PDF: ${downloadHref}`);
        try {
          const res = await this.page!.request.get(downloadHref as string, { timeout: 20000 });
          if (res.ok()) {
            pdfBuffer = Buffer.from(await res.body());
            console.log(`[Brawley] PDF downloaded: ${pdfBuffer.length} bytes`);
            billDetails = await this.parseBillPdf(pdfBuffer);
          }
        } catch (pdfErr) {
          console.warn('[Brawley] PDF download failed:', pdfErr instanceof Error ? pdfErr.message : pdfErr);
        }
      }

      if (Object.keys(billDetails).length === 0) {
        billDetails = await this.parseBillPage();
      }

      // Navigate back
      await this.page!.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await this.page!.waitForTimeout(2000);
    } catch (err) {
      console.warn(`[Brawley] Bill page error for ${row.date}:`, err instanceof Error ? err.message : err);
      await this.page!.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    }

    const n = (k: string) => billDetails[k] != null ? Number(billDetails[k]) : undefined;

    return {
      statementDate,
      dueDate:            billDetails.dueDate ? this.parseDate(String(billDetails.dueDate)) ?? undefined : undefined,
      billingPeriodStart: billDetails.periodStart ? this.parseDate(String(billDetails.periodStart)) ?? undefined : undefined,
      billingPeriodEnd:   billDetails.periodEnd   ? this.parseDate(String(billDetails.periodEnd))   ?? undefined : undefined,
      amountDue:          n('currentBill') ?? billAmt,
      usageValue:         n('gallons'),
      usageUnit:          'GAL',
      pdfBuffer:          pdfBuffer ? Buffer.from(pdfBuffer) : undefined,
      pdfFilename:        pdfBuffer ? `brawley_${accountNumber}_${statementDate.toISOString().slice(0, 10)}.pdf` : undefined,
      rawData: {
        accountNumber,
        previousBalance: n('previousBalance'),
        payments:        n('payments'),
        adjustments:     n('adjustments'),
        penalties:       n('penalties'),
        pastDue:         n('pastDue'),
        currentBill:     n('currentBill') ?? billAmt,
        totalDue:        n('totalDue'),
        afterDueDateAmt: n('afterDueDateAmt'),
        waterCharge:     n('water'),
        sewerCharge:     n('sewer'),
        taxCharge:       n('tax'),
        runningBalance:  parseFloat(row.runningBalance.replace(/[($,)\s]/g, '')) || undefined,
        isPaid:          false,
      },
    };
  }

  private async parseBillPage(): Promise<Record<string, unknown>> {
    return this.page!.evaluate(() => {
      const text = document.body.innerText || '';
      const n = (re: RegExp) => {
        const m = text.match(re);
        return m ? parseFloat(m[1].replace(/[$,]/g, '')) : undefined;
      };
      const d = (re: RegExp) => text.match(re)?.[1]?.trim() || undefined;

      return {
        previousBalance: n(/Previous\s+Balance[:\s]+\$?([\d,]+\.\d{2})/i),
        payments:        n(/Payments[:\s]+\$?([\d,]+\.\d{2})/i),
        adjustments:     n(/Adjustments[:\s]+\$?([\d,]+\.\d{2})/i),
        penalties:       n(/Penalties[:\s]+\$?([\d,]+\.\d{2})/i),
        pastDue:         n(/Past\s+Due\s+Amount[:\s]+\$?([\d,]+\.\d{2})/i),
        currentBill:     n(/Current\s+Bill[:\s]+\$?([\d,]+\.\d{2})/i),
        totalDue:        n(/Amount\s+Due[:\s]+\$?([\d,]+\.\d{2})/i) || n(/Total\s+Due[:\s]+\$?([\d,]+\.\d{2})/i),
        afterDueDateAmt: n(/Amount\s+Due\s+After[^$]*\$?([\d,]+\.\d{2})/i),
        water:           n(/Water[:\s]+\$?([\d,]+\.\d{2})/i),
        sewer:           n(/Sewer[:\s]+\$?([\d,]+\.\d{2})/i),
        tax:             n(/Tax[:\s]+\$?([\d,]+\.\d{2})/i),
        gallons:         (() => { const m = text.match(/(\d[\d,]+)\s*(?:gallons?|GAL)/i); return m ? parseInt(m[1].replace(/,/g, '')) : undefined; })(),
        dueDate:         d(/Due\s+Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i),
        periodStart:     d(/(?:Service\s+)?(?:From|Start)[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i),
        periodEnd:       d(/(?:Service\s+)?(?:To|End|Through)[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i),
      };
    });
  }

  private async parseBillPdf(pdfBuffer: Buffer): Promise<Record<string, unknown>> {
    try {
      const parsed = await pdfParse(pdfBuffer);
      const text = parsed.text;
      console.log('[Brawley] PDF text:\n', text.slice(0, 1500));

      const n = (re: RegExp) => {
        const m = text.match(re);
        return m ? parseFloat(m[1].replace(/[$,]/g, '')) : undefined;
      };
      const d = (re: RegExp) => text.match(re)?.[1]?.trim() || undefined;

      return {
        previousBalance: n(/PREVIOUS\s+BALANCE\s+\$?([\d,]+\.\d{2})/i),
        payments:        n(/PAYMENTS?\s+\$?([\d,]+\.\d{2})/i),
        adjustments:     n(/ADJUSTMENTS?\s+\$?([\d,]+\.\d{2})/i),
        penalties:       n(/PENALTIES?\s+\$?([\d,]+\.\d{2})/i),
        pastDue:         n(/PAST\s+DUE\s+AMOUNT\s+\$?([\d,]+\.\d{2})/i),
        currentBill:     n(/CURRENT\s+BILL\s+\$?([\d,]+\.\d{2})/i),
        totalDue:        n(/AMOUNT\s+DUE\s+\$?([\d,]+\.\d{2})/i),
        afterDueDateAmt: n(/AMOUNT\s+DUE\s+AFTER\s+\d[^\n]*\$?([\d,]+\.\d{2})/i),
        water:           n(/Water\s+\$?([\d,]+\.\d{2})/i),
        sewer:           n(/Sewer\s+\$?([\d,]+\.\d{2})/i),
        tax:             n(/Tax\s+\$?([\d,]+\.\d{2})/i),
        gallons:         (() => {
          // "GALLONS ... 44,000" or "CURRENT READING ... PREVIOUS READING ... GALLONS"
          const m = text.match(/GALLONS?\s+\n?\s*([\d,]+)/i) || text.match(/(\d[\d,]+)\s*(?:gallons?|GAL)/i);
          return m ? parseInt(m[1].replace(/,/g, '')) : undefined;
        })(),
        dueDate:   d(/Due\s+Date\s+(\d{1,2}\/\d{1,2}\/\d{4})/i),
        periodStart: d(/(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*\d{1,2}\/\d{1,2}\/\d{4}/),
        periodEnd:   d(/\d{1,2}\/\d{1,2}\/\d{4}\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/),
      };
    } catch (err) {
      console.warn('[Brawley] PDF parse error:', err instanceof Error ? err.message : err);
      return {};
    }
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
    const payments: ScrapedPayment[] = [];
    const accountNumbers = this.getAccountNumbers();

    for (const accountNumber of accountNumbers) {
      try {
        const acctPayments = await this.scrapeAccountPayments(accountNumber);
        payments.push(...acctPayments);
      } catch (err) {
        console.error(`[Brawley] Error scraping payments for ${accountNumber}:`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`[Brawley] Total payments: ${payments.length}`);
    return payments;
  }

  private async scrapeAccountPayments(accountNumber: string): Promise<ScrapedPayment[]> {
    const payments: ScrapedPayment[] = [];
    await this.navigateToTransactionHistory(accountNumber);
    await this.expandDateRange();

    const rows = await this.parseTransactionTable();
    for (const row of rows) {
      if (!/payment/i.test(row.description)) continue;

      const paymentDate = this.parseDate(row.date);
      if (!paymentDate) continue;

      // Amount is in parentheses for credits: ($500.00) → 500.00
      const amt = parseFloat(row.amount.replace(/[($,)\s]/g, ''));
      if (isNaN(amt) || amt <= 0) continue;

      payments.push({ paymentDate, amount: amt });
    }

    console.log(`[Brawley] ${accountNumber}: ${payments.length} payment(s)`);
    return payments;
  }

  private getAccountNumbers(): string[] {
    const nums = this.credentials?.accountNumbers?.filter(Boolean) || [];
    if (nums.length) return nums;
    const single = this.credentials?.accountNumber;
    return single ? [single] : [];
  }

  private async screenshot(name: string): Promise<void> {
    try {
      const p = require('path').join('/tmp', `${name}-${Date.now()}.png`);
      await this.page!.screenshot({ path: p, fullPage: true });
      console.log(`[Brawley] Screenshot: ${p}`);
    } catch { /* ignore */ }
  }
}
