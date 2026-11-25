/**
 * What a failed sync is (#279): a login the site rejected or none on file is the owner's to fix,
 * a site that turns automated sign-in away is the site's choice (the bills come by email or
 * upload), a run the owner cancelled is no failure; anything else is a defect.
 */
export type SyncFailureKind = 'needs-owner' | 'blocked-by-site' | 'cancelled' | 'defect';

const NEEDS_OWNER = /rejected the username or password|invalid user ?id|wrong password|incorrect password|bad_login|no (?:portal )?login|add (?:a )?(?:portal )?login|needs? (?:a )?(?:login|website|password)|no website|does not list this account|credentials/i;
const BLOCKED_BY_SITE = /captcha|bot[- ]?(?:check|protection)|turned away|access denied|unable to process your request|verify you are human/i;

export function syncFailureKind(error: string | null | undefined): SyncFailureKind {
  const e = error ?? '';
  if (/^Cancelled by you/.test(e)) return 'cancelled';
  if (NEEDS_OWNER.test(e)) return 'needs-owner';
  if (BLOCKED_BY_SITE.test(e)) return 'blocked-by-site';
  return 'defect';
}
