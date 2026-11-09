import { useEffect, useMemo, useState } from 'react';
import { getDriveConnectUrl } from '../api/client';
import { openOAuth } from '../lib/native';
import { pickFromDrive, DriveNotConnected } from '../lib/drivePicker';

/**
 * "From Google Drive": opens Drive's picker (thumbnails), then shows the
 * chosen file itself — the whole PDF or the image — before anything is
 * imported. Import this hands it to `onFiles`, the same as a file from the
 * computer; Choose another goes back to Drive. With no Drive connected it
 * offers to connect one first.
 */
export default function DriveButton({ onFiles, multiple, folders, disabled, className, label = 'From Google Drive' }: {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  /** A folder can be picked too: every PDF in it. */
  folders?: boolean;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<File[] | null>(null);

  async function open() {
    setBusy(true);
    try {
      const files = await pickFromDrive({ multiple, folders });
      if (files.length) setPicked(files);
    } catch (e) {
      if (e instanceof DriveNotConnected) {
        if (confirm('Connect your Google Drive to pick files from it? (Read-only access.)')) {
          const { url } = await getDriveConnectUrl();
          openOAuth(url, () => window.location.reload());
        }
      } else alert(e instanceof Error ? e.message : 'Could not open Google Drive.');
    } finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" onClick={() => void open()} disabled={disabled || busy}
        className={className ?? 'text-xs text-amber-400 hover:text-amber-300 disabled:opacity-50'}>
        {busy ? 'Opening Drive…' : label}
      </button>
      {picked && (
        <DrivePreview files={picked}
          onImport={() => { const f = picked; setPicked(null); onFiles(f); }}
          onAnother={() => { setPicked(null); void open(); }}
          onCancel={() => setPicked(null)} />
      )}
    </>
  );
}

/** The picked files themselves, before anything is imported. Also used by Add's Drive import. */
export function DrivePreview({ files, onImport, onAnother, onCancel }: { files: File[]; onImport: () => void; onAnother: () => void; onCancel: () => void }) {
  const [i, setI] = useState(0);
  const urls = useMemo(() => files.map(f => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach(u => URL.revokeObjectURL(u)), [urls]);
  const f = files[i];
  const isImage = f.type.startsWith('image/');
  const kb = Math.max(1, Math.round(f.size / 1024));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onCancel}>
      <div className="w-full max-w-4xl h-[88vh] flex flex-col rounded-xl overflow-hidden" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white truncate">{f.name}</p>
            <p className="text-xs text-gray-500">{isImage ? 'Image' : 'PDF'} · {kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`}{files.length > 1 ? ` · ${i + 1} of ${files.length}` : ''}</p>
          </div>
          {files.length > 1 && (
            <div className="flex gap-1">
              <button onClick={() => setI(x => Math.max(0, x - 1))} disabled={i === 0} className="btn text-xs disabled:opacity-40">‹</button>
              <button onClick={() => setI(x => Math.min(files.length - 1, x + 1))} disabled={i === files.length - 1} className="btn text-xs disabled:opacity-40">›</button>
            </div>
          )}
          <button onClick={onCancel} className="text-gray-500 hover:text-white" aria-label="Close">✕</button>
        </div>
        <div className="flex-1 min-h-0" style={{ background: '#111' }}>
          {isImage
            ? <div className="h-full overflow-auto flex items-start justify-center p-4"><img src={urls[i]} alt={f.name} className="max-w-full" /></div>
            : <iframe src={urls[i]} title={f.name} className="w-full h-full" style={{ border: 0 }} />}
        </div>
        <div className="flex items-center gap-2 px-4 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <button onClick={onAnother} className="text-xs text-gray-400 hover:text-white">Choose another</button>
          <span className="flex-1" />
          <button onClick={onCancel} className="btn text-sm">Cancel</button>
          <button onClick={onImport} className="btn-primary text-sm px-4 py-2">{files.length > 1 ? `Import these ${files.length}` : 'Import this'}</button>
        </div>
      </div>
    </div>
  );
}
