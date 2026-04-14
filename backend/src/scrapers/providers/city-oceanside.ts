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
      // Always clear cookies to force a fresh PHP session.
      // WaterSmart's Yii session has access-control state that only works
      // correctly when established via a fresh login flow.  Reusing a cached
      // browser-profile session causes billing navigation to redirect to /logout.
      console.log('[Oceanside] Clearing cookies for fresh session...');
      await this.context!.clearCookies();

      console.log('[Oceanside] Navigating to login page...');
      await this.page!.goto(this.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(2000);

      // After clearing cookies, the login page should always be shown
      const startUrl = this.page!.url();
      if (!startUrl.includes('login') && !startUrl.includes('welcome')) {
        // Shouldn't happen after cookie clear, but handle gracefully
        console.log('[Oceanside] Unexpectedly not on login page:', startUrl);
      }

      const userSel   = '#LoginForm_username, input[name="LoginForm[username]"], input[type="email"]';
      const passSel   = '#LoginForm_password, input[name="LoginForm[password]"], input[type="password"]';
      const submitSel = 'input[type="submit"], button[type="submit"]';

      await this.page!.waitForSelector(userSel, { timeout: 20000 });
      await this.page!.fill(userSel, credentials.username);
      await this.page!.fill(passSel, credentials.password);
      await this.page!.click(submitSel);

      try {
        await this.page!.waitForURL(
          u => !u.toString().includes('/welcome/login') && !u.toString().includes('/login'),
          { timeout: 25000 }
        );
      } catch { /* check below */ }

      const postUrl = this.page!.url();
      if (/login|welcome\/login|logout/.test(postUrl)) {
        console.error('[Oceanside] Login failed, landed on:', postUrl);
        return false;
      }
      console.log('[Oceanside] Login successful:', postUrl);
      return true;
    } catch (err) {
      console.error('[Oceanside] Login error:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  // ── Statements ───────────────────────────────────────────────────────────

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const statements: ScrapedStatement[] = [];

    const accountNumber = (
      this.credentials?.accountNumbers?.[0] || this.credentials?.accountNumber || ''
    ).replace(/\*/g, '').trim();

    const latestKnown = this.credentials?.latestStatementDate
      ? new Date(this.credentials.latestStatementDate)
      : null;

    console.log(`[Oceanside] Account: ${accountNumber} | latestKnown: ${latestKnown?.toISOString().slice(0, 10) ?? 'none'}`);

    try {
      const onBilling = await this.navigateToBillingIndex(accountNumber);
      if (!onBilling) {
        console.error('[Oceanside] Could not reach billing page');
        return [];
      }

      const allRows = await this.collectInvoiceRows();
      console.log(`[Oceanside] Invoice rows found: ${allRows.length}`);
      allRows.forEach(r => console.log(`[Oceanside]   ${r.date} ${r.amount} → ${r.href?.slice(-60) ?? 'no href'}`));

      if (allRows.length === 0) {
        console.warn('[Oceanside] No invoice rows — check /tmp/oceanside-* screenshots');
        return [];
      }

      const newRows = latestKnown
        ? allRows.filter(r => { const d = this.parseDate(r.date); return d && d > latestKnown; })
        : allRows;
      console.log(`[Oceanside] ${newRows.length} new rows to scrape`);

      for (const row of newRows) {
        try {
          const stmt = await this.scrapeInvoice(row, accountNumber);
          if (stmt) statements.push(stmt);
        } catch (err) {
          console.error(`[Oceanside] Error scraping ${row.date}:`, err instanceof Error ? err.message : err);
          await this.screenshot('oceanside-invoice-error');
          await this.navigateToBillingIndex(accountNumber).catch(() => {});
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
    for (const subpath of ['billing/index', 'billing/viewBill', 'billing/payBill']) {
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

  private async collectInvoiceRows(): Promise<Array<{
    date: string; amount: string; href: string | null;
  }>> {
    const currentUrl = this.page!.url();
    console.log('[Oceanside] Collecting rows from:', currentUrl);

    // Give the SPA extra time to render billing history rows
    await this.page!.waitForTimeout(4000);

    // Try expanding "Closed Invoices" / "Billing History" section if present
    const expandedSection = await this.page!.evaluate(`(function() {
      var allEls = Array.from(document.querySelectorAll('a, button, [role="button"], [role="tab"], [aria-expanded], summary'));
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (/^(Closed\\s+Invoices?|Billing\\s+History|View\\s+All|All\\s+(Bills|Invoices)|Invoice\\s+History)$/i.test(text)
            && text.length < 60) {
          el.click();
          return text;
        }
      }
      return null;
    })()`);
    if (expandedSection) {
      console.log('[Oceanside] Expanded section:', expandedSection);
      await this.page!.waitForTimeout(4000);
      await this.screenshot('oceanside-billing-expanded');
    }

    // Scroll down to trigger lazy loading of history rows
    await this.page!.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
    await this.page!.waitForTimeout(2000);
    await this.page!.evaluate(`window.scrollTo(0, 0)`);

    // Dump page text for debugging (6000 chars — history rows appear after "Closed Invoices")
    const pageText = await this.page!.evaluate(
      `(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 6000)`
    ) as string;
    console.log('[Oceanside] Billing page text:', pageText);

    // Raw ES5 string — avoids __name injection from tsx/esbuild
    const rows = await this.page!.evaluate(`(function() {
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

        var viewLink = null;
        var links = Array.from(row.querySelectorAll('a'));
        for (var li = 0; li < links.length; li++) {
          var lt = (links[li].textContent || '');
          var lh = (links[li].getAttribute('href') || '');
          if (/view\\s*(bill|invoice)|download|print|detail/i.test(lt) ||
              /viewBill|viewInvoice|invoice|bill/i.test(lh)) {
            viewLink = links[li]; break;
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

    // Look for real PDF download link
    const allInvLinks = await invPage.evaluate(`
      (function() {
        return Array.from(document.querySelectorAll('a')).map(function(a) {
          return { href: a.href, text: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) };
        });
      })()
    `) as Array<{ href: string; text: string }>;
    console.log('[Oceanside] Invoice page links:', JSON.stringify(allInvLinks));

    const pdfLink = allInvLinks.find(l =>
      /download|print\s*bill|save\s*pdf|export|get\s*pdf/i.test(l.text) ||
      /\.pdf(\?|$)/i.test(l.href) ||
      /download|pdf/i.test(l.href)
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

    if (Object.keys(billDetails).length === 0) {
      billDetails = await this.parseBillPage(invPage);
    }

    if (!pdfBuffer) {
      console.log('[Oceanside] Using page.pdf() fallback');
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
      return {
        billDate:        d(/Bill\s+Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i),
        balanceForward:  n(/Balance\s+Forward\s+\$?([\d,]+\.\d{2})/i),
        currentCharges:  n(/TOTAL\s+CURRENT\s+CHARGES\s+\$?([\d,]+\.\d{2})/i) || n(/Total\s+Current\s+Charges?\s+\$?([\d,]+\.\d{2})/i),
        totalDue:        n(/Total\s+Due\s+\$?([\d,]+\.\d{2})/i) || n(/Amount\s+Due\s+\$?([\d,]+\.\d{2})/i),
        dueDate:         d(/Current\s+Charges?\s+Due\s+Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i) || d(/Due\s+Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i),
        periodStart:     text.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*\d{1,2}\/\d{1,2}\/\d{4}/)?.[1],
        periodEnd:       text.match(/\d{1,2}\/\d{1,2}\/\d{4}\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/)?.[1],
        hcf:             (() => { const m = text.match(/(\d+)\s+units?\s+x[\s\S]{0,60}Gallons/i) || text.match(/(\d+)\s+HCF/i); return m ? parseInt(m[1]) : undefined; })(),
      };
    } catch (err) {
      console.warn('[Oceanside] PDF parse error:', err instanceof Error ? err.message : err);
      return {};
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
