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
  installNativeShims();
  await setStatusBarTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
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

/** Status bar text that contrasts with the page: light text on the dark
 *  theme, dark text on the light one. */
export async function setStatusBarTheme(theme: 'dark' | 'light'): Promise<void> {
  if (!isNative) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: theme === 'light' ? Style.Light : Style.Dark });
    if (platform === 'android') await StatusBar.setBackgroundColor({ color: theme === 'light' ? '#efe9e4' : '#1e1e1e' });
  } catch { /* plugin missing on this platform */ }
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

// ── What a web page does differently inside the iOS web view ────────────────
// WKWebView has no new windows, no print dialog and no downloads, and Google
// refuses to sign in inside an embedded web view. Links, PDFs and exports go
// to the in-app Safari sheet or the share sheet instead (which offers Print,
// Save to Files, Mail, AirDrop), and Google sign-ins to the Safari sheet.

/** Open a link: a page of the app in the app, anything else in the Safari sheet (native) or a new tab (web). */
export async function openUrl(url: string): Promise<void> {
  if (!url) return;
  if (!isNative) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
  if (url.startsWith('/') && !url.startsWith('//')) {
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
    return;
  }
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    const blob = await (await fetch(url)).blob();
    await shareFile(blob, blob.type === 'application/pdf' ? 'Sollux.pdf' : 'Sollux-file');
    return;
  }
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url, presentationStyle: 'popover' });
}

const blobToBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = reject;
  r.readAsDataURL(blob);
});

/** Save a file: a download on the web; on the phone, the share sheet (Save to Files, Print, Mail…). */
export async function shareFile(blob: Blob, filename: string): Promise<void> {
  if (!isNative) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');
  const safe = filename.replace(/[^\w.\- ]+/g, '_');
  const written = await Filesystem.writeFile({ path: safe, data: await blobToBase64(blob), directory: Directory.Cache });
  await Share.share({ title: safe, files: [written.uri] }).catch(() => { /* dismissed */ });
}

/**
 * Sign in with Google (Gmail, Drive): the browser on the web; on the phone
 * the Safari sheet, since Google blocks embedded web views. The connection
 * is saved server-side; `onClosed` runs when the sheet is dismissed so the
 * page can reload what is connected.
 */
export async function openOAuth(url: string, onClosed?: () => void): Promise<void> {
  if (!isNative) { window.location.href = url; return; }
  const { Browser } = await import('@capacitor/browser');
  const handle = await Browser.addListener('browserFinished', () => { handle.remove(); onClosed?.(); });
  await Browser.open({ url, presentationStyle: 'popover' });
}

/** Print: the print dialog on the web; on the phone, the page as a PDF in the share sheet (which has Print). */
export async function printDocument(root?: HTMLElement | null): Promise<void> {
  if (!isNative) { window.print(); return; }
  const el = root ?? (document.querySelector('[data-print-root]') as HTMLElement | null) ?? (document.querySelector('main') as HTMLElement | null) ?? document.body;
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
  const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
  const imgH = (canvas.height * pageW) / canvas.width;
  let y = 0;
  while (y < imgH) {
    if (y > 0) pdf.addPage();
    pdf.addImage(canvas, 'PNG', 0, -y, pageW, imgH);
    y += pageH;
  }
  await shareFile(pdf.output('blob'), `${(document.title || 'Sollux').replace(/[^\w -]+/g, '')}.pdf`);
}

/**
 * On the phone, make the web page's window.open and window.print do the
 * native thing, so every existing "open PDF", "view document" and "print"
 * button works without each one knowing where it runs. A window opened blank
 * and pointed at a URL afterwards (the web's popup-blocker workaround) is
 * followed to that URL.
 */
export function installNativeShims(): void {
  if (!isNative) return;
  window.open = ((url?: string | URL) => {
    const u = url ? String(url) : '';
    if (u) { void openUrl(u); return null; }
    const go = (v: string) => { void openUrl(v); };
    const location = { assign: go, replace: go, get href() { return ''; }, set href(v: string) { go(v); } };
    return { location, close() {}, focus() {}, document: { write() {}, close() {} } } as unknown as Window;
  }) as typeof window.open;
  window.print = () => { void printDocument(); };
}
