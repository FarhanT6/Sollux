import { Capacitor } from '@capacitor/core';

/**
 * The little that differs when the web app runs inside the iOS shell.
 *
 * Everything else — routes, API, auth — is identical, so this file is the
 * whole native surface: knowing we are on a phone, dressing the status bar
 * and splash screen, wiring the hardware back button, and a tap of haptics
 * where the web would have nothing. Each plugin is loaded lazily so the web
 * bundle never pays for code it cannot run.
 */

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform(); // 'ios' | 'android' | 'web'

export async function initNative(): Promise<void> {
  if (!isNative) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    if (platform === 'android') await StatusBar.setBackgroundColor({ color: '#1e1e1e' });
  } catch { /* plugin missing on this platform */ }
  try {
    const { App } = await import('@capacitor/app');
    // Android hardware back: walk history, and leave the app only from the
    // root. iOS has no such button; the listener is harmless there.
    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) window.history.back();
      else App.exitApp();
    });
  } catch { /* ignore */ }
}

/** Hide the launch screen once React has painted something worth seeing. */
export async function hideSplash(): Promise<void> {
  if (!isNative) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 200 });
  } catch { /* ignore */ }
}

export async function tap(): Promise<void> {
  if (!isNative) return;
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch { /* ignore */ }
}
