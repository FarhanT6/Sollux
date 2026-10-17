/**
 * How Sollux opens a browser on a provider's portal, for the portal agent and
 * the built-in scrapers alike. Portals behind bot protection (Akamai on
 * Safeco, SDG&E, T-Mobile) turn away a browser that looks automated, so this
 * one looks like what it is — a current Chrome on Linux — and nothing else:
 *
 * - Full Chromium in Chrome's own headless mode (channel 'chromium'), not
 *   Playwright's stripped-down headless shell, which detectors recognise.
 * - A user agent that matches the browser actually running (the old one
 *   claimed Chrome 123/126 on a Mac from Chrome 147 on Linux — a mismatch
 *   between the agent string and the browser's own hints is a bot tell).
 * - HTTP/2 on, as every real Chrome has it; turned off only on a retry for a
 *   site that resets it (Mohela).
 * - PORTAL_PROXY_URL (http://user:pass@host:port), when set, sends portal
 *   traffic through a residential proxy: some portals refuse every request
 *   from a data centre like Render's, whatever the browser looks like.
 */
import { chromium, type BrowserContext, type LaunchOptions } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

/** The bundled Chromium's version, from Playwright's own list (not importable: the package does not export it). */
function chromiumVersion(): string {
  try {
    const file = path.join(path.dirname(require.resolve('playwright-core')), 'browsers.json');
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as { browsers: { name: string; browserVersion?: string }[] };
    return list.browsers.find(b => b.name === 'chromium')?.browserVersion ?? '147.0.0.0';
  } catch {
    return '147.0.0.0';
  }
}
const version = chromiumVersion();
/** Chrome's own format: the major version, the rest zeroed (as Chrome reports it since 2023). */
export const USER_AGENT = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split('.')[0]}.0.0.0 Safari/537.36`;

const ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];

/** The proxy from PORTAL_PROXY_URL, in Playwright's shape; undefined when unset or malformed. */
export function portalProxy(): LaunchOptions['proxy'] | undefined {
  const raw = process.env.PORTAL_PROXY_URL?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return { server: `${u.protocol}//${u.host}`, ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}) };
  } catch {
    console.warn('[Browser] PORTAL_PROXY_URL is not a valid URL; going direct');
    return undefined;
  }
}

/** True for the error a portal gives when it resets HTTP/2 from an automated browser. */
export const isHttp2Reset = (err: unknown) => /ERR_HTTP2_PROTOCOL_ERROR/.test(err instanceof Error ? err.message : String(err));

/**
 * A persistent browser for one account (its profile directory keeps cookies
 * between runs on the same disk). Full Chromium where it is installed, the
 * headless shell otherwise, so a build without it still works.
 */
export async function launchPortalContext(profileDir: string, o: { http1?: boolean; viewport?: { width: number; height: number } } = {}): Promise<BrowserContext> {
  const options = {
    headless: true,
    args: o.http1 ? [...ARGS, '--disable-http2'] : ARGS,
    viewport: o.viewport ?? { width: 1366, height: 900 },
    locale: 'en-US', timezoneId: 'America/Los_Angeles', acceptDownloads: true,
    userAgent: USER_AGENT,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    proxy: portalProxy(),
  };
  try {
    return await chromium.launchPersistentContext(profileDir, { ...options, channel: 'chromium' });
  } catch (err) {
    console.warn('[Browser] full Chromium unavailable, using the headless shell:', err instanceof Error ? err.message.split('\n')[0] : err);
    return chromium.launchPersistentContext(profileDir, options);
  }
}
