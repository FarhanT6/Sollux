import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The iOS app is the web app in a native shell. The same React bundle that
 * Vercel serves is copied into the Xcode project and loaded from disk, and it
 * talks to the same API over HTTPS — so every screen, import path and rule
 * that works on the web works on the phone, and a fix ships to both at once.
 *
 * The shell opens the live site (server.url below); `npm run ios:sync` copies
 * the config into Xcode. A web deploy reaches the phone on its next launch.
 */
// The app loads the live site rather than the copy on disk. Clerk keeps the
// session in a cookie, and WKWebView keeps no cookies for the app's own
// capacitor://localhost address: signing in worked, then the next page found
// no session and went back to Sign in. On https it behaves like Safari, and
// every deploy reaches the phone without a rebuild. The native plugins (Face
// ID, camera, share sheet) are injected into the live site all the same.
// CAP_SERVER_URL points it elsewhere (a preview deploy) when syncing.
const SERVER_URL = process.env.CAP_SERVER_URL || 'https://sollux-mu.vercel.app';

const config: CapacitorConfig = {
  appId: 'com.sollux.app',
  appName: 'Sollux',
  webDir: 'dist',
  server: {
    url: SERVER_URL,
    // Pages that may open inside the app rather than in the Safari sheet:
    // Sollux itself and Clerk's sign-in handshake.
    allowNavigation: [new URL(SERVER_URL).host, '*.clerk.accounts.dev', '*.accounts.dev', 'clerk.*', '*.clerk.com'],
  },
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
