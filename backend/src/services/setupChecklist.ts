/**
 * The setup checklist (Settings → Setup, and a line on the Overview while anything is left),
 * read live from the account instead of a document kept by hand:
 * properties, the inboxes bills come to, bank links, provider logins, the connector on the
 * owner's computer, the background worker, alerts and loans' last 4. The server's own settings
 * (email and text sending, the bank webhook) show only to the person who runs Sollux.
 */
import { db } from '../config/db';
import { syncFailureKind } from '../lib/syncFailure';
import { workerStatus } from '../workers/heartbeat';
import { emailConfigured, smsConfigured } from './notificationService';
import { isPlatformAdmin } from '../lib/plans';

const DAY = 86_400_000;
const ONLINE_MS = 90_000;
const ago = (d: Date) => { const days = Math.floor((Date.now() - d.getTime()) / DAY); return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`; };

export type SetupState = 'done' | 'todo' | 'warn' | 'optional';
export interface SetupItem { key: string; title: string; state: SetupState; detail: string; to?: string; action?: string }

export async function setupChecklist(userId: string): Promise<{ done: number; total: number; items: SetupItem[] }> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, subscriptionTier: true, phone: true } });
  const [properties, inboxes, banks, accounts, devices, worker, loans] = await Promise.all([
    db.property.count({ where: { userId } }),
    db.gmailToken.findMany({ where: { userId }, select: { email: true, lastScanAt: true, lastScanError: true, backfillFrom: true } }),
    db.plaidItem.findMany({ where: { userId, isActive: true }, select: { institutionName: true, lastSyncedAt: true } }),
    db.utilityAccount.findMany({ where: { property: { userId }, isActive: true }, select: { usernameEnc: true, syncEnabled: true, lastSyncStatus: true, lastSyncError: true } }),
    db.connectorDevice.findMany({ where: { userId }, select: { name: true, lastSeenAt: true }, orderBy: { lastSeenAt: 'desc' } }),
    workerStatus().catch(() => null),
    db.loan.findMany({ where: { userId, isActive: true }, select: { accountLast4: true } }),
  ]);
  const items: SetupItem[] = [];

  items.push(properties
    ? { key: 'properties', title: 'Your properties', state: 'done', detail: `${properties} on file.`, to: '/portfolio' }
    : { key: 'properties', title: 'Add your properties', state: 'todo', detail: 'Everything in Sollux hangs off a property: its bills, tenants, loans and taxes.', to: '/portfolio', action: 'Add a property' });

  if (!inboxes.length) items.push({ key: 'email', title: 'Connect the inboxes your bills go to', state: 'todo', detail: 'Sollux reads them every night and files each bill on its account — the quickest way to get every provider in, scraper or not.', to: '/import', action: 'Connect Gmail' });
  else {
    const broken = inboxes.filter(t => t.lastScanError);
    const stale = inboxes.filter(t => !t.lastScanError && (!t.lastScanAt || Date.now() - t.lastScanAt.getTime() > 2 * DAY));
    const filling = inboxes.filter(t => t.backfillFrom);
    items.push(broken.length || stale.length
      ? { key: 'email', title: 'Bill inboxes', state: 'warn', detail: [...broken.map(t => `${t.email}: ${String(t.lastScanError).slice(0, 120)}`), ...stale.map(t => `${t.email} hasn't been read since ${t.lastScanAt ? ago(t.lastScanAt) : 'it was connected'}.`)].join(' · ') + ' Reconnect it on Import.', to: '/import', action: 'Open Import' }
      : { key: 'email', title: 'Bill inboxes', state: 'done', detail: `${inboxes.map(t => t.email).join(', ')} — read every night${filling.length ? `; still reading back through older mail (${filling.length})` : ''}.`, to: '/import' });
  }

  if (!banks.length) items.push({ key: 'bank', title: 'Link your bank accounts', state: 'todo', detail: 'Payments, deposits and money in flight are matched from the bank lines on their own.', to: '/settings?tab=banking', action: 'Link a bank' });
  else {
    const stale = banks.filter(b => !b.lastSyncedAt || Date.now() - b.lastSyncedAt.getTime() > 3 * DAY);
    items.push(stale.length
      ? { key: 'bank', title: 'Bank links', state: 'warn', detail: `${stale.map(b => `${b.institutionName} hasn't synced since ${b.lastSyncedAt ? ago(b.lastSyncedAt) : 'it was linked'}`).join(' · ')}. The bank may want you to sign in again: remove it and link it again in Settings → Banking.`, to: '/settings?tab=banking', action: 'Open Banking' }
      : { key: 'bank', title: 'Bank links', state: 'done', detail: `${banks.map(b => b.institutionName).join(', ')} — synced lately.`, to: '/settings?tab=banking' });
  }

  const fetching = accounts.filter(a => a.syncEnabled);
  const withLogin = fetching.filter(a => a.usernameEnc).length;
  const toFix = fetching.filter(a => a.lastSyncStatus === 'FAILED' && syncFailureKind(a.lastSyncError) === 'needs-owner').length;
  items.push(!fetching.length
    ? { key: 'logins', title: 'Provider logins', state: 'optional', detail: 'Save a website login on an account and Sollux fetches its statements after each billing day.', to: '/bills' }
    : toFix
      ? { key: 'logins', title: 'Provider logins', state: 'warn', detail: `${toFix} login${toFix === 1 ? '' : 's'} the website rejected or ${toFix === 1 ? 'is' : 'are'} missing — listed under Needs you on the Overview.`, to: '/dashboard', action: 'See which' }
      : { key: 'logins', title: 'Provider logins', state: 'done', detail: `${withLogin} of ${fetching.length} accounts have a website login saved; the rest come by email or upload.`, to: '/bills' });

  const online = devices.find(d => d.lastSeenAt && Date.now() - d.lastSeenAt.getTime() < ONLINE_MS);
  items.push(!devices.length
    ? { key: 'connector', title: 'Fetch from your computer', state: 'optional', detail: "Sites that turn Sollux's browser away (county tax sites, some utilities) work in your own Chrome: run the connector on a computer that stays on.", to: '/settings?tab=ai', action: 'Set it up' }
    : online
      ? { key: 'connector', title: 'Connector', state: 'done', detail: `${online.name} is online.`, to: '/settings?tab=ai' }
      : { key: 'connector', title: 'Connector', state: 'warn', detail: `${devices[0].name} is offline${devices[0].lastSeenAt ? ` (last heard ${ago(devices[0].lastSeenAt)})` : ''} — fetches and tax lookups run in Sollux's browser until it is back. Start it again on that computer.`, to: '/settings?tab=ai', action: 'Open AI usage' });

  if (worker) items.push(worker.state === 'ok' || worker.state === 'busy'
    ? { key: 'worker', title: 'Background worker', state: 'done', detail: 'Fetches, email reading and nightly checks are running.' }
    : { key: 'worker', title: 'Background worker', state: 'warn', detail: worker.message, to: '/settings?tab=ai' });

  items.push(user.phone
    ? { key: 'alerts', title: 'Shut-off and cancellation alerts', state: 'done', detail: 'Texted and emailed to you when a notice comes in.', to: '/settings?tab=notifications' }
    : { key: 'alerts', title: 'Add a mobile number for alerts', state: 'todo', detail: 'Shut-off and cancellation notices are texted to you as well as emailed.', to: '/settings?tab=account', action: 'Add your number' });

  const noLast4 = loans.filter(l => !l.accountLast4).length;
  if (loans.length) items.push(noLast4
    ? { key: 'loans', title: "Loans' last 4 digits", state: 'warn', detail: `${noLast4} loan${noLast4 === 1 ? ' has' : 's have'} no account number's last 4 — a servicer's payment email names the loan by them, so it can't be matched.`, to: '/finances?tab=loans', action: 'Open Loans' }
    : { key: 'loans', title: "Loans' last 4 digits", state: 'done', detail: 'Payment emails from servicers are matched to their loans.', to: '/finances?tab=loans' });

  // Server settings: only the person who runs Sollux can change them.
  if (isPlatformAdmin(user)) {
    const email = emailConfigured(), sms = smsConfigured();
    items.push(email && sms
      ? { key: 'server-alerts', title: 'Alert sending (server)', state: 'done', detail: 'Email and texts are set up on the server.' }
      : { key: 'server-alerts', title: 'Alert sending (server)', state: 'warn', detail: `${!email ? 'Email (SENDGRID_API_KEY, SENDGRID_FROM_EMAIL)' : ''}${!email && !sms ? ' and ' : ''}${!sms ? 'texts (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)' : ''} not set on Render — alerts can't go out.` });
    if (banks.length) items.push(process.env.PLAID_WEBHOOK_URL?.trim()
      ? { key: 'plaid-webhook', title: 'Bank lines at once (server)', state: 'done', detail: 'Banks tell Sollux about new lines as they post.' }
      : { key: 'plaid-webhook', title: 'Bank lines at once (server)', state: 'optional', detail: 'Set PLAID_WEBHOOK_URL on Render (the API\'s /api/plaid/webhook) and banks report new lines at once instead of at the next sync.' });
  }

  const counted = items.filter(i => i.state !== 'optional');
  return { done: counted.filter(i => i.state === 'done').length, total: counted.length, items };
}
