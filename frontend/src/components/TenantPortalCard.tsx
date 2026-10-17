import { useEffect, useState } from 'react';
import { getPortalInvite, sendPortalInvite, revokePortalInvite, type PortalInvite } from '../api/client';
import { fmtMoment } from '../lib/date';
import { toast } from '../lib/toast';

/**
 * The tenant's portal access, on their page: invite them (a one-time link,
 * emailed when email is set up, and shown to copy or text), see whether they
 * joined and use autopay, or turn their access off.
 */
export default function TenantPortalCard({ tenantId, email }: { tenantId: string; email: string | null }) {
  const [inv, setInv] = useState<PortalInvite | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => getPortalInvite(tenantId).then(i => { setInv(i); setLink(i.link ?? null); }).catch(() => {});
  useEffect(() => { void load(); }, [tenantId]);

  async function invite() {
    setBusy(true);
    try {
      const r = await sendPortalInvite(tenantId);
      setLink(r.link);
      toast(r.emailed ? `Invite emailed to ${r.email}.` : 'Invite link ready — copy it and text or email it to them.');
      void load();
    } catch (e: any) { toast(e?.response?.data?.error ?? 'Could not create the invite.', 'error'); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); toast('Link copied.'); } catch { window.prompt('Copy the invite link:', link); }
  }

  if (!inv) return null;
  return (
    <div className="card p-4 mt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">Tenant portal</p>
          <p className="text-xs text-gray-400 mt-0.5">
            {inv.joined ? `Joined${inv.acceptedAt ? ` ${fmtMoment(inv.acceptedAt)}` : ''}${inv.autopay ? ' · autopay on' : ''} — they can pay rent online and send repair requests.`
              : inv.invited ? `Invited${inv.invitedAt ? ` ${fmtMoment(inv.invitedAt)}` : ''}${inv.email ? ` (${inv.email})` : ''} — not joined yet.`
              : 'Let them pay rent online (bank free, card with fee), set up autopay, and send repair requests with photos.'}
          </p>
        </div>
        {inv.invited
          ? <button className="text-xs text-red-400 whitespace-nowrap" onClick={() => { if (confirm('Turn off their portal access? Autopay stops too.')) void revokePortalInvite(tenantId).then(load); }}>Turn off</button>
          : null}
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        {!inv.joined && <button className="btn btn-primary text-xs" disabled={busy} onClick={() => void invite()}>{inv.invited ? 'Send a new link' : email ? `Invite ${email}` : 'Create invite link'}</button>}
        {link && !inv.joined && <button className="btn text-xs" onClick={() => void copy()}>Copy link</button>}
      </div>
      {!email && !inv.joined && <p className="text-[11px] text-gray-500 mt-2">No email on file: copy the link and text it to them.</p>}
    </div>
  );
}
