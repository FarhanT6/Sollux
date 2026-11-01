import { useState } from 'react';
import { getDriveConnectUrl } from '../api/client';
import { openOAuth } from '../lib/native';
import { pickFromDrive, DriveNotConnected } from '../lib/drivePicker';

/**
 * "From Google Drive": opens Drive's picker and hands the chosen file(s) to
 * `onFiles`, the same as a file from the computer. With no Drive connected
 * it offers to connect one first.
 */
export default function DriveButton({ onFiles, multiple, disabled, className, label = 'From Google Drive' }: {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true);
    try {
      const files = await pickFromDrive({ multiple });
      if (files.length) onFiles(files);
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
    <button type="button" onClick={() => void open()} disabled={disabled || busy}
      className={className ?? 'text-xs text-amber-400 hover:text-amber-300 disabled:opacity-50'}>
      {busy ? 'Opening Drive…' : label}
    </button>
  );
}
