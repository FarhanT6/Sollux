import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The iOS app is the web app in a native shell. The same React bundle that
 * Vercel serves is copied into the Xcode project and loaded from disk, and it
 * talks to the same API over HTTPS — so every screen, import path and rule
 * that works on the web works on the phone, and a fix ships to both at once.
 *
 * Build for the phone with `npm run build:ios` (which reads .env.ios for the
 * absolute API and Clerk keys, since a bundle loaded from disk has no origin
 * to resolve "/api" against), then `npx cap sync ios` and `npx cap open ios`.
 */
const config: CapacitorConfig = {
  appId: 'com.sollux.app',
  appName: 'Sollux',
  webDir: 'dist',
  backgroundColor: '#1e1e1e',
  ios: {
    // Content flows under the status bar; the layout pads itself with the
    // safe-area insets, so nothing is hidden behind the notch.
    contentInset: 'never',
    backgroundColor: '#1e1e1e',
    preferredContentMode: 'mobile',
    scrollEnabled: true,
    // Clerk's session cookies and the API's credentialed requests rely on
    // WKWebView keeping cookies across launches.
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      launchAutoHide: false,
      backgroundColor: '#1e1e1e',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#1e1e1e',
      overlaysWebView: true,
    },
  },
};

export default config;
