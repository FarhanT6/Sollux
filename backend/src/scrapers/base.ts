import { Browser, BrowserContext, Page, chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ScraperResult {
  success: boolean;
  statements: ScrapedStatement[];
  payments: ScrapedPayment[];
  error?: string;
}

export interface ScrapedStatement {
  statementDate: Date;
  dueDate?: Date;
  billingPeriodStart?: Date;
  billingPeriodEnd?: Date;
  amountDue?: number;
  balance?: number;
  usageValue?: number;
  usageUnit?: string;
  ratePlan?: string;
  pdfBuffer?: Buffer;
  pdfFilename?: string;
  rawData?: Record<string, unknown>;
}

export interface ScrapedPayment {
  paymentDate: Date;
  amount: number;
  confirmationNumber?: string;
  paymentMethod?: string;
}

export interface ScraperCredentials {
  username: string;
  password: string;
  accountNumber?: string;
  /** When multiple accounts share one login, list all account numbers to scrape.
   *  Scrapers that support multi-account sessions (e.g. WM) use this to limit
   *  which accounts they drill into, skipping any not tracked in Sollux. */
  accountNumbers?: string[];
  loginUrl?: string;
}

export abstract class BaseScraperProvider {
  abstract readonly providerSlug: string;
  abstract readonly providerName: string;

  protected browser?: Browser;
  protected context?: BrowserContext;
  protected page?: Page;
  protected credentials?: ScraperCredentials;

  /** Path to persistent browser profile for this account (preserves cookies/session between runs) */
  static profileDir(accountId: string): string {
    const base = process.env.BROWSER_PROFILES_DIR
      || path.join(os.homedir(), '.sollux', 'browser-profiles');
    return path.join(base, accountId);
  }

  async init(profileDir?: string): Promise<void> {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ];
    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 } as const,
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    };

    if (profileDir) {
      // Persistent context — stores cookies, localStorage, and session state on disk.
      // After a provider's MFA is solved once, the device is trusted for future headless runs.
      await fs.promises.mkdir(profileDir, { recursive: true });
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        args: launchArgs,
        ...contextOptions,
      });
    } else {
      // Ephemeral context — used when no accountId is available (e.g. CLI test runs)
      this.browser = await chromium.launch({ headless: true, args: launchArgs });
      this.context = await this.browser.newContext(contextOptions);
    }

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    this.page = await this.context.newPage();
  }

  async cleanup(): Promise<void> {
    await this.page?.close();
    await this.context?.close();
    await this.browser?.close();
  }

  abstract login(credentials: ScraperCredentials): Promise<boolean>;
  abstract scrapeStatements(): Promise<ScrapedStatement[]>;
  abstract scrapePayments(): Promise<ScrapedPayment[]>;

  async run(credentials: ScraperCredentials, accountId?: string): Promise<ScraperResult> {
    try {
      const profileDir = accountId ? BaseScraperProvider.profileDir(accountId) : undefined;
      await this.init(profileDir);
      this.credentials = credentials;
      let loggedIn = await this.login(credentials);

      // If login fails with a cached profile the session is likely poisoned (stale cookies,
      // rate-limit token). Clear the profile directory and retry once with a fresh session
      // so that subsequent BullMQ retries also start clean.
      if (!loggedIn && profileDir) {
        console.log(`[${this.providerSlug}] Login failed with cached profile — clearing and retrying fresh`);
        await this.cleanup();
        await fs.promises.rm(profileDir, { recursive: true, force: true });
        await this.init(); // ephemeral, no profile
        loggedIn = await this.login(credentials);
      }

      if (!loggedIn) {
        return { success: false, statements: [], payments: [], error: 'Login failed' };
      }

      const [statements, payments] = await Promise.all([
        this.scrapeStatements(),
        this.scrapePayments(),
      ]);

      return { success: true, statements, payments };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown scraper error';
      console.error(`[${this.providerSlug}] Scraper error:`, message);
      return { success: false, statements: [], payments: [], error: message };
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Detect if the current page is an MFA / phone-verification screen.
   * Throws a recognisable MFA_REQUIRED error so the worker can surface it clearly in the UI.
   */
  protected async throwIfMfaRequired(): Promise<void> {
    const isMfa = await this.page!.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      return /verification code|verify your identity|enter the code|two.factor|authentication code|sent a code|check your (phone|email|text)|confirm.*identity|security code/i.test(text);
    });
    if (isMfa) {
      const providerName = this.providerName;
      throw new Error(
        `MFA_REQUIRED: ${providerName} sent a verification code to your phone or email. ` +
        `To fix this: log in to ${providerName} manually in your browser once, complete the verification, ` +
        `then click Sync again — Sollux will reuse the trusted session automatically.`
      );
    }
  }

  /** Helper: wait for selector with timeout */
  protected async waitFor(selector: string, timeout = 10000): Promise<void> {
    await this.page!.waitForSelector(selector, { timeout });
  }

  /** Helper: safe text content extraction */
  protected async getText(selector: string): Promise<string | null> {
    try {
      return await this.page!.$eval(selector, el => el.textContent?.trim() ?? null);
    } catch {
      return null;
    }
  }

  /** Helper: parse US dollar amount string to number */
  protected parseDollar(str: string | null): number | undefined {
    if (!str) return undefined;
    const num = parseFloat(str.replace(/[$,\s]/g, ''));
    return isNaN(num) ? undefined : num;
  }

  /** Helper: parse date string to Date object */
  protected parseDate(str: string | null): Date | undefined {
    if (!str) return undefined;
    const d = new Date(str);
    return isNaN(d.getTime()) ? undefined : d;
  }
}

