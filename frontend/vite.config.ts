import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Env vars the production bundle cannot function without. These are inlined at
// build time, so a missing one is not a runtime misconfiguration you can fix by
// restarting — it bakes a broken bundle. Worse, Vite replaces a missing var
// with `undefined`, which lets Rollup constant-fold guards against it and strip
// the code they protect. Fail the build instead of shipping that.
const REQUIRED_ENV = ['VITE_CLERK_PUBLISHABLE_KEY'];

// Each build's id, also written to /version.json: an open tab compares the
// two and reloads onto a newer build (src/lib/appVersion.ts).
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || String(Date.now());

export default defineConfig(({ command, mode }) => {
  // `vite --mode mock`: local screen testing with a stand-in for Clerk
  // (src/dev/clerkMock.tsx) and the API served by scripts/screens.mjs.
  // Refused for builds so it can never ship.
  const mock = mode === 'mock';
  if (mock && command === 'build') throw new Error('mock mode is for the dev server only');
  if (command === 'build') {
    const env = loadEnv(mode, process.cwd(), 'VITE_');
    const missing = REQUIRED_ENV.filter(k => !env[k] && !process.env[k]);
    if (missing.length) {
      throw new Error(
        `Missing required build-time environment variable(s): ${missing.join(', ')}.\n` +
        `Set them in the deployment's environment settings (or frontend/.env for a local build) and rebuild.`
      );
    }
  }

  return {
    plugins: [
      react(),
      {
        name: 'version-json',
        apply: 'build',
        generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) }); },
      },
    ],
    define: { __BUILD_ID__: JSON.stringify(command === 'build' ? BUILD_ID : 'dev') },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        ...(mock ? { '@clerk/clerk-react': path.resolve(__dirname, './src/dev/clerkMock.tsx') } : {}),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
