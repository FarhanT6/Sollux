import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Env vars the production bundle cannot function without. These are inlined at
// build time, so a missing one is not a runtime misconfiguration you can fix by
// restarting — it bakes a broken bundle. Worse, Vite replaces a missing var
// with `undefined`, which lets Rollup constant-fold guards against it and strip
// the code they protect. Fail the build instead of shipping that.
const REQUIRED_ENV = ['VITE_CLERK_PUBLISHABLE_KEY'];

export default defineConfig(({ command, mode }) => {
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
    plugins: [react()],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
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
