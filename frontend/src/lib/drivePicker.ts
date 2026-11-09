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
const FOLDER = 'application/vnd.google-apps.folder';
/** The most PDFs a picked folder brings in at once. */
export const FOLDER_LIMIT = 150;

/** The PDFs in a Drive folder and the folders inside it, oldest first by name order Drive gives. */
async function pdfsInFolder(folderId: string, accessToken: string): Promise<{ id: string; name: string; mimeType: string }[]> {
  const out: { id: string; name: string; mimeType: string }[] = [];
  const stack = [folderId];
  while (stack.length && out.length < FOLDER_LIMIT) {
    const parent = stack.shift()!;
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${parent}' in parents and trashed = false`);
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType)&pageSize=200&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`,
        { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`Could not list the folder in Drive (${r.status}).`);
      const j = await r.json() as { nextPageToken?: string; files?: { id: string; name: string; mimeType: string }[] };
      for (const f of j.files ?? []) {
        if (f.mimeType === FOLDER) stack.push(f.id);
        else if (f.mimeType === 'application/pdf' && out.length < FOLDER_LIMIT) out.push(f);
      }
      pageToken = j.nextPageToken ?? '';
    } while (pageToken && out.length < FOLDER_LIMIT);
  }
  return out;
}

/**
 * Opens the picker; resolves with the chosen files (empty when cancelled). Throws DriveNotConnected when no Drive account is connected.
 * With `folders`, a folder can be chosen too: every PDF in it (and its folders) comes back, up to FOLDER_LIMIT.
 */
export async function pickFromDrive(opts: { mimeTypes?: string; multiple?: boolean; folders?: boolean } = {}): Promise<File[]> {
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
      .setIncludeFolders(true)
      .setSelectFolderEnabled(!!opts.folders)
      // Thumbnails, not just names, so the right file can be told apart before it is chosen.
      .setMode(google.picker.DocsViewMode.GRID);
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

  // A folder picked: its PDFs.
  const picked: { id: string; name: string; mimeType: string }[] = [];
  for (const d of docs) {
    if (d.mimeType === FOLDER) picked.push(...await pdfsInFolder(d.id, accessToken));
    else picked.push(d);
  }
  const seen = new Set<string>();
  return downloadDriveFiles(picked.filter(d => !seen.has(d.id) && !!seen.add(d.id)), accessToken);
}

/** Picked Drive files fetched into the browser (a Google Doc as a PDF). */
export function downloadDriveFiles(docs: { id: string; name: string; mimeType: string }[], accessToken: string): Promise<File[]> {
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
