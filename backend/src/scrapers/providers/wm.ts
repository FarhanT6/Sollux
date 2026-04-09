import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';
import * as path from 'path';

interface WMInvoice {
  invoiceId?: string;
  invoiceDate?: string;
  dueDate?: string;
  amountDue?: number;
  balance?: number;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  pdfUrl?: string;
  status?: string;
  // Multi-account fields
  accountName?: string;
  accountNumber?: string;
  serviceAddress?: string;
  accountDetailUrl?: string;
  // Historical detail fields
  pastDue?: number;
  rawData?: Record<string, unknown>;
}

interface WMPayment {
  paymentDate?: string;
  amount?: number;
  confirmationNumber?: string;
  paymentMethod?: string;
}

export class WMScraper extends BaseScraperProvider {
  readonly providerSlug = 'wm';
  readonly providerName = 'WM (Waste Management)';

  private capturedInvoices: WMInvoice[] = [];
  private capturedPayments: WMPayment[] = [];

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      // Navigate to login
      await this.page!.goto('https://www.wm.com/us/en/user/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Dismiss cookie consent banner if present
      try {
        await this.page!.waitForSelector('#onetrust-accept-btn-handler, button:has-text("Accept Cookies")', { timeout: 5000 });
        await this.page!.click('#onetrust-accept-btn-handler, button:has-text("Accept Cookies")');
        await this.page!.waitForTimeout(1000);
      } catch { /* no cookie banner */ }

      // Wait for email field
      await this.page!.waitForSelector(
        'input[placeholder="Email"], input[type="email"], #email, input[name="email"]',
        { timeout: 15000 }
      );

      // Type with human-like delays to avoid bot detection
      await this.page!.type(
        'input[placeholder="Email"], input[type="email"], #email, input[name="email"]',
        credentials.username,
        { delay: 60 }
      );
      await this.page!.waitForTimeout(400 + Math.random() * 300);
      await this.page!.type(
        'input[placeholder="Password"], input[type="password"], #password',
        credentials.password,
        { delay: 60 }
      );
      await this.page!.waitForTimeout(300 + Math.random() * 200);

      await this.screenshot('wm-before-login');
      await this.page!.click('form button[type="submit"], form input[type="submit"], form button:has-text("Log In")');
      await this.page!.waitForURL(/mywm|my-account|my-services/i, { timeout: 25000 });

      // SPA needs time to render + set up XHR interceptor AFTER login
      await this.page!.waitForTimeout(3000);
      this.setupXHRInterceptor();
      await this.screenshot('wm-post-login');
      console.log('[WM] Login successful, URL:', this.page!.url());
      return true;

    } catch (err) {
      console.error('[WM] Login failed:', err instanceof Error ? err.message : err);
      await this.screenshot('wm-login-error');
      return false;
    }
  }

  private setupXHRInterceptor(): void {
    this.page!.on('response', async (response) => {
      const url = response.url();
      if (!response.ok()) return;
      try {
        if (url.includes('/invoices') || url.includes('/billing') || url.includes('/invoice')) {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('application/json')) {
            const data = await response.json().catch(() => null);
            if (data) this.parseInvoiceResponse(url, data);
          }
        }
        if (url.includes('/payment') || url.includes('/transaction') || url.includes('/history')) {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('application/json')) {
            const data = await response.json().catch(() => null);
            if (data) this.parsePaymentResponse(url, data);
          }
        }
      } catch { /* ignore */ }
    });
  }

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    // accountNumbers = the set of account numbers tracked in Sollux for this login.
    // If provided, we only drill into those accounts on the WM overview — skipping any
    // WM service address that the user hasn't added to Sollux yet.
    // Falls back to the legacy single accountNumber, or scrapes all if neither is set.
    const filterNumbers: string[] =
      this.credentials?.accountNumbers ??
      (this.credentials?.accountNumber ? [this.credentials.accountNumber] : []);

    const normalize = (s: string) => s.replace(/[-\s]/g, '').toLowerCase();

    const matchesAnyFilter = (accountNumber: string) => {
      if (filterNumbers.length === 0) return true; // no filter = scrape all
      const scraped = normalize(accountNumber);
      return filterNumbers.some(f => {
        const filter = normalize(f);
        return scraped === filter || scraped.includes(filter) || filter.includes(scraped);
      });
    };

    try {
      await this.page!.waitForTimeout(3000);

      // ── Step 1: Navigate to Billing Overview ───────────────
      await this.ensureBillingOverview();
      await this.screenshot('wm-billing-overview');
      await this.scrapeBillingDOM();
      const overviewAccounts = [...this.capturedInvoices];
      console.log(`[WM] Found ${overviewAccounts.length} accounts on overview`);

      // ── Step 2: Filter to only accounts tracked in Sollux ─
      const accountsToScrape = overviewAccounts.filter(a =>
        !a.accountNumber || matchesAnyFilter(a.accountNumber)
      );

      if (filterNumbers.length > 0 && accountsToScrape.length === 0) {
        console.warn(`[WM] No accounts matched filters [${filterNumbers.join(', ')}]. Available: ${overviewAccounts.map(a => a.accountNumber).join(', ')}`);
      }

      // Reset captured invoices — will re-populate with historical data
      this.capturedInvoices = [];

      for (let i = 0; i < accountsToScrape.length; i++) {
        const account = accountsToScrape[i];
        console.log(`[WM] Drilling into account ${i + 1}/${accountsToScrape.length}: ${account.accountName} (${account.accountNumber})`);

        try {
          await this.scrapeAccountHistory(account, i);
        } catch (err) {
          console.error(`[WM] History scrape failed for ${account.accountNumber}:`, err instanceof Error ? err.message : err);
          // Fall back to overview data for this account
          this.capturedInvoices.push(account);
        }

        // Brief pause between accounts
        await this.page!.waitForTimeout(1500);
      }

      // ── Step 4: Convert to ScrapedStatement ───────────────
      // Build a set of account numbers that have real history entries,
      // so we can skip overview-only fallback entries for those accounts.
      const accountsWithHistory = new Set(
        this.capturedInvoices
          .filter(inv => inv.status !== 'overview-only')
          .map(inv => inv.accountNumber)
          .filter(Boolean)
      );

      const statements: ScrapedStatement[] = [];
      for (const inv of this.capturedInvoices) {
        // Skip overview-only entry if we have real history for this account
        if (inv.status === 'overview-only' && accountsWithHistory.has(inv.accountNumber)) {
          continue;
        }

        // Safety: drop statements whose account number isn't in our filter set.
        // Guards against cross-account contamination if back-navigation fails.
        if (filterNumbers.length > 0 && inv.accountNumber && !matchesAnyFilter(inv.accountNumber)) {
          continue;
        }

        const statementDate = this.parseDate(inv.invoiceDate || inv.billingPeriodEnd || null);
        if (!statementDate) continue;

        let pdfBuffer: Buffer | undefined;
        let pdfFilename: string | undefined;
        if (inv.pdfUrl) {
          pdfBuffer = await this.downloadPdf(inv.pdfUrl);
          if (pdfBuffer) {
            pdfFilename = `wm_${inv.accountNumber}_${inv.invoiceDate?.replace(/\//g, '-') ?? statementDate.toISOString().slice(0, 10)}.pdf`;
          }
        }

        statements.push({
          statementDate,
          dueDate: this.parseDate(inv.dueDate || null),
          billingPeriodStart: this.parseDate(inv.billingPeriodStart || null),
          billingPeriodEnd: this.parseDate(inv.billingPeriodEnd || null),
          amountDue: inv.amountDue,
          balance: inv.balance,
          usageUnit: 'pickup',
          pdfBuffer,
          pdfFilename,
          rawData: {
            ...inv.rawData,
            accountName: inv.accountName,
            accountNumber: inv.accountNumber,
            serviceAddress: inv.serviceAddress,
            pastDue: inv.pastDue,
          },
        });
      }

      console.log(`[WM] Total statements scraped: ${statements.length}`);
      return statements;

    } catch (err) {
      console.error('[WM] Statement scraping error:', err instanceof Error ? err.message : err);
      await this.screenshot('wm-statements-error');
      return [];
    }
  }

  // ── Ensure we are on the billing overview with rows rendered ──
  private async ensureBillingOverview(): Promise<boolean> {
    // Strategy 1: click the real nav link — most reliable from any page including dashboard
    const clicked = await this.page!.evaluate(() => {
      const el = Array.from(document.querySelectorAll('a, button'))
        .find(e => /billing|pay.*bill|my bill/i.test(e.textContent || ''));
      if (el) { (el as HTMLElement).click(); return true; }
      return false;
    });
    if (clicked) await this.page!.waitForTimeout(3000);

    // Strategy 2: SPA pushState (fallback when nav link not found or not yet rendered)
    if (!clicked || !this.page!.url().includes('billing/overview')) {
      await this.page!.evaluate(() => {
        window.history.pushState({}, '', '/us/en/mywm/user/my-payment/billing/overview');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await this.page!.waitForTimeout(3000);
    }

    // Wait for MUI account rows — retry up to 3 times (15 s total)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.page!.waitForFunction(() => {
          const rows = Array.from(document.querySelectorAll('.MuiGrid-container'))
            .filter(el =>
              el.className.includes('d-md-flex') &&
              /\$[\d,]+\.\d{2}/.test(el.textContent || '')
            );
          return rows.length >= 1;
        }, { timeout: 5000 });
        await this.page!.waitForTimeout(800);
        return true;
      } catch {
        console.warn(`[WM] Billing overview rows not ready (attempt ${attempt}/3), retrying…`);
        // Re-trigger SPA navigation and wait
        await this.page!.evaluate(() => {
          window.history.pushState({}, '', '/us/en/mywm/user/my-payment/billing/overview');
          window.dispatchEvent(new PopStateEvent('popstate'));
        });
        await this.page!.waitForTimeout(4000);
      }
    }

    console.warn('[WM] Billing overview rows did not render after 3 attempts');
    return false;
  }

  // ── Drill into a single account's billing history ──────────
  private async scrapeAccountHistory(account: WMInvoice, index: number): Promise<void> {
    const urlBefore = this.page!.url();

    // Ensure billing overview is rendered before trying to click
    if (!urlBefore.includes('billing/overview')) {
      await this.ensureBillingOverview();
    }

    // Method 1: navigate directly to the account detail URL if we captured the href
    if (account.accountDetailUrl && account.accountDetailUrl.includes('wm.com')) {
      console.log(`[WM] Navigating to account URL: ${account.accountDetailUrl}`);
      await this.page!.goto(account.accountDetailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else {
      // Method 2: find the row by account number (robust vs. index which breaks after SPA re-render)
      const accountNumber = account.accountNumber || '';
      const clicked = await this.page!.evaluate((acctNum) => {
        const rows = Array.from(document.querySelectorAll('.MuiGrid-container'))
          .filter(el => el.className.includes('d-md-flex'));

        // Find the row whose text contains this account number
        const row = acctNum
          ? rows.find(r => (r.textContent || '').includes(acctNum))
          : rows[0]; // fallback: first row

        if (!row) return false;
        // Account name is a <button class="wm-link"> — NOT an <a> tag
        const btn = row.querySelector('button.wm-link, button.a-taggable, button.Link') as HTMLElement | null;
        if (btn) { btn.click(); return true; }
        return false;
      }, accountNumber);

      if (!clicked) {
        console.log(`[WM] Could not find button for account ${accountNumber} (index ${index}), skipping`);
        this.capturedInvoices.push(account);
        return;
      }
    }

    // Wait for account detail page to render
    await this.page!.waitForTimeout(4000);
    const urlAfter = this.page!.url();
    console.log(`[WM] Account ${index} URL: ${urlBefore} → ${urlAfter}`);
    await this.screenshot(`wm-account-${index}-detail`);

    // Scrape the billing history table on the detail page
    const historyRows = await this.page!.evaluate(() => {
      type HistRow = { text: string; cells: string[] };
      const results: HistRow[] = [];

      // Look for history/statement rows — tables, lists, or MUI grids
      const containers = [
        ...Array.from(document.querySelectorAll('table tbody tr')),
        ...Array.from(document.querySelectorAll('.MuiGrid-container')).filter(el =>
          el.className.includes('d-md-flex') || el.className.includes('jss')
        ),
        ...Array.from(document.querySelectorAll('[class*="history-row"], [class*="statement-row"], [class*="billing-row"]')),
      ];

      for (const row of containers) {
        const text = row.textContent?.trim() || '';
        // Must have a dollar amount
        if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
        // Must have at least 2 distinct MM/DD/YYYY dates — this filters out line-item rows
        // (e.g. "Incidental Charges $5.00 01/15/2024") which only have one date
        const rowDates = [...text.matchAll(/\d{2}\/\d{2}\/\d{4}/g)].map(m => m[0]);
        const uniqueRowDates = new Set(rowDates);
        if (uniqueRowDates.size < 2) continue;
        const cells = Array.from(row.querySelectorAll('td, .MuiGrid-item, [class*="cell"]'))
          .map(el => el.textContent?.trim() || '');
        results.push({ text, cells });
      }
      return results;
    });

    console.log(`[WM] Account ${account.accountNumber}: found ${historyRows.length} history rows`);

    if (historyRows.length === 0) {
      // No history found — keep the overview row as the latest statement
      this.capturedInvoices.push(account);
    } else {
      for (const row of historyRows) {
        const text = row.text;

        // Extract dates — real invoice rows have BOTH an invoice date and a due date.
        // Line-item rows (individual charges like "Incidental Charges") only have one date.
        // Filter these out so we don't mistake incidental line items for invoice summaries.
        const dates = [...text.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)].map(m => m[1]);
        const uniqueDates = [...new Set(dates)];
        if (uniqueDates.length < 2) continue; // line item, not an invoice summary row

        const invoiceDate = dates[0];
        const dueDate = dates[1];

        // Extract all dollar amounts from the row text.
        // WM layouts amounts as: [incidental charges, service charges, ..., TOTAL]
        // The total (rightmost column) is always the largest and always last — use it.
        const amounts = [...text.matchAll(/\$\s*([\d,]+\.\d{2})/g)]
          .map(m => parseFloat(m[1].replace(/,/g, '')));
        if (amounts.length === 0) continue;

        // Last amount = total amount due for this invoice period (service + overages combined)
        const amountDue = amounts[amounts.length - 1];
        // Second-to-last = previous balance carried (if row shows running balance)
        const balance = amounts.length >= 2 ? amounts[amounts.length - 2] : amountDue;

        this.capturedInvoices.push({
          ...account,
          invoiceDate,
          dueDate,
          amountDue,
          balance,
          rawData: {
            // accountBalance = overview total (what you owe including any past due)
            // shown as the primary amount on the card
            accountBalance: account.amountDue,
            accountName: account.accountName,
            accountNumber: account.accountNumber,
            serviceAddress: account.serviceAddress,
            rawText: text.slice(0, 200),
          },
        });
      }
    }

    // Navigate back to billing overview (pushState is more reliable than history.back() for SPAs)
    await this.ensureBillingOverview();
    await this.screenshot(`wm-back-to-overview-${index}`);
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
    try {
      // Use SPA navigation for payment history tab
      await this.page!.evaluate(() => {
        window.history.pushState({}, '', '/us/en/mywm/user/my-payment/billing');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });

      await this.page!.waitForTimeout(3000);

      console.log(`[WM] Captured ${this.capturedPayments.length} payments from XHR`);

      const payments: ScrapedPayment[] = [];
      for (const pmt of this.capturedPayments) {
        const paymentDate = this.parseDate(pmt.paymentDate || null);
        if (!paymentDate || !pmt.amount) continue;
        payments.push({
          paymentDate,
          amount: pmt.amount,
          confirmationNumber: pmt.confirmationNumber,
          paymentMethod: pmt.paymentMethod,
        });
      }

      return payments;
    } catch (err) {
      console.error('[WM] Payment scraping error:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  // ─── DOM scraper for Billing Overview table ──────────────
  private async scrapeBillingDOM(): Promise<void> {
    try {
      // Use the desktop MUI grid rows (d-md-flex) — each is one service account row

      const rowData = await this.page!.evaluate(() => {
        type RowResult = { text: string; cells: string[]; href?: string };
        const results: RowResult[] = [];

        // Filter to rows that have d-md-flex (desktop billing rows).
        // Intentionally NOT checking for jss31 — that's a dynamic MUI class that changes between sessions.
        const desktopRows = Array.from(document.querySelectorAll('.MuiGrid-container'))
          .filter(el => el.className.includes('d-md-flex'));

        for (const row of desktopRows) {
          const text = row.textContent?.trim() || '';
          if (!/\$[\d,]+\.\d{2}/.test(text) || !/\d{2}\/\d{2}\/\d{4}/.test(text)) continue;
          const cells = Array.from(row.querySelectorAll('.MuiGrid-item'))
            .map(el => el.textContent?.trim() || '');
          // Search parent/grandparent for anchors too
          let href: string | undefined;
          let el: Element | null = row;
          for (let i = 0; i < 4 && !href; i++) {
            const a = el?.querySelector('a[href]') as HTMLAnchorElement | null;
            if (a) href = a.href;
            el = el?.parentElement || null;
          }
          results.push({ text, cells, href });
        }

        return results;
      });

      const today = new Date().toISOString().slice(0, 10);

      for (const row of rowData) {
        const text = row.text;

        const amountMatch = text.match(/\$\s*([\d,]+\.\d{2})/);
        if (!amountMatch) continue;
        const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
        if (!amount || amount <= 0) continue;

        const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})/);
        const dueDate = dateMatch ? dateMatch[1] : undefined;

        // WM account numbers: X-XXXXX-XXXXX (exactly 5 digits in each of the last two segments)
        // Constraining to \d{5} prevents bleeding into the street address number that follows
        const firstCell = row.cells[0] || text;
        const accountNumberMatch = firstCell.match(/(\d+-\d{5}-\d{5})/);
        const accountNumber = accountNumberMatch ? accountNumberMatch[1] : undefined;

        // Name is text BEFORE the account number
        const nameEnd = accountNumber ? firstCell.indexOf(accountNumber) : firstCell.length;
        const accountName = firstCell.slice(0, nameEnd).trim() || undefined;

        // Address is text AFTER the account number (up to first $ or newline-equivalent)
        const addrStart = accountNumber ? firstCell.indexOf(accountNumber) + accountNumber.length : 0;
        const serviceAddress = firstCell.slice(addrStart).replace(/\$[\d,.]+.*$/, '').trim().split('\n')[0].trim() || undefined;

        this.capturedInvoices.push({
          invoiceDate: today,
          dueDate,
          amountDue: amount,
          accountName,
          accountNumber,
          serviceAddress,
          accountDetailUrl: row.href,
          status: 'overview-only', // marks this as a fallback — only used if no history found
        });
        console.log(`[WM] Account "${accountName}" (${accountNumber}) @ ${serviceAddress}: $${amount} due ${dueDate}`);
      }
    } catch (err) {
      console.error('[WM] DOM scrape error:', err instanceof Error ? err.message : err);
    }
  }

  // ─── XHR response parsers ────────────────────────────────
  private parseInvoiceResponse(url: string, data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;

    // Try common response shapes
    const invoiceArray: unknown[] =
      (Array.isArray(d.invoices) ? d.invoices : null) ||
      (Array.isArray(d.bills) ? d.bills : null) ||
      (Array.isArray(d.data) ? d.data : null) ||
      (Array.isArray(d.items) ? d.items : null) ||
      (Array.isArray(data) ? data as unknown[] : null) ||
      [];

    for (const item of invoiceArray) {
      if (!item || typeof item !== 'object') continue;
      const inv = item as Record<string, unknown>;

      const invoice: WMInvoice = {
        invoiceId: String(inv.invoiceId || inv.id || inv.billId || ''),
        invoiceDate: String(inv.invoiceDate || inv.billDate || inv.statementDate || inv.date || ''),
        dueDate: String(inv.dueDate || inv.payByDate || ''),
        amountDue: this.toNumber(inv.amountDue || inv.totalAmount || inv.amount || inv.balance),
        balance: this.toNumber(inv.balance || inv.currentBalance),
        billingPeriodStart: String(inv.serviceStartDate || inv.periodStart || inv.fromDate || ''),
        billingPeriodEnd: String(inv.serviceEndDate || inv.periodEnd || inv.toDate || ''),
        pdfUrl: String(inv.pdfUrl || inv.invoiceUrl || inv.documentUrl || ''),
        status: String(inv.status || inv.paymentStatus || ''),
      };

      // Only add if we have at least a date and amount
      if (invoice.invoiceDate && invoice.invoiceDate !== 'undefined' && invoice.amountDue) {
        this.capturedInvoices.push(invoice);
        console.log(`[WM] Captured invoice: ${invoice.invoiceDate} $${invoice.amountDue}`);
      }
    }
  }

  private parsePaymentResponse(url: string, data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;

    const paymentArray: unknown[] =
      (Array.isArray(d.payments) ? d.payments : null) ||
      (Array.isArray(d.transactions) ? d.transactions : null) ||
      (Array.isArray(d.history) ? d.history : null) ||
      (Array.isArray(d.data) ? d.data : null) ||
      (Array.isArray(data) ? data as unknown[] : null) ||
      [];

    for (const item of paymentArray) {
      if (!item || typeof item !== 'object') continue;
      const pmt = item as Record<string, unknown>;

      const amount = this.toNumber(pmt.amount || pmt.paymentAmount || pmt.total);
      const paymentDate = String(pmt.paymentDate || pmt.date || pmt.transactionDate || '');

      if (paymentDate && paymentDate !== 'undefined' && amount) {
        this.capturedPayments.push({
          paymentDate,
          amount,
          confirmationNumber: String(pmt.confirmationNumber || pmt.confirmationId || pmt.transactionId || ''),
          paymentMethod: String(pmt.paymentMethod || pmt.method || ''),
        });
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────
  private async downloadPdf(url: string): Promise<Buffer | undefined> {
    if (!url || url === 'undefined') return undefined;
    try {
      const response = await this.page!.request.get(url, { timeout: 15000 });
      if (response.ok()) return Buffer.from(await response.body());
    } catch { }
    return undefined;
  }

  private toNumber(val: unknown): number | undefined {
    if (val == null) return undefined;
    const n = parseFloat(String(val).replace(/[$,\s]/g, ''));
    return isNaN(n) ? undefined : n;
  }

  private async screenshot(name: string): Promise<void> {
    try {
      const p = path.join('/tmp', `${name}-${Date.now()}.png`);
      await this.page!.screenshot({ path: p, fullPage: true });
      console.log(`[WM] Screenshot saved: ${p}`);
    } catch { }
  }
}
