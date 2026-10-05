/**
 * Where Playwright finds its browser on Render.
 *
 * Render keeps only the project directory from build to runtime, so a browser
 * installed into the default cache (~/.cache/ms-playwright) at build time is
 * gone when the service starts. Every e-bill print and portal login then
 * failed with "Executable doesn't exist". With PLAYWRIGHT_BROWSERS_PATH=0
 * the browser lives inside node_modules, which is deployed. The build
 * installs it the same way (scripts/install-browser.cjs). Imported first by
 * both entry points, before anything loads Playwright.
 */
if (process.env.RENDER && !process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
