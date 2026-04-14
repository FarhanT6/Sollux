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

  // Cache populated by scrapeStatements() so that scrapePayments() (called concurrently
  // by the base class via Promise.all) can return without re-navigating the same pages.
  private _paymentCache: ScrapedPayment[] = [];
  private _scraped = false;

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    await this._scrapeAll();
    return this._statementCache;
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
    await this._scrapeAll();
    return this._paymentCache;
  }

  private _statementCache: ScrapedStatement[] = [];

  /** Single combined pass: navigate each account once, collect both statements and payments. */
  private async _scrapeAll(): Promise<void> {
    if (this._scraped) return;   // already done (handles concurrent Promise.all calls)
    this._scraped = true;

    const accountNumbers = this.getAccountNumbers();
    console.log('[Brawley] Scraping accounts (combined pass):', accountNumbers);

    for (const accountNumber of accountNumbers) {
      try {
        await this.navigateToTransactionHistory(accountNumber);
        await this.screenshot(`brawley-txn-${accountNumber}`);
        console.log(`[Brawley] Transaction page URL: ${this.page!.url()}`);

        await this.expandDateRange();
        const rows = await this.parseAllPages();
        console.log(`[Brawley] ${accountNumber}: ${rows.length} transaction rows`);

        // ── Statements ────────────────────────────────────────────────────────
        // Use the exact-date set to skip only rows whose specific date is already
        // stored in S3. DO NOT use a cutoff (latestKnown) — that would block older
        // bills that were never downloaded (e.g. 2024 data when we only have 2025-26).
        const knownDates: Set<string> = new Set(
          this.credentials?.knownStatementDates?.[accountNumber] ?? []
        );
        console.log(`[Brawley] ${accountNumber}: ${knownDates.size} dates already stored`);

        const billRows = rows.filter(r => {
          if (!r.description.toLowerCase().includes('bill')) return false;
          if (!r.billUrl && !r.isClickable) return false;
          const rowDate = this.parseDate(r.date);
          if (rowDate) {
            const iso = rowDate.toISOString().slice(0, 10); // YYYY-MM-DD
            if (knownDates.has(iso)) return false; // exact date already in S3, skip
          }
          return true;
        });
        console.log(`[Brawley] ${accountNumber}: ${billRows.length} new bill rows to scrape`);

        for (const row of billRows) {
          try {
            const stmt = await this.scrapeBill(row, accountNumber);
            if (stmt) this._statementCache.push(stmt);
          } catch (err) {
            console.warn(`[Brawley] Error scraping bill ${row.date}:`, err instanceof Error ? err.message : err);
          }
        }

        // ── Payments ──────────────────────────────────────────────────────────
        for (const row of rows) {
          if (!/payment/i.test(row.description)) continue;
          const paymentDate = this.parseDate(row.date);
          if (!paymentDate) continue;
          const amt = parseFloat(row.amount.replace(/[($,)\s]/g, ''));
          if (isNaN(amt) || amt <= 0) continue;
          this._paymentCache.push({ paymentDate, amount: amt });
        }
        console.log(`[Brawley] ${accountNumber}: ${this._paymentCache.length} payment(s) so far`);

      } catch (err) {
        console.error(`[Brawley] Error scraping ${accountNumber}:`, err instanceof Error ? err.message : err);
        await this.screenshot(`brawley-error-${accountNumber}`);
      }
    }

    console.log(`[Brawley] Total: ${this._statementCache.length} statement(s), ${this._paymentCache.length} payment(s)`);
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

  private async expandDateRange(): Promise<void> {
    const today = new Date();
    const endStr = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
    const startStr = '01/01/2019';

    try {
      // Wait for the page to fully settle before touching anything.
      await this.page!.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await this.page!.waitForTimeout(1500);

      // ── Step 1: find and focus the "from" date input via shadow-root traversal ──
      // Forge date pickers put their <input> inside a shadow root. We can't use
      // page.locator() to fill them, but we CAN focus() them in evaluate and then
      // use page.keyboard to type — keyboard events reach any focused element.
      const focusInfo = await this.page!.evaluate(`(function() {
        function allInputs(root) {
          var found = [];
          var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
          var node;
          while ((node = walker.nextNode())) {
            if (node.tagName === 'INPUT') found.push(node);
            if (node.shadowRoot) found = found.concat(allInputs(node.shadowRoot));
          }
          return found;
        }
        var inputs = allInputs(document);
        var textInputs = inputs.filter(function(i) { return i.type === 'text' || i.type === 'date'; });

        // Log all inputs for diagnostics
        console.log('[Brawley-eval] Inputs:', textInputs.map(function(i) {
          return (i.placeholder || i.id || i.name || i.type);
        }).join(' | '));

        // Also log top-level forge-button / button elements for diagnostics
        var topBtns = Array.from(document.querySelectorAll('forge-button, button'));
        console.log('[Brawley-eval] Top-level buttons:', topBtns.map(function(b) {
          return b.tagName + ':' + (b.textContent || '').trim().slice(0, 30);
        }).join(' | '));

        if (textInputs.length === 0) return { found: false };

        // Focus the first input (Start / From date)
        textInputs[0].focus();
        textInputs[0].select();
        return { found: true, count: textInputs.length };
      })()`);

      if (!(focusInfo as any)?.found) {
        console.log('[Brawley] No date inputs found on page');
        return;
      }
      console.log(`[Brawley] Found ${(focusInfo as any).count} date input(s), typing start date...`);

      // ── Step 2: type start date via real keyboard events ─────────────────────
      // Forge components IGNORE the native setter trick — they respond only to
      // real keyboard input events dispatched by the OS-level keyboard event path.
      await this.page!.keyboard.press('Control+A');
      await this.page!.keyboard.type(startStr, { delay: 50 });
      await this.page!.waitForTimeout(400);
      await this.page!.keyboard.press('Tab');          // move to "end" input
      await this.page!.waitForTimeout(400);
      await this.page!.keyboard.press('Control+A');
      await this.page!.keyboard.type(endStr, { delay: 50 });
      await this.page!.waitForTimeout(400);

      // ── Step 3: trigger the filter ────────────────────────────────────────────
      // Try pressing Enter first (auto-apply on Enter is common in Forge filters).
      await this.page!.keyboard.press('Enter');
      await this.page!.waitForTimeout(800);

      // Also try clicking a forge-button or <button> with Apply/Search/Filter text.
      // forge-button is a top-level custom element — NOT inside a shadow root —
      // so a plain querySelectorAll finds it.
      const clicked = await this.page!.evaluate(`(function() {
        var candidates = Array.from(document.querySelectorAll(
          'forge-button, button, [role="button"]'
        ));
        console.log('[Brawley-eval] Button candidates:', candidates.map(function(b) {
          return b.tagName + ':' + (b.textContent || '').trim().slice(0, 40);
        }).join(' | '));
        var btn = candidates.find(function(b) {
          var t = (b.textContent || b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
          return /^(apply|search|filter|go|update)$/i.test(t);
        });
        if (btn) { btn.click(); return (btn.textContent || '').trim(); }
        return null;
      })()`);

      if (clicked) {
        console.log(`[Brawley] Clicked button: "${clicked}"`);
      } else {
        console.log('[Brawley] No Apply button found — relied on Enter key');
      }

      // Wait for table to reload after filter
      await this.page!.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await this.page!.waitForTimeout(3000);
      await this.screenshot('brawley-txn-full-range');

      const listing = await this.page!.evaluate(
        `document.body.innerText.match(/\\d+\\s*[-–]\\s*\\d+\\s*of\\s*\\d+/)?.[0] || ''`
      );
      console.log('[Brawley] Row listing after date expand:', listing || '(no pagination text found)');

    } catch (err) {
      console.warn('[Brawley] Date range expansion failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Walk through all pagination pages and collect every transaction row. */
  private async parseAllPages(): Promise<Array<{
    date: string; description: string; amount: string; runningBalance: string;
    billUrl: string | null; rowIndex: number; isClickable: boolean;
  }>> {
    const allRows: Array<{
      date: string; description: string; amount: string; runningBalance: string;
      billUrl: string | null; rowIndex: number; isClickable: boolean;
    }> = [];

    let pageNum = 0;
    while (true) {
      pageNum++;
      const rows = await this.parseTransactionTable();
      allRows.push(...rows);

      // Check for a "Next page" button that is enabled
      const hasNext = await this.page!.evaluate(`(function() {
        function allElements(root, tag) {
          var found = [];
          var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
          var node;
          while ((node = walker.nextNode())) {
            if (node.tagName === tag.toUpperCase()) found.push(node);
            if (node.shadowRoot) found = found.concat(allElements(node.shadowRoot, tag));
          }
          return found;
        }
        var btns = allElements(document, 'button');
        // Forge pagination uses aria-label="Next page" or title="Next" or ›/» text
        var next = btns.find(function(b) {
          var label = (b.getAttribute('aria-label') || b.title || b.textContent || '').toLowerCase();
          return (label.indexOf('next') >= 0 || label === '›' || label === '»' || label === '>') &&
                 !b.disabled && !b.hasAttribute('disabled');
        });
        if (next) { next.click(); return true; }
        return false;
      })()`);

      if (!hasNext) {
        console.log(`[Brawley] Pagination: ${pageNum} page(s), ${allRows.length} total rows`);
        break;
      }

      console.log(`[Brawley] Pagination: loaded page ${pageNum}, clicking Next...`);
      await this.page!.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await this.page!.waitForTimeout(2000);

      if (pageNum > 20) {
        console.warn('[Brawley] Pagination safety limit (20 pages) reached');
        break;
      }
    }

    return allRows;
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
        // accountBalance = canonical "total amount currently owed" field read by the frontend.
        // Equal to totalDue (current charge + any past due); fall back to amountDue.
        accountBalance:  n('totalDue') ?? (n('currentBill') ?? billAmt),
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
