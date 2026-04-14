/**
 * Republic Services scraper
 * Portal:  https://my.republicservices.com
 * Login:   https://my.republicservices.com/u/login  (Auth0 universal login)
 *
 * Auth0 flow: email → Continue → password → Sign In (two-step)
 * SPA: React, intercept XHR/fetch for billing API calls.
 * Multiple service addresses can share one login — uses accountNumbers to filter.
 */
import { BaseScraperProvider, ScraperCredentials, ScrapedStatement, ScrapedPayment } from '../base';
import * as path from 'path';

// ── Internal shapes ───────────────────────────────────────────────────────────

interface RSAccount {
  accountId?: string;
  accountNumber?: string;
  accountName?: string;
  serviceAddress?: string;
  status?: string;
  detailUrl?: string;
}

interface RSInvoice {
  accountId?: string;
  accountNumber?: string;
  accountName?: string;
  serviceAddress?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  amountDue?: number;
  balance?: number;
  pastDue?: number;
  totalDue?: number;
  pdfUrl?: string;
  status?: string;
  isPaid?: boolean;
  rawData?: Record<string, unknown>;
}

interface RSPayment {
  paymentDate?: string;
  amount?: number;
  confirmationNumber?: string;
  paymentMethod?: string;
  accountNumber?: string;
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class RepublicServicesScraper extends BaseScraperProvider {
  readonly providerSlug = 'republic-services';
  readonly providerName = 'Republic Services';

  // Clicking Login on the marketing page triggers a fresh Auth0 redirect.
  // After auth, the portal lives at www.republicservices.com/account/...
  private readonly LOGIN_URL   = 'https://my.republicservices.com';
  private readonly PORTAL_BASE = 'https://www.republicservices.com';

  private capturedAccounts: RSAccount[]  = [];
  private capturedInvoices: RSInvoice[]  = [];
  private capturedPayments: RSPayment[]  = [];

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(credentials: ScraperCredentials): Promise<boolean> {
    try {
      // Set up interceptors early — captures API responses from the post-login
      // dashboard redirect (account/billing data fired on initial page load).
      this.setupInterceptors();

      // Navigate to portal home — /u/login without a state param redirects to
      // the marketing site. We land on the marketing page, click Login to
      // trigger a fresh Auth0 redirect, then fill in credentials.
      await this.page!.goto(this.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page!.waitForTimeout(2000);
      await this.screenshot('rs-login-page');

      // Dismiss cookie / privacy banners first
      await this.dismissBanners();
      await this.page!.waitForTimeout(500);

      // ── Click the Login button on the marketing page ─────────────────────
      // The page shows a centered "Login" card with a pink Login button.
      // Clicking it triggers the OAuth/Auth0 redirect with a fresh state.
      const marketingEmailSel = 'input[type="email"], input[name="email"], input[name="username"], #username, #email';
      const alreadyOnAuthForm = await this.page!.locator(marketingEmailSel).count() > 0;

      if (!alreadyOnAuthForm) {
        // Find and click the Login button on the marketing landing page
        const loginBtnClicked = await this.page!.evaluate(() => {
          // The Login card has an <a> or <button> with text "Login" or "Log In"
          const candidates = Array.from(document.querySelectorAll('a, button, input[type="submit"]'));
          const btn = candidates.find(el => {
            const txt = (el.textContent || (el as HTMLInputElement).value || '').trim();
            return /^(log\s*in|login|sign\s*in)$/i.test(txt);
          });
          if (btn) { (btn as HTMLElement).click(); return true; }
          return false;
        });

        if (!loginBtnClicked) {
          // Fallback: try direct navigation to the auth endpoint
          await this.page!.goto('https://my.republicservices.com/login', {
            waitUntil: 'domcontentloaded', timeout: 15000,
          }).catch(() => {});
        }

        await this.screenshot('rs-after-login-click');

        // Wait for Auth0 form (redirected URL will contain /u/login?state=...)
        try {
          await this.page!.waitForURL(/\/u\/login|auth0|login/i, { timeout: 15000 });
        } catch { /* may already be there */ }
        await this.page!.waitForTimeout(2000);
        await this.dismissBanners();
      }

      await this.screenshot('rs-auth-form');

      const emailSel = 'input[type="email"], input[name="email"], input[name="username"], #username, #email, input[placeholder*="Email" i]';
      const passSel  = 'input[type="password"], input[name="password"], #password';
      const submitSel = 'button[type="submit"]:has-text("Continue"), button[type="submit"]:has-text("Log In"), button[type="submit"]:has-text("Sign In"), button[name="action"], input[type="submit"]';

      // ── Step 1: Email ────────────────────────────────────────────────────
      await this.page!.waitForSelector(emailSel, { timeout: 20000 });
      await this.page!.fill(emailSel, credentials.username);
      await this.page!.waitForTimeout(400 + Math.random() * 200);

      // ── Step 2: Password ─────────────────────────────────────────────────
      // RS uses a single-page form (email + password visible together).
      // If the password field is already visible, fill it directly.
      // If not (true two-step), click Continue first to reveal it.
      const passVisible = await this.page!.locator(passSel).isVisible().catch(() => false);
      if (!passVisible) {
        await this.page!.click(submitSel);
        await this.page!.waitForTimeout(1500);
        await this.screenshot('rs-after-continue');
      }

      await this.page!.waitForSelector(passSel, { timeout: 10000 });
      await this.page!.fill(passSel, credentials.password);
      await this.page!.waitForTimeout(400 + Math.random() * 200);

      await this.screenshot('rs-before-submit');
      await this.page!.click(submitSel);

      // Wait for redirect away from Auth0 login form
      try {
        await this.page!.waitForURL(
          url => !url.toString().includes('/u/login'),
          { timeout: 30000 }
        );
      } catch { /* may already be redirected, check below */ }

      await this.throwIfMfaRequired();
      await this.page!.waitForTimeout(3000);

      const finalUrl = this.page!.url();
      await this.screenshot('rs-post-login');

      // Still on login page = bad credentials or unexpected state
      if (/\/u\/login|auth0\.com.*\/login/i.test(finalUrl)) {
        const errText = await this.page!.locator('[class*="error"], [class*="alert"], .ulp-error, [data-action-button-primary]').textContent().catch(() => '');
        console.error(`[RepublicServices] Login failed — URL: ${finalUrl}`, errText?.slice(0, 100));
        return false;
      }

      console.log('[RepublicServices] Login successful, URL:', finalUrl);

      // Give the dashboard time to load and fire its initial API calls
      // (interceptors already active — set up at start of login)
      await this.page!.waitForTimeout(5000);

      return true;
    } catch (err) {
      console.error('[RepublicServices] Login error:', err instanceof Error ? err.message : err);
      await this.screenshot('rs-login-error');
      return false;
    }
  }

  // ── API interceptors ──────────────────────────────────────────────────────

  private setupInterceptors(): void {
    this.page!.on('response', async (response) => {
      if (!response.ok()) return;
      const url = response.url();
      const ct  = response.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;

      try {
        const data = await response.json().catch(() => null);
        if (!data) return;

        // Accounts / service addresses
        if (/\/accounts?\b|\/customers?\b|\/services?\b/i.test(url)) {
          this.parseAccountResponse(url, data);
        }

        // Invoices / bills / statements
        if (/\/invoice|\/bill|\/statement/i.test(url)) {
          this.parseInvoiceResponse(url, data);
        }

        // Payments / transactions
        if (/\/payment|\/transaction|\/history/i.test(url)) {
          this.parsePaymentResponse(url, data);
        }
      } catch { /* ignore parse errors */ }
    });
  }

  // ── Statements ────────────────────────────────────────────────────────────

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    const filterNumbers: string[] =
      this.credentials?.accountNumbers ??
      (this.credentials?.accountNumber ? [this.credentials.accountNumber] : []);

    const normalize = (s: string) => s.replace(/[-\s]/g, '').toLowerCase();
    const matchesFilter = (acct: string) => {
      if (filterNumbers.length === 0) return true;
      const a = normalize(acct);
      return filterNumbers.some(f => { const b = normalize(f); return a === b || a.includes(b) || b.includes(a); });
    };

    try {
      // ── 1. Navigate to the billing / accounts overview ───────────────────
      await this.navigateToBillingOverview();
      await this.screenshot('rs-billing-overview');

      // ── 2. DOM-scrape account rows as fallback if interceptors missed them
      await this.domScrapeAccounts();

      console.log(`[RepublicServices] Captured ${this.capturedAccounts.length} account(s), ${this.capturedInvoices.length} invoice(s) from interceptors`);

      // ── 3. Determine which accounts to drill into ────────────────────────
      const accountsToScrape = filterNumbers.length === 0
        ? this.capturedAccounts
        : this.capturedAccounts.filter(a => a.accountNumber && matchesFilter(a.accountNumber));

      if (filterNumbers.length > 0 && accountsToScrape.length === 0 && this.capturedAccounts.length > 0) {
        console.warn(`[RepublicServices] No accounts matched filter [${filterNumbers.join(', ')}]. Available: ${this.capturedAccounts.map(a => a.accountNumber).join(', ')}`);
      }

      // ── 4. If the overview page already has invoice data (from XHR), see if ─
      //       we can skip account-level drilling for accounts we know about.
      //       Otherwise drill into each account detail page.
      if (accountsToScrape.length > 0) {
        for (let i = 0; i < accountsToScrape.length; i++) {
          const acct = accountsToScrape[i];
          const alreadyHaveHistory = this.capturedInvoices.some(
            inv => inv.accountNumber && acct.accountNumber && normalize(inv.accountNumber) === normalize(acct.accountNumber)
          );
          if (!alreadyHaveHistory) {
            console.log(`[RepublicServices] Drilling into account ${i + 1}/${accountsToScrape.length}: ${acct.accountName} (${acct.accountNumber})`);
            await this.scrapeAccountDetail(acct, i);
            await this.page!.waitForTimeout(1500);
          }
        }
      } else {
        // No accounts detected from DOM; try generic billing history nav
        await this.navigateToBillingHistory();
        await this.domScrapeStatementRows();
      }

      // ── 5. Build cutoff set per account ──────────────────────────────────
      const knownDatesMap = this.credentials?.knownStatementDates ?? {};

      // ── 6. Deduplicate invoices (same account + same invoice date) ────────
      const seen = new Set<string>();
      const deduped = this.capturedInvoices.filter(inv => {
        const key = `${normalize(inv.accountNumber || '')}:${inv.invoiceDate}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // ── 7. Build ScrapedStatement objects ────────────────────────────────
      const statements: ScrapedStatement[] = [];
      for (const inv of deduped) {
        // Account filter
        if (filterNumbers.length > 0 && inv.accountNumber && !matchesFilter(inv.accountNumber)) continue;

        const statementDate = this.parseDate(inv.invoiceDate || null);
        if (!statementDate) continue;

        // Exact-date dedup against DB
        const acctKey = inv.accountNumber ?? '';
        const knownDates = new Set<string>(knownDatesMap[acctKey] ?? []);
        const isoDate = statementDate.toISOString().slice(0, 10);
        if (knownDates.has(isoDate)) {
          console.log(`[RepublicServices] Skipping already-stored ${acctKey} ${isoDate}`);
          continue;
        }

        // PDF download
        let pdfBuffer: Buffer | undefined;
        let pdfFilename: string | undefined;
        if (inv.pdfUrl) {
          pdfBuffer = await this.downloadPdf(inv.pdfUrl);
          if (pdfBuffer) {
            const safeName = (inv.accountNumber ?? 'rs').replace(/[^a-z0-9]/gi, '_');
            pdfFilename = `rs_${safeName}_${isoDate}.pdf`;
          }
        }

        const amountDue   = inv.amountDue ?? inv.totalDue;
        const currentBill = inv.amountDue;
        const pastDue     = inv.pastDue;
        const totalDue    = inv.totalDue ?? (amountDue != null && pastDue != null ? amountDue + pastDue : amountDue);

        statements.push({
          statementDate,
          dueDate: this.parseDate(inv.dueDate || null),
          billingPeriodStart: this.parseDate(inv.billingPeriodStart || null),
          billingPeriodEnd:   this.parseDate(inv.billingPeriodEnd || null),
          amountDue,
          balance: inv.balance ?? totalDue,
          usageUnit: 'pickup',
          pdfBuffer,
          pdfFilename,
          rawData: {
            accountNumber:   inv.accountNumber,
            accountName:     inv.accountName,
            serviceAddress:  inv.serviceAddress,
            invoiceNumber:   inv.invoiceNumber,
            currentBill,
            pastDue,
            totalDue,
            accountBalance:  totalDue,
            isPaid:          inv.isPaid ?? false,
            isPastDue:       pastDue != null && pastDue > 0,
            status:          inv.status,
            ...inv.rawData,
          },
        });
      }

      console.log(`[RepublicServices] Total statements: ${statements.length}`);
      return statements;
    } catch (err) {
      console.error('[RepublicServices] Statement error:', err instanceof Error ? err.message : err);
      await this.screenshot('rs-statements-error');
      return [];
    }
  }

  // ── Payments ──────────────────────────────────────────────────────────────

  async scrapePayments(): Promise<ScrapedPayment[]> {
    try {
      await this.navigateToPaymentHistory();
      await this.page!.waitForTimeout(3000);
      await this.domScrapePayments();

      const payments: ScrapedPayment[] = [];
      for (const p of this.capturedPayments) {
        const paymentDate = this.parseDate(p.paymentDate || null);
        if (!paymentDate || !p.amount) continue;
        payments.push({
          paymentDate,
          amount: p.amount,
          confirmationNumber: p.confirmationNumber,
          paymentMethod: p.paymentMethod,
        });
      }

      console.log(`[RepublicServices] Total payments: ${payments.length}`);
      return payments;
    } catch (err) {
      console.error('[RepublicServices] Payment error:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  // ── Navigation helpers ────────────────────────────────────────────────────

  private async navigateToBillingOverview(): Promise<void> {
    // RS portal lives at www.republicservices.com/account/...
    // Try known billing paths, fall back to clicking nav links.
    const billingPaths = [
      '/account/pay-bill',
      '/account/billing',
      '/account/billing-history',
      '/account/dashboard',
    ];

    for (const p of billingPaths) {
      try {
        await this.page!.goto(`${this.PORTAL_BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await this.page!.waitForTimeout(3000);
        const hasMoney = await this.page!.evaluate(() => /\$[\d,]+\.\d{2}/.test(document.body.textContent || ''));
        if (hasMoney) { await this.screenshot(`rs-billing-${p.replace(/\//g, '-')}`); return; }
      } catch { /* try next */ }
    }

    // Fallback: click a billing/pay nav link from wherever we are
    await this.page!.evaluate(() => {
      const el = Array.from(document.querySelectorAll('a, button, [role="menuitem"]'))
        .find(e => /pay.*bill|billing|bill.*history/i.test(e.textContent || ''));
      if (el) (el as HTMLElement).click();
    });
    await this.page!.waitForTimeout(3000);
  }

  private async navigateToBillingHistory(): Promise<void> {
    const paths = [
      '/account/billing-history',
      '/account/billing',
      '/account/pay-bill',
      '/account/statements',
    ];
    for (const p of paths) {
      try {
        await this.page!.goto(`${this.PORTAL_BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await this.page!.waitForTimeout(2500);
        const hasMoney = await this.page!.evaluate(() => /\$[\d,]+\.\d{2}/.test(document.body.textContent || ''));
        if (hasMoney) { await this.screenshot('rs-billing-history'); return; }
      } catch { /* try next */ }
    }
  }

  private async navigateToPaymentHistory(): Promise<void> {
    const paths = [
      '/account/payment-history',
      '/account/billing-history',
      '/account/billing',
    ];
    for (const p of paths) {
      try {
        await this.page!.goto(`${this.PORTAL_BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await this.page!.waitForTimeout(2500);
        return;
      } catch { /* try next */ }
    }
    await this.page!.evaluate(() => {
      const el = Array.from(document.querySelectorAll('a, button'))
        .find(e => /payment history|payment.*record|paid/i.test(e.textContent || ''));
      if (el) (el as HTMLElement).click();
    });
    await this.page!.waitForTimeout(2500);
  }

  private async scrapeAccountDetail(account: RSAccount, idx: number): Promise<void> {
    try {
      if (account.detailUrl) {
        await this.page!.goto(account.detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } else if (account.accountId) {
        await this.page!.goto(`${this.PORTAL_BASE}/accounts/${account.accountId}/billing`, {
          waitUntil: 'domcontentloaded', timeout: 20000,
        });
      } else {
        return;
      }
      await this.page!.waitForTimeout(3500);
      await this.screenshot(`rs-account-${idx}-detail`);
      await this.domScrapeStatementRows(account);
      await this.navigateToBillingOverview();
    } catch (err) {
      console.error(`[RepublicServices] Detail scrape error for ${account.accountNumber}:`, err instanceof Error ? err.message : err);
    }
  }

  // ── DOM scrapers ──────────────────────────────────────────────────────────

  private async domScrapeAccounts(): Promise<void> {
    try {
      const rows = await this.page!.evaluate(() => {
        const results: Array<{
          accountNumber?: string; accountName?: string;
          serviceAddress?: string; detailUrl?: string; accountId?: string;
        }> = [];

        // Look for account/service address cards or rows
        const candidates = Array.from(document.querySelectorAll(
          '[class*="account"], [class*="service-address"], [class*="card"], [class*="row"], tr'
        ));

        for (const el of candidates) {
          const text = el.textContent?.trim() || '';
          if (!text || el.children.length > 12) continue;

          // Must look like an account row: has an account-number-like string
          const acctMatch = text.match(/(\d[\d-]{4,})/);
          if (!acctMatch) continue;

          const a = el.querySelector('a[href]') as HTMLAnchorElement | null;
          const href = a?.href;
          const idMatch = href?.match(/\/accounts?\/([^/]+)/);

          results.push({
            accountNumber: acctMatch[1],
            accountName:   undefined,
            serviceAddress: undefined,
            detailUrl: href,
            accountId: idMatch?.[1],
          });
        }

        return results.slice(0, 20);
      });

      for (const r of rows) {
        if (!this.capturedAccounts.some(a => a.accountNumber === r.accountNumber)) {
          this.capturedAccounts.push(r);
        }
      }
    } catch { /* non-critical */ }
  }

  private async domScrapeStatementRows(account?: RSAccount): Promise<void> {
    try {
      const rows = await this.page!.evaluate(() => {
        const results: Array<{
          text: string; cells: string[]; pdfHref?: string; hasPayBtn: boolean;
        }> = [];

        const containers: Element[] = [
          ...Array.from(document.querySelectorAll('table tbody tr')),
          ...Array.from(document.querySelectorAll('[class*="invoice"], [class*="statement"], [class*="bill-row"], [class*="history-row"]')),
        ];

        for (const el of containers) {
          const text = el.textContent?.trim() || '';
          if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
          const dates = text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) || [];
          if (dates.length === 0) continue;

          const cells = Array.from(el.querySelectorAll('td, [class*="cell"], [class*="col"]'))
            .map(c => c.textContent?.trim() || '').filter(Boolean);

          const pdfEl = el.querySelector('a[href*=".pdf"], a[href*="statement"], a[href*="invoice"], a[href*="download"]') as HTMLAnchorElement | null;

          const btns = Array.from(el.querySelectorAll('button, a'));
          const hasPayBtn = btns.some(b => /\bpay\b/i.test(b.textContent || ''));

          results.push({ text, cells, pdfHref: pdfEl?.href, hasPayBtn });
        }

        return results.slice(0, 36);
      });

      const now = new Date();
      for (const row of rows) {
        const text = row.text;
        const dates = [...text.matchAll(/(\d{1,2}\/\d{1,2}\/\d{2,4})/g)].map(m => m[1]);
        const amounts = [...text.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map(m => parseFloat(m[1].replace(/,/g, '')));

        const invoiceDate = dates[0] ? new Date(dates[0]) : now;
        const dueDate = dates[1] || undefined;
        if (isNaN(invoiceDate.getTime())) continue;

        const pastDueMatch = text.match(/past\s*due[^$]*\$\s*([\d,]+\.\d{2})/i);
        const pastDue = pastDueMatch ? parseFloat(pastDueMatch[1].replace(/,/g, '')) : undefined;

        this.capturedInvoices.push({
          accountNumber:  account?.accountNumber,
          accountName:    account?.accountName,
          serviceAddress: account?.serviceAddress,
          invoiceDate:    invoiceDate.toLocaleDateString('en-US'),
          dueDate,
          amountDue:      amounts[0],
          balance:        amounts[1] ?? amounts[0],
          pastDue,
          totalDue:       amounts[amounts.length - 1],
          pdfUrl:         row.pdfHref,
          isPaid:         !row.hasPayBtn,
        });
      }
    } catch { /* non-critical */ }
  }

  private async domScrapePayments(): Promise<void> {
    try {
      const rows = await this.page!.evaluate(() => {
        const results: Array<{ text: string; cells: string[] }> = [];
        const containers: Element[] = [
          ...Array.from(document.querySelectorAll('table tbody tr')),
          ...Array.from(document.querySelectorAll('[class*="payment"], [class*="transaction"]')),
        ];
        for (const el of containers) {
          const text = el.textContent?.trim() || '';
          if (!/\$[\d,]+\.\d{2}/.test(text)) continue;
          if (!text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/)) continue;
          const cells = Array.from(el.querySelectorAll('td, [class*="cell"]'))
            .map(c => c.textContent?.trim() || '').filter(Boolean);
          results.push({ text, cells });
        }
        return results.slice(0, 50);
      });

      for (const row of rows) {
        const dates   = [...row.text.matchAll(/(\d{1,2}\/\d{1,2}\/\d{2,4})/g)].map(m => m[1]);
        const amounts = [...row.text.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map(m => parseFloat(m[1].replace(/,/g, '')));
        if (!dates[0] || !amounts[0]) continue;

        const confMatch = row.text.match(/conf[a-z#.:]*\s*([A-Z0-9-]{6,})/i);
        this.capturedPayments.push({
          paymentDate: dates[0],
          amount: amounts[0],
          confirmationNumber: confMatch?.[1],
        });
      }
    } catch { /* non-critical */ }
  }

  // ── XHR response parsers ──────────────────────────────────────────────────

  private parseAccountResponse(url: string, data: unknown): void {
    const toArr = (d: unknown): unknown[] => {
      if (Array.isArray(d)) return d;
      if (d && typeof d === 'object') {
        const o = d as Record<string, unknown>;
        for (const k of ['accounts', 'data', 'items', 'results', 'services']) {
          if (Array.isArray(o[k])) return o[k] as unknown[];
        }
      }
      return [];
    };

    for (const item of toArr(data)) {
      if (!item || typeof item !== 'object') continue;
      const a = item as Record<string, unknown>;

      const accountNumber = String(a.accountNumber || a.accountId || a.serviceAccountId || a.id || '');
      if (!accountNumber || accountNumber === 'undefined') continue;

      if (this.capturedAccounts.some(x => x.accountNumber === accountNumber)) continue;

      const detailUrl = String(a.detailUrl || a.accountUrl || a.url || '');

      this.capturedAccounts.push({
        accountId:      String(a.id || a.accountId || ''),
        accountNumber,
        accountName:    String(a.name || a.accountName || a.nickname || ''),
        serviceAddress: String(a.serviceAddress || a.address || a.location || ''),
        status:         String(a.status || ''),
        detailUrl:      detailUrl && detailUrl !== 'undefined' ? detailUrl : undefined,
      });
      console.log(`[RepublicServices] Captured account: ${accountNumber}`);
    }
  }

  private parseInvoiceResponse(url: string, data: unknown): void {
    const toArr = (d: unknown): unknown[] => {
      if (Array.isArray(d)) return d;
      if (d && typeof d === 'object') {
        const o = d as Record<string, unknown>;
        for (const k of ['invoices', 'bills', 'statements', 'data', 'items', 'results']) {
          if (Array.isArray(o[k])) return o[k] as unknown[];
        }
      }
      return [];
    };

    for (const item of toArr(data)) {
      if (!item || typeof item !== 'object') continue;
      const inv = item as Record<string, unknown>;

      const invoiceDate = String(
        inv.invoiceDate || inv.billDate || inv.statementDate || inv.date || inv.createdDate || ''
      );
      if (!invoiceDate || invoiceDate === 'undefined') continue;

      const amountDue = this.toNumber(inv.amountDue || inv.currentCharges || inv.currentAmount || inv.amount);
      const pastDue   = this.toNumber(inv.pastDueAmount || inv.pastDue || inv.previousBalance);
      const totalDue  = this.toNumber(inv.totalAmountDue || inv.totalDue || inv.balance)
        ?? (amountDue != null && pastDue != null ? amountDue + pastDue : amountDue);

      const pdfUrl = String(inv.pdfUrl || inv.invoiceUrl || inv.documentUrl || inv.statementUrl || '');

      const acctNum = String(inv.accountNumber || inv.serviceAccountId || inv.accountId || '');
      if (acctNum) {
        // Merge into capturedAccounts if not there
        if (!this.capturedAccounts.some(a => a.accountNumber === acctNum)) {
          this.capturedAccounts.push({
            accountNumber: acctNum,
            accountId:     String(inv.accountId || inv.serviceAccountId || ''),
            accountName:   String(inv.accountName || ''),
            serviceAddress: String(inv.serviceAddress || inv.address || ''),
          });
        }
      }

      this.capturedInvoices.push({
        accountNumber:      acctNum || undefined,
        accountName:        String(inv.accountName || ''),
        serviceAddress:     String(inv.serviceAddress || inv.address || ''),
        invoiceId:          String(inv.invoiceId || inv.id || ''),
        invoiceNumber:      String(inv.invoiceNumber || inv.billNumber || ''),
        invoiceDate,
        dueDate:            String(inv.dueDate || inv.payByDate || inv.dueDateDisplay || ''),
        billingPeriodStart: String(inv.periodStart || inv.serviceStartDate || inv.fromDate || ''),
        billingPeriodEnd:   String(inv.periodEnd   || inv.serviceEndDate   || inv.toDate   || ''),
        amountDue,
        pastDue,
        totalDue,
        balance:            totalDue ?? amountDue,
        pdfUrl:             pdfUrl && pdfUrl !== 'undefined' ? pdfUrl : undefined,
        status:             String(inv.status || inv.paymentStatus || ''),
        isPaid:             String(inv.status || inv.paymentStatus || '').toLowerCase() === 'paid'
                            || Boolean(inv.isPaid),
        rawData:            { raw: inv },
      });

      console.log(`[RepublicServices] Captured invoice: ${acctNum} ${invoiceDate} $${totalDue ?? amountDue}`);
    }
  }

  private parsePaymentResponse(url: string, data: unknown): void {
    const toArr = (d: unknown): unknown[] => {
      if (Array.isArray(d)) return d;
      if (d && typeof d === 'object') {
        const o = d as Record<string, unknown>;
        for (const k of ['payments', 'transactions', 'history', 'data', 'items']) {
          if (Array.isArray(o[k])) return o[k] as unknown[];
        }
      }
      return [];
    };

    for (const item of toArr(data)) {
      if (!item || typeof item !== 'object') continue;
      const p = item as Record<string, unknown>;

      const paymentDate = String(p.paymentDate || p.date || p.transactionDate || p.paidDate || '');
      const amount      = this.toNumber(p.amount || p.paymentAmount || p.total);
      if (!paymentDate || paymentDate === 'undefined' || !amount) continue;

      this.capturedPayments.push({
        paymentDate,
        amount,
        confirmationNumber: String(p.confirmationNumber || p.confirmationId || p.transactionId || p.referenceId || ''),
        paymentMethod:      String(p.paymentMethod || p.method || p.type || ''),
        accountNumber:      String(p.accountNumber || ''),
      });
    }
  }

  // ── Utility helpers ───────────────────────────────────────────────────────

  private async dismissBanners(): Promise<void> {
    const bannerSels = [
      '#onetrust-accept-btn-handler',
      'button:has-text("Accept All")',
      'button:has-text("Accept")',
      'button:has-text("Got it")',
      'button:has-text("I agree")',
      '[aria-label="Close"]',
    ];
    for (const sel of bannerSels) {
      try {
        const el = this.page!.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.click();
          await this.page!.waitForTimeout(600);
          break;
        }
      } catch { /* not found */ }
    }
  }

  private async downloadPdf(url: string): Promise<Buffer | undefined> {
    if (!url || url === 'undefined') return undefined;
    try {
      const res = await this.page!.request.get(url, { timeout: 20000 });
      if (res.ok()) {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('pdf') || ct.includes('octet')) return Buffer.from(await res.body());
      }
      // Try navigating and capturing download
      const [download] = await Promise.all([
        this.page!.waitForEvent('download', { timeout: 8000 }),
        this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 }),
      ]).catch(() => [null]);
      if (download) {
        const buf = await download.createReadStream().then(s => {
          return new Promise<Buffer>((res, rej) => {
            const chunks: Buffer[] = [];
            s.on('data', (c: Buffer) => chunks.push(c));
            s.on('end', () => res(Buffer.concat(chunks)));
            s.on('error', rej);
          });
        });
        return buf;
      }
    } catch { /* download failed */ }
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
      console.log(`[RepublicServices] Screenshot: ${p}`);
    } catch { /* non-critical */ }
  }
}
