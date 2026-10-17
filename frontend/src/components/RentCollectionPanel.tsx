import { useEffect, useState } from 'react';
import { getRentCollection, connectRentPayouts, openPayoutsDashboard, type RentCollectionStatus } from '../api/client';
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

  return (
    <div className="space-y-4">
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
        <p className="text-xs text-gray-500 mt-1">Invite a tenant from their page under Tenants. They pay rent, set up autopay and send repair requests with photos from the portal.</p>
      </div>
    </div>
  );
}
