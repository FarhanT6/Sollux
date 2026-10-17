import { useEffect, useState } from 'react';
import { getBilling, startCheckout, openBillingPortal, type BillingSummary, type PlanKey } from '../api/client';
import { openUrl } from '../lib/native';
import { fmtDate } from '../lib/date';
import { toast } from '../lib/toast';

/**
 * Plan & billing: where the account stands (trial, plan, complimentary),
 * what it uses, and the three plans. Choosing one opens Stripe Checkout;
 * cards, invoices and cancelling are Stripe's billing portal. Sollux never
 * sees a card number.
 */
export default function BillingPanel() {
  const [b, setB] = useState<BillingSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => getBilling().then(setB).catch(() => {});
  useEffect(() => {
    void load();
    if (new URLSearchParams(window.location.search).get('checkout') === 'success') toast('Thanks — your plan is active.');
  }, []);
  if (!b) return <p className="text-sm text-gray-500">Loading…</p>;

  const daysLeft = b.trialEndsAt ? Math.max(0, Math.ceil((new Date(b.trialEndsAt).getTime() - Date.now()) / 86400000)) : 0;
  const current = b.plans.find(p => p.key === b.plan);
  const headline =
    b.access === 'comp' ? 'Complimentary — every feature, no limits, nothing to pay.'
    : b.access === 'trial' ? `Free trial — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left. Choose a plan any time; the rest of the trial carries over.`
    : b.access === 'active' ? `${current?.name ?? 'Your'} plan${b.status === 'past_due' ? ' — the last payment failed; update your card to keep it' : b.currentPeriodEnd ? ` · renews ${fmtDate(b.currentPeriodEnd, 'MMM d, yyyy')}` : ''}.`
    : b.lapsedReason === 'trial_ended' ? 'Your free trial has ended. Everything is still here — choose a plan to keep adding and changing things.'
    : 'Your plan has ended. Everything is still here — choose a plan to keep adding and changing things.';

  async function go(fn: () => Promise<{ url: string }>, key: string) {
    setBusy(key);
    try { const { url } = await fn(); await openUrl(url); }
    catch (e: any) { toast(e?.response?.data?.error ?? 'Could not open billing.', 'error'); }
    finally { setBusy(null); }
  }

  const limit = b.usage.propertyLimit;
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="text-sm text-gray-200">{headline}</p>
        <div className="mt-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Properties</span><span>{b.usage.properties}{limit != null ? ` of ${limit}` : ' · unlimited'}</span>
          </div>
          {limit != null && (
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, (b.usage.properties / Math.max(1, limit)) * 100)}%`, background: b.usage.properties >= limit ? '#ef4444' : '#F59E0B' }} />
            </div>
          )}
        </div>
        {b.hasCustomer && b.canManage && (
          <button onClick={() => void go(openBillingPortal, 'portal')} disabled={busy === 'portal'} className="btn text-xs mt-4">
            {busy === 'portal' ? 'Opening…' : 'Manage billing — card, invoices, cancel'}
          </button>
        )}
      </div>

      {b.access !== 'comp' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {b.plans.map(p => {
            const isCurrent = b.access === 'active' && b.plan === p.key;
            return (
              <div key={p.key} className="card p-5 flex flex-col" style={isCurrent ? { borderColor: 'rgba(245,158,11,0.6)' } : undefined}>
                <p className="text-sm font-semibold text-white">{p.name}</p>
                <p className="mt-1"><span className="text-2xl font-semibold text-white">${p.priceMonthly}</span><span className="text-xs text-gray-500"> / month</span></p>
                <p className="text-xs text-gray-400 mt-1 flex-1">{p.blurb} · utility intelligence, rent collection and the tenant portal included</p>
                {isCurrent
                  ? <span className="mt-4 text-xs text-amber-400">Your plan</span>
                  : b.canManage && (
                    <button onClick={() => void go(() => startCheckout(p.key as PlanKey), p.key)} disabled={!b.billingConfigured || !!busy}
                      className="btn btn-primary text-xs mt-4 justify-center disabled:opacity-40">
                      {busy === p.key ? 'Opening…' : b.access === 'active' ? `Switch to ${p.name}` : `Choose ${p.name}`}
                    </button>
                  )}
              </div>
            );
          })}
        </div>
      )}
      {!b.billingConfigured && b.access !== 'comp' && <p className="text-xs text-gray-500">Plans can't be bought on this server yet — billing isn't connected.</p>}
      {!b.canManage && <p className="text-xs text-gray-500">Only the account owner can change the plan.</p>}
    </div>
  );
}
