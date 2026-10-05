/**
 * Installs Playwright's Chromium into node_modules during the Render build
 * (see src/config/playwrightPath.ts). Elsewhere it does nothing: local setups
 * keep their own browsers. A failed install warns rather than failing the
 * deploy; e-bills then fall back to a plain-text PDF.
 */
const { execSync } = require('child_process');
if (!process.env.RENDER) process.exit(0);
try {
  execSync('npx playwright install chromium', { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '0' } });
} catch (e) {
  console.warn('[install-browser] Chromium install failed; e-bills will use the text fallback.', e && e.message);
}
