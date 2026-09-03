import { useCallback, useState, useRef, useEffect } from 'react';
import { format } from 'date-fns';
import { PageHeader } from '../components/ui';
import api, { getDriveStatus, getDriveConnectUrl, getDriveAccessToken, startDriveImport, getDriveImportJob, getProperties } from '../api/client';
import type { Property } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExtractedBill {
  providerName:       string | null;
  serviceAddress:     string | null;
  accountNumber:      string | null;
  statementDate:      string | null;
  dueDate:            string | null;
  billingPeriodStart: string | null;
  billingPeriodEnd:   string | null;
  amountDue:          number | null;
  previousBalance:    number | null;
  paymentsReceived:   number | null;
  currentCharges:     number | null;
  lateFee:            number | null;
  usageValue:         number | null;
  usageUnit:          string | null;
  ratePlan:           string | null;
  isPaid:             boolean;
  utilityType:        string;
  chargeBreakdown:    Record<string, number> | null;
  alerts:             string[];
}

interface MatchResult {
  confidence:       'high' | 'medium' | 'low' | 'none';
  method:           string;
  utilityAccountId: string | null;
  propertyId:       string | null;
  propertyName:     string | null;
  providerName:     string | null;
}

interface NewPropertyPayload {
  address:  string;
  city:     string;
  state:    string;
  zip:      string;
  nickname: string;
  type:     string;
}

interface NewAccountPayload {
  providerName:  string;
  providerSlug:  string;
  category:      string;
  accountNumber: string;
}

interface ParsedBill {
  filename:     string;
  extracted:    ExtractedBill;
  match:        MatchResult;
  error?:       string;
  // Which extractor actually ran. AI extraction falls back to reading the text
  // layer for PDFs the API cannot open, and that path produces no charge
  // breakdown, infers the billing period from the issue month, and reads
  // totals far less reliably — so the downgrade has to be visible.
  extractedBy?: 'ai' | 'text';
  extractionNote?: string;
  fileData:     string;       // base64, retained for S3 upload on confirm
  newProperty?: NewPropertyPayload;
  newAccount?:  NewAccountPayload;
  // When adding to an existing property (no new property creation needed)
  addToPropertyId?: string | null;
}

interface SlimAccount {
  id: string; providerName: string; category: string;
  // Two accounts for one provider on one property are otherwise identical in
  // the picker; these are what tells them apart.
  serviceLabel?: string | null;
  accountNumber?: string | null;
}
interface PropertyWithAccounts extends Omit<Property, 'utilityAccounts'> {
  utilityAccounts: SlimAccount[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONFIDENCE_COLORS: Record<string, string> = {
  high:   '#34d399',
  medium: '#fbbf24',
  low:    '#f87171',
  none:   '#6b7280',
};

const CONFIDENCE_LABELS: Record<string, string> = {
  high:   'Auto-matched',
  medium: 'Likely match  -  verify',
  low:    'Possible match  -  verify',
  none:   'No match found',
};

// A pending selection is not a database id, so it is prefixed to keep the two
// apart in the same <select>.
const PENDING_PREFIX = 'pending:';

const UTILITY_TYPE_TO_CATEGORY: Record<string, string> = {
  electric: 'ELECTRIC',
  gas:      'GAS',
  water:    'WATER',
  sewer:    'SEWER',
  trash:    'TRASH',
  solar:    'SOLAR',
  internet: 'INTERNET',
  phone:    'PHONE',
  other:    'OTHER',
};

function fmt$(n: number | null | undefined) {
  return n != null ? `$${Number(n).toFixed(2)}` : ' - ';
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve((e.target!.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Normalize an address line for loose matching (street number + name only) */
function normAddr(s: string) {
  return s.toLowerCase().split(',')[0].replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/** Return the first property whose address fuzzy-matches `addr`, or null */
function findExistingProperty(addr: string, properties: PropertyWithAccounts[]): PropertyWithAccounts | null {
  if (!addr.trim()) return null;
  const input = normAddr(addr);
  return properties.find(p => {
    const stored = normAddr(p.address);
    return input && stored && (input.includes(stored) || stored.includes(input));
  }) || null;
}

/** Best-effort parse of "123 Main St, San Diego, CA 92101" or similar formats */
function parseServiceAddress(addr: string | null): Partial<NewPropertyPayload> {
  if (!addr) return {};
  const parts = addr.split(',').map(s => s.trim());
  if (parts.length >= 3) {
    const street = parts[0];
    const city   = parts[1];
    const tokens = parts[2].split(/\s+/).filter(Boolean);
    const state  = tokens[0] || '';
    const zip    = tokens[1] || '';
    return { address: street, city, state, zip };
  }
  if (parts.length === 2) {
    const street = parts[0];
    const tokens = parts[1].split(/\s+/).filter(Boolean);
    // last token is zip if numeric
    if (/^\d{5}/.test(tokens[tokens.length - 1] || '')) {
      const zip   = tokens[tokens.length - 1];
      const state = tokens[tokens.length - 2] || '';
      const city  = tokens.slice(0, -2).join(' ');
      return { address: street, city, state, zip };
    }
    return { address: street, city: parts[1] };
  }
  return { address: addr };
}

// ── Dropzone ──────────────────────────────────────────────────────────────────

function Dropzone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const pdfs = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    if (pdfs.length) onFiles(pdfs);
  }, [onFiles]);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className="rounded-xl border-2 border-dashed cursor-pointer transition-colors flex flex-col items-center justify-center gap-3 py-16"
      style={{
        borderColor: dragging ? '#F5A623' : 'rgba(255,255,255,0.12)',
        background:  dragging ? 'rgba(245,166,35,0.05)' : 'rgba(255,255,255,0.03)',
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        className="hidden"
        onChange={e => {
          const pdfs = Array.from(e.target.files || []);
          if (pdfs.length) onFiles(pdfs);
          e.target.value = '';
        }}
      />
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(245,166,35,0.12)' }}>
        <svg width="28" height="28" fill="none" viewBox="0 0 24 24">
          <path d="M12 16V8m0 0-3 3m3-3 3 3" stroke="#F5A623" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="#F5A623" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-gray-200">Drop utility bill PDFs here</p>
        <p className="text-xs text-gray-500 mt-1">or click to browse · any utility · any format · up to 50 at once</p>
      </div>
    </div>
  );
}

// ── Google Drive import ──────────────────────────────────────────────────────

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve((e.target!.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

interface DriveJobStatus {
  id: string;
  status: string;
  totalFiles: number;
  processedFiles: number;
  autoImported: number;
  needsReview: { filename: string; s3Key: string; extracted: ExtractedBill; match: MatchResult; pdfUrl: string }[];
}

// Lazily loads Google's API + Picker client libraries (not an npm package  - 
// Google only ships these as browser globals from their own CDN).
let gapiLoadPromise: Promise<void> | null = null;
function loadGooglePicker(): Promise<void> {
  if (gapiLoadPromise) return gapiLoadPromise;
  gapiLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => {
      (window as any).gapi.load('picker', () => resolve());
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return gapiLoadPromise;
}

function DriveImportPanel({ onResolved, onStreamStart, onBillStreamed, onProgress, extractionMethod }: {
  onResolved:       (bills: ParsedBill[], properties: PropertyWithAccounts[], autoImported: number) => void;
  onStreamStart?:   (properties: PropertyWithAccounts[], autoImported: number) => void;
  onBillStreamed?:  (bill: ParsedBill) => void;
  onProgress?:      (done: number, total: number) => void;
  extractionMethod: 'ai' | 'regex';
}) {
  const [status, setStatus] = useState<{ connected: boolean; accounts: { id: string; email: string }[] } | null>(null);
  const [tokenId, setTokenId] = useState('');
  const [opening, setOpening] = useState(false);
  const [job, setJob] = useState<DriveJobStatus | null>(null);
  const [folderName, setFolderName] = useState('');
  const [resolving, setResolving] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);

  useEffect(() => {
    getDriveStatus().then(s => {
      setStatus(s);
      if (s.accounts[0]) setTokenId(s.accounts[0].id);
    }).catch(() => {});

    // Rehydrate last job from localStorage so Review button survives page reloads
    const savedJobId = localStorage.getItem('sollux_last_drive_job');
    if (savedJobId) {
      getDriveImportJob(savedJobId).then(data => {
        const j = data as DriveJobStatus;
        if (j && j.needsReview?.length > 0) setJob(j);
      }).catch(() => {});
    }
  }, []);

  const [streaming, setStreaming] = useState(false);
  const [streamTotal, setStreamTotal] = useState(0);
  const [streamDone, setStreamDone]   = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const cancelStream = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  };

  const openPicker = async () => {
    const apiKey = import.meta.env.VITE_GOOGLE_PICKER_API_KEY;
    if (!apiKey) {
      alert('Google Picker API key is not configured (VITE_GOOGLE_PICKER_API_KEY).');
      return;
    }
    setOpening(true);
    try {
      await loadGooglePicker();
      const { accessToken } = await getDriveAccessToken(tokenId);
      const google = (window as any).google;

      const foldersView = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setSelectFolderEnabled(true)
        .setIncludeFolders(true);
      const pdfView = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setMimeTypes('application/pdf')
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true);

      const picker = new google.picker.PickerBuilder()
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .addView(foldersView)
        .addView(pdfView)
        .setOAuthToken(accessToken)
        .setDeveloperKey(apiKey)
        .setCallback(async (data: any) => {
          if (data.action === google.picker.Action.PICKED) {
            const docs: any[] = data.docs || [];
            if (!docs.length) return;
            const folders = docs.filter(d => d.mimeType === 'application/vnd.google-apps.folder');
            const files   = docs.filter(d => d.mimeType !== 'application/vnd.google-apps.folder');
            const displayName =
              folders.length > 0 ? folders[0].name :
              files.length === 1 ? files[0].name :
              `${files.length} files`;
            setFolderName(displayName);
            await startStream(tokenId, folders[0]?.id, files.map((f: any) => f.id));
          }
        })
        .build();

      picker.setVisible(true);
    } finally {
      setOpening(false);
    }
  };

  const startStream = async (tId: string, folderId?: string, fileIds?: string[]) => {
    setStreaming(true);
    setStreamTotal(0);
    setStreamDone(0);
    setDriveError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // @ts-ignore
      const token = await window.Clerk?.session?.getToken();
      const base  = import.meta.env.VITE_API_URL || '/api';

      const response = await fetch(`${base}/drive/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ tokenId: tId, folderId, fileIds, method: extractionMethod }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) throw new Error('Stream failed');

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let buf     = '';
      let done    = false;
      let started = false;
      let counted = 0;
      let total   = 0;  // local var so it's always current inside the loop

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;
        buf += decoder.decode(value ?? new Uint8Array(), { stream: !streamDone });

        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));

          if (event.type === 'total') {
            total = event.count;
            setStreamTotal(total);
            onProgress?.(0, total);
          } else if (event.type === 'bill') {
            counted++;
            setStreamDone(counted);
            onProgress?.(counted, total);
            if (!started) {
              onStreamStart?.({} as any, 0);
              started = true;
            }
            onBillStreamed?.({ filename: event.filename, extracted: event.extracted, match: event.match, fileData: event.fileData, error: event.error });
          } else if (event.type === 'auto_imported') {
            counted++;
            setStreamDone(counted);
            onProgress?.(counted, total);
          } else if (event.type === 'done') {
            onProgress?.(total, total);  // mark complete
            if (!started) {
              onResolved([], event.properties || [], event.autoImported ?? 0);
            } else {
              onStreamStart?.(event.properties || [], event.autoImported ?? 0);
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setDriveError(`Import failed: ${(err as Error).message}`);
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  if (!status) return null;

  if (!status.connected) {
    return (
      <div className="rounded-xl p-5 mb-5 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div>
          <p className="text-sm font-medium text-gray-200">Import from Google Drive</p>
          <p className="text-xs text-gray-500 mt-0.5">Connect a Drive account to bulk-import a whole folder of statements at once.</p>
        </div>
        <button className="btn text-xs" onClick={() => getDriveConnectUrl().then(r => { window.location.href = r.url; })}>
          + Connect Drive
        </button>
      </div>
    );
  }

  if (streaming) {
    const pct = streamTotal > 0 ? Math.round((streamDone / streamTotal) * 100) : 0;
    return (
      <div className="rounded-xl p-5 mb-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <p className="text-sm font-medium text-gray-200">
              {streamTotal > 0
                ? `Processing ${folderName}  -  ${streamDone} / ${streamTotal} files`
                : 'Connecting to Drive...'}
            </p>
          </div>
          <button
            onClick={cancelStream}
            className="text-xs px-3 py-1 rounded-lg transition-colors text-gray-400 hover:text-red-400"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
          >
            Cancel
          </button>
        </div>
        {streamTotal > 0 && (
          <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full bg-amber-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
        {driveError && <p className="text-xs text-red-400 mt-2">{driveError}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-xl p-5 mb-5 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div>
        <p className="text-sm font-medium text-gray-200">Import from Google Drive</p>
        <p className="text-xs text-gray-500 mt-0.5">Pick a folder from My Drive or Shared with me  -  every PDF inside (including subfolders) gets pulled in.</p>
      </div>
      <button onClick={openPicker} disabled={opening} className="btn btn-primary text-xs disabled:opacity-40">
        {opening ? 'Opening...' : 'Choose folder'}
      </button>
    </div>
  );
}

// ── New-property mini-form ─────────────────────────────────────────────────────

const PROPERTY_TYPES = ['RENTAL', 'PRIMARY', 'COMMERCIAL', 'VACATION'];
const CATEGORIES     = ['ELECTRIC', 'GAS', 'WATER', 'SEWER', 'TRASH', 'SOLAR', 'INTERNET', 'PHONE', 'OTHER'];

function NewPropertyForm({
  propForm,
  acctForm,
  onChangeProp,
  onChangeAcct,
  onSave,
  onCancel,
}: {
  propForm:     NewPropertyPayload;
  acctForm:     NewAccountPayload;
  onChangeProp: (f: NewPropertyPayload) => void;
  onChangeAcct: (f: NewAccountPayload) => void;
  onSave:       () => void;
  onCancel:     () => void;
}) {
  const inputCls = 'w-full rounded-lg px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-amber-500/50';
  const inputStyle = { background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' };
  const labelCls  = 'block text-xs text-gray-500 mb-0.5';

  return (
    <div className="space-y-3 pt-2">
      {/* Property section */}
      <div className="rounded-lg p-3 space-y-2.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-xs font-medium text-gray-400">New property</p>
        <div>
          <label className={labelCls}>Street address *</label>
          <input
            className={inputCls}
            style={inputStyle}
            value={propForm.address}
            onChange={e => onChangeProp({ ...propForm, address: e.target.value })}
            placeholder="123 Main St"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          <div className="col-span-1">
            <label className={labelCls}>City *</label>
            <input
              className={inputCls}
              style={inputStyle}
              value={propForm.city}
              onChange={e => onChangeProp({ ...propForm, city: e.target.value })}
              placeholder="San Diego"
            />
          </div>
          <div>
            <label className={labelCls}>State *</label>
            <input
              className={inputCls}
              style={inputStyle}
              value={propForm.state}
              onChange={e => onChangeProp({ ...propForm, state: e.target.value.toUpperCase().slice(0, 2) })}
              placeholder="CA"
              maxLength={2}
            />
          </div>
          <div>
            <label className={labelCls}>ZIP *</label>
            <input
              className={inputCls}
              style={inputStyle}
              value={propForm.zip}
              onChange={e => onChangeProp({ ...propForm, zip: e.target.value })}
              placeholder="92101"
              maxLength={10}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Nickname (optional)</label>
            <input
              className={inputCls}
              style={inputStyle}
              value={propForm.nickname}
              onChange={e => onChangeProp({ ...propForm, nickname: e.target.value })}
              placeholder="e.g. Beach House"
            />
          </div>
          <div>
            <label className={labelCls}>Type</label>
            <select
              className={inputCls}
              style={inputStyle}
              value={propForm.type}
              onChange={e => onChangeProp({ ...propForm, type: e.target.value })}
            >
              {PROPERTY_TYPES.map(t => (
                <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Account section */}
      <div className="rounded-lg p-3 space-y-2.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-xs font-medium text-gray-400">New utility account</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Provider name *</label>
            <input
              className={inputCls}
              style={inputStyle}
              value={acctForm.providerName}
              onChange={e => onChangeAcct({ ...acctForm, providerName: e.target.value, providerSlug: toSlug(e.target.value) })}
              placeholder="e.g. SDG&E"
            />
          </div>
          <div>
            <label className={labelCls}>Category</label>
            <select
              className={inputCls}
              style={inputStyle}
              value={acctForm.category}
              onChange={e => onChangeAcct({ ...acctForm, category: e.target.value })}
            >
              {CATEGORIES.map(c => (
                <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls}>Account number (optional)</label>
          <input
            className={inputCls}
            style={inputStyle}
            value={acctForm.accountNumber}
            onChange={e => onChangeAcct({ ...acctForm, accountNumber: e.target.value })}
            placeholder="e.g. 12345678"
          />
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <button
          onClick={onCancel}
          className="text-xs text-gray-500 hover:text-gray-400 transition-colors"
        >
          ← Use existing account
        </button>
        <button
          onClick={onSave}
          disabled={!(propForm.address && propForm.city && propForm.state && propForm.zip && acctForm.providerName)}
          className="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: '#F5A623', color: '#000' }}
        >
          Save new property &amp; account
        </button>
      </div>
    </div>
  );
}

// ── Add-account-to-existing-property form ────────────────────────────────────

function AddAccountForm({
  propertyName,
  acctForm,
  onChangeAcct,
  onSave,
  onCancel,
}: {
  propertyName: string;
  acctForm:     NewAccountPayload;
  onChangeAcct: (f: NewAccountPayload) => void;
  onSave:       () => void;
  onCancel:     () => void;
}) {
  const inputCls  = 'w-full rounded-lg px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-amber-500/50';
  const inputStyle = { background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' };
  const labelCls  = 'block text-xs text-gray-500 mb-0.5';

  return (
    <div className="space-y-3 pt-2">
      {/* Property banner */}
      <div className="rounded-lg px-3 py-2 flex items-center gap-2" style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="flex-shrink-0">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="#818cf8" strokeWidth="1.8"/>
          <path d="M9 22V12h6v10" stroke="#818cf8" strokeWidth="1.8"/>
        </svg>
        <span className="text-xs text-indigo-300 font-medium truncate">Adding to: {propertyName}</span>
      </div>

      {/* Account fields */}
      <div className="rounded-lg p-3 space-y-2.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-xs font-medium text-gray-400">New utility account</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Provider name *</label>
            <input
              className={inputCls}
              style={inputStyle}
              value={acctForm.providerName}
              onChange={e => onChangeAcct({ ...acctForm, providerName: e.target.value, providerSlug: toSlug(e.target.value) })}
              placeholder="e.g. SDG&E"
            />
          </div>
          <div>
            <label className={labelCls}>Category</label>
            <select
              className={inputCls}
              style={inputStyle}
              value={acctForm.category}
              onChange={e => onChangeAcct({ ...acctForm, category: e.target.value })}
            >
              {CATEGORIES.map(c => (
                <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls}>Account number (optional)</label>
          <input
            className={inputCls}
            style={inputStyle}
            value={acctForm.accountNumber}
            onChange={e => onChangeAcct({ ...acctForm, accountNumber: e.target.value })}
            placeholder="e.g. 50849413"
          />
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-400 transition-colors">
          ← Other options
        </button>
        <button
          onClick={onSave}
          disabled={!acctForm.providerName.trim()}
          className="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: '#F5A623', color: '#000' }}
        >
          Add account to property
        </button>
      </div>
    </div>
  );
}

// ── Bill review card ──────────────────────────────────────────────────────────

type CardMode = 'select' | 'add-existing' | 'new';

function BillCard({
  bill,
  properties,
  onAssign,
  onAddToProperty,
  onAssignNew,
  onRemove,
  sameProviderBills,
  onApplyTo,
  pendingAccounts,
  onPickPending,
}: {
  bill:               ParsedBill;
  properties:         PropertyWithAccounts[];
  onAssign:           (utilityAccountId: string) => void;
  onAddToProperty:    (propertyId: string, acct: NewAccountPayload) => void;
  onAssignNew:        (prop: NewPropertyPayload, acct: NewAccountPayload) => void;
  onRemove:           () => void;
  sameProviderBills:  ParsedBill[];
  onApplyTo:          (filenames: string[] | 'all') => void;
  // Accounts other cards in this batch are about to create.
  pendingAccounts:    { key: string; propertyId: string; propertyLabel: string; account: NewAccountPayload }[];
  onPickPending:      (propertyId: string, account: NewAccountPayload) => void;
}) {
  const { extracted: ex, match, error } = bill;
  const confColor = CONFIDENCE_COLORS[match.confidence];

  // Default to 'add-existing' when the backend found the property but no account
  const defaultMode: CardMode = match.method === 'property_exists_no_account' ? 'add-existing' : 'select';

  const [selectedAcctId, setSelectedAcctId]           = useState(match.utilityAccountId || '');
  const [mode, setMode]                               = useState<CardMode>(defaultMode);
  const [applied, setApplied]                         = useState(false);

  // "Apply to all" rewrites the assignment on the bill objects in the parent,
  // but this card is keyed by filename, so React keeps the same instance and
  // these useState initialisers never run again. Without this the data was
  // updated while the card carried on showing its old unassigned state — which
  // read as "apply to all did nothing".
  const assignmentKey =
    `${bill.match.utilityAccountId ?? ''}|${bill.addToPropertyId ?? ''}|` +
    `${bill.newAccount?.providerName ?? ''}|${bill.newProperty?.address ?? ''}`;
  useEffect(() => {
    if (bill.match.utilityAccountId) {
      setSelectedAcctId(bill.match.utilityAccountId);
      setMode('select');
      setApplied(true);
    } else if (bill.addToPropertyId && bill.newAccount) {
      setMode('add-existing');
      setApplied(true);
    } else if (bill.newProperty && bill.newAccount) {
      setMode('new');
      setApplied(true);
    }
    if (bill.newAccount) setAcctForm(bill.newAccount);
    if (bill.newProperty) setPropForm(bill.newProperty);
  }, [assignmentKey]);
  const [resolvedPropertyName, setResolvedPropertyName] = useState<string | null>(null);
  const [showApplyPanel, setShowApplyPanel]           = useState(false);
  const [selectedForApply, setSelectedForApply]       = useState<Set<string>>(new Set());

  // Pre-fill forms from extracted data
  const addrParts = parseServiceAddress(ex.serviceAddress);
  const [propForm, setPropForm] = useState<NewPropertyPayload>({
    address:  addrParts.address  || '',
    city:     addrParts.city     || '',
    state:    addrParts.state    || '',
    zip:      addrParts.zip      || '',
    nickname: '',
    type:     'RENTAL',
  });
  const [acctForm, setAcctForm] = useState<NewAccountPayload>({
    providerName:  ex.providerName  || '',
    providerSlug:  toSlug(ex.providerName || ''),
    category:      UTILITY_TYPE_TO_CATEGORY[ex.utilityType] || 'OTHER',
    accountNumber: ex.accountNumber || '',
  });

  const handleAcctSelect = (v: string) => {
    if (v.startsWith(PENDING_PREFIX)) {
      // Joining an account another card is creating: adopt its property and
      // payload so both resolve to the same account server-side.
      const pending = pendingAccounts.find(p => PENDING_PREFIX + p.key === v);
      if (pending) {
        setAcctForm(pending.account);
        setMode('add-existing');
        setApplied(true);
        onPickPending(pending.propertyId, pending.account);
      }
      return;
    }
    setSelectedAcctId(v);
    setMode('select');
    setApplied(false);
    onAssign(v);
  };

  const handleSwitchToNew = () => {
    setSelectedAcctId('');
    setApplied(false);
    setMode('new');
  };

  const handleSwitchToAddExisting = () => {
    setSelectedAcctId('');
    setApplied(false);
    setMode('add-existing');
  };

  const handleSaveNew = () => {
    // Reuse an existing property if the address already matches  -  prevents duplicates
    const matchedProp = findExistingProperty(propForm.address, properties);
    if (matchedProp) {
      setResolvedPropertyName(matchedProp.nickname || matchedProp.address);
      onAddToProperty(matchedProp.id, acctForm);
    } else {
      setResolvedPropertyName(null);
      onAssignNew(propForm, acctForm);
    }
    setApplied(true);
  };

  const handleSaveAddExisting = () => {
    if (!match.propertyId) return;
    onAddToProperty(match.propertyId, acctForm);
    setApplied(true);
  };

  const handleCancelSubform = () => {
    setMode('select');
    setApplied(false);
    onAssign(selectedAcctId);
  };

  // Status label for the badge
  const resolvedPropName = resolvedPropertyName || match.propertyName;
  const statusLabel = applied
    ? (mode === 'add-existing' || resolvedPropertyName != null)
      ? `New ${acctForm.category.toLowerCase()} account → ${resolvedPropName}`
      : 'New property & account will be created'
    : CONFIDENCE_LABELS[match.confidence];

  return (
    <div className="card p-4 space-y-4" style={{ borderColor: error ? '#f87171' : undefined }}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-10 rounded bg-red-500/10 flex items-center justify-center flex-shrink-0">
            <svg width="18" height="22" viewBox="0 0 18 22" fill="none">
              <path d="M2 1h10l4 4v16H2V1z" fill="rgba(239,68,68,0.15)" stroke="#f87171" strokeWidth="1.2"/>
              <path d="M11 1v4h4" stroke="#f87171" strokeWidth="1.2"/>
              <path d="M5 10h8M5 14h5" stroke="#f87171" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-100 truncate">{bill.filename}</p>
            <p className="text-xs text-gray-500 truncate">
              {ex.providerName || 'Unknown provider'}
              {ex.serviceAddress ? ` · ${ex.serviceAddress}` : ''}
            </p>
            {/* AI extraction quietly falls back to reading the text layer when
                the API cannot open a PDF. That path produces no charge
                breakdown and infers the billing period, so the bill lands
                looking fine and is materially worse. Say so here. */}
            {bill.extractedBy === 'text' && (
              <p className="text-xs mt-1" style={{ color: '#F5A623' }}>
                Read as text, not by AI — no charge breakdown, and the billing
                period may be guessed from the issue month
                {bill.extractionNote ? ` (${bill.extractionNote})` : ''}
              </p>
            )}
          </div>
        </div>
        <button onClick={onRemove} className="text-gray-600 hover:text-gray-400 flex-shrink-0 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
          Parse error: {error}
        </div>
      )}

      {/* Extracted data grid */}
      {!error && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {[
            ['Date',         ex.statementDate   ? format(new Date(ex.statementDate + 'T12:00:00'),   'MMM d, yyyy') : ' - '],
            ['Due',          ex.dueDate         ? format(new Date(ex.dueDate         + 'T12:00:00'), 'MMM d, yyyy') : ' - '],
            ['Amount due',   fmt$(ex.amountDue)],
            ['Current chgs', fmt$(ex.currentCharges)],
            ['Prev balance', fmt$(ex.previousBalance)],
            ['Late fee',     fmt$(ex.lateFee)],
            ['Payments',     fmt$(ex.paymentsReceived)],
            ['Usage',        ex.usageValue != null ? `${ex.usageValue} ${ex.usageUnit || ''}` : ' - '],
            ['Rate plan',    ex.ratePlan || ' - '],
            ['Acct #',       ex.accountNumber  || ' - '],
            ['Type',         ex.utilityType    || ' - '],
          ].map(([label, value]) => (
            <div key={label} className="flex gap-1.5">
              <span className="text-gray-500 w-20 flex-shrink-0">{label}</span>
              <span className="text-gray-200 font-medium truncate">{value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Charge breakdown */}
      {ex.chargeBreakdown && Object.keys(ex.chargeBreakdown).length > 0 && (
        <details className="text-xs">
          <summary className="text-gray-500 cursor-pointer hover:text-gray-400 select-none">
            Charge breakdown ({Object.keys(ex.chargeBreakdown).length} line items)
          </summary>
          <div className="mt-2 space-y-1 pl-2">
            {Object.entries(ex.chargeBreakdown).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-gray-400">{k}</span>
                <span className="text-gray-300">{fmt$(v)}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Alerts */}
      {ex.alerts.length > 0 && (
        <div className="space-y-1">
          {ex.alerts.map((a, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs bg-amber-500/10 rounded px-2.5 py-1.5">
              <span className="text-amber-400 flex-shrink-0">⚠</span>
              <span className="text-amber-200">{a}</span>
            </div>
          ))}
        </div>
      )}

      {/* Match status + account selector */}
      <div className="space-y-2 pt-1 border-t" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        {/* Confidence / status badge */}
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: applied ? '#34d399' : confColor }} />
          <span className="text-xs" style={{ color: applied ? '#34d399' : confColor }}>
            {statusLabel}
          </span>
        </div>

        {/* Compact confirmed summary */}
        {applied && (
          <div className="space-y-2">
            <div className="rounded-lg px-3 py-2.5 space-y-0.5" style={{ background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.2)' }}>
              {(mode === 'add-existing' || resolvedPropertyName != null) ? (
                <p className="text-xs text-emerald-300 font-medium">{resolvedPropName}</p>
              ) : (
                <p className="text-xs text-emerald-300 font-medium">
                  {propForm.address}, {propForm.city}, {propForm.state} {propForm.zip}
                </p>
              )}
              <p className="text-xs text-gray-400">
                {acctForm.providerName} · {acctForm.category.toLowerCase()}
                {acctForm.accountNumber ? ` · #${acctForm.accountNumber.slice(-4)}` : ''}
              </p>
              <button onClick={() => setApplied(false)} className="text-xs text-gray-500 hover:text-gray-400 transition-colors mt-0.5">
                Edit
              </button>
            </div>

            {/* Apply to other same-provider bills */}
            {sameProviderBills.length > 0 && (
              <div className="rounded-lg overflow-hidden" style={{ border: '1px solid rgba(245,166,35,0.2)' }}>
                {/* Header row */}
                <div className="flex items-center justify-between px-3 py-2" style={{ background: 'rgba(245,166,35,0.08)' }}>
                  <span className="text-xs font-medium" style={{ color: '#F5A623' }}>
                    Apply to {sameProviderBills.length} other {ex.providerName || ''} statement{sameProviderBills.length > 1 ? 's' : ''}
                  </span>
                  <button
                    onClick={() => {
                      setShowApplyPanel(v => !v);
                      setSelectedForApply(new Set(sameProviderBills.map(b => b.filename)));
                    }}
                    className="text-xs px-2 py-0.5 rounded transition-colors"
                    style={{ color: '#F5A623', background: 'rgba(245,166,35,0.12)' }}
                  >
                    {showApplyPanel ? 'Cancel' : 'Select'}
                  </button>
                </div>

                {!showApplyPanel ? (
                  // Compact: single "Apply to all" button
                  <button
                    onClick={() => onApplyTo('all')}
                    className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-white/5"
                    style={{ color: '#F5A623' }}
                  >
                    Apply to all {sameProviderBills.length} →
                  </button>
                ) : (
                  // Expanded: checklist + actions
                  <div style={{ background: 'rgba(0,0,0,0.2)' }}>
                    <div className="px-3 py-2 space-y-1.5 max-h-48 overflow-y-auto">
                      {sameProviderBills.map(b => (
                        <label key={b.filename} className="flex items-center gap-2 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={selectedForApply.has(b.filename)}
                            onChange={e => {
                              const next = new Set(selectedForApply);
                              if (e.target.checked) next.add(b.filename); else next.delete(b.filename);
                              setSelectedForApply(next);
                            }}
                            className="accent-amber-500 w-3.5 h-3.5 flex-shrink-0"
                          />
                          <span className="text-xs text-gray-300 truncate group-hover:text-white">{b.filename}</span>
                          {b.extracted.statementDate && (
                            <span className="text-xs text-gray-600 flex-shrink-0 ml-auto">
                              {format(new Date(b.extracted.statementDate + 'T12:00:00'), 'MMM yyyy')}
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                    <div className="flex gap-2 px-3 py-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                      <button
                        onClick={() => setSelectedForApply(new Set(sameProviderBills.map(b => b.filename)))}
                        className="text-xs text-gray-500 hover:text-gray-300"
                      >
                        All
                      </button>
                      <button
                        onClick={() => setSelectedForApply(new Set())}
                        className="text-xs text-gray-500 hover:text-gray-300"
                      >
                        None
                      </button>
                      <button
                        disabled={selectedForApply.size === 0}
                        onClick={() => { onApplyTo([...selectedForApply]); setShowApplyPanel(false); }}
                        className="ml-auto text-xs px-3 py-1 rounded-lg font-medium text-black bg-amber-500 disabled:opacity-40"
                      >
                        Apply to {selectedForApply.size} selected
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Form / dropdown (hidden when confirmed) */}
        {!applied && (
          <>
            {mode === 'select' && (
              <>
                <select
                  value={selectedAcctId}
                  onChange={e => handleAcctSelect(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                  style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' }}
                >
                  <option value=""> -  Select utility account  - </option>
                  {properties.map(prop => (
                    <optgroup key={prop.id} label={prop.nickname || prop.address}>
                      {prop.utilityAccounts.map(acct => (
                        <option key={acct.id} value={acct.id}>
                          {describeAccount(acct)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  {/* Accounts set up on another card in this batch do not exist
                      in the database yet, so they are absent from `properties`.
                      Offering them here is what lets the rest of a provider's
                      bills join an account just created for the first one. */}
                  {pendingAccounts.length > 0 && (
                    <optgroup label="Being created in this batch">
                      {pendingAccounts.map(p => (
                        <option key={p.key} value={PENDING_PREFIX + p.key}>
                          {p.account.providerName} ({p.account.category.toLowerCase()}) → {p.propertyLabel}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {/* If the backend found a matching property with no account, surface it prominently */}
                {match.method === 'property_exists_no_account' && match.propertyId && (
                  <button
                    onClick={handleSwitchToAddExisting}
                    className="w-full rounded-lg px-3 py-2 text-xs transition-colors flex items-center justify-center gap-1.5"
                    style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', color: '#a5b4fc' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" strokeWidth="2"/>
                    </svg>
                    Add new account to "{match.propertyName}"
                  </button>
                )}
                <button
                  onClick={handleSwitchToNew}
                  className="w-full rounded-lg px-3 py-2 text-xs transition-colors flex items-center justify-center gap-1.5"
                  style={{ background: 'rgba(245,166,35,0.06)', border: '1px dashed rgba(245,166,35,0.35)', color: '#F5A623' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  Create new property &amp; account
                </button>
              </>
            )}

            {mode === 'add-existing' && match.propertyId && (
              <AddAccountForm
                propertyName={match.propertyName || match.propertyId}
                acctForm={acctForm}
                onChangeAcct={f => setAcctForm(f)}
                onSave={handleSaveAddExisting}
                onCancel={handleCancelSubform}
              />
            )}

            {mode === 'new' && (
              <NewPropertyForm
                propForm={propForm}
                acctForm={acctForm}
                onChangeProp={f => setPropForm(f)}
                onChangeAcct={f => setAcctForm(f)}
                onSave={handleSaveNew}
                onCancel={handleCancelSubform}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Stage = 'drop' | 'analyzing' | 'review' | 'importing' | 'done';

function isBillReady(bill: ParsedBill): boolean {
  if (bill.match.utilityAccountId) return true;
  // Add account to existing property
  if (bill.addToPropertyId && bill.newAccount?.providerName) return true;
  // Create new property + account
  if (bill.newProperty && bill.newAccount) {
    const p = bill.newProperty;
    const a = bill.newAccount;
    return !!(p.address && p.city && p.state && p.zip && a.providerName);
  }
  return false;
}

async function refreshAccounts(): Promise<PropertyWithAccounts[]> {
  const res = await api.get('/import/accounts');
  return (res.data as { properties: PropertyWithAccounts[] }).properties;
}

/**
 * How an account reads in the picker.
 *
 * A property can hold two accounts with the same provider and category — two
 * IID meters, two City of El Centro accounts — and "IID (electric)" twice
 * gives no way to choose. The nickname says which meter it is; the masked
 * number is the fallback when there is no nickname yet.
 */
function describeAccount(acct: {
  providerName: string; category: string;
  serviceLabel?: string | null; accountNumber?: string | null;
}): string {
  const base = `${acct.providerName} (${acct.category.toLowerCase()})`;
  if (acct.serviceLabel) return `${base} — ${acct.serviceLabel}`;
  if (acct.accountNumber) return `${base} — ${acct.accountNumber}`;
  return base;
}

export default function ImportPage() {
  const [stage, setStage]                   = useState<Stage>('drop');
  const [bills, setBills]                   = useState<ParsedBill[]>([]);
  const [properties, setProperties]         = useState<PropertyWithAccounts[]>([]);
  const [result, setResult]                 = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [driveNote, setDriveNote]           = useState<string | null>(null);
  const [progress, setProgress]             = useState('');
  const [refreshing, setRefreshing]         = useState(false);
  const [driveProgress, setDriveProgress]   = useState<{ done: number; total: number } | null>(null);
  const [extractionMethod, setExtractionMethod] = useState<'ai' | 'regex'>('regex');

  const handleRefreshAccounts = async () => {
    setRefreshing(true);
    try {
      const fresh = await refreshAccounts();
      setProperties(fresh);
    } catch { /* silent */ } finally {
      setRefreshing(false);
    }
  };

  const handleFiles = async (files: File[]) => {
    setStage('analyzing');
    setProgress(`Reading ${files.length} file${files.length !== 1 ? 's' : ''}...`);
    setBills([]);

    try {
      const filePayloads = await Promise.all(
        files.map(async f => ({ name: f.name, data: await readFileAsBase64(f) }))
      );

      // Build a lookup so we can attach fileData as each result streams in
      const dataByName = Object.fromEntries(filePayloads.map(f => [f.name, f.data]));

      setProgress(`Analyzing 0 / ${files.length} ${extractionMethod === 'regex' ? '(free text parsing)' : 'with AI'}...`);

      // Get Clerk token the same way the axios interceptor does
      // @ts-ignore
      const token = await window.Clerk?.session?.getToken();
      const base  = import.meta.env.VITE_API_URL || '/api';

      const response = await fetch(`${base}/import/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ files: filePayloads, method: extractionMethod }),
      });

      if (!response.ok || !response.body) throw new Error('Stream failed');

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let buf     = '';
      let done    = false;
      let counted = 0;

      // Switch to review immediately so cards appear as they stream in
      setStage('review');

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;
        buf += decoder.decode(value ?? new Uint8Array(), { stream: !streamDone });

        // SSE lines are separated by \n\n; split and process complete events
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';   // keep the incomplete tail

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));

          if (event.type === 'bill') {
            counted++;
            setProgress(`Analyzed ${counted} / ${files.length} files...`);
            setBills(prev => [...prev, {
              ...event,
              fileData: dataByName[event.filename] ?? '',
            }]);
          } else if (event.type === 'done') {
            setProperties(event.properties);
            setProgress('');
          } else if (event.type === 'error') {
            console.error('[Import] stream error:', event.message);
          }
        }
      }
    } catch (err) {
      console.error(err);
      setProgress('Error analyzing files. Please try again.');
      setTimeout(() => { setStage('drop'); setBills([]); }, 3000);
    }
  };

  const handleAssign = (filename: string, utilityAccountId: string) => {
    setBills(prev => prev.map(b =>
      b.filename === filename
        ? { ...b, match: { ...b.match, utilityAccountId: utilityAccountId || null }, newProperty: undefined, newAccount: undefined }
        : b
    ));
  };

  const handleAddToProperty = (filename: string, propertyId: string, acct: NewAccountPayload) => {
    setBills(prev => prev.map(b =>
      b.filename === filename
        ? { ...b, match: { ...b.match, utilityAccountId: null }, addToPropertyId: propertyId, newAccount: acct, newProperty: undefined }
        : b
    ));
  };

  const handleAssignNew = (filename: string, prop: NewPropertyPayload, acct: NewAccountPayload) => {
    setBills(prev => prev.map(b =>
      b.filename === filename
        ? { ...b, match: { ...b.match, utilityAccountId: null }, newProperty: prop, newAccount: acct, addToPropertyId: undefined }
        : b
    ));
  };

  const handleRemove = (filename: string) => {
    setBills(prev => prev.filter(b => b.filename !== filename));
  };

  // A bill is "user-confirmed" if the user explicitly assigned it.
  // High-confidence auto-matches are already handled, not targets for apply-to.
  function isUserConfirmed(b: ParsedBill): boolean {
    if (b.newAccount || b.newProperty || b.addToPropertyId) return true;
    if (b.match.confidence === 'high' && b.match.utilityAccountId) return true;
    return false;
  }

  function applyAssignment(source: ParsedBill, target: ParsedBill): ParsedBill {
    if (source.match.utilityAccountId) {
      return { ...target, match: { ...target.match, utilityAccountId: source.match.utilityAccountId }, newProperty: undefined, newAccount: undefined, addToPropertyId: undefined };
    }
    if (source.addToPropertyId && source.newAccount) {
      return { ...target, match: { ...target.match, utilityAccountId: null }, addToPropertyId: source.addToPropertyId, newAccount: source.newAccount, newProperty: undefined };
    }
    if (source.newProperty && source.newAccount) {
      return { ...target, match: { ...target.match, utilityAccountId: null }, newProperty: source.newProperty, newAccount: source.newAccount, addToPropertyId: undefined };
    }
    return target;
  }

  const handleApplyTo = (sourceBill: ParsedBill, targetFilenames: string[] | 'all') => {
    setBills(prev => prev.map(b => {
      if (b.filename === sourceBill.filename) return b;
      if (targetFilenames !== 'all' && !targetFilenames.includes(b.filename)) return b;
      return applyAssignment(sourceBill, b);
    }));
  };

  // Every distinct account the batch is about to create, so a card can join one
  // instead of defining its own. Keyed the same way the backend dedupes on
  // confirm, so picking one really does land on a single account.
  const getPendingAccounts = (exclude: string) =>
    Object.values(
      bills.reduce((acc, b) => {
        if (b.filename === exclude || !b.newAccount || !b.addToPropertyId) return acc;
        const key = `${b.addToPropertyId}:${b.newAccount.providerName.toLowerCase().trim()}`;
        if (!acc[key]) {
          const prop = properties.find(p => p.id === b.addToPropertyId);
          acc[key] = {
            key,
            propertyId: b.addToPropertyId,
            propertyLabel: prop ? (prop.nickname || prop.address) : 'property',
            account: b.newAccount,
          };
        }
        return acc;
      }, {} as Record<string, { key: string; propertyId: string; propertyLabel: string; account: NewAccountPayload }>)
    );

  const getSameProviderBills = (bill: ParsedBill): ParsedBill[] => {
    const provider = bill.extracted.providerName?.toLowerCase().trim();
    // Source must be confirmed by user first
    if (!provider || !isUserConfirmed(bill)) return [];
    return bills.filter(b =>
      b.filename !== bill.filename &&
      b.extracted.providerName?.toLowerCase().trim() === provider &&
      !isUserConfirmed(b)   // not yet explicitly assigned
    );
  };

  const handleDriveResolved = (driveBills: ParsedBill[], props: PropertyWithAccounts[], autoImported: number) => {
    if (driveBills.length === 0) {
      // Called when there are no bills to review (all auto-filed) OR at end of stream
      if (stage !== 'review') {
        setResult({ imported: autoImported, skipped: 0, errors: [] });
        setStage('done');
      }
      return;
    }
    // Fallback non-streaming path
    setBills(prev => [...prev, ...driveBills]);
    setProperties(props);
    setDriveNote(
      autoImported > 0
        ? `${autoImported} statement${autoImported !== 1 ? 's' : ''} already auto-filed from Drive  -  these ${driveBills.length} need a quick check.`
        : `${driveBills.length} statement${driveBills.length !== 1 ? 's' : ''} from Drive need a quick check before they can be filed.`
    );
    setStage('review');
  };

  const handleDriveStreamStart = (props: PropertyWithAccounts[], autoImported: number) => {
    if (props && (props as any).length > 0) setProperties(props);
    setDriveNote(
      autoImported > 0
        ? `${autoImported} statement${autoImported !== 1 ? 's' : ''} already auto-filed from Drive  -  reviewing the rest.`
        : 'Reviewing statements from Drive...'
    );
    setStage('review');
  };

  const handleDriveBillStreamed = (bill: ParsedBill) => {
    setBills(prev => [...prev, bill]);
  };

  const handleDriveProgress = (done: number, total: number) => {
    if (total > 0 && done < total) {
      setDriveProgress({ done, total });
    } else {
      setDriveProgress(null);
    }
  };

  const handleImport = async () => {
    const ready = bills.filter(isBillReady);
    if (ready.length === 0) return;

    setStage('importing');

    // Anything not ready is about to be left behind. Saying so is the whole
    // point: an import that reports "9 imported" after being handed 12 files
    // looks like a success, and the three that vanished are only discovered
    // later by counting rows by hand. Name them here instead.
    const excluded = bills.filter(b => !isBillReady(b));

    const toItem = (b: ParsedBill) => ({
      filename:         b.filename,
      fileData:         b.fileData,
      extracted:        b.extracted,
      extractedBy:      b.extractedBy,
      match:            b.match,
      utilityAccountId: b.match.utilityAccountId || null,
      propertyId:       b.addToPropertyId || null,
      newProperty:      b.newProperty,
      newAccount:       b.newAccount,
    });

    // Submit in batches rather than one request. Every item carries its PDF as
    // base64 and the server uploads each to S3 before responding, so forty
    // bills meant a ~10MB payload and forty round-trips inside one request —
    // which times out, taking the whole batch with it and losing the manual
    // assignments behind it.
    //
    // Batching means a failure costs one batch, the rest are already saved,
    // and whatever did not land stays on screen to retry.
    const CONFIRM_BATCH = 5;
    const totals = { imported: 0, skipped: 0, errors: [] as string[] };
    const failed: ParsedBill[] = [];

    for (const b of excluded) {
      totals.errors.push(
        `${b.filename}: not filed — ${b.error ? `could not be read (${b.error})` : 'no utility account assigned'}`
      );
    }

    for (let i = 0; i < ready.length; i += CONFIRM_BATCH) {
      const batch = ready.slice(i, i + CONFIRM_BATCH);
      setProgress(`Filing ${Math.min(i + batch.length, ready.length)} / ${ready.length}...`);
      try {
        const res = await api.post('/import/confirm', { items: batch.map(toItem) });
        totals.imported += res.data?.imported ?? 0;
        totals.skipped  += res.data?.skipped ?? 0;
        if (Array.isArray(res.data?.errors)) totals.errors.push(...res.data.errors);
      } catch (err: any) {
        console.error('confirm batch failed', err);
        failed.push(...batch);
        const detail = err?.response?.data?.error ?? err?.message ?? 'request failed';
        totals.errors.push(`${batch.length} file(s) failed: ${detail}`);
      }
    }

    // Reconcile what was sent against what the server accounted for. Every
    // known drop path already reports itself, so a shortfall here means a file
    // went missing through a path nobody has named yet — which is exactly the
    // thing that must not pass silently.
    const accountedFor = totals.imported + totals.skipped + totals.errors.length - excluded.length;
    if (accountedFor < ready.length) {
      totals.errors.push(
        `${ready.length - accountedFor} file(s) were sent but not accounted for by the server. ` +
        'Nothing was reported against them — please re-run the import for those bills.'
      );
    }

    setProgress('');
    setResult(totals);

    if (failed.length > 0) {
      // Keep the ones that did not land, with their assignments intact, so the
      // work of assigning them is not thrown away.
      const failedNames = new Set(failed.map(f => f.filename));
      setBills(prev => prev.filter(b => failedNames.has(b.filename)));
      setDriveNote(
        `${totals.imported} filed. ${failed.length} could not be saved and are still listed below — press Confirm again to retry just those.`
      );
      setStage('review');
      return;
    }

    setStage('done');
  };

  const reset = () => {
    setStage('drop');
    setBills([]);
    setProperties([]);
    setResult(null);
    setProgress('');
    setDriveNote(null);
    setDriveProgress(null);
  };

  const readyCount      = bills.filter(isBillReady).length;
  const notReadyCount   = bills.length - readyCount;
  const highConf        = bills.filter(b => b.match.confidence === 'high').length;

  return (
    <div>
      <PageHeader
        title="Import bills"
        subtitle="Upload utility bill PDFs  -  Claude extracts and auto-matches them to your properties"
      />

      <div className="px-6 py-5 max-w-5xl">

        {/* Drop stage */}
        {stage === 'drop' && (
          <>
            {/* Extraction method toggle */}
            <div className="flex items-center justify-between mb-4 rounded-xl px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div>
                <p className="text-sm font-medium text-gray-200">
                  {extractionMethod === 'regex' ? 'Free extraction' : 'AI extraction'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {extractionMethod === 'regex'
                    ? 'Text parsing — no API cost, works for most standard utility bills'
                    : 'Claude reads the PDF directly — higher accuracy, uses Anthropic credits'}
                </p>
              </div>
              <button
                onClick={() => setExtractionMethod(m => m === 'regex' ? 'ai' : 'regex')}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-all"
                style={{
                  background: extractionMethod === 'ai' ? 'rgba(245,166,35,0.15)' : 'rgba(255,255,255,0.06)',
                  border: extractionMethod === 'ai' ? '1px solid rgba(245,166,35,0.4)' : '1px solid rgba(255,255,255,0.1)',
                  color: extractionMethod === 'ai' ? '#F5A623' : '#9ca3af',
                }}
              >
                <div className="w-7 h-4 rounded-full relative transition-colors flex-shrink-0"
                  style={{ background: extractionMethod === 'ai' ? '#F5A623' : 'rgba(255,255,255,0.15)' }}>
                  <div className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all"
                    style={{ left: extractionMethod === 'ai' ? '14px' : '2px' }} />
                </div>
                {extractionMethod === 'ai' ? 'AI (uses credits)' : 'Free mode'}
              </button>
            </div>
            <DriveImportPanel
              onResolved={handleDriveResolved}
              onStreamStart={handleDriveStreamStart}
              onBillStreamed={handleDriveBillStreamed}
              onProgress={handleDriveProgress}
              extractionMethod={extractionMethod}
            />
            <Dropzone onFiles={handleFiles} />
          </>
        )}

        {/* Analyzing */}
        {stage === 'analyzing' && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-10 h-10 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-gray-400">{progress}</p>
            <p className="text-xs text-gray-600">This takes 2–5 seconds per file</p>
          </div>
        )}

        {/* Review */}
        {stage === 'review' && (
          <div className="space-y-6">
            {driveNote && (
              <div className="text-xs text-blue-400 bg-blue-500/10 rounded-lg px-4 py-2.5">{driveNote}</div>
            )}
            {/* Drive streaming progress */}
            {driveProgress && (
              <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  <p className="text-sm font-medium text-gray-200">
                    Processing {driveProgress.done} / {driveProgress.total} files from Drive...
                  </p>
                </div>
                <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full bg-amber-500 transition-all" style={{ width: `${Math.round((driveProgress.done / driveProgress.total) * 100)}%` }} />
                </div>
              </div>
            )}
            {/* Direct upload live progress bar */}
            {progress && (
              <div className="flex items-center gap-3 rounded-lg px-4 py-2.5" style={{ background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.2)' }}>
                <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <span className="text-xs text-amber-400">{progress}</span>
              </div>
            )}

            {/* Summary bar */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4 text-sm">
                <span className="text-gray-400">{bills.length} bill{bills.length !== 1 ? 's' : ''} parsed</span>
                <span className="text-green-400">{highConf} auto-matched</span>
                {notReadyCount > 0 && (
                  <span className="text-amber-400">{notReadyCount} need assignment</span>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={reset} className="btn text-xs">Start over</button>
                <button
                  onClick={handleRefreshAccounts}
                  disabled={refreshing}
                  className="btn text-xs disabled:opacity-40"
                  title="Reload accounts  -  use this if you just created a new account"
                >
                  {refreshing ? 'Refreshing...' : '↺ Refresh accounts'}
                </button>
                <button
                  onClick={handleImport}
                  disabled={readyCount === 0}
                  className="btn btn-primary text-xs disabled:opacity-40"
                >
                  Import {readyCount} statement{readyCount !== 1 ? 's' : ''}
                </button>
              </div>
            </div>

            {notReadyCount > 0 && (
              <div className="text-xs text-amber-400 bg-amber-500/10 rounded-lg px-4 py-2.5">
                {notReadyCount} bill{notReadyCount !== 1 ? 's' : ''} still need{notReadyCount === 1 ? 's' : ''} a utility account selected or a new property created before they can be imported.
              </div>
            )}

            {/* Bill cards */}
            <div className="grid grid-cols-2 gap-4">
              {bills.map(bill => (
                <BillCard
                  key={bill.filename}
                  bill={bill}
                  properties={properties}
                  onAssign={acctId => handleAssign(bill.filename, acctId)}
                  onAddToProperty={(propId, acct) => handleAddToProperty(bill.filename, propId, acct)}
                  onAssignNew={(prop, acct) => handleAssignNew(bill.filename, prop, acct)}
                  onRemove={() => handleRemove(bill.filename)}
                  sameProviderBills={getSameProviderBills(bill)}
                  onApplyTo={targets => handleApplyTo(bill, targets)}
                  pendingAccounts={getPendingAccounts(bill.filename)}
                  onPickPending={(propId, acct) => handleAddToProperty(bill.filename, propId, acct)}
                />
              ))}
            </div>

            {/* Bottom action bar (repeated for long lists) */}
            {bills.length > 4 && (
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={reset} className="btn text-xs">Start over</button>
                <button
                  onClick={handleImport}
                  disabled={readyCount === 0}
                  className="btn btn-primary text-xs disabled:opacity-40"
                >
                  Import {readyCount} statement{readyCount !== 1 ? 's' : ''}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Importing */}
        {stage === 'importing' && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-10 h-10 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-gray-400">Saving statements and uploading PDFs...</p>
          </div>
        )}

        {/* Done */}
        {stage === 'done' && result && (
          <div className="flex flex-col items-center justify-center py-24 gap-5">
            <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: 'rgba(52,211,153,0.15)' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-gray-100">
                {result.imported} statement{result.imported !== 1 ? 's' : ''} imported
              </p>
              {result.skipped > 0 && (
                <p className="text-sm text-gray-500 mt-1">{result.skipped} already existed (updated if needed)</p>
              )}
              {result.errors.length > 0 && (
                <div className="mt-3 text-left space-y-1">
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-xs text-red-400">{e}</p>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-3">
              <button onClick={reset} className="btn text-sm">Import more</button>
              <a href="/documents" className="btn btn-primary text-sm">View vault</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
