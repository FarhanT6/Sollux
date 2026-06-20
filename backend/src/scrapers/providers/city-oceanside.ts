/**
 * City of Oceanside Water Utility scraper
 * Portal: https://oceanside.watersmart.com (WaterSmart / VertexOne, Yii 1.x PHP)
 *
 * Hard-won lessons:
 *  - HTTP POST login sets cookies in context.request but they DON'T transfer to browser pages.
 *    Browser login only.
 *  - Direct page.goto() to /billing or /billing/index causes server-side logout UNLESS
 *    account context has been established first via the userPicker link click.
 *  - After the picker click + 8s wait the Yii session has account context, so
 *    goto('/billing/index') and goto('/billing/viewBill') are both safe.
 *  - payBill only shows UNPAID bills; billing/index has full history.
 *  - viewBill shows the current bill's detail inline.
 *  - All page.evaluate() calls use raw ES5 strings to avoid tsx/esbuild
 *    __name() injection (which doesn't exist in the browser context).
 *
 * Flow:
 *  1. Browser login → land on combinedSummary
 *  2. evaluate-click account picker link → wait 8 s for session context
 *  3. goto /billing/index (full history) — fallback to /billing/viewBill
 *  4. Parse all invoice rows (date + amount + href)
 *  5. For each row: goto(viewBill href), look for PDF download link
 *  6. Fall back to page.pdf() if no real PDF link found
 */
import pdfParse from 'pdf-parse';
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';
import * as path from 'path';

export class CityOceansideScraper extends BaseScraperProvider {
  readonly providerSlug = 'city-oceanside';
  readonly providerName = 'City of Oceanside';

  private readonly BASE_URL    = 'https://oceanside.watersmart.com';
  private readonly LOGIN_URL   = 'https://oceanside.watersmart.com/index.php/welcome/login';
  private readonly SUMMARY_URL = 'https://oceanside.watersmart.com/index.php/combinedSummary/index';

  // ── Login ────────────────────────────────────────────────────────────────

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      // ── Step 1: Try to reuse existing session from persistent browser profile ──
      // WaterSmart marks browsers as trusted via cookies/localStorage. Clearing cookies on
      // every run destroys that trust and triggers bot-detection / email-verification challenges.
      // So: check if we're already logged in first; only do a full login if the session is dead.
      console.log('[Oceanside] Checking for existing session...');
      await this.page!.goto(this.SUMMARY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(2000);
      const existingUrl = this.page!.url();
      console.log('[Oceanside] Session check URL:', existingUrl);

      if (!existingUrl.includes('/login') && !existingUrl.includes('/logout') && !existingUrl.includes('/welcome')) {
        console.log('[Oceanside] Existing session active — skipping login');
        return true;
      }

      // ── Step 2: Session expired — attempt login WITHOUT clearing cookies ──
      // Preserving cookies keeps any trust tokens WaterSmart has set (device fingerprint,
      // "remember me" tokens, etc.) so we don't look like a new suspicious browser.
      console.log('[Oceanside] No active session — logging in...');
      const loginOk = await this.doLogin(credentials);
      if (loginOk) return true;

      // ── Step 3: Login failed — clear cookies and retry once ──
      // A stale/corrupted session can block the login form. Clear and try again.
      console.log('[Oceanside] Login failed with existing cookies — clearing and retrying...');
      await this.context!.clearCookies();
      return await this.doLogin(credentials);

    } catch (err) {
      // Re-throw MFA errors so the worker surfaces them clearly in the UI
      if (err instanceof Error && err.message.startsWith('MFA_REQUIRED')) throw err;
      console.error('[Oceanside] Login error:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Core login form submission. Called by login() with or without existing cookies. */
  private async doLogin(credentials: ScraperCredentials): Promise<boolean> {
    console.log('[Oceanside] Navigating to login page...');
    // Use 'load' (not 'domcontentloaded') so Yii's JS fully runs before we read the form.
    // Yii sets the CSRF token and initialises form validation via JavaScript.
    await this.page!.goto(this.LOGIN_URL, { waitUntil: 'load', timeout: 45000 });
    await this.page!.waitForTimeout(1500);
    await this.screenshot('oceanside-login-page');

    // Log visible page text so we can see if there's a CAPTCHA or error message
    const loginPageText = await this.page!.evaluate(
      `(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 500)`
    ) as string;
    console.log('[Oceanside] Login page text:', loginPageText);

    const userSel   = '#LoginForm_username, input[name="LoginForm[username]"], input[type="email"]';
    const passSel   = '#LoginForm_password, input[name="LoginForm[password]"], input[type="password"]';
    const submitSel = 'input[type="submit"], button[type="submit"]';

    const userField = await this.page!.$(userSel);
    if (!userField) {
      console.error('[Oceanside] Username field not found on login page');
      await this.screenshot('oceanside-no-login-form');
      return false;
    }

    // Use fill() for reliable form population (doesn't trigger character-by-character validation)
    await this.page!.fill(userSel, credentials.username);
    await this.page!.waitForTimeout(300);
    await this.page!.fill(passSel, credentials.password);
    await this.page!.waitForTimeout(500);
    await this.screenshot('oceanside-before-submit');
    await this.page!.click(submitSel);

    try {
      await this.page!.waitForURL(
        u => !u.toString().includes('/welcome/login') && !u.toString().includes('/login'),
        { timeout: 25000 }
      );
    } catch { /* check below */ }

    const postUrl = this.page!.url();
    await this.screenshot('oceanside-after-submit');

    // Log page text after submission — reveals error messages or verification prompts
    const postText = await this.page!.evaluate(
      `(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 500)`
    ) as string;
    console.log('[Oceanside] Post-submit page text:', postText);

    // WaterSmart ?forceEmail=1 means it wants email-based verification before allowing login.
    // This happens when it suspects automated access. Throw MFA_REQUIRED so the UI shows
    // a clear message telling the user to log in manually once to re-establish trust.
    if (/forceEmail/i.test(postUrl)) {
      throw new Error(
        'MFA_REQUIRED: City of Oceanside (WaterSmart) is requiring email verification. ' +
        'Log in to oceanside.watersmart.com manually in your browser, complete the email ' +
        'verification step, then click Sync again — Sollux will reuse the trusted session automatically.'
      );
    }

    if (/login|welcome\/login|logout/.test(postUrl)) {
      // Surface any MFA/verification challenge from the page content before giving up
      await this.throwIfMfaRequired();
      console.error('[Oceanside] Login form rejected, landed on:', postUrl);
      return false;
    }

    console.log('[Oceanside] Login successful:', postUrl);
    return true;
  }

  // ── Statements ───────────────────────────────────────────────────────────

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const statements: ScrapedStatement[] = [];

    // All account numbers this session should cover (may be 1 or many sharing the same login)
    const accountNumbers = (
      this.credentials?.accountNumbers?.length
        ? this.credentials.accountNumbers
        : [this.credentials?.accountNumber || '']
    ).map(n => n.replace(/\*/g, '').trim()).filter(Boolean);

    const primaryAccount = accountNumbers[0] || '';

    try {
      // Navigate once using the first account's picker context
      const onBilling = await this.navigateToBillingIndex(primaryAccount);
      if (!onBilling) {
        console.error('[Oceanside] Could not reach billing page');
        return [];
      }

      // Collect ALL rows from Invoice Cloud with no account filter.
      // The iframe shows open invoices for ALL accounts under this login in one view.
      const allRows = await this.collectInvoiceRows('');
      console.log(`[Oceanside] Total iframe rows: ${allRows.length}`);
      allRows.forEach(r => console.log(`[Oceanside]   ${r.accountNumber ?? 'unknown'} | ${r.date} ${r.amount} → ${r.href?.slice(-60) ?? 'no href'}`));

      if (allRows.length === 0) {
        console.warn('[Oceanside] No invoice rows — check /tmp/oceanside-* screenshots');
        return [];
      }

      // Process each tracked account separately with its own latestKnown cutoff
      for (const accountNumber of accountNumbers) {
        const datesMap = this.credentials?.latestStatementDates;
        const rawCutoff = datesMap
          ? (datesMap[accountNumber] ?? null)
          : (this.credentials?.latestStatementDate ?? null);
        const latestKnown = rawCutoff ? new Date(rawCutoff) : null;

        console.log(`[Oceanside] Account: ${accountNumber} | latestKnown: ${latestKnown?.toISOString().slice(0, 10) ?? 'none'}`);

        // Filter rows matching this account number
        const acctNorm = accountNumber.replace(/[-\s]/g, '');
        const acctRows = allRows.filter(r => {
          const rAcct = (r.accountNumber || '').replace(/[-\s]/g, '');
          return rAcct === acctNorm || rAcct.includes(acctNorm) || acctNorm.includes(rAcct);
        });

        const newRows = latestKnown
          ? acctRows.filter(r => { const d = this.parseDate(r.date); return d && d > latestKnown; })
          : acctRows;
        console.log(`[Oceanside] ${acctRows.length} row(s) for ${accountNumber}, ${newRows.length} new`);

        for (const row of newRows) {
          try {
            const stmt = await this.scrapeInvoice(row, accountNumber);
            if (stmt) statements.push(stmt);
          } catch (err) {
            console.error(`[Oceanside] Error scraping ${row.date} for ${accountNumber}:`, err instanceof Error ? err.message : err);
            await this.screenshot('oceanside-invoice-error');
          }
        }
      }
    } catch (err) {
      console.error('[Oceanside] Scrape error:', err instanceof Error ? err.message : err);
      await this.screenshot('oceanside-scrape-error');
    }

    console.log(`[Oceanside] Total statements: ${statements.length}`);
    return statements;
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  /**
   * Navigate to the billing history page.
   *
   * Strategy order:
   *   1. goto /billing/index  — works after account context is set via picker
   *   2. goto /billing/viewBill — safe fallback, shows only current bill
   *   3. goto /billing/payBill  — shows unpaid bills only
   *   4. evaluate-click a billing link visible on the current page
   *
   * Returns true if we land on any billing page that isn't a logout/login redirect.
   */
  private async navigateToBillingIndex(accountNumber: string): Promise<boolean> {
    await this.page!.goto(this.SUMMARY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page!.waitForTimeout(3000);
    await this.screenshot('oceanside-summary');

    const summaryUrl = this.page!.url();
    if (/login|logout|welcome\/login/.test(summaryUrl)) {
      console.error('[Oceanside] Not logged in at summary page:', summaryUrl);
      return false;
    }

    // ── Select account via userPicker ─────────────────────────────────────
    const pickerLinks = await this.page!.evaluate(`(function() {
      return Array.from(document.querySelectorAll('a[href*="userPicker"]')).map(function(a) {
        return { href: a.href, text: (a.textContent || '').replace(/\\s+/g, ' ').trim() };
      });
    })()`) as Array<{ href: string; text: string }>;
    console.log('[Oceanside] Picker links:', JSON.stringify(pickerLinks));

    if (pickerLinks.length > 0 && accountNumber) {
      const normalized = accountNumber.replace(/[-\s]/g, '');
      const segments   = accountNumber.split(/[-\s]/).filter(s => s.length >= 3);

      let pickerHref: string | null = null;
      for (const link of pickerLinks) {
        const linkNorm = link.text.replace(/[-\s]/g, '');
        if (normalized && linkNorm.includes(normalized)) { pickerHref = link.href; break; }
        if (segments.length >= 2 && segments.every(seg => link.text.includes(seg))) { pickerHref = link.href; break; }
      }
      if (!pickerHref) {
        const lastSeg = accountNumber.split(/[-\s]/).filter(s => s.length >= 4).pop();
        if (lastSeg) pickerHref = pickerLinks.find(l => l.text.includes(lastSeg))?.href ?? null;
      }
      // If still no match and only one picker link, just use it
      if (!pickerHref && pickerLinks.length === 1) pickerHref = pickerLinks[0].href;

      if (pickerHref) {
        console.log('[Oceanside] evaluate-click picker:', pickerLinks.find(l => l.href === pickerHref)?.text);
        // evaluate-click (not goto) — allows the React SPA to handle the navigation
        // event normally, setting up client-side session state required by billing.
        // goto(pickerHref) was tried and causes billing access to redirect to /logout.
        await this.page!.evaluate(`(function(href) {
          var a = Array.from(document.querySelectorAll('a')).find(function(el) { return el.href === href; });
          if (a) a.click();
        })('${pickerHref.replace(/'/g, "\\'")}')
        `);
        await this.page!.waitForTimeout(8000);
        await this.screenshot('oceanside-after-picker');
        const afterPickerUrl = this.page!.url();
        console.log('[Oceanside] After picker URL:', afterPickerUrl);
        if (/login|logout|welcome/.test(afterPickerUrl)) {
          console.error('[Oceanside] Picker click failed, landed on:', afterPickerUrl);
          return false;
        }
      } else {
        console.log('[Oceanside] No matching picker — proceeding with current account');
      }
    }

    // ── Navigate to billing via direct URL ───────────────────────────────────
    // After a fresh PHP session (cookies cleared in login) + evaluate-click picker,
    // the Yii session has valid account context and billing URLs are accessible.
    for (const subpath of ['billing/index', 'billing/invoiceHistory', 'billing/viewBill', 'billing/payBill']) {
      const url = `${this.BASE_URL}/index.php/${subpath}`;
      try {
        await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.page!.waitForTimeout(4000);
        const landed = this.page!.url();
        console.log(`[Oceanside] goto(${subpath}) → ${landed}`);
        await this.screenshot(`oceanside-${subpath.replace('/', '-')}`);
        if (!(/login|logout|welcome/.test(landed))) {
          return true;
        }
        console.log(`[Oceanside] ${subpath} redirected to login/logout — trying next`);
      } catch (err) {
        console.warn(`[Oceanside] goto(${subpath}) failed:`, err instanceof Error ? err.message : err);
      }
    }

    const bodyText = await this.page!.evaluate(`(document.body.innerText || '').slice(0, 300)`) as string;
    console.error('[Oceanside] All billing navigation strategies failed. Body:', bodyText);
    return false;
  }

  // ── Invoice row collection ───────────────────────────────────────────────

  private async collectInvoiceRows(accountNumber?: string): Promise<Array<{
    date: string; amount: string; href: string | null; accountNumber?: string;
  }>> {
    const currentUrl = this.page!.url();
    console.log('[Oceanside] Collecting rows from:', currentUrl);
    console.log('[Oceanside] Filtering rows for account:', accountNumber || '(any)');

    // Give the SPA extra time to render billing history rows
    await this.page!.waitForTimeout(4000);

    // Navigate to the invoice history list.
    // Prefer "Recent Invoice and Payment History" (no loading modal).
    // Fall back to "Closed Invoices" which triggers the "Checking for updated
    // information" modal that we wait out below.
    // Instead of clicking the link via JS, navigate directly to /billing/payBill
    // which is more reliable than finding the right element among multiple "Pay Bill" texts
    console.log('[Oceanside] Navigating directly to /billing/payBill');
    await this.page!.goto(`${this.BASE_URL}/index.php/billing/payBill`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await this.page!.waitForTimeout(3000);
    const expandedSection: string | null = 'Pay Bill';

    if (expandedSection) {
      console.log('[Oceanside] Clicked history link:', expandedSection);

      // Pay Bill navigates to /billing/payBill — wait for that URL
      if (/pay\s*bill/i.test(expandedSection)) {
        try {
          await this.page!.waitForURL(url => /payBill/i.test(url.toString()), { timeout: 15000 });
          console.log('[Oceanside] Reached Pay Bill page:', this.page!.url());
        } catch {
          console.log('[Oceanside] No URL change, continuing on current page');
        }
        await this.page!.waitForTimeout(3000);
      }

      // BOTH "Recent Invoice and Payment History" AND "Closed Invoices" trigger
      // the "Checking for updated information" loading modal. Wait for it to clear.
      console.log('[Oceanside] Waiting for data-refresh modal to clear...');

      // First wait for the modal to APPEAR
      await this.page!.waitForTimeout(3000);

      // Wait for ANY visible "Checking for updated" / "patience" text to disappear.
      // This checks all elements, not just body.innerText (which misses some modals).
      try {
        await this.page!.waitForFunction(`
          (function() {
            var allText = '';
            var els = document.querySelectorAll('*');
            for (var i = 0; i < els.length; i++) {
              var el = els[i];
              if (el.offsetParent === null) continue; // skip hidden
              var t = (el.textContent || '').toLowerCase();
              if (t.includes('checking for updated') || t.includes('thank you for your patience')) {
                return false;
              }
            }
            return true;
          })()
        `, { timeout: 60000, polling: 1000 });
        console.log('[Oceanside] Modal cleared');
      } catch {
        console.warn('[Oceanside] Modal still showing after 60s — trying to close it');
        // Try to click the CLOSE button
        await this.page!.evaluate(`
          (function() {
            var els = Array.from(document.querySelectorAll('button, a, span, div'));
            for (var i = 0; i < els.length; i++) {
              var t = (els[i].textContent || '').trim().toUpperCase();
              if (t === 'CLOSE' || t === '× CLOSE' || t === 'X CLOSE') {
                els[i].click();
                return true;
              }
            }
            return false;
          })()
        `);
        await this.page!.waitForTimeout(2000);
        await this.screenshot('oceanside-modal-after-close-attempt');
      }

      // After modal clears, wait for the invoice table to render
      await this.page!.waitForTimeout(5000);
      await this.screenshot('oceanside-billing-expanded');
    }

    // Scroll down to trigger lazy loading of history rows
    await this.page!.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
    await this.page!.waitForTimeout(2000);
    await this.page!.evaluate(`window.scrollTo(0, 0)`);
    await this.screenshot('oceanside-invoice-list');

    // The Pay Bill page embeds an Invoice Cloud iframe with pre-authenticated session.
    // The actual invoice rows are inside that iframe — parse rows from the iframe context.
    const invoiceCloudFrame = this.page!.frames().find(f =>
      f.url().includes('invoicecloud.com') || f.url().includes('customerportalredirect')
    );

    if (invoiceCloudFrame) {
      console.log('[Oceanside] Found Invoice Cloud iframe:', invoiceCloudFrame.url().slice(0, 80));
      // Wait for invoice rows to appear inside the iframe
      try {
        await invoiceCloudFrame.waitForFunction(`
          (function() {
            var rows = document.querySelectorAll('tr, [class*="invoice"], [class*="bill-row"]');
            for (var i = 0; i < rows.length; i++) {
              var t = (rows[i].textContent || '');
              if (t.match(/\\$[\\d,]+\\.\\d{2}/) && t.match(/\\d{1,2}\\/\\d{1,2}\\/\\d{4}/)) {
                return true;
              }
            }
            return false;
          })()
        `, { timeout: 20000 });
        console.log('[Oceanside] Invoice rows appeared inside iframe');
      } catch {
        console.warn('[Oceanside] Timed out waiting for iframe invoice rows');
      }

      // Take screenshot via the iframe's URL navigation if possible
      await this.screenshot('oceanside-iframe-loaded');

      const iframeText = await invoiceCloudFrame.evaluate(
        `(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 8000)`
      ) as string;
      console.log('[Oceanside] Iframe page text:', iframeText);

      // Parse ALL rows from inside the iframe and tag each with its account number.
      // Strategy: anchor on each "View Invoice" link (one per row), then walk up to the
      // smallest ancestor containing exactly ONE Account # reference — that's the row container.
      // This avoids the trap of matching a parent that contains all rows' text.
      const acctParamFrame = accountNumber || '';
      const iframeRows = await invoiceCloudFrame.evaluate(`(function() {
        var targetAccount = ${JSON.stringify(acctParamFrame)};
        var targetNorm = targetAccount.replace(/[-\\s]/g, '');
        var results = [];
        var seen = {};

        function findInvoiceDate(text) {
          var beforeAmt = text.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{4})[\\s\\S]{0,40}\\$\\s*[\\d,]+\\.\\d{2}/);
          if (beforeAmt) return beforeAmt[1];
          var m = text.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/);
          if (m) return m[1];
          m = text.match(/([A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})/i);
          return m ? m[1] : null;
        }

        function extractAccountNumber(text) {
          var m = text.match(/Account\\s*#?\\s*(\\d{6}-\\d{6})/i);
          return m ? m[1] : null;
        }

        // Find each row by anchoring on "View Invoice" link, then climb up to its row container
        var allLinks = Array.from(document.querySelectorAll('a, button'));
        var viewLinks = allLinks.filter(function(el) {
          var t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          return /^view\\s+invoice$/i.test(t) || /^view\\s*invoice$/i.test(t);
        });

        for (var i = 0; i < viewLinks.length; i++) {
          var link = viewLinks[i];

          // Walk up: find smallest ancestor that contains exactly ONE Account # match
          var container = link.parentElement;
          var rowContainer = null;
          var hops = 0;
          while (container && container.tagName !== 'BODY' && hops < 20) {
            var t = (container.innerText || container.textContent || '');
            var accountMatches = t.match(/Account\\s*#?\\s*\\d{6}-\\d{6}/gi) || [];
            if (accountMatches.length === 1) {
              var dateOk = /\\d{1,2}\\/\\d{1,2}\\/\\d{4}/.test(t);
              var amtOk = /\\$[\\d,]+\\.\\d{2}/.test(t);
              if (dateOk && amtOk) { rowContainer = container; break; }
            }
            if (accountMatches.length > 1) break; // climbed too far
            container = container.parentElement;
            hops++;
          }
          if (!rowContainer) continue;

          var text = ((rowContainer.innerText || rowContainer.textContent || '')).replace(/\\s+/g, ' ').trim();
          var dateStr = findInvoiceDate(text);
          var amtMatch = text.match(/\\$\\s*([\\d,]+\\.\\d{2})/);
          var rowAccount = extractAccountNumber(text);
          if (!dateStr || !amtMatch || !rowAccount) continue;

          if (targetNorm) {
            var rowNorm = text.replace(/[-\\s]/g, '');
            if (rowNorm.indexOf(targetNorm) === -1) continue;
          }

          var href = link.href || (link.getAttribute && link.getAttribute('href')) || null;

          var key = rowAccount + '|' + dateStr + '|' + amtMatch[1];
          if (!seen[key]) {
            seen[key] = true;
            results.push({ date: dateStr, amount: '$' + amtMatch[1], href: href, accountNumber: rowAccount });
          }
        }
        return results;
      })()`) as Array<{ date: string; amount: string; href: string | null; accountNumber?: string }>;

      console.log(`[Oceanside] Iframe rows found: ${iframeRows.length}`);
      if (iframeRows.length > 0) return iframeRows;
    } else {
      console.log('[Oceanside] No Invoice Cloud iframe found, falling back to main page');
    }

    // Dump page text for debugging (6000 chars — history rows appear after navigation)
    const pageText = await this.page!.evaluate(
      `(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 6000)`
    ) as string;
    console.log('[Oceanside] Billing page text:', pageText);

    // Raw ES5 string — avoids __name injection from tsx/esbuild
    // Pass account number for filtering rows (Pay Bill page shows ALL accounts)
    const acctParam = accountNumber || '';
    const rows = await this.page!.evaluate(`(function() {
      var targetAccount = ${JSON.stringify(acctParam)};
      var targetNorm = targetAccount.replace(/[-\\s]/g, '');
      var results = [];
      var seen = {};

      // Helper: extract a date-like string, preferring Bill Date labels over bare dates
      // to avoid picking up DUE dates ("DUE APR 14") as the statement date
      function findDate(text) {
        // Prefer explicit bill/invoice/statement date label
        var labeled = text.match(/(?:bill|invoice|statement)\\s+date[:\\s]+([A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})/i)
                   || text.match(/(?:bill|invoice|statement)\\s+date[:\\s]+(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/i);
        if (labeled) return labeled[1];
        // Fall back to MM/DD/YYYY (more specific than month-name)
        var m = text.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/);
        if (m) return m[1];
        // Last resort: month-name date (but not if preceded by "DUE")
        m = text.match(/(?<!DUE\\s{0,5})([A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})/i);
        return m ? m[1] : null;
      }

      // Strategy 1: table/list containers with date + amount + a view link
      var selectors = ['table tbody tr', 'tr', 'li',
        '[class*="invoice"]', '[class*="bill-row"]', '[class*="statement"]',
        '[class*="billing"]', '[class*="history"]'];
      var containers = [];
      selectors.forEach(function(s) {
        try { containers = containers.concat(Array.from(document.querySelectorAll(s))); } catch(e) {}
      });

      for (var ci = 0; ci < containers.length; ci++) {
        var row = containers[ci];
        var text = (row.textContent || '').replace(/\\s+/g, ' ').trim();
        var dateStr = findDate(text);
        var amtMatch = text.match(/\\$\\s*([\\d,]+\\.\\d{2})/);
        if (!dateStr || !amtMatch) continue;

        // Filter by account number when one is provided (Pay Bill page shows ALL accounts)
        if (targetNorm) {
          var rowNorm = text.replace(/[-\\s]/g, '');
          // Look for the account number as a substring (handles "177299-182052" → "177299182052")
          if (rowNorm.indexOf(targetNorm) === -1) continue;
        }

        // Find the "View Invoice" link specifically (not Payment History, etc.)
        var viewLink = null;
        var links = Array.from(row.querySelectorAll('a'));
        for (var li = 0; li < links.length; li++) {
          var lt = (links[li].textContent || '').replace(/\\s+/g, ' ').trim();
          var lh = (links[li].getAttribute('href') || '');
          // Strictly match "View Invoice" text first
          if (/^view\\s+invoice$/i.test(lt)) {
            viewLink = links[li]; break;
          }
        }
        // Fallback: broader patterns
        if (!viewLink) {
          for (var li2 = 0; li2 < links.length; li2++) {
            var lt2 = (links[li2].textContent || '');
            var lh2 = (links[li2].getAttribute('href') || '');
            if (/view\\s*(bill|invoice)|download|print|detail/i.test(lt2) ||
                /viewBill|viewInvoice|viewInvoiceHistory/i.test(lh2)) {
              viewLink = links[li2]; break;
            }
          }
        }

        if (!seen[dateStr]) {
          seen[dateStr] = true;
          results.push({ date: dateStr, amount: '$' + amtMatch[1], href: viewLink ? viewLink.href : null });
        }
      }

      // Strategy 2: walk up from View Bill links to find date + amount
      if (results.length === 0) {
        var viewLinks = Array.from(document.querySelectorAll('a')).filter(function(a) {
          return /view\\s*(bill|invoice)/i.test(a.textContent || '') ||
                 /viewBill|viewInvoice/i.test(a.getAttribute('href') || '');
        });
        for (var vli = 0; vli < viewLinks.length; vli++) {
          var link = viewLinks[vli];
          var el = link;
          for (var i = 0; i < 12; i++) {
            if (!el) break;
            var t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            var ds = findDate(t);
            var am = t.match(/\\$\\s*([\\d,]+\\.\\d{2})/);
            if (ds && am && !seen[ds]) {
              seen[ds] = true;
              results.push({ date: ds, amount: '$' + am[1], href: link.href });
              break;
            }
            el = el.parentElement;
          }
        }
      }

      // Strategy 3: parse current bill directly from page text
      // Handles formats:
      //   "Bill date: Mar 24, 2026"  /  "Bill Date: 03/24/2026"
      //   "Bill Amount $367.25"  /  "Total Due $367.25"  /  "Amount Due $367.25"
      if (results.length === 0) {
        var text2 = (document.body.innerText || '').replace(/\\s+/g, ' ');
        var billDateM =
          text2.match(/Bill\\s+date[:\\s]+([A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})/i) ||
          text2.match(/Bill\\s+Date[:\\s]+(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/i) ||
          text2.match(/Statement\\s+Date[:\\s]+([A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})/i) ||
          text2.match(/Statement\\s+Date[:\\s]+(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/i);
        var totalM =
          text2.match(/Bill\\s+Amount\\s+\\$?([\\d,]+\\.\\d{2})/i) ||
          text2.match(/Total\\s+Due\\s+\\$?([\\d,]+\\.\\d{2})/i) ||
          text2.match(/Amount\\s+Due\\s+\\$?([\\d,]+\\.\\d{2})/i) ||
          text2.match(/TOTAL\\s+CURRENT\\s+CHARGES\\s+\\$?([\\d,]+\\.\\d{2})/i);
        if (billDateM && totalM) {
          results.push({ date: billDateM[1].trim(), amount: '$' + totalM[1], href: window.location.href });
        }
      }

      return results;
    })()`) as Array<{ date: string; amount: string; href: string | null }>;

    return rows;
  }

  // ── Individual invoice ───────────────────────────────────────────────────

  private async scrapeInvoice(
    row: { date: string; amount: string; href: string | null },
    accountNumber: string
  ): Promise<ScrapedStatement | null> {
    const statementDate = this.parseDate(row.date);
    if (!statementDate) return null;

    console.log(`[Oceanside] Scraping invoice ${row.date} = ${row.amount}`);

    let pdfBuffer: Buffer | undefined;
    let billDetails: Record<string, unknown> = {};

    if (!row.href) {
      console.warn(`[Oceanside] No href for invoice ${row.date} — skipping`);
      return null;
    }

    // ── Fast path: direct Invoice Cloud PDF URL ──────────────────────────────
    // The "View Invoice" link in the Pay Bill iframe is a direct PDF URL like:
    //   https://www.invoicecloud.com/templates/Advanced/pdf.aspx?InvoiceGUID=...&pdf=1
    // Download it directly via HTTP (page.goto fails because it's a file download).
    if (/invoicecloud\.com\/templates\/Advanced\/pdf\.aspx/i.test(row.href) ||
        /\.pdf(\?|$)/i.test(row.href) ||
        /[?&]pdf=1/i.test(row.href)) {
      console.log('[Oceanside] Direct Invoice Cloud PDF URL detected');
      try {
        // Get cookies from the Invoice Cloud iframe context so the request is authenticated
        const icFrame = this.page!.frames().find(f =>
          f.url().includes('invoicecloud.com') || f.url().includes('customerportalredirect')
        );
        const requestContext = icFrame ? icFrame.page().request : this.page!.request;
        const res = await requestContext.get(row.href, {
          timeout: 30000,
          headers: {
            'Referer': icFrame ? icFrame.url() : this.page!.url(),
            'Accept': 'application/pdf,*/*',
          },
        });
        if (res.ok()) {
          const buf = Buffer.from(await res.body());
          const ct = res.headers()['content-type'] || '';
          console.log(`[Oceanside] PDF response: ${buf.length} bytes, content-type: ${ct}`);
          if (ct.includes('pdf') || buf.slice(0, 4).toString() === '%PDF') {
            const billDetails = await this.parseBillPdf(buf);
            const n = (k: string) => (billDetails[k] != null ? Number(billDetails[k]) : undefined);
            const amountDue = n('currentCharges') ?? n('totalDue') ?? parseFloat(row.amount.replace(/[$,\s]/g, ''));
            // Prefer bill date from PDF (more accurate than row's potentially wrong date)
            const pdfBillDate = billDetails.billDate ? this.parseDate(String(billDetails.billDate)) : undefined;
            const finalStatementDate = pdfBillDate || statementDate;
            return {
              statementDate: finalStatementDate,
              dueDate: billDetails.dueDate ? this.parseDate(String(billDetails.dueDate)) ?? undefined : undefined,
              billingPeriodStart: billDetails.periodStart ? this.parseDate(String(billDetails.periodStart)) ?? undefined : undefined,
              billingPeriodEnd: billDetails.periodEnd ? this.parseDate(String(billDetails.periodEnd)) ?? undefined : undefined,
              amountDue,
              usageValue: n('hcf'),
              usageUnit: 'HCF',
              pdfBuffer: buf,
              pdfFilename: `oceanside_${accountNumber}_${finalStatementDate.toISOString().slice(0, 10)}.pdf`,
              rawData: {
                accountNumber,
                source: 'invoicecloud-direct',
                balanceForward: n('balanceForward'),
                currentCharges: n('currentCharges'),
                totalDue: n('totalDue'),
                pastDue: (n('balanceForward') ?? 0) > 0 ? n('balanceForward') : undefined,
                isPaid: false,
              },
            };
          }
        } else {
          console.warn(`[Oceanside] PDF download status: ${res.status()}`);
        }
      } catch (err) {
        console.warn('[Oceanside] Direct PDF download failed:', err instanceof Error ? err.message : err);
      }
    }

    // If the href IS the current page (strategy 3 above), skip the goto
    const alreadyHere = row.href === this.page!.url();
    if (!alreadyHere) {
      await this.page!.goto(row.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(4000);
    }
    await this.screenshot(`oceanside-invoice-${row.date.replace(/\//g, '-')}`);
    console.log('[Oceanside] Invoice page URL:', this.page!.url());

    const pages   = this.context!.pages();
    const newTab  = pages.find(p => p !== this.page && !p.url().includes('blank'));
    const invPage = newTab || this.page!;

    const invText = await invPage.evaluate(
      `(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1500)`
    ) as string;
    console.log('[Oceanside] Invoice page text:', invText);

    // ── Strategy 1: Look for real PDF anchor links ───────────────────────────
    const allInvLinks = await invPage.evaluate(`
      (function() {
        return Array.from(document.querySelectorAll('a')).map(function(a) {
          return { href: a.href, text: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
        });
      })()
    `) as Array<{ href: string; text: string }>;
    console.log('[Oceanside] Invoice page links:', JSON.stringify(allInvLinks));

    const pdfLink = allInvLinks.find(l =>
      /download|print|save.*pdf|export|get.*pdf|view.*pdf|bill.*pdf|pdf.*bill/i.test(l.text) ||
      /\.pdf(\?|$)/i.test(l.href) ||
      /download|pdf|print|export|getPdf|getStatement|downloadBill|printBill/i.test(l.href)
    )?.href ?? null;

    if (pdfLink) {
      console.log(`[Oceanside] Found PDF link: ${pdfLink}`);
      try {
        const res = await this.page!.request.get(pdfLink, { timeout: 25000 });
        if (res.ok()) {
          pdfBuffer = Buffer.from(await res.body());
          console.log(`[Oceanside] PDF downloaded: ${pdfBuffer.length} bytes`);
          billDetails = await this.parseBillPdf(pdfBuffer);
        }
      } catch (err) {
        console.warn('[Oceanside] PDF download failed:', err instanceof Error ? err.message : err);
      }
    }

    // ── Strategy 2: Click Print/Download button → intercept popup/new-tab ────
    if (!pdfBuffer) {
      try {
        // Listen for a new page/popup before clicking so we can capture it
        const popupPromise = this.context!.waitForEvent('page', { timeout: 8000 }).catch(() => null);

        const printClicked = await invPage.evaluate(`
          (function() {
            var btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
            var printBtn = btns.find(function(b) {
              var t = (b.textContent || b.value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
              return t === 'print' || t === 'print bill' || t === 'download' || t === 'download pdf' ||
                     /^(print|download|pdf|export)$/i.test(t);
            });
            if (printBtn) { printBtn.click(); return true; }
            return false;
          })()
        `);

        if (printClicked) {
          console.log('[Oceanside] Clicked Print/Download button, waiting for popup...');
          const popup = await popupPromise;
          if (popup) {
            await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            await popup.waitForTimeout(2000);
            console.log('[Oceanside] Popup URL:', popup.url());
            await this.screenshot('oceanside-print-popup');

            // Parse bill details from the printable page first (before converting to PDF)
            if (Object.keys(billDetails).length === 0) {
              billDetails = await this.parseBillPage(popup);
            }

            // Capture the printable full bill as PDF
            const data = await popup.pdf({ format: 'A4', printBackground: true });
            pdfBuffer = Buffer.from(data);
            console.log(`[Oceanside] Popup page.pdf() size: ${pdfBuffer.length} bytes`);
            if (Object.keys(billDetails).length === 0) billDetails = await this.parseBillPdf(pdfBuffer);
            await popup.close().catch(() => {});
          }
        }
      } catch (err) {
        console.warn('[Oceanside] Print button strategy failed:', err instanceof Error ? err.message : err);
      }
    }

    // ── Strategy 3: Try Invoice Cloud portal for the actual bill PDF ──────────
    if (!pdfBuffer && accountNumber) {
      try {
        pdfBuffer = await this.tryInvoiceCloudPdf(accountNumber, statementDate);
        if (pdfBuffer) {
          console.log(`[Oceanside] Invoice Cloud PDF downloaded: ${pdfBuffer.length} bytes`);
          billDetails = await this.parseBillPdf(pdfBuffer);
        }
      } catch (err) {
        console.warn('[Oceanside] Invoice Cloud PDF failed:', err instanceof Error ? err.message : err);
      }
    }

    if (Object.keys(billDetails).length === 0) {
      billDetails = await this.parseBillPage(invPage);
    }

    // ── Strategy 4: page.pdf() on current (summary) page as last resort ──────
    if (!pdfBuffer) {
      console.log('[Oceanside] Using page.pdf() fallback on current page');
      try {
        const data = await invPage.pdf({ format: 'A4', printBackground: true });
        pdfBuffer  = Buffer.from(data);
        console.log(`[Oceanside] page.pdf() size: ${pdfBuffer.length} bytes`);
        if (Object.keys(billDetails).length === 0) billDetails = await this.parseBillPdf(pdfBuffer);
      } catch (err) {
        console.warn('[Oceanside] page.pdf() failed:', err instanceof Error ? err.message : err);
      }
    }

    if (newTab) await newTab.close().catch(() => {});

    const n = (k: string) => (billDetails[k] != null ? Number(billDetails[k]) : undefined);
    const amountDue = n('currentCharges') ?? n('totalDue') ??
      parseFloat(row.amount.replace(/[$,\s]/g, ''));

    return {
      statementDate,
      dueDate:            billDetails.dueDate ? this.parseDate(String(billDetails.dueDate)) ?? undefined : undefined,
      billingPeriodStart: billDetails.periodStart ? this.parseDate(String(billDetails.periodStart)) ?? undefined : undefined,
      billingPeriodEnd:   billDetails.periodEnd   ? this.parseDate(String(billDetails.periodEnd))   ?? undefined : undefined,
      amountDue,
      usageValue: n('hcf'),
      usageUnit:  'HCF',
      pdfBuffer,
      pdfFilename: `oceanside_${accountNumber}_${statementDate.toISOString().slice(0, 10)}.pdf`,
      rawData: {
        accountNumber,
        balanceForward:  n('balanceForward'),
        currentCharges:  n('currentCharges'),
        totalDue:        n('totalDue'),
        pastDue:         (n('balanceForward') ?? 0) > 0 ? n('balanceForward') : undefined,
        isPaid:          false,
      },
    };
  }

  // ── Parsing ──────────────────────────────────────────────────────────────

  // Raw ES5 string — avoids tsx/esbuild __name() injection for named inner functions
  private async parseBillPage(page = this.page!): Promise<Record<string, unknown>> {
    return page.evaluate(`(function() {
      var text = (document.body.innerText || '').replace(/\\s+/g, ' ');
      function n(re) { var m = text.match(re); return m ? parseFloat(m[1].replace(/[$,]/g, '')) : undefined; }
      function d(re) { var m = text.match(re); return m ? m[1].trim() : undefined; }
      var hcfMatch = text.match(/(\\d+)\\s+units?\\s+x[\\s\\S]{0,60}Gallons/i) || text.match(/(\\d+)\\s+HCF/i);
      var perStart = text.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{4})\\s*[-\\u2013]\\s*\\d{1,2}\\/\\d{1,2}\\/\\d{4}/);
      var perEnd   = text.match(/\\d{1,2}\\/\\d{1,2}\\/\\d{4}\\s*[-\\u2013]\\s*(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/);
      return {
        billDate:       d(/Bill\\s+Date[:\\s]+(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/i) || d(/Statement\\s+Date[:\\s]+(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/i),
        balanceForward: n(/Balance\\s+Forward\\s+\\$?([\\d,]+\\.\\d{2})/i),
        currentCharges: n(/TOTAL\\s+CURRENT\\s+CHARGES\\s+\\$?([\\d,]+\\.\\d{2})/i) || n(/Total\\s+Current\\s+Charges?\\s+\\$?([\\d,]+\\.\\d{2})/i),
        totalDue:       n(/Total\\s+Due\\s+\\$?([\\d,]+\\.\\d{2})/i) || n(/Amount\\s+Due\\s+\\$?([\\d,]+\\.\\d{2})/i),
        dueDate:        d(/Current\\s+Charges?\\s+Due\\s+Date[:\\s]+(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/i) || d(/Due\\s+Date[:\\s]+(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/i) || d(/DUE\\s+([A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})/i),
        periodStart:    perStart ? perStart[1] : undefined,
        periodEnd:      perEnd   ? perEnd[1]   : undefined,
        hcf:            hcfMatch ? parseInt(hcfMatch[1]) : undefined,
      };
    })()`);
  }

  private async parseBillPdf(pdfBuffer: Buffer): Promise<Record<string, unknown>> {
    try {
      const parsed = await pdfParse(pdfBuffer);
      const text = parsed.text;
      console.log('[Oceanside] PDF text:\n' + text.slice(0, 2000));
      const n = (re: RegExp) => { const m = text.match(re); return m ? parseFloat(m[1].replace(/[$,]/g, '')) : undefined; };
      const d = (re: RegExp) => text.match(re)?.[1]?.trim();

      // The Invoice Cloud PDF extracts text with labels and values on separate lines.
      // The first two dates near the top of the bill are: bill date, then due date.
      // Then the service period appears as "MM/DD/YYYY - MM/DD/YYYY"
      // Capture the first two standalone dates that aren't part of a range
      const allDates: string[] = [];
      const dateRe = /(\d{1,2}\/\d{1,2}\/\d{4})/g;
      let dm: RegExpExecArray | null;
      while ((dm = dateRe.exec(text)) !== null) allDates.push(dm[1]);

      // billDate is also visible at bottom: "Current Charges - Due 6/16/2026"
      // Find a "Due M/D/YYYY" pattern to identify the due date
      const dueFromBottom = d(/Due\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);

      // Bill date: first standalone date that's not the due date
      let billDate: string | undefined;
      let dueDate: string | undefined = dueFromBottom;
      for (const dt of allDates) {
        if (dueDate && dt === dueDate) continue;
        if (!billDate) { billDate = dt; }
        else if (!dueDate) { dueDate = dt; break; }
      }

      // Invoice Cloud PDFs in this format put Balance Forward's value BEFORE the label
      // (e.g. "$296.26BALANCE FORWARD" in the ACCOUNT TRANSACTIONS section near the top).
      // Try that pattern first; fall back to the standard label-first pattern.
      const currentCharges = n(/TOTAL\s+CURRENT\s+CHARGES\s*\$?([\d,]+\.\d{2})/i) || n(/Total\s+Current\s+Charges?\s*\$?([\d,]+\.\d{2})/i);
      const balanceForward = n(/\$([\d,]+\.\d{2})\s*BALANCE\s+FORWARD/i) ?? n(/Balance\s+Forward\s+\$?([\d,]+\.\d{2})/i);
      // Total Due = current charges + balance forward. Compute it for reliability since
      // the PDF's column-extracted text makes the literal "Total Due" value ambiguous.
      const totalDue = (currentCharges != null || balanceForward != null)
        ? (currentCharges ?? 0) + (balanceForward ?? 0)
        : (n(/Total\s+Due\s+\$?([\d,]+\.\d{2})/i) || n(/Amount\s+Due\s+\$?([\d,]+\.\d{2})/i));

      return {
        billDate:        billDate || d(/Bill\s+Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i),
        balanceForward,
        currentCharges,
        totalDue,
        dueDate:         dueDate || d(/Current\s+Charges?\s+Due\s+Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i) || d(/Due\s+Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i),
        periodStart:     text.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*\d{1,2}\/\d{1,2}\/\d{4}/)?.[1],
        periodEnd:       text.match(/\d{1,2}\/\d{1,2}\/\d{4}\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/)?.[1],
        // HCF / water units — try multiple patterns based on the actual PDF format
        hcf:             (() => {
          // "10.00 units x 3.03" (Consumption Tier 1)
          let m = text.match(/Consumption[\s\S]{0,40}?(\d+(?:\.\d+)?)\s+units?\s+x/i);
          if (m) return parseFloat(m[1]);
          // "Water Used (Unit) ... 10" (meter table)
          m = text.match(/Water\s+Used[\s\S]{0,200}?(\d+)\s*$/im);
          if (m) return parseInt(m[1]);
          // "(\d+) units x ... Gallons"
          m = text.match(/(\d+)\s+units?\s+x[\s\S]{0,60}Gallons/i);
          if (m) return parseInt(m[1]);
          m = text.match(/(\d+)\s+HCF/i);
          return m ? parseInt(m[1]) : undefined;
        })(),
      };
    } catch (err) {
      console.warn('[Oceanside] PDF parse error:', err instanceof Error ? err.message : err);
      return {};
    }
  }

  // ── Invoice Cloud PDF download ────────────────────────────────────────────
  // City of Oceanside also uses Invoice Cloud (invoicecloud.com) as its payment
  // portal.  When the WaterSmart portal doesn't expose a direct PDF link we fall
  // back here to look up the account and download the bill from Invoice Cloud.

  private readonly INVOICE_CLOUD_LOCATOR =
    'https://www.invoicecloud.com/portal/2/customerlocator.aspx' +
    '?iti=42&bg=6e845e36-128a-4605-a057-4b50dc1f72b6&vsii=367';

  private async tryInvoiceCloudPdf(
    accountNumber: string,
    statementDate: Date,
  ): Promise<Buffer | undefined> {
    try {
      console.log(`[Oceanside] Trying Invoice Cloud for account ${accountNumber}`);

      // Open a fresh tab so Invoice Cloud navigation doesn't disturb the WaterSmart session
      const icPage = await this.context!.newPage();
      try {
        await icPage.goto(this.INVOICE_CLOUD_LOCATOR, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await icPage.waitForTimeout(3000);
        await this.screenshot('oceanside-ic-locator');

        // Enter account number in the search field
        const acctInputSel = 'input[type="text"], input[name*="account" i], input[id*="account" i], input[placeholder*="account" i]';
        await icPage.waitForSelector(acctInputSel, { timeout: 15000 });
        await icPage.fill(acctInputSel, accountNumber);
        await icPage.waitForTimeout(500);

        // Click Find / Search button
        const findBtnSel = 'button[type="submit"], input[type="submit"], button:has-text("Find"), button:has-text("Search"), button:has-text("Locate")';
        await icPage.click(findBtnSel);
        await icPage.waitForTimeout(5000);
        await this.screenshot('oceanside-ic-search-result');

        console.log('[Oceanside] Invoice Cloud post-search URL:', icPage.url());

        // Look for a PDF or "View Bill" / "View Statement" link
        const icLinks = await icPage.evaluate(`
          (function() {
            return Array.from(document.querySelectorAll('a')).map(function(a) {
              return { href: a.href, text: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
            });
          })()
        `) as Array<{ href: string; text: string }>;
        console.log('[Oceanside] Invoice Cloud links:', JSON.stringify(icLinks.slice(0, 10)));

        const billLink = icLinks.find(l =>
          /view\s*(bill|statement|invoice)|download|pdf|print/i.test(l.text) ||
          /\.pdf|viewbill|download|statement/i.test(l.href)
        )?.href ?? null;

        if (billLink) {
          console.log('[Oceanside] Invoice Cloud bill link:', billLink);
          const res = await icPage.request.get(billLink, { timeout: 25000 });
          if (res.ok()) {
            const ct = res.headers()['content-type'] || '';
            if (ct.includes('pdf') || ct.includes('octet')) {
              return Buffer.from(await res.body());
            }
          }
        }

        return undefined;
      } finally {
        await icPage.close().catch(() => {});
      }
    } catch (err) {
      console.warn('[Oceanside] Invoice Cloud error:', err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  // ── Payments ─────────────────────────────────────────────────────────────

  async scrapePayments(): Promise<ScrapedPayment[]> {
    return [];
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async screenshot(name: string): Promise<void> {
    try {
      const p = path.join('/tmp', `${name}-${Date.now()}.png`);
      await this.page!.screenshot({ path: p, fullPage: true });
      console.log(`[Oceanside] Screenshot: ${p}`);
    } catch { /* ignore */ }
  }
}
