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
  fileData:     string;       // base64, retained for S3 upload on confirm
  newProperty?: NewPropertyPayload;
  newAccount?:  NewAccountPayload;
  // When adding to an existing property (no new property creation needed)
  addToPropertyId?: string | null;
}

interface SlimAccount { id: string; providerName: string; category: string; }
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
  medium: 'Likely match — verify',
  low:    'Possible match — verify',
  none:   'No match found',
};

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
  return n != null ? `$${Number(n).toFixed(2)}` : '—';
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

// Lazily loads Google's API + Picker client libraries (not an npm package —
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

function DriveImportPanel({ onResolved }: {
  onResolved: (bills: ParsedBill[], properties: PropertyWithAccounts[], autoImported: number) => void;
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

      // Show folders AND PDFs, with multi-select so the user can pick a whole
      // folder, a specific handful of files, or any mix of the two.
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
            const files = docs.filter(d => d.mimeType !== 'application/vnd.google-apps.folder');
            const displayName =
              folders.length > 0 ? folders[0].name :
              files.length === 1 ? files[0].name :
              `${files.length} files`;
            setFolderName(displayName);
            const { jobId } = await startDriveImport(tokenId, {
              folderId: folders[0]?.id,
              fileIds: files.map(f => f.id),
              folderName: displayName,
            });
            localStorage.setItem('sollux_last_drive_job', jobId);
            setJob({ id: jobId, status: 'RUNNING', totalFiles: 0, processedFiles: 0, autoImported: 0, needsReview: [] });
          }
        })
        .build();

      picker.setVisible(true);
    } finally {
      setOpening(false);
    }
  };

  // Poll job progress until it finishes.
  useEffect(() => {
    if (!job || job.status !== 'RUNNING') return;
    const interval = setInterval(async () => {
      const data = await getDriveImportJob(job.id) as DriveJobStatus;
      setJob(data);
      if (data.status !== 'RUNNING') clearInterval(interval);
    }, 1500);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  const finishReview = async () => {
    if (!job) return;
    setResolving(true);
    setDriveError(null);
    try {
      const res = await api.get(`/drive/jobs/${job.id}/review-data`);
      const { items, autoImported } = res.data;
      const properties = await getProperties() as unknown as PropertyWithAccounts[];
      localStorage.removeItem('sollux_last_drive_job');
      onResolved(items, properties, autoImported ?? job.autoImported);
    } catch (err) {
      setDriveError(`Failed to load review data: ${(err as Error).message}`);
    } finally {
      setResolving(false);
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

  if (job) {
    const done = job.status !== 'RUNNING';
    return (
      <div className="rounded-xl p-5 mb-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-sm font-medium text-gray-200 mb-2">
          {done ? 'Drive import finished' : `Importing “${folderName}”…`}
        </p>
        {!done ? (
          <>
            <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden mb-2">
              <div
                className="h-full bg-amber-500 transition-all"
                style={{ width: job.totalFiles ? `${(job.processedFiles / job.totalFiles) * 100}%` : '4%' }}
              />
            </div>
            <p className="text-xs text-gray-500">{job.processedFiles} / {job.totalFiles || '…'} files processed</p>
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-green-400">{job.autoImported} statement{job.autoImported !== 1 ? 's' : ''} auto-filed</p>
            {job.needsReview.length > 0 ? (
              <>
                <p className="text-xs text-amber-400">{job.needsReview.length} need{job.needsReview.length === 1 ? 's' : ''} your review — couldn't confidently match a property/utility</p>
                <button onClick={finishReview} disabled={resolving} className="btn btn-primary text-xs disabled:opacity-40">
                  {resolving ? 'Loading…' : `Review ${job.needsReview.length} statement${job.needsReview.length !== 1 ? 's' : ''}`}
                </button>
                {driveError && <p className="text-xs text-red-400 mt-1">{driveError}</p>}
              </>
            ) : (
              <button onClick={() => setJob(null)} className="btn text-xs">Import another folder</button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl p-5 mb-5 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div>
        <p className="text-sm font-medium text-gray-200">Import from Google Drive</p>
        <p className="text-xs text-gray-500 mt-0.5">Pick a folder from My Drive or Shared with me — every PDF inside (including subfolders) gets pulled in.</p>
      </div>
      <button onClick={openPicker} disabled={opening} className="btn btn-primary text-xs disabled:opacity-40">
        {opening ? 'Opening…' : 'Choose folder'}
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
        <div className="grid grid-cols-3 gap-2">
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
}: {
  bill:            ParsedBill;
  properties:      PropertyWithAccounts[];
  onAssign:        (utilityAccountId: string) => void;
  onAddToProperty: (propertyId: string, acct: NewAccountPayload) => void;
  onAssignNew:     (prop: NewPropertyPayload, acct: NewAccountPayload) => void;
  onRemove:        () => void;
}) {
  const { extracted: ex, match, error } = bill;
  const confColor = CONFIDENCE_COLORS[match.confidence];

  // Default to 'add-existing' when the backend found the property but no account
  const defaultMode: CardMode = match.method === 'property_exists_no_account' ? 'add-existing' : 'select';

  const [selectedAcctId, setSelectedAcctId] = useState(match.utilityAccountId || '');
  const [mode, setMode]       = useState<CardMode>(defaultMode);
  const [applied, setApplied] = useState(false);

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
    onAssignNew(propForm, acctForm);
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
  const statusLabel = applied
    ? (mode === 'add-existing' ? `New ${acctForm.category.toLowerCase()} account → ${match.propertyName}` : 'New property & account will be created')
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
            ['Date',         ex.statementDate   ? format(new Date(ex.statementDate + 'T12:00:00'),   'MMM d, yyyy') : '—'],
            ['Due',          ex.dueDate         ? format(new Date(ex.dueDate         + 'T12:00:00'), 'MMM d, yyyy') : '—'],
            ['Amount due',   fmt$(ex.amountDue)],
            ['Current chgs', fmt$(ex.currentCharges)],
            ['Prev balance', fmt$(ex.previousBalance)],
            ['Payments',     fmt$(ex.paymentsReceived)],
            ['Usage',        ex.usageValue != null ? `${ex.usageValue} ${ex.usageUnit || ''}` : '—'],
            ['Rate plan',    ex.ratePlan || '—'],
            ['Acct #',       ex.accountNumber  || '—'],
            ['Type',         ex.utilityType    || '—'],
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
          <div className="rounded-lg px-3 py-2.5 space-y-0.5" style={{ background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.2)' }}>
            {mode === 'add-existing' ? (
              <p className="text-xs text-emerald-300 font-medium">{match.propertyName}</p>
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
                  <option value="">— Select utility account —</option>
                  {properties.map(prop => (
                    <optgroup key={prop.id} label={prop.nickname || prop.address}>
                      {prop.utilityAccounts.map(acct => (
                        <option key={acct.id} value={acct.id}>
                          {acct.providerName} ({acct.category.toLowerCase()})
                        </option>
                      ))}
                    </optgroup>
                  ))}
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

export default function ImportPage() {
  const [stage, setStage]           = useState<Stage>('drop');
  const [bills, setBills]           = useState<ParsedBill[]>([]);
  const [properties, setProperties] = useState<PropertyWithAccounts[]>([]);
  const [result, setResult]         = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [driveNote, setDriveNote]   = useState<string | null>(null);
  const [progress, setProgress]     = useState('');
  const [refreshing, setRefreshing] = useState(false);

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
    setProgress(`Reading ${files.length} file${files.length !== 1 ? 's' : ''}…`);

    try {
      const filePayloads = await Promise.all(
        files.map(async f => ({
          name: f.name,
          data: await readFileAsBase64(f),
        }))
      );

      setProgress(`Extracting data from ${files.length} PDF${files.length !== 1 ? 's' : ''} with AI…`);

      const res = await api.post('/import/analyze', { files: filePayloads });
      const { bills: parsed, properties: props } = res.data as {
        bills: Omit<ParsedBill, 'fileData' | 'newProperty' | 'newAccount'>[];
        properties: PropertyWithAccounts[];
      };

      const withData: ParsedBill[] = parsed.map((b, i) => ({
        ...b,
        fileData: filePayloads[i]?.data || '',
      }));

      setBills(withData);
      setProperties(props);
      setStage('review');
    } catch (err) {
      console.error(err);
      setProgress('Error analyzing files. Please try again.');
      setTimeout(() => setStage('drop'), 3000);
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

  const handleDriveResolved = (driveBills: ParsedBill[], props: PropertyWithAccounts[], autoImported: number) => {
    if (driveBills.length === 0) {
      setResult({ imported: autoImported, skipped: 0, errors: [] });
      setStage('done');
      return;
    }
    setBills(prev => [...prev, ...driveBills]);
    setProperties(props);
    setDriveNote(
      autoImported > 0
        ? `${autoImported} statement${autoImported !== 1 ? 's' : ''} already auto-filed from Drive — these ${driveBills.length} need a quick check.`
        : `${driveBills.length} statement${driveBills.length !== 1 ? 's' : ''} from Drive need a quick check before they can be filed.`
    );
    setStage('review');
  };

  const handleImport = async () => {
    const ready = bills.filter(isBillReady);
    if (ready.length === 0) return;

    setStage('importing');

    try {
      const items = ready.map(b => ({
        filename:         b.filename,
        fileData:         b.fileData,
        extracted:        b.extracted,
        match:            b.match,
        utilityAccountId: b.match.utilityAccountId || null,
        propertyId:       b.addToPropertyId || null,
        newProperty:      b.newProperty,
        newAccount:       b.newAccount,
      }));

      const res = await api.post('/import/confirm', { items });
      setResult(res.data);
      setStage('done');
    } catch (err) {
      console.error(err);
      setStage('review');
    }
  };

  const reset = () => {
    setStage('drop');
    setBills([]);
    setProperties([]);
    setResult(null);
    setProgress('');
    setDriveNote(null);
  };

  const readyCount      = bills.filter(isBillReady).length;
  const notReadyCount   = bills.length - readyCount;
  const highConf        = bills.filter(b => b.match.confidence === 'high').length;

  return (
    <div>
      <PageHeader
        title="Import bills"
        subtitle="Upload utility bill PDFs — Claude extracts and auto-matches them to your properties"
      />

      <div className="px-6 py-5 max-w-5xl">

        {/* Drop stage */}
        {stage === 'drop' && (
          <>
            <DriveImportPanel onResolved={handleDriveResolved} />
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
                  title="Reload accounts — use this if you just created a new account"
                >
                  {refreshing ? 'Refreshing…' : '↺ Refresh accounts'}
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
            <p className="text-sm text-gray-400">Saving statements and uploading PDFs…</p>
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
