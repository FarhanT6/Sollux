# Sollux for iOS

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

## What's native

- Status bar and splash screen match the app's dark theme
  (`src/lib/native.ts`, `capacitor.config.ts`).
- Safe-area insets: the header clears the notch, the tab bar clears the
  home indicator (`--safe-top` / `--safe-bottom` in `globals.css`).
- Scan → the camera opens directly (the page's file input uses
  `capture="environment"`; `Info.plist` carries the usage strings).
- Light haptic tap on tab-bar and menu presses.

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
- Biometric unlock: `@capacitor-community/biometric-auth` gating the app on
  resume.
