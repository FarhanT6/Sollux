import { Browser, BrowserContext, Page, chromium } from 'playwright';

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
  loginUrl?: string;
}

export abstract class BaseScraperProvider {
  abstract readonly providerSlug: string;
  abstract readonly providerName: string;

  protected browser?: Browser;
  protected context?: BrowserContext;
  protected page?: Page;

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    this.page = await this.context.newPage();
  }

  async cleanup(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }

  abstract login(credentials: ScraperCredentials): Promise<boolean>;
  abstract scrapeStatements(): Promise<ScrapedStatement[]>;
  abstract scrapePayments(): Promise<ScrapedPayment[]>;

  async run(credentials: ScraperCredentials): Promise<ScraperResult> {
    try {
      await this.init();
      const loggedIn = await this.login(credentials);

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

// ─── Provider registry ────────────────────────────────────────────────────────

import { SDGEScraper } from './providers/sdge';
import { SoCalGasScraper } from './providers/socalgas';
import { WMScraper } from './providers/wm';
import { CoxScraper } from './providers/cox';
import { FPLScraper } from './providers/fpl';
import { GmailFallbackScraper } from './providers/gmailFallback';

const registry: Record<string, new () => BaseScraperProvider> = {
  'sdge': SDGEScraper,
  'socal-gas': SoCalGasScraper,
  'wm': WMScraper,
  'cox': CoxScraper,
  'fpl': FPLScraper,
  'gmail-fallback': GmailFallbackScraper,
};

export function getScraperProvider(slug: string): BaseScraperProvider | null {
  const Provider = registry[slug];
  if (!Provider) return null;
  return new Provider();
}
