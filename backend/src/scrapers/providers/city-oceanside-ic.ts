/**
 * City of Oceanside Water Utility scraper (Invoice Cloud direct)
 * Portal: https://www.invoicecloud.com/
 *
 * Account ID format: {customerId}-{accountNumber}
 * Example: 177299-182052
 *   customerId = 177299 (first 6 digits)
 *   accountNumber = 182052 (last 6 digits after dash)
 *
 * Flow:
 *  1. Go to Invoice Cloud customer locator
 *  2. Enter customer ID
 *  3. Enter account number
 *  4. Search → get to account/bills page
 *  5. Parse all bills and download PDFs
 */
import pdfParse from 'pdf-parse';
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';
import * as path from 'path';

export class CityOceansideInvoiceCloudScraper extends BaseScraperProvider {
  readonly providerSlug = 'city-oceanside-ic';
  readonly providerName = 'City of Oceanside (Invoice Cloud)';

  private readonly INVOICE_CLOUD_LOCATOR =
    'https://www.invoicecloud.com/portal/(S(inquvxj0wvsthlscr2olsg3z))/2/customerlocator.aspx' +
    '?iti=42&bg=6e845e36-128a-4605-a057-4b50dc1f72b6&vsii=367';

  // ── Login (invoice lookup) ────────────────────────────────────────────────

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      // Wrap the entire login in a timeout so we don't hang forever
      return await Promise.race([
        this.loginInternal(credentials),
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            console.error('[Oceanside-IC] Login timeout after 60 seconds');
            resolve(false);
          }, 60000);
        }),
      ]);
    } catch (err) {
      console.error('[Oceanside-IC] Login error:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private async loginInternal(credentials: ScraperCredentials): Promise<boolean> {
    try {
      console.log('[Oceanside-IC] Starting customer locator lookup');

      // Extract customer ID and account number from accountNumber
      // Try different formats since Invoice Cloud might expect a different structure
      const accountId = (credentials.accountNumber || '').trim();

      let customerId = '';
      let accountNumber = '';

      // Try format: {customerId}-{accountNumber}
      const parts = accountId.split('-');
      if (parts.length === 2) {
        customerId = parts[0];
        accountNumber = parts[1];
      } else if (parts.length === 1 && accountId.length === 12) {
        // Try as full number: first 6 = customer, last 6 = account
        customerId = accountId.slice(0, 6);
        accountNumber = accountId.slice(6);
      } else {
        // Try as-is
        customerId = accountId;
        accountNumber = accountId;
      }

      if (!customerId || !accountNumber) {
        console.error('[Oceanside-IC] Could not parse account ID. Expected format: 177299-182052 or 177299182052');
        return false;
      }

      console.log(`[Oceanside-IC] Lookup: customerId=${customerId}, accountNumber=${accountNumber}`);

      // Navigate to locator page
      await this.page!.goto(this.INVOICE_CLOUD_LOCATOR, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await this.page!.waitForTimeout(2000);
      await this.screenshot('oceanside-ic-locator-page');

      // Close any modal dialogs that might be in the way
      // Try JavaScript approach since the button might not be visible/clickable
      try {
        const modalClosed = await this.page!.evaluate(`
          (function() {
            // Try to find and close modal
            var modal = document.querySelector('.modal.show, [role="dialog"]');
            if (modal) {
              console.log('Found modal, removing...');
              modal.remove();
              return true;
            }
            // Try clicking via JavaScript (doesn't require visibility)
            var closeBtn = document.querySelector('button[data-dismiss="modal"], button.close');
            if (closeBtn) {
              console.log('Found close button, clicking via JS...');
              closeBtn.click();
              return true;
            }
            return false;
          })()
        `);
        if (modalClosed) {
          console.log('[Oceanside-IC] Modal closed via JavaScript');
          await this.page!.waitForTimeout(2000);
          await this.screenshot('oceanside-ic-after-modal-close');
        }
      } catch (err) {
        console.warn('[Oceanside-IC] Modal close failed:', err instanceof Error ? err.message : err);
      }

      // Fill in customer ID and account number fields
      // The form has two text inputs: first is Customer Number, second is Account Number
      console.log('[Oceanside-IC] Looking for input fields...');
      const inputs = await this.page!.$$('input[type="text"]');
      console.log(`[Oceanside-IC] Found ${inputs.length} text inputs`);

      if (inputs.length < 2) {
        console.error('[Oceanside-IC] Not enough input fields found');
        const allInputs = await this.page!.evaluate(`
          (function() {
            return Array.from(document.querySelectorAll('input')).map(function(i) {
              return { type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, value: i.value };
            });
          })()
        `);
        console.log('[Oceanside-IC] All inputs:', JSON.stringify(allInputs));
        await this.screenshot('oceanside-ic-insufficient-inputs');
        return false;
      }

      console.log(`[Oceanside-IC] Filling customer ID with: ${customerId}`);
      await inputs[0].fill(customerId);
      await this.page!.waitForTimeout(800);

      console.log(`[Oceanside-IC] Filling account number with: ${accountNumber}`);
      await inputs[1].fill(accountNumber);
      await this.page!.waitForTimeout(800);
      await this.screenshot('oceanside-ic-form-filled');

      // Debug: log all clickable elements with "search" text
      const searchElements = await this.page!.evaluate(`
        (function() {
          var els = Array.from(document.querySelectorAll('a, button, input[type="submit"]'));
          return els.filter(function(el) {
            var t = (el.textContent || el.value || '').toLowerCase();
            return t.includes('search');
          }).map(function(el) {
            return {
              tag: el.tagName,
              id: el.id || '',
              class: el.className || '',
              text: (el.textContent || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
              href: el.href || ''
            };
          });
        })()
      `);
      console.log('[Oceanside-IC] Search-related elements:', JSON.stringify(searchElements, null, 2));

      // Click "Search Invoices" link/button
      // The button is actually an <a> tag styled as a button (ASP.NET LinkButton)
      // It triggers __doPostBack via its href
      const foundButton = await this.page!.evaluate(`
        (function() {
          // Look for the Search Invoices link/button (anchor or button)
          var allClickable = Array.from(document.querySelectorAll('a, button'));

          for (var i = 0; i < allClickable.length; i++) {
            var el = allClickable[i];
            var fullText = (el.textContent || '').toLowerCase().replace(/\\s+/g, ' ').trim();
            var html = el.innerHTML.toLowerCase();

            // Check for "search invoices" specifically
            if (fullText.includes('search invoices') ||
                (fullText.includes('search') && el.id && el.id.toLowerCase().includes('btnsearch')) ||
                (html.includes('glyphicon-search') && fullText.includes('search'))) {
              console.log('Found Search Invoices element:', el.tagName, el.id || el.className);

              // For ASP.NET LinkButton, use the href which contains __doPostBack
              if (el.tagName === 'A' && el.href && el.href.includes('__doPostBack')) {
                console.log('Using __doPostBack from href');
                // Extract and execute the postback
                var match = el.href.match(/__doPostBack\\(['\"]([^'\"]+)['\"],\\s*['\"]([^'\"]*)['\"]\\)/);
                if (match && typeof window.__doPostBack === 'function') {
                  window.__doPostBack(match[1], match[2]);
                  return true;
                }
              }

              try {
                el.click();
              } catch (e) {
                var evt = new MouseEvent('click', { bubbles: true, cancelable: true });
                el.dispatchEvent(evt);
              }
              return true;
            }
          }

          return false;
        })()
      `);

      if (!foundButton) {
        console.error('[Oceanside-IC] Could not find/click Search button');
        await this.screenshot('oceanside-ic-no-submit-button');
        return false;
      }

      console.log('[Oceanside-IC] Clicked Search Invoices button');

      // Wait for navigation or page load
      try {
        await Promise.race([
          this.page!.waitForNavigation({ timeout: 15000 }).catch(() => null),
          this.page!.waitForTimeout(8000),
        ]);
      } catch {
        // Ignore navigation errors
      }
      await this.page!.waitForTimeout(2000);

      console.log('[Oceanside-IC] Submitted customer lookup');
      await this.page!.waitForTimeout(5000);
      await this.screenshot('oceanside-ic-after-lookup');

      const postLookupUrl = this.page!.url();
      console.log('[Oceanside-IC] Post-lookup URL:', postLookupUrl);

      // Success: URL changes to customerlocatorresults1.aspx
      if (postLookupUrl.includes('customerlocatorresults')) {
        console.log('[Oceanside-IC] Lookup successful — reached results page');
        return true;
      }

      // Check if we're still on the locator page (login failed)
      if (postLookupUrl.includes('customerlocator')) {
        console.error('[Oceanside-IC] Still on locator page after lookup');
        const pageText = await this.page!.evaluate(
          `(document.body.innerText || '').slice(0, 1000)`
        ) as string;
        console.log('[Oceanside-IC] Page text:', pageText);

        // Look for error messages
        const errorMsg = await this.page!.evaluate(`
          (function() {
            var errorSelectors = ['.alert', '.error', '[role="alert"]', '.alert-danger', '.alert-error'];
            for (var i = 0; i < errorSelectors.length; i++) {
              var el = document.querySelector(errorSelectors[i]);
              if (el) return (el.textContent || '').trim().slice(0, 200);
            }
            return null;
          })()
        `) as string | null;

        if (errorMsg) {
          console.error('[Oceanside-IC] Error message:', errorMsg);
        } else {
          console.error('[Oceanside-IC] No error message found. Account may be invalid or form data incorrect.');
          console.error('[Oceanside-IC] Tried: customerId=177299, accountNumber=182052');
        }

        return false;
      }

      console.log('[Oceanside-IC] Lookup successful');
      return true;
    } catch (err) {
      console.error('[Oceanside-IC] Login error:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  // ── Statements ───────────────────────────────────────────────────────────

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const statements: ScrapedStatement[] = [];

    const accountNumber = (this.credentials?.accountNumber || '').replace(/\*/g, '').trim();
    const datesMap = this.credentials?.latestStatementDates;
    const rawCutoff = datesMap
      ? (datesMap[accountNumber] ?? null)
      : (this.credentials?.latestStatementDate ?? null);
    const latestKnown = rawCutoff ? new Date(rawCutoff) : null;

    console.log(`[Oceanside-IC] Account: ${accountNumber} | latestKnown: ${latestKnown?.toISOString().slice(0, 10) ?? 'none'}`);

    try {
      // We're now on the bills page after lookup. Collect and parse bills.
      await this.page!.waitForTimeout(3000);
      const allBills = await this.collectBills();
      console.log(`[Oceanside-IC] Bills found: ${allBills.length}`);
      allBills.forEach((b) =>
        console.log(`[Oceanside-IC]   ${b.date} ${b.amount} → ${b.href?.slice(-60) ?? 'no href'}`)
      );

      if (allBills.length === 0) {
        console.warn('[Oceanside-IC] No bills found — check /tmp/oceanside-ic-* screenshots');
        return [];
      }

      const newBills = latestKnown
        ? allBills.filter((b) => {
            const d = this.parseDate(b.date);
            return d && d > latestKnown;
          })
        : allBills;
      console.log(`[Oceanside-IC] ${newBills.length} new bills to scrape`);

      for (const bill of newBills) {
        try {
          const stmt = await this.scrapeBill(bill, accountNumber);
          if (stmt) statements.push(stmt);
        } catch (err) {
          console.error(`[Oceanside-IC] Error scraping ${bill.date}:`, err instanceof Error ? err.message : err);
          await this.screenshot('oceanside-ic-bill-error');
        }
      }
    } catch (err) {
      console.error('[Oceanside-IC] Scrape error:', err instanceof Error ? err.message : err);
      await this.screenshot('oceanside-ic-scrape-error');
    }

    console.log(`[Oceanside-IC] Total statements: ${statements.length}`);
    return statements;
  }

  // ── Bill collection ──────────────────────────────────────────────────────

  private async collectBills(): Promise<Array<{ date: string; amount: string; href: string | null }>> {
    const currentUrl = this.page!.url();
    console.log('[Oceanside-IC] Collecting bills from:', currentUrl);

    await this.page!.waitForTimeout(2000);
    await this.screenshot('oceanside-ic-bills-page');

    // Raw ES5 string
    const bills = await this.page!.evaluate(`(function() {
      var results = [];
      var seen = {};

      function findDate(text) {
        var labeled = text.match(/(?:bill|invoice|statement)\\s+date[:\\s]+([A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})/i)
                   || text.match(/(?:bill|invoice|statement)\\s+date[:\\s]+(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/i);
        if (labeled) return labeled[1];
        var m = text.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/);
        if (m) return m[1];
        m = text.match(/([A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})/i);
        return m ? m[1] : null;
      }

      // Look for bill rows/items
      var selectors = ['table tbody tr', 'tr', 'li', '[class*="invoice"]', '[class*="bill"]', '[class*="statement"]'];
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
          if (/view\\s*(bill|invoice)|download|print|detail|pdf/i.test(lt) ||
              /viewBill|viewInvoice|invoice|bill|pdf|download/i.test(lh)) {
            viewLink = links[li]; break;
          }
        }

        if (!seen[dateStr]) {
          seen[dateStr] = true;
          results.push({ date: dateStr, amount: '$' + amtMatch[1], href: viewLink ? viewLink.href : null });
        }
      }

      // Strategy 2: walk up from View links
      if (results.length === 0) {
        var viewLinks = Array.from(document.querySelectorAll('a')).filter(function(a) {
          return /view\\s*(bill|invoice|pdf)/i.test(a.textContent || '') ||
                 /viewBill|viewInvoice|invoice|bill|pdf/i.test(a.getAttribute('href') || '');
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

      return results;
    })()`) as Array<{ date: string; amount: string; href: string | null }>;

    return bills;
  }

  // ── Individual bill ──────────────────────────────────────────────────────

  private async scrapeBill(
    bill: { date: string; amount: string; href: string | null },
    accountNumber: string
  ): Promise<ScrapedStatement | null> {
    const statementDate = this.parseDate(bill.date);
    if (!statementDate) return null;

    console.log(`[Oceanside-IC] Scraping bill ${bill.date} = ${bill.amount}`);

    let pdfBuffer: Buffer | undefined;
    let billDetails: Record<string, unknown> = {};

    if (bill.href) {
      try {
        const res = await this.page!.request.get(bill.href, { timeout: 25000 });
        if (res.ok()) {
          const ct = res.headers()['content-type'] || '';
          if (ct.includes('pdf')) {
            pdfBuffer = Buffer.from(await res.body());
            console.log(`[Oceanside-IC] PDF downloaded: ${pdfBuffer.length} bytes`);
            billDetails = await this.parseBillPdf(pdfBuffer);
          }
        }
      } catch (err) {
        console.warn('[Oceanside-IC] PDF download failed:', err instanceof Error ? err.message : err);
      }
    }

    const n = (k: string) => (billDetails[k] != null ? Number(billDetails[k]) : undefined);
    const amountDue = n('totalDue') ?? parseFloat(bill.amount.replace(/[$,\s]/g, ''));

    return {
      statementDate,
      dueDate: billDetails.dueDate ? this.parseDate(String(billDetails.dueDate)) ?? undefined : undefined,
      billingPeriodStart: billDetails.periodStart
        ? this.parseDate(String(billDetails.periodStart)) ?? undefined
        : undefined,
      billingPeriodEnd: billDetails.periodEnd ? this.parseDate(String(billDetails.periodEnd)) ?? undefined : undefined,
      amountDue,
      usageValue: n('hcf'),
      usageUnit: 'HCF',
      pdfBuffer,
      pdfFilename: `oceanside_${accountNumber}_${statementDate.toISOString().slice(0, 10)}.pdf`,
      rawData: {
        accountNumber,
        totalDue: n('totalDue'),
      },
    };
  }

  // ── PDF parsing ──────────────────────────────────────────────────────────

  private async parseBillPdf(pdfBuffer: Buffer): Promise<Record<string, unknown>> {
    try {
      const parsed = await pdfParse(pdfBuffer);
      const text = parsed.text;
      console.log('[Oceanside-IC] PDF text:\n' + text.slice(0, 2000));
      const n = (re: RegExp) => {
        const m = text.match(re);
        return m ? parseFloat(m[1].replace(/[$,]/g, '')) : undefined;
      };
      const d = (re: RegExp) => text.match(re)?.[1]?.trim();
      return {
        billDate: d(/Bill\s+Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i),
        totalDue: n(/Total\s+Due\s+\$?([\d,]+\.\d{2})/i) || n(/Amount\s+Due\s+\$?([\d,]+\.\d{2})/i),
        dueDate: d(/Due\s+Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i),
        periodStart: text.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*\d{1,2}\/\d{1,2}\/\d{4}/)?.[1],
        periodEnd: text.match(/\d{1,2}\/\d{1,2}\/\d{4}\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/)?.[1],
        hcf: (() => {
          const m = text.match(/(\d+)\s+units?\s+x[\s\S]{0,60}Gallons/i) || text.match(/(\d+)\s+HCF/i);
          return m ? parseInt(m[1]) : undefined;
        })(),
      };
    } catch (err) {
      console.warn('[Oceanside-IC] PDF parse error:', err instanceof Error ? err.message : err);
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
      console.log(`[Oceanside-IC] Screenshot: ${p}`);
    } catch {
      /* ignore */
    }
  }
}
