/**
 * Stored files whose upload was sent as a whole data URL (lib/dataUrl.ts):
 * restored in place, so the PDF opens again. Checked when a lease document
 * is opened, and once for every lease document when the API starts.
 */
import { db } from '../config/db';
import { downloadDocument, uploadDocument } from './s3Service';
import { repairDataUrlFile } from '../lib/dataUrl';

/** Restore one stored file if it carries a decoded data-URL label; true when it was repaired. */
export async function repairStoredFile(key: string): Promise<boolean> {
  try {
    const buf = await downloadDocument(key);
    const fixed = repairDataUrlFile(buf);
    if (!fixed) return false;
    await uploadDocument(key, fixed);
    console.log(`[RepairUploads] restored ${key.split('/').pop()} (${buf.length} → ${fixed.length} bytes)`);
    return true;
  } catch (err) {
    console.warn(`[RepairUploads] ${key.split('/').pop()}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

const DONE = 'repair:data-url-uploads-v1';

/** Once: every lease document and lease agreement on file. */
export async function repairLeaseUploadsOnce(): Promise<void> {
  if (await db.appSetting.findUnique({ where: { key: DONE } })) return;
  const docs = await db.document.findMany({ where: { linkedType: 'Lease' }, select: { s3Key: true } });
  const leases = await db.lease.findMany({ where: { documentUrl: { not: null } }, select: { documentUrl: true } });
  const keys = [...new Set([...docs.map(d => d.s3Key).filter(Boolean), ...leases.map(l => l.documentUrl!).filter(k => !/^https?:/.test(k))])];
  let fixed = 0;
  for (const k of keys) if (await repairStoredFile(k)) fixed++;
  await db.appSetting.upsert({ where: { key: DONE }, create: { key: DONE, value: JSON.stringify({ at: new Date().toISOString(), checked: keys.length, fixed }) }, update: {} });
  console.log(`[RepairUploads] checked ${keys.length} lease files, restored ${fixed}`);
}
