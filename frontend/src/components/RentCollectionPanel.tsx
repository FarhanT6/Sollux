import { useEffect, useState } from 'react';
import { getRentCollection, connectRentPayouts, openPayoutsDashboard, getInviteAll, inviteAll, type RentCollectionStatus, type PortalInviteCandidate } from '../api/client';
import { fmtMoney } from '../lib/money';
import { openUrl } from '../lib/native';
import { toast } from '../lib/toast';

/**
 * Online rent: connect the Stripe account rent is paid out to, what each
 * way of paying costs whom, and how many tenants are on the portal.
 */
export default function RentCollectionPanel() {
  const [s, setS] = useState<RentCollectionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // "Invite tenants": the list first, then the owner presses Invite.
  const [candidates, setCandidates] = useState<{ tenants: PortalInviteCandidate[]; emailConfigured: boolean } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState<(PortalInviteCandidate & { link: string; emailed: boolean })[] | null>(null);
  const loadCandidates = () => getInviteAll().then(c => { setCandidates(c); setPicked(new Set(c.tenants.map(t => t.id))); setSent(null); }).catch(() => toast('Could not load tenants.', 'error'));
  async function sendInvites() {
    setBusy(true);
    try {
      const r = await inviteAll([...picked]);
      setSent(r.invited); setCandidates(null);
      void getRentCollection().then(setS);
      const mailed = r.invited.filter(x => x.emailed).length;
      toast(`${r.invited.length} invited${mailed ? ` — ${mailed} by email` : ''}.`);
    } catch (e: any) { toast(e?.response?.data?.error ?? 'Could not send the invites.', 'error'); } finally { setBusy(false); }
  }
  const copy = (link: string) => { void navigator.clipboard?.writeText(link).then(() => toast('Link copied — text it to the tenant.')).catch(() => toast(link)); };
  useEffect(() => {
    void getRentCollection().then(setS).catch(() => {});
    if (new URLSearchParams(window.location.search).get('connected')) toast('Back from Stripe — if anything is still needed, Stripe will say so here.');
  }, []);
  if (!s) return <p className="text-sm text-gray-500">Loading…</p>;

  async function go(fn: () => Promise<{ url: string }>) {
    setBusy(true);
    try { await openUrl((await fn()).url); } catch (e: any) { toast(e?.response?.data?.error ?? 'Could not open Stripe.', 'error'); } finally { setBusy(false); }
  }
  const ready = s.connected && s.chargesEnabled;
  const ex = s.example;

  const setup = s.setup ?? [];
  const todo = setup.filter(x => !x.ok).length;
  return (
    <div className="space-y-4">
      {setup.length > 0 && (
        <div className="card p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-white">Setup</h2>
            <span className="text-xs" style={{ color: todo ? '#F5A623' : '#22c55e' }}>{todo ? `${todo} to do` : 'Ready'}</span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5 mb-2">What the tenant portal needs before tenants use it, checked live.</p>
          <div className="divide-y divide-white/5">
            {setup.map(x => (
              <div key={x.key} className="flex items-start gap-2.5 py-2">
                <span className="text-xs mt-0.5" style={{ color: x.ok ? '#22c55e' : '#F5A623' }}>{x.ok ? '✓' : '○'}</span>
                <div className="min-w-0">
                  <p className="text-sm text-gray-200">{x.label}</p>
                  <p className="text-xs text-gray-500">{x.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Collect rent online</h2>
            <p className="text-sm text-gray-300 mt-1">
              {!s.configured ? 'Stripe is not set up on this server yet (STRIPE_SECRET_KEY on Render).'
                : ready ? `On — tenants can pay from their portal.${s.payoutsEnabled ? ' Payouts go to your bank.' : ' Payouts start once Stripe has verified your bank.'}`
                : s.connected ? 'Stripe still needs a few details before tenants can pay.' : 'Connect a Stripe account to receive rent. Takes about 5 minutes: your name, SSN or EIN, and the bank account rent should go to.'}
            </p>
            {s.error && <p className="text-xs text-red-400 mt-1">{s.error}</p>}
          </div>
          <span className="text-xs whitespace-nowrap" style={{ color: ready ? '#22c55e' : '#F5A623' }}>{ready ? 'Active' : s.connected ? 'Needs info' : 'Off'}</span>
        </div>
        {s.configured && s.canManage && (
          <div className="flex flex-wrap gap-2 mt-4">
            {(!ready || s.needsInfo) && <button className="btn btn-primary text-sm" disabled={busy} onClick={() => void go(connectRentPayouts)}>{s.connected ? 'Finish setup on Stripe' : 'Connect with Stripe'}</button>}
            {s.connected && <button className="btn text-sm" disabled={busy} onClick={() => void go(openPayoutsDashboard)}>Payouts & bank</button>}
          </div>
        )}
        {!s.canManage && <p className="text-xs text-gray-500 mt-3">Only the account owner can connect the payout account.</p>}
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold text-white mb-3">Who pays what</h2>
        <p className="text-xs text-gray-400 mb-3">Sollux takes no cut. Stripe's processing fee is the only cost. On {fmtMoney(ex.rent)} rent:</p>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <p className="text-white font-medium">Bank transfer (ACH)</p>
            <p className="text-xs text-gray-400 mt-1">Tenant pays {fmtMoney(ex.bank.charge)} — free for them.</p>
            <p className="text-xs text-gray-400">You receive {fmtMoney(ex.bank.ownerReceives)} (0.8%, at most $5).</p>
            <p className="text-xs text-gray-500">Clears in 2–4 business days.</p>
          </div>
          <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <p className="text-white font-medium">Card</p>
            <p className="text-xs text-gray-400 mt-1">Tenant pays {fmtMoney(ex.card.charge)} (adds {fmtMoney(ex.card.tenantFee)}, 2.9% + 30¢).</p>
            <p className="text-xs text-gray-400">You receive {fmtMoney(ex.card.ownerReceives)} — the full rent.</p>
            <p className="text-xs text-gray-500">Instant.</p>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-3">Payments land in each lease's rent ledger by themselves: a card payment as received, a bank payment as pending until it clears. Tenants can turn on autopay for each month's rent.</p>
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold text-white">Tenant portal</h2>
        <p className="text-sm text-gray-300 mt-1">{s.tenants.joined} of {s.tenants.invited} invited tenant{s.tenants.invited === 1 ? '' : 's'} joined · {s.tenants.autopay} on autopay</p>
        <p className="text-xs text-gray-500 mt-1">Tenants pay rent, set up autopay and send repair requests with photos from the portal. Invite one from their page under Tenants, or everyone on an active lease here.</p>
        {!candidates && !sent && <button className="btn text-sm mt-3" onClick={() => void loadCandidates()}>Invite tenants…</button>}
        {candidates && (
          <div className="mt-3">
            {candidates.tenants.length === 0 ? (
              <p className="text-xs text-gray-500">Everyone on an active lease is already on the portal.</p>
            ) : <>
              <p className="text-xs text-gray-400 mb-1">On an active lease, not on the portal yet{candidates.emailConfigured ? ' — those with an email get one' : ' — email is not set up, so you copy each link and text it'}:</p>
              <div className="divide-y divide-white/5 max-h-72 overflow-y-auto">
                {candidates.tenants.map(t => (
                  <label key={t.id} className="flex items-center gap-2 py-1.5 text-sm">
                    <input type="checkbox" className="accent-amber-500" checked={picked.has(t.id)} onChange={e => setPicked(p => { const n = new Set(p); e.target.checked ? n.add(t.id) : n.delete(t.id); return n; })} />
                    <span className="text-gray-200">{t.fullName}</span>
                    <span className="text-xs text-gray-500 truncate">{t.place}{t.email ? ` · ${t.email}` : ' · no email — copy the link'}</span>
                  </label>
                ))}
              </div>
              {!ready && <p className="text-xs text-amber-400 mt-2">Online payments are not on yet: tenants can join and send repair requests now, and pay once the setup above is done.</p>}
              <div className="flex gap-2 mt-3">
                <button className="btn btn-primary text-sm" disabled={busy || picked.size === 0} onClick={() => void sendInvites()}>{busy ? 'Inviting…' : `Invite ${picked.size} tenant${picked.size === 1 ? '' : 's'}`}</button>
                <button className="btn text-sm" onClick={() => setCandidates(null)}>Cancel</button>
              </div>
            </>}
          </div>
        )}
        {sent && (
          <div className="mt-3">
            <p className="text-xs text-gray-400 mb-1">Invited — each link works for 14 days:</p>
            <div className="divide-y divide-white/5">
              {sent.map(t => (
                <div key={t.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                  <span className="text-gray-200 min-w-0 truncate">{t.fullName} <span className="text-xs text-gray-500">{t.emailed ? `· emailed to ${t.email}` : '· not emailed'}</span></span>
                  <button className="btn text-xs whitespace-nowrap" onClick={() => copy(t.link)}>Copy link</button>
                </div>
              ))}
            </div>
            <button className="text-xs text-gray-500 hover:text-gray-300 mt-2" onClick={() => setSent(null)}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
