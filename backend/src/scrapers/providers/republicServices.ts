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
  pdfBuffer?: Buffer;  // populated by _downloadInvoicePdfs()
  status?: string;
  isPaid?: boolean;
  rawData?: Record<string, unknown>;
  // Internal fields populated when merging bills data into obligations
  _billId?: string;       // RS numeric bill ID (e.g. "570150464") — used for document API
  _rawAccountId?: string; // RS internal accountId (e.g. "304670038334") — used for document API
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

  // Auth headers captured from the portal's own API calls (bearer token etc.)
  // Used for direct API fetches in step 6 of _doScrapeAll.
  private _rsAuthHeaders: Record<string, string> = {};

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
    // Capture auth headers from the portal's own API calls so we can reuse
    // them in direct per-account API fetches (step 6 of _doScrapeAll).
    // The RS portal uses Auth0 bearer tokens stored in JS memory — they are
    // NOT in cookies, so page.request.get() alone won't authenticate.
    this.page!.on('request', (request) => {
      try {
        const url = request.url();
        if (!/republicservices\.com/i.test(url)) return;
        const headers = request.headers();
        const auth = headers['authorization'];
        if (auth && auth.toLowerCase().startsWith('bearer ')) {
          if (!this._rsAuthHeaders['authorization']) {
            console.log('[RepublicServices] Captured bearer token from portal request');
          }
          this._rsAuthHeaders['authorization'] = auth;
          // Carry over any other API-key style headers
          for (const h of ['x-api-key', 'x-amzn-requestid', 'x-client-id', 'x-api-version']) {
            if (headers[h]) this._rsAuthHeaders[h] = headers[h];
          }
        }
      } catch { /* non-critical */ }
    });

    this.page!.on('response', async (response) => {
      if (!response.ok()) return;
      const url = response.url();
      const ct  = response.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;

      try {
        const data = await response.json().catch(() => null);
        if (!data) return;

        // Log all JSON API calls to/from republicservices.com for diagnosis
        if (/republicservices\.com/i.test(url)) {
          const preview = JSON.stringify(data).slice(0, 600);
          console.log(`[RepublicServices] API ← ${url}`);
          console.log(`[RepublicServices] API data: ${preview}`);
        }

        // Accounts / service addresses
        if (/\/accounts?\b|\/customers?\b|\/services?\b/i.test(url)) {
          this.parseAccountResponse(url, data);
        }

        // Obligations endpoint — PREFERRED source. Returns per-invoice charges
        // (originalAmount) and remaining balance (openAmount). This is the data the
        // RS portal's "Invoice History" page uses. Check BEFORE bills so obligations
        // populate first and bills get de-duped against them.
        if (/\/obligations?/i.test(url)) {
          // Extract accountId from the URL path: /accounts/{accountId}/obligations
          const acctMatch = url.match(/\/accounts\/(\d+)\/obligations/i);
          this.parseObligationsResponse(url, data, acctMatch ? acctMatch[1] : '');
        }

        // Invoices / bills / statements — fallback when obligations isn't available.
        // Bills give the running balance, not the per-invoice charge.
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

  // ── Shared scrape pass (prevents concurrent page navigation) ─────────────
  // Use a Promise lock so a concurrent caller awaits the same run instead of
  // returning immediately with empty data (the boolean flag was not enough).

  private _scrapeAllPromise: Promise<void> | null = null;

  async scrapeStatements(): Promise<ScrapedStatement[]> {
    await this._scrapeAll();
    await this._downloadInvoicePdfs();
    return this._buildStatements();
  }

  /**
   * Download PDFs for captured invoices.
   *
   * RS generates PDFs client-side (pdfmake + /api/v1/pdfConstants template data).
   * There is no server-side document endpoint — all REST /document paths return 404.
   *
   * Strategy: navigate to the billing history page, intercept Playwright download
   * events triggered by the "Download" buttons in each bill row, and match the
   * downloaded files to our captured invoices by statement date.
   *
   * We cap at MAX_PDF_DOWNLOADS to keep scrape time reasonable.
   */
  private async _downloadInvoicePdfs(): Promise<void> {
    const MAX_PDF_DOWNLOADS = 12;

    // Fast path: some invoices may have had a pdfUrl DOM-scraped
    for (const inv of this.capturedInvoices.filter(i => i.pdfUrl && !i.pdfBuffer)) {
      try {
        const url = inv.pdfUrl!.startsWith('http')
          ? inv.pdfUrl!
          : `${this.PORTAL_BASE}${inv.pdfUrl!.startsWith('/') ? '' : '/'}${inv.pdfUrl!}`;
        const res = await this.page!.request.get(url, { timeout: 20000 });
        if (res.ok()) {
          inv.pdfBuffer = Buffer.from(await res.body());
          console.log(`[RepublicServices] PDF (url) for ${inv.invoiceId}: ${inv.pdfBuffer.length} bytes`);
        }
      } catch { /* non-critical */ }
    }

    // Navigate to billing history page and click download buttons
    await this._downloadPdfsViaClick(MAX_PDF_DOWNLOADS);
  }

  private async _downloadPdfsViaClick(maxDownloads: number): Promise<void> {
    try {
      // The RS portal is a React SPA — direct page.goto() to billing-history doesn't
      // work because the app needs account context that's only established after the
      // dashboard loads. We must navigate in-page (React Router), exactly like pay-bill.
      //
      // Path: dashboard → click "Manage My Account" → click "Billing History"

      // Step 1: Go to dashboard (this always works)
      await this.page!.goto(`${this.PORTAL_BASE}/account/dashboard`, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
      await this.page!.waitForTimeout(3000);

      // Step 2: Click "Manage My Account" in-page (React Router, no full reload)
      const manageClicked = await this.page!.evaluate(() => {
        const el = Array.from(document.querySelectorAll('a'))
          .find(a => /manage.*(my\s*)?account|my\s*account/i.test(a.textContent || '')
            || (a as HTMLAnchorElement).href?.includes('/account/manage'));
        if (el) { (el as HTMLElement).click(); return (el as HTMLAnchorElement).href || 'clicked'; }
        return null;
      });
      console.log(`[RepublicServices] Manage click: ${manageClicked}`);
      await this.page!.waitForTimeout(2500);

      // Step 3: Click "Billing History" in-page
      const historyClicked = await this.page!.evaluate(() => {
        const el = Array.from(document.querySelectorAll('a, button'))
          .find(e => /billing.?history|bill.?history|invoice.?history|view\s+bill/i.test(e.textContent || '')
            || (e as HTMLAnchorElement).href?.includes('billing-history'));
        if (el) { (el as HTMLElement).click(); return (el as HTMLAnchorElement).href || 'clicked'; }
        return null;
      });
      console.log(`[RepublicServices] Billing history click: ${historyClicked}`);
      await this.page!.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await this.page!.waitForTimeout(2000);

      // Step 4: Poll for React to render the billing rows (XHRs fire after initial paint)
      let rendered = false;
      for (let i = 0; i < 14; i++) {
        await this.page!.waitForTimeout(1500);
        const hasContent = await this.page!.evaluate(() =>
          /\$[\d,]+\.\d{2}/.test(document.body.textContent || '')
        );
        if (hasContent) { rendered = true; break; }
      }
      console.log(`[RepublicServices] Billing history rendered: ${rendered}, url: ${this.page!.url()}`);

      await this.screenshot('rs-billing-history-for-pdf');

      // Log some of the page content to understand the structure
      const pageBodySnippet = await this.page!.evaluate(() =>
        (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600)
      );
      console.log(`[RepublicServices] Billing history body: ${pageBodySnippet}`);

      // Also log all button/link text on the page
      const allBtnText = await this.page!.evaluate(() =>
        Array.from(document.querySelectorAll('button, a'))
          .map(el => (el.textContent || '').trim())
          .filter(t => t && t.length < 60)
          .slice(0, 40)
          .join(' | ')
      );
      console.log(`[RepublicServices] All button/link text: ${allBtnText}`);

      const pageUrl = this.page!.url();
      console.log(`[RepublicServices] PDF download page: ${pageUrl}`);

      // Find download/PDF buttons and their adjacent date text
      const buttonInfo = await this.page!.evaluate(() => {
        const results: Array<{ idx: number; dateText: string; amountText: string }> = [];
        const btns = Array.from(document.querySelectorAll('button, a'))
          .filter(el => {
            const txt = (el.textContent || '').trim().toLowerCase();
            const aria = ((el as HTMLElement).getAttribute('aria-label') || '').toLowerCase();
            return txt.includes('download') || txt.includes('pdf') || txt.includes('view bill')
              || aria.includes('download') || aria.includes('pdf');
          });

        btns.forEach((btn, idx) => {
          // Walk up to find the row/card containing this button
          let container: Element | null = btn;
          for (let i = 0; i < 5; i++) {
            container = container?.parentElement ?? null;
            if (!container) break;
            const text = container.textContent || '';
            if (/\$[\d,]+\.\d{2}/.test(text) && /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}/.test(text)) {
              const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/);
              const amtMatch  = text.match(/\$([\d,]+\.\d{2})/);
              results.push({
                idx,
                dateText:   dateMatch?.[1] || '',
                amountText: amtMatch?.[1]  || '',
              });
              break;
            }
          }
        });
        return results;
      });

      console.log(`[RepublicServices] Found ${buttonInfo.length} PDF download button(s) on billing history page`);
      if (buttonInfo.length === 0) {
        console.log('[RepublicServices] No PDF download buttons found — skipping click-based PDF download');
        return;
      }

      let downloaded = 0;
      for (const info of buttonInfo.slice(0, maxDownloads)) {
        if (downloaded >= maxDownloads) break;

        // Find the matching invoice by date (parsed from the button's row text)
        const rowDate = info.dateText ? new Date(info.dateText) : null;
        const targetInv = rowDate && !isNaN(rowDate.getTime())
          ? this.capturedInvoices.find(inv => {
              if (inv.pdfBuffer) return false;
              const d = this.parseDate(inv.invoiceDate || null);
              return d && Math.abs(d.getTime() - rowDate.getTime()) < 15 * 24 * 60 * 60 * 1000; // within 15 days
            })
          : null;

        try {
          const downloadPromise = this.page!.waitForEvent('download', { timeout: 30000 });

          // Re-query buttons each iteration (React may have re-rendered)
          const clicked = await this.page!.evaluate((btnIdx: number) => {
            const btns = Array.from(document.querySelectorAll('button, a'))
              .filter(el => {
                const txt = (el.textContent || '').trim().toLowerCase();
                const aria = ((el as HTMLElement).getAttribute('aria-label') || '').toLowerCase();
                return txt.includes('download') || txt.includes('pdf') || txt.includes('view bill')
                  || aria.includes('download') || aria.includes('pdf');
              });
            if (btns[btnIdx]) {
              (btns[btnIdx] as HTMLElement).click();
              return true;
            }
            return false;
          }, info.idx);

          if (!clicked) {
            downloadPromise.catch(() => {});
            continue;
          }

          const download = await downloadPromise;
          const stream = await download.createReadStream();
          const chunks: Buffer[] = [];
          await new Promise<void>((res, rej) => {
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', res);
            stream.on('error', rej);
          });
          const buf = Buffer.concat(chunks);
          console.log(`[RepublicServices] PDF (click) downloaded: ${buf.length} bytes, row date=${info.dateText} amount=$${info.amountText}`);

          if (targetInv) {
            targetInv.pdfBuffer = buf;
            console.log(`[RepublicServices] Assigned PDF to invoice ${targetInv.invoiceNumber} (${targetInv.invoiceDate})`);
          } else {
            // No matching invoice — store on the first unmatched obligation that has the right amount
            const amtNum = info.amountText ? parseFloat(info.amountText.replace(/,/g, '')) : NaN;
            const fallback = isNaN(amtNum) ? null
              : this.capturedInvoices.find(inv => !inv.pdfBuffer && inv.amountDue != null && Math.abs(inv.amountDue - amtNum) < 0.02);
            if (fallback) {
              fallback.pdfBuffer = buf;
              console.log(`[RepublicServices] Assigned PDF to invoice ${fallback.invoiceNumber} by amount match ($${amtNum})`);
            } else {
              console.log(`[RepublicServices] PDF downloaded but no matching invoice found (date=${info.dateText} amt=$${info.amountText})`);
            }
          }

          downloaded++;
          await this.page!.waitForTimeout(1000); // brief pause between clicks
        } catch (err) {
          console.log(`[RepublicServices] PDF click download failed for row ${info.idx}: ${err instanceof Error ? err.message : err}`);
        }
      }

      console.log(`[RepublicServices] Click-based PDF download complete: ${downloaded} file(s)`);
    } catch (err) {
      console.error('[RepublicServices] _downloadPdfsViaClick error:', err instanceof Error ? err.message : err);
    }
  }

  async scrapePayments(): Promise<ScrapedPayment[]> {
    await this._scrapeAll();
    const payments: ScrapedPayment[] = [];
    for (const p of this.capturedPayments) {
      const paymentDate = this.parseDate(p.paymentDate || null);
      if (!paymentDate || !p.amount) continue;
      payments.push({ paymentDate, amount: p.amount, confirmationNumber: p.confirmationNumber, paymentMethod: p.paymentMethod });
    }
    console.log(`[RepublicServices] Total payments: ${payments.length}`);
    return payments;
  }

  private _scrapeAll(): Promise<void> {
    if (!this._scrapeAllPromise) this._scrapeAllPromise = this._doScrapeAll();
    return this._scrapeAllPromise;
  }

  private async _doScrapeAll(): Promise<void> {

    try {
      // ── 1. Start from dashboard — click header shortcuts to navigate ───────
      // Direct URL navigation (e.g. /account/pay-bill) returns 404 because
      // the portal requires a specific service account to be in session context.
      // We must navigate via the page's own links from the dashboard.
      await this.page!.goto(`${this.PORTAL_BASE}/account/dashboard`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await this.page!.waitForTimeout(3000);
      await this.dismissBanners();
      await this.screenshot('rs-dashboard');

      // Log dashboard body to see account tiles / balances
      const dashBody = await this.page!.evaluate(() =>
        (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600)
      );
      console.log(`[RepublicServices] Dashboard body: ${dashBody}`);

      // Extract all useful hrefs from the dashboard before navigating away
      const dashLinks = await this.page!.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
        return links
          .map(a => ({ text: (a.textContent || '').trim(), href: a.href }))
          .filter(l => l.href && l.href.startsWith('http'));
      });

      // Find the Pay Bill link href
      const payBillLink = dashLinks.find(l => /pay.?bill|pay\s+my/i.test(l.text));
      const billingHistoryLink = dashLinks.find(l => /billing.?history|bill.?history|statement/i.test(l.text));

      // ── 2. Navigate to Pay Bill via click (not goto) ──────────────────────
      // The RS portal is a React Router SPA. Using page.goto() triggers a full
      // page reload which resets React state (incl. the selected account). We
      // must click the link so React Router handles it in-page, preserving
      // the account context that was set during the post-login dashboard load.
      const payBillUrl = payBillLink?.href;
      console.log(`[RepublicServices] Clicking Pay Bill: ${payBillUrl || '(not found, will evaluate-click)'}`);
      await this.page!.evaluate(() => {
        const el = Array.from(document.querySelectorAll('a'))
          .find(a => /pay.?bill/i.test(a.textContent || '') && a.href?.includes('pay-bill'));
        if (el) (el as HTMLElement).click();
      });
      // Wait for React Router to finish the client-side navigation + data fetch
      await this.page!.waitForURL(/pay-bill/, { timeout: 15000 }).catch(() => {});
      await this.page!.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await this.page!.waitForTimeout(2000);
      await this.screenshot('rs-billing-overview');
      await this.domScrapePayBillPage();
      const payBillFinalUrl = this.page!.url();
      console.log(`[RepublicServices] After pay-bill nav: ${payBillFinalUrl}`);

      // ── 3. Navigate to Billing History ────────────────────────────────────
      // Derive billing history URL: try replacing "pay-bill" segment in pay-bill URL,
      // then fall back to the explicit dashboard link if found.
      const derivedHistoryUrls: string[] = [];
      if (payBillFinalUrl.includes('pay-bill')) {
        derivedHistoryUrls.push(
          payBillFinalUrl.replace('pay-bill', 'billing-history'),
          payBillFinalUrl.replace('pay-bill', 'history'),
          payBillFinalUrl.replace(/\/payment\/pay-bill.*$/, '/billing-history'),
        );
      }
      if (billingHistoryLink?.href) derivedHistoryUrls.unshift(billingHistoryLink.href);

      // Also try fixed paths under the portal base (incl. manage area)
      derivedHistoryUrls.push(
        `${this.PORTAL_BASE}/account/payment/billing-history`,
        `${this.PORTAL_BASE}/account/payment/history`,
        `${this.PORTAL_BASE}/account/billing-history`,
        `${this.PORTAL_BASE}/account/manage/billing`,
        `${this.PORTAL_BASE}/account/manage/billing-history`,
      );

      // ── 4. Navigate to Billing History via in-page click ─────────────────
      // First try clicking a "billing history" link that's already on the
      // pay-bill page (React Router — no reload, account context preserved).
      const historyClicked = await this.page!.evaluate(() => {
        const el = Array.from(document.querySelectorAll('a, button'))
          .find(e => /billing.?history|bill.?history|view.*statement|statement.*history/i.test(e.textContent || ''));
        if (el) { (el as HTMLElement).click(); return (el as HTMLAnchorElement).href || 'clicked'; }
        return null;
      });
      if (historyClicked) {
        await this.page!.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
        await this.page!.waitForTimeout(2000);
        const bodyAfterClick = await this.page!.evaluate(() =>
          (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300)
        );
        console.log(`[RepublicServices] After clicking history link "${historyClicked}": ${this.page!.url()}`);
        console.log(`[RepublicServices] Body after history click: ${bodyAfterClick}`);
        await this.screenshot('rs-billing-history-clicked');
        await this.domScrapeStatementRows();
        console.log(`[RepublicServices] Invoices after history click: ${this.capturedInvoices.length}`);
      }

      // If click didn't work, try clicking the nav links from the account portal
      // (these also use React Router so won't reset state)
      if (this.capturedInvoices.length <= 1) {
        const navClicked = await this.page!.evaluate(() => {
          // Try clicking any "Billing" or "History" nav item
          const el = Array.from(document.querySelectorAll('nav a, [role="navigation"] a, [class*="nav"] a'))
            .find(e => /billing|history|statement/i.test(e.textContent || ''));
          if (el) { (el as HTMLElement).click(); return (el as HTMLAnchorElement).href || 'clicked'; }
          return null;
        });
        if (navClicked) {
          await this.page!.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
          await this.page!.waitForTimeout(2000);
          const bodyAfterNav = await this.page!.evaluate(() =>
            (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300)
          );
          console.log(`[RepublicServices] After clicking nav "${navClicked}": ${this.page!.url()}`);
          console.log(`[RepublicServices] Body after nav click: ${bodyAfterNav}`);
          await this.screenshot('rs-billing-history-nav');
          await this.domScrapeStatementRows();
          console.log(`[RepublicServices] Invoices after nav click: ${this.capturedInvoices.length}`);
        }
      }

      console.log(`[RepublicServices] Captured ${this.capturedAccounts.length} account(s), ${this.capturedInvoices.length} invoice(s)`);

      // ── 5. Payment history ───────────────────────────────────────────────
      const payHistoryLink = dashLinks.find(l => /payment.?history|pay.*history/i.test(l.text));
      if (payHistoryLink?.href) {
        await this.page!.goto(payHistoryLink.href, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await this.page!.waitForTimeout(2500);
        await this.domScrapePayments();
      } else {
        // fall back — re-use dashboard billing-history URL which may have payment rows
        const fallbackPaths = ['/account/payment-history'];
        for (const p of fallbackPaths) {
        try {
          await this.page!.goto(`${this.PORTAL_BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
          await this.page!.waitForTimeout(2500);
          await this.domScrapePayments();
          if (this.capturedPayments.length > 0) break;
        } catch { /* try next */ }
        }
      }

      // ── 6. Direct API fetch for EACH stored account number ──────────────
      // The RS portal defaults to one account after login. Any additional accounts
      // (e.g. a second service address under the same login) are never loaded by
      // the portal unless the user manually switches accounts — so the XHR
      // interceptor misses them entirely.
      //
      // Fix: after the normal portal scraping, directly call the RS REST API
      // for every account number the user has stored in Sollux.  The Playwright
      // session is already authenticated, so page.request.get() inherits all
      // session cookies and tokens.
      //
      // Account ID mapping:
      //   user-stored "3-04670-041160" → strip dashes → "304670041160" = RS accountId
      //   RS bills API: /api/v2/mr/accounts/{accountId}/bills?limit=10000000
      //   RS payments:  /api/v2/mr/accounts/{accountId}/payments?includeDetails=false&limit=10000000&refresh=true
      {
        const storedAccountNumbers: string[] =
          this.credentials?.accountNumbers ??
          (this.credentials?.accountNumber ? [this.credentials.accountNumber] : []);

        console.log(`[RepublicServices] Direct API fetch for ${storedAccountNumbers.length} stored account(s): ${storedAccountNumbers.join(', ')}`);

        for (const storedNum of storedAccountNumbers) {
          // Strip dashes/spaces to get the RS internal accountId
          const accountId = storedNum.replace(/[-\s]/g, '');
          if (!accountId) continue;

          console.log(`[RepublicServices] Direct API fetch for accountId=${accountId} (stored: ${storedNum}), bearer=${!!this._rsAuthHeaders['authorization']}`);

          // Helper: fetch a URL using the captured bearer token first, then fall back
          // to page.evaluate(fetch) which runs inside the browser context and
          // automatically carries whatever auth the React app has in memory.
          const fetchJson = async (url: string): Promise<unknown> => {
            // Attempt 1: page.request.get with captured auth headers (fast path)
            if (this._rsAuthHeaders['authorization']) {
              try {
                const res = await this.page!.request.get(url, {
                  timeout: 25000,
                  headers: {
                    'Accept': 'application/json',
                    ...this._rsAuthHeaders,
                  },
                });
                if (res.ok()) {
                  const data = await res.json().catch(() => null);
                  if (data) {
                    console.log(`[RepublicServices] API (bearer) ${res.status()} ← ${url}`);
                    return data;
                  }
                } else {
                  console.log(`[RepublicServices] API (bearer) HTTP ${res.status()} ← ${url}`);
                }
              } catch (e) {
                console.log(`[RepublicServices] API (bearer) error for ${url}: ${e instanceof Error ? e.message : e}`);
              }
            }

            // Attempt 2: run fetch() from inside the browser (inherits all in-memory tokens)
            // We're currently on a www.republicservices.com page, so same-origin — no CORS.
            try {
              const data: unknown = await this.page!.evaluate(async (reqUrl: string) => {
                try {
                  const r = await fetch(reqUrl, {
                    credentials: 'include',
                    headers: { 'Accept': 'application/json' },
                  });
                  if (!r.ok) return null;
                  return await r.json();
                } catch { return null; }
              }, url);
              if (data) {
                console.log(`[RepublicServices] API (browser-fetch) OK ← ${url}`);
                return data;
              }
              console.log(`[RepublicServices] API (browser-fetch) returned null ← ${url}`);
            } catch (e) {
              console.log(`[RepublicServices] API (browser-fetch) error for ${url}: ${e instanceof Error ? e.message : e}`);
            }

            return null;
          };

          try {
            // 6a. Account details — populates capturedAccounts with infoProId
            const acctUrl = `${this.PORTAL_BASE}/api/v2/mr/accounts/${accountId}`;
            const acctData = await fetchJson(acctUrl);
            if (acctData) {
              console.log(`[RepublicServices] Account ${accountId}: ${JSON.stringify(acctData).slice(0, 400)}`);
              this.parseAccountResponse(acctUrl, acctData);
            }
          } catch (err) {
            console.warn(`[RepublicServices] Account fetch failed for ${accountId}:`, err instanceof Error ? err.message : err);
          }

          try {
            // 6b. Obligations — PREFERRED source. Gives per-invoice originalAmount and
            // openAmount (what's still owed) instead of running account balance.
            // Use a wide startDate to capture full history since service started.
            const oblUrl = `${this.PORTAL_BASE}/api/v1/mr/accounts/${accountId}/obligations?limit=10000000&startDate=01012020`;
            const oblData = await fetchJson(oblUrl);
            if (oblData) {
              console.log(`[RepublicServices] Obligations ${accountId}: ${JSON.stringify(oblData).slice(0, 400)}`);
              this.parseObligationsResponse(oblUrl, oblData, accountId);
            } else {
              console.log(`[RepublicServices] No obligations data returned for ${accountId}`);
            }
          } catch (err) {
            console.warn(`[RepublicServices] Obligations fetch failed for ${accountId}:`, err instanceof Error ? err.message : err);
          }

          try {
            // 6b.2. Bills — fallback. Will dedupe against obligations by billReferenceId.
            const billsUrl = `${this.PORTAL_BASE}/api/v2/mr/accounts/${accountId}/bills?limit=10000000`;
            const billsData = await fetchJson(billsUrl);
            if (billsData) {
              console.log(`[RepublicServices] Bills ${accountId}: ${JSON.stringify(billsData).slice(0, 400)}`);
              this.parseInvoiceResponse(billsUrl, billsData);
            } else {
              console.log(`[RepublicServices] No bills data returned for ${accountId}`);
            }
          } catch (err) {
            console.warn(`[RepublicServices] Bills fetch failed for ${accountId}:`, err instanceof Error ? err.message : err);
          }

          try {
            // 6c. Payments
            const pmtUrl = `${this.PORTAL_BASE}/api/v2/mr/accounts/${accountId}/payments?includeDetails=false&limit=10000000&refresh=true`;
            const pmtData = await fetchJson(pmtUrl);
            if (pmtData) {
              console.log(`[RepublicServices] Payments ${accountId}: ${JSON.stringify(pmtData).slice(0, 400)}`);
              this.parsePaymentResponse(pmtUrl, pmtData);
            }
          } catch (err) {
            console.warn(`[RepublicServices] Payments fetch failed for ${accountId}:`, err instanceof Error ? err.message : err);
          }
        }

        console.log(`[RepublicServices] After direct fetch: ${this.capturedInvoices.length} invoice(s), ${this.capturedPayments.length} payment(s)`);
      }
    } catch (err) {
      console.error('[RepublicServices] _scrapeAll error:', err instanceof Error ? err.message : err);
      await this.screenshot('rs-scrapeall-error');
    }
  }

  private _buildStatements(): ScrapedStatement[] {
    const filterNumbers: string[] =
      this.credentials?.accountNumbers ??
      (this.credentials?.accountNumber ? [this.credentials.accountNumber] : []);
    const normalize = (s: string) => s.replace(/[-\s]/g, '').toLowerCase();
    const matchesFilter = (acct: string) => {
      if (filterNumbers.length === 0) return true;
      const a = normalize(acct);
      return filterNumbers.some(f => { const b = normalize(f); return a === b || a.includes(b) || b.includes(a); });
    };
    const knownDatesMap = this.credentials?.knownStatementDates ?? {};

    // Deduplicate
    const seen = new Set<string>();
    const deduped = this.capturedInvoices.filter(inv => {
      const key = `${normalize(inv.accountNumber || '')}:${inv.invoiceDate}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // RS bills carry the internal accountId, not the human-visible infoProId entered by the user.
    // The scraper-side filter often produces 0 results due to account number format mismatches.
    // Skip the filter here — the worker's rawData.accountNumber matching handles multi-account
    // distribution, and falls back to sameCredAccounts.length===1 when no accountNumber is set.
    if (filterNumbers.length > 0) {
      const filterHit = deduped.some(inv => inv.accountNumber && matchesFilter(inv.accountNumber));
      if (!filterHit) {
        console.log(`[RepublicServices] Account number filter (${filterNumbers.join(',')}) matched no invoices — bypassing filter (RS uses internal accountId in bills, not infoProId). User may need to update account number.`);
      }
    }

    const statements: ScrapedStatement[] = [];
    for (const inv of deduped) {
      const statementDate = this.parseDate(inv.invoiceDate || null);
      if (!statementDate) continue;

      // knownStatementDates is keyed by the user's stored account number, but inv.accountNumber
      // is the RS infoProId which may differ. Check both keys to avoid unnecessary re-imports.
      const isoDate = statementDate.toISOString().slice(0, 10);
      const knownForAcct = new Set<string>([
        ...(knownDatesMap[inv.accountNumber ?? ''] ?? []),
        ...filterNumbers.flatMap(f => knownDatesMap[f] ?? []),
      ]);
      if (knownForAcct.has(isoDate)) {
        console.log(`[RepublicServices] Skipping already-stored ${inv.accountNumber} ${isoDate}`);
        continue;
      }

      const amountDue = inv.amountDue ?? inv.totalDue;
      const pastDue   = inv.pastDue;
      const totalDue  = inv.totalDue ?? (amountDue != null && pastDue != null ? amountDue + pastDue : amountDue);

      statements.push({
        statementDate,
        dueDate: this.parseDate(inv.dueDate || null),
        billingPeriodStart: this.parseDate(inv.billingPeriodStart || null),
        billingPeriodEnd:   this.parseDate(inv.billingPeriodEnd || null),
        amountDue,
        balance: inv.balance ?? totalDue,
        usageUnit: 'pickup',
        pdfBuffer: inv.pdfBuffer,
        pdfFilename: inv.pdfBuffer
          ? `republic_services_${inv.accountNumber || 'acct'}_${isoDate}.pdf`
          : undefined,
        rawData: {
          // Omit accountNumber so the worker falls back to sameCredAccounts.length===1 assignment
          // (RS bills carry the internal accountId, not the user-entered account number).
          // Store it under rsInfoProId for reference only.
          rsInfoProId: inv.accountNumber,
          accountName: inv.accountName, serviceAddress: inv.serviceAddress,
          invoiceNumber: inv.invoiceNumber, currentBill: inv.amountDue, pastDue, totalDue,
          accountBalance: totalDue, isPaid: inv.isPaid ?? false,
          isPastDue: !(inv.isPaid ?? false) && pastDue != null && pastDue > 0,
          status: inv.status, pdfUrl: inv.pdfUrl, ...inv.rawData,
        },
      });
    }

    // ── Mark older statements as paid (per-account) ─────────────────────────
    // RS's API gives bill.amountDue = running ACCOUNT BALANCE at bill issue time,
    // not the per-period charge. So once a newer bill arrives, the prior bill's balance
    // has been rolled into it — we treat older bills as paid by definition.
    //
    // Important: group by account number BEFORE finding "latest", or bills from
    // different accounts get mixed together and the wrong ones stay flagged unpaid.
    if (statements.length > 0) {
      const byAcct = new Map<string, ScrapedStatement[]>();
      for (const s of statements) {
        const acct = ((s.rawData as Record<string, unknown> | undefined)?.rsInfoProId as string | undefined) || 'unknown';
        if (!byAcct.has(acct)) byAcct.set(acct, []);
        byAcct.get(acct)!.push(s);
      }

      for (const [, arr] of byAcct) {
        // Sort ascending so the LAST entry is the most recent bill
        arr.sort((a, b) => a.statementDate.getTime() - b.statementDate.getTime());
        for (let i = 0; i < arr.length - 1; i++) {
          const raw = (arr[i].rawData ?? {}) as Record<string, unknown>;
          // If this came from the obligations endpoint, openAmount-based isPaid is
          // authoritative — don't override (it correctly handles cases where a user
          // is behind on multiple bills). Only apply the "older=paid" heuristic when
          // only bills data exists (running balance, no per-invoice paid status).
          if (raw.source === 'obligations') continue;
          raw.isPaid = true;
          arr[i].rawData = raw;
        }
      }
    }

    console.log(`[RepublicServices] Total statements: ${statements.length}`);
    return statements;
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

  /** Scrape the "Make a Payment" page for current balance + account number. */
  private async domScrapePayBillPage(): Promise<void> {
    try {
      // Wait up to 10s for a dollar amount to appear (React SPA loads async)
      await this.page!.waitForSelector('text=/\\$[\\d,]+\\.\\d{2}/', { timeout: 10000 }).catch(() => {});

      const data = await this.page!.evaluate(() => {
        const text = document.body.textContent || '';

        // Debug: first 500 chars and dollar amounts found
        const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 500);
        const allAmounts = [...text.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map(m => m[0]);

        // Account number — RS format: digits with dashes, e.g. 3-0887738-03334
        const acctMatch = text.match(/(\d-\d{6,}-\d{4,})/);
        const accountNumber = acctMatch ? acctMatch[1] : undefined;

        // Total balance (first $x.xx on the page)
        const amounts = allAmounts.map(s => parseFloat(s.replace(/[$,\s]/g, '')));
        const totalBalance = amounts[0];

        // Due date
        const dateMatch = text.match(/(?:due|by)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
        const dueDate = dateMatch ? dateMatch[1] : undefined;

        // Account name
        const nameEl = document.querySelector('[class*="account-name"], [class*="accountName"]');
        const accountName = nameEl?.textContent?.trim();

        // Service address from breadcrumb or header
        const addrEl = document.querySelector('[class*="service-address"], [class*="serviceAddress"], [class*="address"]');
        const serviceAddress = addrEl?.textContent?.trim();

        return { accountNumber, totalBalance, dueDate, accountName, serviceAddress, snippet, allAmounts };
      });

      console.log(`[RepublicServices] Pay-bill page body snippet: ${data.snippet}`);
      console.log(`[RepublicServices] Pay-bill dollar amounts found: ${JSON.stringify(data.allAmounts)}`);

      if (!data.totalBalance) {
        console.log('[RepublicServices] Pay-bill: no balance found, skipping');
        return;
      }

      const today = new Date().toISOString().slice(0, 10);
      // Use first of current month as statement date (RS bills monthly)
      const statementDate = new Date();
      statementDate.setDate(1);

      console.log(`[RepublicServices] Pay-bill page: account=${data.accountNumber} balance=$${data.totalBalance} due=${data.dueDate}`);

      // Update captured accounts
      if (data.accountNumber && !this.capturedAccounts.some(a => a.accountNumber === data.accountNumber)) {
        this.capturedAccounts.push({
          accountNumber: data.accountNumber,
          accountName: data.accountName,
          serviceAddress: data.serviceAddress,
        });
      }

      this.capturedInvoices.push({
        accountNumber:  data.accountNumber,
        accountName:    data.accountName,
        serviceAddress: data.serviceAddress,
        invoiceDate:    statementDate.toLocaleDateString('en-US'),
        dueDate:        data.dueDate,
        amountDue:      data.totalBalance,
        totalDue:       data.totalBalance,
        balance:        data.totalBalance,
        isPaid:         false,
        status:         'current',
      });
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

  // ── RS API shape helpers ──────────────────────────────────────────────────
  // RS wraps all responses: {statusCode:200, data:{bills:[...]} | data:[...]}
  // We must unwrap two levels to get to the actual array.

  private rsToArr(data: unknown, arrayKeys: string[]): unknown[] {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    const outer = data as Record<string, unknown>;

    // First unwrap the outer {statusCode, data:...} shell
    const inner = outer.data !== undefined ? outer.data : outer;

    if (Array.isArray(inner)) return inner;

    if (inner && typeof inner === 'object') {
      const i = inner as Record<string, unknown>;
      for (const k of arrayKeys) {
        if (Array.isArray(i[k])) return i[k] as unknown[];
      }
    }
    // Also check the outer object directly
    for (const k of arrayKeys) {
      if (Array.isArray(outer[k])) return outer[k] as unknown[];
    }
    return [];
  }

  /** Extract a number from a plain number, string, or RS amount object {amount, currency, display} */
  private rsAmount(val: unknown): number | undefined {
    if (val == null) return undefined;
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const n = parseFloat(val.replace(/[$,\s]/g, ''));
      return isNaN(n) ? undefined : n;
    }
    if (typeof val === 'object') {
      const o = val as Record<string, unknown>;
      // RS: {amount: 653.58, currency: "USD", display: "$653.58"}
      if (typeof o.amount === 'number') return o.amount;
      if (typeof o.amount === 'string') {
        const n = parseFloat((o.amount as string).replace(/[$,\s]/g, ''));
        return isNaN(n) ? undefined : n;
      }
    }
    return undefined;
  }

  /**
   * Normalize RS date strings to a form parseDate() can handle.
   * RS uses: "2026-03-30" (ISO), "03302026" (MMDDYYYY), "20260330" (YYYYMMDD),
   *          "20260410T141836.820 GMT" (ISO-ish), "04/14/2026" (US)
   */
  private rsDate(val: unknown): string {
    if (!val) return '';
    const s = String(val).trim();
    if (!s || s === 'undefined') return '';
    // MMDDYYYY: "03302026"
    if (/^\d{8}$/.test(s)) {
      const mm = s.slice(0, 2), dd = s.slice(2, 4), yyyy = s.slice(4, 8);
      const y = parseInt(yyyy);
      if (y > 2000 && y < 2100) return `${yyyy}-${mm}-${dd}`;
      // YYYYMMDD: "20260330"
      const yyyy2 = s.slice(0, 4), mm2 = s.slice(4, 6), dd2 = s.slice(6, 8);
      if (parseInt(yyyy2) > 2000) return `${yyyy2}-${mm2}-${dd2}`;
    }
    // ISO with time: "20260410T141836.820 GMT"
    if (/^\d{8}T/.test(s)) {
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    }
    return s; // "2026-03-30", "04/14/2026" — parseDate handles these
  }

  private parseAccountResponse(url: string, data: unknown): void {
    const items = this.rsToArr(data, ['accounts', 'items', 'results', 'services']);
    // Also handle single-account responses: {statusCode, data:{accountId,...}}
    const dataObj = (data && typeof data === 'object') ? (data as Record<string, unknown>).data : null;
    const candidates = items.length > 0 ? items
      : (dataObj && typeof dataObj === 'object' && !Array.isArray(dataObj)
          && (dataObj as Record<string, unknown>).accountId ? [dataObj] : []);

    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      const a = item as Record<string, unknown>;

      // RS uses infoProId as the human-visible account number
      const accountNumber = String(a.infoProId || a.accountNumber || a.accountId || a.serviceAccountId || '');
      if (!accountNumber || accountNumber === 'undefined') continue;

      if (this.capturedAccounts.some(x => x.accountNumber === accountNumber)) continue;

      this.capturedAccounts.push({
        accountId:      String(a.accountId || a.id || ''),
        accountNumber,
        accountName:    String(a.name || a.accountName || a.nickname || ''),
        serviceAddress: String(a.serviceAddress || a.address || a.location || ''),
        status:         String(a.status || a.accountStatus || ''),
      });
      console.log(`[RepublicServices] Captured account: ${accountNumber} (${a.name || ''})`);
    }
  }

  private parseInvoiceResponse(url: string, data: unknown): void {
    const items = this.rsToArr(data, ['bills', 'invoices', 'statements', 'items', 'results']);

    if (items.length > 0) {
      const first = items[0] as Record<string, unknown>;
      console.log(`[RepublicServices] Invoice array length: ${items.length}, first bill keys: ${Object.keys(first).join(', ')}`);
      console.log(`[RepublicServices] First bill sample: ${JSON.stringify(first).slice(0, 600)}`);
    }

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const inv = item as Record<string, unknown>;

      // RS bills: prefer creation date fields; fall back to dueDate (RS bills API only returns dueDate)
      const invoiceDate = this.rsDate(
        inv.billDate || inv.invoiceDate || inv.statementDate || inv.issueDate
        || inv.date || inv.createdDate || inv.dueDate
      );
      if (!invoiceDate) continue;

      const amountDue = this.rsAmount(inv.amountDue || inv.currentCharges || inv.currentAmount);

      // Skip negative-amount bill entries. These are running-balance "credit events"
      // (the user had a credit balance at bill issue time) and not actual invoices —
      // RS doesn't issue an invoice obligation for these months. The obligations
      // endpoint is the source of truth for real invoices.
      if (amountDue != null && amountDue < 0) {
        console.log(`[RepublicServices] Skipping negative-amount bill (credit event): $${amountDue}`);
        continue;
      }

      const pastDue   = this.rsAmount(inv.pastDueAmount || inv.pastDue || inv.previousBalance);
      const totalDue  = this.rsAmount(inv.totalAmountDue || inv.totalDue || inv.balance)
        ?? (amountDue != null && pastDue != null ? amountDue + pastDue : amountDue);

      const pdfUrl = String(inv.pdfUrl || inv.invoiceUrl || inv.documentUrl || inv.statementUrl || '');

      // RS bills only carry the internal accountId ("304670038334"), not the human-readable infoProId.
      // Look up the infoProId from capturedAccounts (set by parseAccountResponse) so that
      // _buildStatements and the worker can match against what the user actually entered.
      const rawAccountId = String(inv.accountId || '');
      const matchedAcct = rawAccountId
        ? this.capturedAccounts.find(a => a.accountId === rawAccountId)
        : undefined;
      const acctNum = String(
        matchedAcct?.accountNumber  // infoProId, e.g. "4670038334"
        || inv.infoProId || inv.accountNumber || inv.serviceAccountId || rawAccountId || ''
      );

      if (acctNum && !this.capturedAccounts.some(a => a.accountNumber === acctNum || a.accountId === acctNum)) {
        this.capturedAccounts.push({
          accountNumber: acctNum,
          accountId:     String(inv.accountId || ''),
          accountName:   String(inv.accountName || ''),
          serviceAddress: String(inv.serviceAddress || inv.address || ''),
        });
      }

      const dueDate = this.rsDate(inv.dueDate || inv.payByDate || inv.dueDateDisplay);
      const billId  = String(inv.billId || inv.invoiceId || inv.id || '');
      const billRefId = String(inv.billReferenceId || inv.invoiceNumber || '');

      // Deduplicate by billId, AND by billReferenceId — the latter matches obligationId
      // from the obligations endpoint, so if obligations data already exists for this
      // invoice (with the better originalAmount/openAmount fields), we skip the bills
      // version here.
      // BUT: the obligations endpoint never returns a pdfUrl (it's a financial ledger API),
      // while the bills endpoint often does. Merge the pdfUrl into the existing entry
      // rather than throwing it away.
      const mergedPdfUrl = pdfUrl && pdfUrl !== 'undefined' ? pdfUrl : undefined;
      if (billId) {
        const existingById = this.capturedInvoices.find(x => x.invoiceId === billId);
        if (existingById) {
          if (mergedPdfUrl && !existingById.pdfUrl) existingById.pdfUrl = mergedPdfUrl;
          if (billId && !existingById._billId) existingById._billId = billId;
          if (rawAccountId && !existingById._rawAccountId) existingById._rawAccountId = rawAccountId;
          continue;
        }
      }
      if (billRefId) {
        const existingByRef = this.capturedInvoices.find(x => x.invoiceNumber === billRefId);
        if (existingByRef) {
          if (mergedPdfUrl && !existingByRef.pdfUrl) existingByRef.pdfUrl = mergedPdfUrl;
          if (billId && !existingByRef._billId) {
            existingByRef._billId = billId;
            console.log(`[RepublicServices] Stored billId=${billId} accountId=${rawAccountId} on obligation ${billRefId}`);
          }
          if (rawAccountId && !existingByRef._rawAccountId) existingByRef._rawAccountId = rawAccountId;
          continue;
        }
      }

      this.capturedInvoices.push({
        accountNumber:      acctNum || undefined,
        accountName:        String(inv.accountName || ''),
        serviceAddress:     String(inv.serviceAddress || inv.address || ''),
        invoiceId:          billId,
        invoiceNumber:      String(inv.billReferenceId || inv.invoiceNumber || inv.billNumber || billId),
        invoiceDate,
        dueDate:            dueDate || undefined,
        billingPeriodStart: this.rsDate(inv.periodStart || inv.serviceStartDate || inv.fromDate) || undefined,
        billingPeriodEnd:   this.rsDate(inv.periodEnd   || inv.serviceEndDate   || inv.toDate)   || undefined,
        amountDue,
        pastDue,
        totalDue,
        balance:            totalDue ?? amountDue,
        pdfUrl:             pdfUrl && pdfUrl !== 'undefined' ? pdfUrl : undefined,
        status:             String(inv.status || inv.paymentStatus || inv.billStatus || ''),
        isPaid:             /paid|closed|complete|processed/i.test(String(inv.status || inv.paymentStatus || inv.billStatus || ''))
                            || Boolean(inv.isPaid)
                            || (amountDue != null && amountDue === 0),
        rawData:            { raw: inv },
      });

      console.log(`[RepublicServices] Captured invoice: acct=${acctNum} date=${invoiceDate} due=${dueDate} amount=$${totalDue ?? amountDue}`);
    }
  }

  /**
   * Parse the obligations endpoint response.
   *
   * This is the data source RS's "Invoice History" page uses. Each obligation of
   * `type === "invoice"` represents one billing period and gives:
   *   - originalAmount: per-invoice charge (what was billed that period)
   *   - openAmount:     remaining balance (0 → fully paid)
   *   - creationDate:   when the invoice was generated
   *   - invoiceDueDate: when payment is due
   *   - obligationId:   matches billReferenceId from the /bills endpoint
   *
   * This is materially better than /bills (which returns running account balance,
   * not per-invoice charges), so we run obligations FIRST and let bills dedupe.
   */
  private parseObligationsResponse(url: string, data: unknown, accountIdFromUrl: string): void {
    const items = this.rsToArr(data, ['obligations', 'items', 'results', 'data']);
    if (items.length === 0) return;

    // Try to match this account against a captured account so we get the
    // human-readable infoProId (matches what the user stored).
    const matchedAcct = accountIdFromUrl
      ? this.capturedAccounts.find(a => a.accountId === accountIdFromUrl)
      : undefined;
    const acctNum = matchedAcct?.accountNumber || accountIdFromUrl;

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const obl = item as Record<string, unknown>;

      // Only count invoice-type obligations. RS also returns adjustment, fee, payment-event,
      // and other non-invoice obligations on this endpoint. Require type === 'invoice'
      // strictly (was lenient when type was empty, which let through some payment events).
      const type = String(obl.type || '').toLowerCase();
      if (type !== 'invoice') continue;

      const obligationId = String(obl.obligationId || obl.id || '');
      // Dedup against already-captured (either obligations or bills)
      if (obligationId && this.capturedInvoices.some(x =>
        x.invoiceId === obligationId || x.invoiceNumber === obligationId
      )) continue;

      const originalAmount = this.rsAmount(obl.originalAmount);
      const openAmount = this.rsAmount(obl.openAmount);
      const invoiceDate = this.rsDate(obl.creationDate || obl.invoiceDate || obl.date);
      const dueDate = this.rsDate(obl.invoiceDueDate || obl.dueDate);
      if (!invoiceDate || originalAmount == null) continue;

      // Log obligation keys on the first one so we can spot any document/pdf fields
      if (this.capturedInvoices.filter(x => (x.rawData as any)?.source === 'obligations').length === 0) {
        console.log(`[RepublicServices] Obligation keys: ${Object.keys(obl).join(', ')}`);
      }

      const isFullyPaid = openAmount != null && openAmount <= 0.01;

      this.capturedInvoices.push({
        accountNumber:  acctNum || undefined,
        accountName:    matchedAcct?.accountName || '',
        serviceAddress: matchedAcct?.serviceAddress || '',
        invoiceId:      obligationId,
        invoiceNumber:  obligationId,
        invoiceDate,
        dueDate:        dueDate || undefined,
        amountDue:      originalAmount,   // ← per-invoice charge (the actual bill amount)
        balance:        openAmount ?? originalAmount,  // ← what's still owed
        totalDue:       openAmount ?? originalAmount,
        pdfUrl:         undefined,
        status:         isFullyPaid ? 'paid' : (obl.isDue ? 'due' : 'open'),
        isPaid:         isFullyPaid,
        rawData:        { obligation: obl, source: 'obligations' },
      });

      console.log(`[RepublicServices] Captured obligation: acct=${acctNum} date=${invoiceDate} original=$${originalAmount} open=$${openAmount ?? '?'} paid=${isFullyPaid}`);
    }
  }

  private parsePaymentResponse(url: string, data: unknown): void {
    const items = this.rsToArr(data, ['payments', 'transactions', 'history', 'items', 'results']);

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const p = item as Record<string, unknown>;

      const paymentDate = this.rsDate(p.date || p.paymentDate || p.transactionDate || p.paidDate || p.creationDate);
      const amount      = this.rsAmount(p.amount || p.paymentAmount || p.total);
      if (!paymentDate || !amount) continue;

      // Skip negative amounts from the applied-payments ledger (debit entries)
      // Actual customer payments are positive in /payments, negative in /applied-payments
      const absAmount = Math.abs(amount);

      const confNum = String(p.confirmationNumber || p.confirmationId || p.transactionId
                             || p.paymentId || p.referenceId || '');

      // Deduplicate: the interceptor can fire multiple times per session (re-login + navigation)
      if (confNum && this.capturedPayments.some(x => x.confirmationNumber === confNum)) continue;

      this.capturedPayments.push({
        paymentDate,
        amount: absAmount,
        confirmationNumber: confNum,
        paymentMethod:      String(p.paymentMethod || p.method || p.type || ''),
        accountNumber:      String(p.accountNumber || p.accountId || ''),
      });
      console.log(`[RepublicServices] Captured payment: ${paymentDate} $${absAmount}`);
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
