import { getDriveStatus, getDriveAccessToken } from '../api/client';

/**
 * Google Drive's file picker, and the picked files fetched into the browser
 * as ordinary Files — so anything that takes an upload can take a file from
 * Drive too, through the same path. Uses the Drive account connected in Add
 * (read-only access). A Google Doc comes down as a PDF.
 */

// Google ships the Picker only as a browser global from its own CDN.
let gapiLoadPromise: Promise<void> | null = null;
export function loadGooglePicker(): Promise<void> {
  if (gapiLoadPromise) return gapiLoadPromise;
  gapiLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => { (window as any).gapi.load('picker', () => resolve()); };
    script.onerror = e => { gapiLoadPromise = null; reject(e); };
    document.head.appendChild(script);
  });
  return gapiLoadPromise;
}

export class DriveNotConnected extends Error {}

const GOOGLE_DOC = 'application/vnd.google-apps.document';

/** Opens the picker; resolves with the chosen files (empty when cancelled). Throws DriveNotConnected when no Drive account is connected. */
export async function pickFromDrive(opts: { mimeTypes?: string; multiple?: boolean } = {}): Promise<File[]> {
  const apiKey = import.meta.env.VITE_GOOGLE_PICKER_API_KEY;
  if (!apiKey) throw new Error('Google Drive is not set up for this app (VITE_GOOGLE_PICKER_API_KEY).');
  const status = await getDriveStatus();
  const account = status.accounts[0];
  if (!account) throw new DriveNotConnected('Connect a Google Drive account first.');
  await loadGooglePicker();
  const { accessToken } = await getDriveAccessToken(account.id);
  const google = (window as any).google;

  const docs: { id: string; name: string; mimeType: string }[] = await new Promise(resolve => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes(opts.mimeTypes ?? `application/pdf,image/png,image/jpeg,image/webp,${GOOGLE_DOC}`)
      .setIncludeFolders(true);
    let builder = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      .setCallback((data: any) => {
        if (data.action === google.picker.Action.PICKED) resolve(data.docs ?? []);
        else if (data.action === google.picker.Action.CANCEL) resolve([]);
      });
    if (opts.multiple) builder = builder.enableFeature(google.picker.Feature.MULTISELECT_ENABLED);
    builder.build().setVisible(true);
  });

  return Promise.all(docs.map(async d => {
    const isDoc = d.mimeType === GOOGLE_DOC;
    const url = isDoc
      ? `https://www.googleapis.com/drive/v3/files/${d.id}/export?mimeType=application/pdf`
      : `https://www.googleapis.com/drive/v3/files/${d.id}?alt=media&supportsAllDrives=true`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`Could not download "${d.name}" from Drive (${r.status}).`);
    const blob = await r.blob();
    const name = isDoc && !/\.pdf$/i.test(d.name) ? `${d.name}.pdf` : d.name;
    return new File([blob], name, { type: isDoc ? 'application/pdf' : (blob.type || d.mimeType) });
  }));
}
