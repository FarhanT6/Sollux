/**
 * Repair requests, shared by the tenant portal (routes/portal.ts) and the
 * owner's side (routes/maintenance.ts): creating one with its photos, the
 * owner's alert, and the view each side gets.
 */
import { randomBytes } from 'node:crypto';
import { db } from '../config/db';
import { uploadDocument, getSignedDocumentUrl, detectContentType } from './s3Service';
import { emailConfigured, smsConfigured, sendAlertEmail, sendAlertSMS } from './notificationService';

export const URGENCY = ['EMERGENCY', 'URGENT', 'ROUTINE'] as const;
export const STATUSES = ['OPEN', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export const CATEGORIES = ['PLUMBING', 'ELECTRICAL', 'HVAC', 'APPLIANCE', 'PEST', 'LOCKS_DOORS', 'ROOF_LEAK', 'OTHER'] as const;

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export interface PhotoUpload { name?: string; data: string } // base64

/** Store the photos (images only) and return their keys; a photo that fails is reported, not fatal. */
export async function savePhotos(ownerUserId: string, requestId: string, photos: PhotoUpload[] = []): Promise<{ keys: string[]; failed: number }> {
  const keys: string[] = [];
  let failed = 0;
  for (const p of photos.slice(0, MAX_PHOTOS)) {
    try {
      const buf = Buffer.from(String(p.data).replace(/^data:[^,]+,/, ''), 'base64');
      const type = detectContentType(buf, p.name);
      if (!type.startsWith('image/') || buf.length > MAX_PHOTO_BYTES) { failed++; continue; }
      const ext = type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'img';
      keys.push(await uploadDocument(`maintenance/${ownerUserId}/${requestId}/${randomBytes(6).toString('hex')}.${ext}`, buf, type));
    } catch (err) {
      console.warn('[Maintenance] photo not saved:', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  return { keys, failed };
}

export async function photoUrls(keys: unknown): Promise<string[]> {
  const list = Array.isArray(keys) ? (keys as string[]) : [];
  return Promise.all(list.map(k => getSignedDocumentUrl(k).catch(() => ''))).then(u => u.filter(Boolean));
}

/** Tell the owner: an in-app alert always; email, and a text for an emergency, when set up. */
export async function alertOwner(requestId: string): Promise<void> {
  const r = await db.maintenanceRequest.findUnique({ where: { id: requestId } });
  if (!r) return;
  const [owner, property, tenant] = await Promise.all([
    db.user.findUnique({ where: { id: r.ownerUserId }, select: { email: true, phone: true } }),
    db.property.findUnique({ where: { id: r.propertyId }, select: { address: true, nickname: true } }),
    r.tenantId ? db.tenant.findUnique({ where: { id: r.tenantId }, select: { fullName: true } }) : null,
  ]);
  const place = property?.nickname || property?.address || 'a property';
  const who = tenant?.fullName ?? 'A tenant';
  const severity = r.urgency === 'EMERGENCY' ? 'ALERT' : r.urgency === 'URGENT' ? 'WARNING' : 'INFO';
  await db.aIInsight.create({
    data: {
      propertyId: r.propertyId, insightType: 'INFO', severity, dedupeKey: `repair:${r.id}`,
      title: `${r.urgency === 'EMERGENCY' ? 'Emergency repair' : 'Repair request'}: ${r.title}`,
      body: `${who} at ${place}: ${r.description.slice(0, 400)}`,
      recommendation: 'Open Repairs to schedule it and reply to the tenant.',
    },
  }).catch(() => {});
  if (owner?.email && emailConfigured()) {
    await sendAlertEmail({
      to: owner.email, subject: `${r.urgency === 'EMERGENCY' ? 'EMERGENCY — ' : ''}Repair request: ${r.title}`,
      headline: `${who} reported: ${r.title}`,
      lines: [place, `Urgency: ${r.urgency.toLowerCase()}`, r.description.slice(0, 500), r.permissionToEnter ? 'Permission to enter: yes' : 'Permission to enter: no — arrange a time', ...(r.availability ? [`Availability: ${r.availability}`] : [])],
      path: `/repairs/${r.id}`,
    }).catch(err => console.warn('[Maintenance] email failed:', err instanceof Error ? err.message : err));
  }
  if (r.urgency === 'EMERGENCY' && owner?.phone && smsConfigured()) {
    await sendAlertSMS({ to: owner.phone, body: `Sollux: EMERGENCY repair at ${place} — ${r.title}. ${who}. Open Repairs in Sollux.` }).catch(() => {});
  }
}

/** Tell the tenant their request moved (email, when set up). */
export async function alertTenant(requestId: string, what: string): Promise<void> {
  const r = await db.maintenanceRequest.findUnique({ where: { id: requestId }, select: { title: true, tenantId: true } });
  if (!r?.tenantId || !emailConfigured()) return;
  const t = await db.tenant.findUnique({ where: { id: r.tenantId }, select: { email: true } });
  if (!t?.email) return;
  await sendAlertEmail({ to: t.email, subject: `Repair update: ${r.title}`, headline: `Update on your repair request`, lines: [r.title, what], path: '/portal/repairs' }).catch(() => {});
}

export const STATUS_WORDS: Record<string, string> = {
  OPEN: 'Received', SCHEDULED: 'Scheduled', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};
