# Sollux for iOS

## Status (Sep 2026)

| Piece | State |
|---|---|
| Native shell (Capacitor 6, bundle id `com.sollux.app`) | Done — `frontend/ios` |
| Status bar, splash, safe areas, camera for Scan, haptics | Done |
| App icon and launch screen (the Sollux mark) | Done |
| PDFs, documents and links open in an in-app Safari sheet | Done (`openUrl`, window.open shim) |
| Print buttons → PDF in the share sheet (Print, Save to Files, Mail) | Done (`printDocument`, window.print shim) |
| Exports (Schedule E CSV, vault recovery key) → share sheet | Done (`shareFile`) |
| Gmail / Drive connect in the Safari sheet (Google blocks embedded sign-in) | Done (`openOAuth`) |
| Face ID lock (Settings → Lock this phone's Sollux) and app-switcher privacy cover | Done (`NativeLock`) |
| Vault on the phone (clipboard cleared without the iOS paste prompt) | Done |
| Built and run on a device | **Needs a Mac** — see below |
| TestFlight / App Store | **Needs an Apple Developer account** |
| Push notifications for bills due | Not started — needs an APNs key (see Later) |

Nothing here can be compiled without Xcode on a Mac; everything up to that
point is in the repo and builds (`npm run build:ios`).

The iOS app is the web app in a native shell (Capacitor). The React bundle
that Vercel serves is copied into an Xcode project and loaded from disk; it
talks to the same API and the same Clerk instance. Every screen, import
path and rule that works on the web works on the phone, and a fix ships to
both at once. On a phone the layout swaps the sidebar for a drawer and a
bottom tab bar (Overview · Utilities · Scan · Finances · Payments · More).

## One-time setup (on a Mac)

1. Xcode 15+ from the App Store, then `xcode-select --install`.
2. CocoaPods: `sudo gem install cocoapods` (or `brew install cocoapods`).
3. In `frontend/`, copy `.env.ios.example` to `.env.ios` and fill in:
   - `VITE_API_URL` — the backend's public URL **plus `/api`**, e.g.
     `https://sollux-api.onrender.com/api`. The bundle is loaded from disk,
     so a relative `/api` has nothing to resolve against.
   - `VITE_CLERK_PUBLISHABLE_KEY` — the production key once you move off the
     dev instance.
4. Clerk dashboard → your instance → **Allowed origins** (under API keys /
   Native applications): add `capacitor://localhost`. Dev instances accept
   any origin; production instances do not.
5. Render → `sollux-env`: nothing to add. The API already allows the
   `capacitor://localhost` origin.

## Build and run

```bash
cd frontend
npm run ios          # builds in iOS mode, syncs into ios/, opens Xcode
```

In Xcode: select the **App** target → Signing & Capabilities → pick your
Team (a free Apple ID works for a device you own). Choose your iPhone or a
simulator and press Run.

After any web change:

```bash
npm run ios:sync     # rebuild + copy into the Xcode project
```

then Run again in Xcode. `ios/App/App/public/` is generated and ignored by
git; the rest of `ios/` is committed.

## Before the first build

- `cd frontend && npm install`, then `npm run ios` — CocoaPods installs the
  eight plugins listed in `ios/App/Podfile` (app, browser, filesystem, share,
  haptics, splash, status bar, biometric auth).
- Sign in with **email and password** (or a passkey) in the app. Clerk's
  "Continue with Google" is refused by Google inside embedded web views; if
  you want it on the phone, enable Clerk's native/redirect flow first.

## What's native

- Status bar and splash screen match the app's dark theme
  (`src/lib/native.ts`, `capacitor.config.ts`).
- Safe-area insets: the header clears the notch, the tab bar clears the
  home indicator (`--safe-top` / `--safe-bottom` in `globals.css`).
- Scan → the camera opens directly (the page's file input uses
  `capture="environment"`; `Info.plist` carries the usage strings).
- Light haptic tap on tab-bar and menu presses.
- Links, statement PDFs and documents open in the in-app Safari sheet;
  a page of Sollux opened "in a new tab" opens in the app instead
  (`installNativeShims` in `src/lib/native.ts` redirects window.open).
- Print buttons produce a PDF of the page and open the share sheet, which
  has Print, Save to Files, Mail and AirDrop (window.print shim).
- Downloads (Schedule E CSV, the vault recovery key) go to the share sheet.
- Gmail and Drive connect in the Safari sheet; closing it reloads what is
  connected.
- Face ID / passcode lock, per phone, from Settings. The screen is covered
  while the app is in the background so the app switcher shows nothing.

## Shipping to TestFlight / the App Store

1. Apple Developer Program membership ($99/yr).
2. Xcode → Product → Archive → Distribute App → App Store Connect.
3. In App Store Connect create the app with bundle id `com.sollux.app`,
   upload screenshots (6.7" and 6.1"), a privacy policy URL, and the data
   disclosure (financial info, contact info, user content — all linked to
   the user, used for app functionality).
4. Review note for Apple: the app requires an account; provide a demo login.

## Later

- Push notifications for bills due / penalty dates: `@capacitor/push-notifications`
  plus APNs keys, wired to the existing `notifications` queue.
- Sign in with Apple is required by App Review **only if** you offer other
  third-party sign-ins (Google). Clerk supports it; enable it in the Clerk
  dashboard before submitting.
- Unlocking the vault with Face ID (the passphrase kept in the Keychain,
  released by Face ID) — a convenience over typing it, at the cost of the
  vault opening for anyone who can pass the phone's Face ID.
