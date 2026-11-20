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

/** Google's own files have no bytes to download: they come down as one of these. A Sheet as CSV (what the importer reads as a loan sheet). */
const EXPORT_AS: Record<string, { mime: string; ext: string }> = {
  [GOOGLE_DOC]: { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', ext: 'csv' },
};

/** Picked Drive files fetched into the browser (a Google Doc as a PDF). */
export function downloadDriveFiles(docs: { id: string; name: string; mimeType: string }[], accessToken: string): Promise<File[]> {
  return Promise.all(docs.map(async d => {
    const as = EXPORT_AS[d.mimeType];
    const url = as
      ? `https://www.googleapis.com/drive/v3/files/${d.id}/export?mimeType=${encodeURIComponent(as.mime)}`
      : `https://www.googleapis.com/drive/v3/files/${d.id}?alt=media&supportsAllDrives=true`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`Could not download "${d.name}" from Drive (${r.status}).`);
    const blob = await r.blob();
    const name = as && !new RegExp(`\\.${as.ext}$`, 'i').test(d.name) ? `${d.name}.${as.ext}` : d.name;
    return new File([blob], name, { type: as ? as.mime : (blob.type || d.mimeType) });
  }));
}

// ── Files dragged in from Google Drive's own tab ─────────────────────────────
// Chrome does not hand a web page the file when it is dragged out of drive.google.com: the drop
// carries a link to it (a plain link, a page snippet, or a "DownloadURL"). The file's id is in that
// link, and the Drive account connected in Add can fetch it.

const ID = '([A-Za-z0-9_-]{20,})';
const DRIVE_LINKS: RegExp[] = [
  // drive.google.com/file/d/<id>/view, docs.google.com/document/d/<id>/edit, …/spreadsheets/d/, /presentation/d/
  new RegExp(`(?:drive|docs)\\.google\\.com/(?:a/[^/\\s]+/)?(?:file|document|spreadsheets|presentation|drawings)/(?:u/\\d+/)?d/(?:e/)?${ID}`, 'g'),
  // drive.google.com/drive/folders/<id>, …/drive/u/0/folders/<id>
  new RegExp(`drive\\.google\\.com/(?:a/[^/\\s]+/)?drive/(?:u/\\d+/)?(?:mobile/)?folders/${ID}`, 'g'),
  // drive.google.com/open?id=<id>, /uc?id=<id>&export=download, drive.usercontent.google.com/download?id=<id>
  new RegExp(`(?:drive|docs|drive\\.usercontent)\\.google\\.com/[^\\s"'<>]*?(?:[?&]|&amp;)id=${ID}`, 'g'),
];

/** The Drive file and folder ids in what a drop carried, first seen first, each once. */
export function driveIdsIn(texts: string[]): string[] {
  const ids: string[] = [];
  for (const raw of texts) {
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* not encoded */ }
    for (const text of decoded === raw ? [raw] : [raw, decoded]) {
      for (const re of DRIVE_LINKS) {
        for (const m of text.matchAll(re)) if (!ids.includes(m[1])) ids.push(m[1]);
      }
    }
  }
  return ids;
}

/** Everything a drop carried as text (links, page snippets, a DownloadURL). Read it inside the drop event: the browser empties it after. */
export function dropTexts(dt: DataTransfer): string[] {
  const out: string[] = [];
  for (const type of Array.from(dt.types ?? [])) {
    if (type === 'Files') continue;
    try { const v = dt.getData(type); if (v) out.push(v); } catch { /* a type the browser will not read out */ }
  }
  return out;
}

export class DriveFileUnreachable extends Error {}

/**
 * The files behind dropped Drive links, downloaded through the connected Drive account(s) — the first
 * one that can open each (a file shared with only one of them). A folder brings its PDFs.
 * Throws DriveNotConnected with no account, DriveFileUnreachable when none of them can open a link.
 */
export async function filesFromDriveIds(ids: string[]): Promise<File[]> {
  const status = await getDriveStatus();
  if (!status.accounts.length) throw new DriveNotConnected('Connect a Google Drive account first.');
  const tokens = new Map<string, string>();
  const tokenFor = async (accountId: string) => {
    if (!tokens.has(accountId)) tokens.set(accountId, (await getDriveAccessToken(accountId)).accessToken);
    return tokens.get(accountId)!;
  };

  const files: File[] = [];
  const unreachable: string[] = [];
  for (const id of ids) {
    let found: { meta: { id: string; name: string; mimeType: string }; token: string } | null = null;
    for (const account of status.accounts) {
      const token = await tokenFor(account.id);
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { found = { meta: await r.json(), token }; break; }
      if (r.status !== 404 && r.status !== 403) throw new Error(`Google Drive did not answer (${r.status}). Try again in a moment.`);
    }
    if (!found) { unreachable.push(id); continue; }
    const docs = found.meta.mimeType === FOLDER ? await pdfsInFolder(found.meta.id, found.token) : [found.meta];
    files.push(...await downloadDriveFiles(docs, found.token));
  }
  if (!files.length && unreachable.length) {
    const who = status.accounts.map(a => a.email).join(' or ');
    throw new DriveFileUnreachable(`${unreachable.length === 1 ? 'That file is' : 'Those files are'} not in the Drive Sollux is connected to (${who}). Connect the Google account that has ${unreachable.length === 1 ? 'it' : 'them'} under Import from Google Drive, or download ${unreachable.length === 1 ? 'it' : 'them'} and drop the downloaded file.`);
  }
  return files;
}
