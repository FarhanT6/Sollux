import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePortal } from './PortalLayout';
import { getPortalFees, payRent, setupAutopay, stopAutopay, getPortalLeaseDocument, type Fees, type PayMethod, type PortalLease } from '../../api/client';
import { fmtMoney } from '../../lib/money';
import { fmtDate } from '../../lib/date';
import { isNative, openUrl } from '../../lib/native';
import { toast } from '../../lib/toast';

/** Stripe's pages: the same tab on the web (it comes back here), Safari in the app. */
const go = (url: string) => (isNative ? openUrl(url) : (window.location.href = url, Promise.resolve()));
const ordinal = (n: number) => `${n}${[, 'st', 'nd', 'rd'][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10] ?? 'th'}`;

export default function PortalHomePage() {
  const { me, reload } = usePortal();
  const [paying, setPaying] = useState<PortalLease | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('paid')) { toast('Thank you — your payment was sent. A bank payment shows as pending until it clears.'); void reload(); }
    if (q.get('autopay')) { toast('Autopay is set up.'); void reload(); }
  }, []);
  if (!me) return null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-white">Hi {me.tenant?.fullName.split(/\s+/)[0] ?? 'there'}</h1>
        <p className="text-sm text-gray-400">Your landlord: {me.landlord}</p>
      </div>

      {me.leases.length === 0 && <div className="card p-5 text-sm text-gray-300">No active lease is on file for you yet. Ask your landlord to check it.</div>}

      {me.leases.map(l => (
        <div key={l.id} className="card p-5">
          <p className="text-xs text-gray-500">{l.address}{l.city ? ` · ${l.city}` : ''}</p>
          <div className="flex items-end justify-between mt-2">
            <div>
              <p className="text-xs text-gray-400">{l.balance.total > 0 ? 'Due now' : 'Balance'}</p>
              <p className="text-3xl font-semibold text-white">{fmtMoney(l.balance.total)}</p>
            </div>
            {me.onlinePayments && l.balance.total > 0 && (
              <button className="btn btn-primary" onClick={() => setPaying(l)}>Pay rent</button>
            )}
          </div>
          <div className="mt-3 space-y-0.5 text-xs text-gray-400">
            <p>Rent {fmtMoney(l.rent)} a month, due on the {ordinal(l.dueDay)}{l.lateFee ? ` · late fee ${typeof l.lateFee === 'number' ? fmtMoney(l.lateFee) : l.lateFee}${l.graceDays ? ` after ${l.graceDays} days` : ''}` : ''}</p>
            {l.balance.arrears > 0 && <p>Includes {fmtMoney(l.balance.arrears)} from earlier months.</p>}
            {l.balance.pending > 0 && <p className="text-amber-400">{fmtMoney(l.balance.pending)} on its way (bank payment clearing).</p>}
            {l.balance.total <= 0 && <p className="text-green-400">You're all paid up. Thank you!</p>}
          </div>
          {!me.onlinePayments && l.balance.total > 0 && <p className="text-xs text-gray-500 mt-3">Online payment isn't turned on yet — pay your landlord the usual way for now.</p>}
          <div className="flex gap-4 mt-4 text-xs">
            {l.hasDocument && <button className="text-amber-400" onClick={() => void getPortalLeaseDocument(l.id).then(d => openUrl(d.url)).catch(() => toast('The lease could not be opened.', 'error'))}>View lease</button>}
            <Link to="/portal/repairs?new=1" className="text-amber-400">Request a repair</Link>
          </div>
        </div>
      ))}

      {me.onlinePayments && me.leases.length > 0 && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-white">Autopay</h2>
          {me.autopay.on ? (
            <>
              <p className="text-sm text-gray-300 mt-1">On — each month's rent is paid on its due date from {me.autopay.label ?? 'your saved account'}.</p>
              <button className="btn text-xs mt-3" onClick={() => { if (confirm('Turn off autopay?')) void stopAutopay().then(reload); }}>Turn off</button>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-400 mt-1">Pay each month's rent automatically on its due date. Bank account: free. Card: the card fee applies each month.</p>
              <div className="flex gap-2 mt-3">
                <button className="btn btn-primary text-xs" onClick={() => void setupAutopay('us_bank_account').then(r => go(r.url)).catch((e: any) => toast(e?.response?.data?.error ?? 'Could not start autopay.', 'error'))}>Use my bank account</button>
                <button className="btn text-xs" onClick={() => void setupAutopay('card').then(r => go(r.url)).catch((e: any) => toast(e?.response?.data?.error ?? 'Could not start autopay.', 'error'))}>Use a card</button>
              </div>
            </>
          )}
        </div>
      )}

      {paying && <PaySheet lease={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}

function PaySheet({ lease, onClose }: { lease: PortalLease; onClose: () => void }) {
  const [amount, setAmount] = useState(lease.balance.total.toFixed(2));
  const [fees, setFees] = useState<{ card: Fees; bank: Fees } | null>(null);
  const [busy, setBusy] = useState(false);
  const n = Number(amount) || 0;
  useEffect(() => { const t = setTimeout(() => { if (n >= 1) void getPortalFees(n).then(setFees).catch(() => {}); }, 250); return () => clearTimeout(t); }, [n]);

  async function pay(method: PayMethod) {
    setBusy(true);
    try { const r = await payRent({ leaseId: lease.id, amount: n, method }); await go(r.url); }
    catch (e: any) { toast(e?.response?.data?.error ?? 'The payment could not be started.', 'error'); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5" style={{ background: '#1e1e1e', paddingBottom: 'calc(20px + env(safe-area-inset-bottom))' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Pay rent</h2>
          <button className="text-sm text-gray-400" onClick={onClose}>Cancel</button>
        </div>
        <label className="block text-xs text-gray-400 mt-4">Amount</label>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-2xl text-gray-400">$</span>
          <input inputMode="decimal" className="input-dark text-2xl font-semibold flex-1" value={amount} onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
        </div>
        {lease.balance.arrears > 0 && <p className="text-xs text-gray-500 mt-1">This month {fmtMoney(lease.balance.thisMonth)} + earlier {fmtMoney(lease.balance.arrears)}. You can pay part of it.</p>}
        <div className="mt-5 space-y-2">
          <button disabled={busy || n < 1} onClick={() => void pay('us_bank_account')} className="w-full rounded-xl p-4 text-left disabled:opacity-40" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.35)' }}>
            <div className="flex justify-between"><span className="text-sm font-medium text-white">Bank account</span><span className="text-sm text-white">{fmtMoney(n)}</span></div>
            <p className="text-xs text-green-400 mt-0.5">No fee · clears in 2–4 business days</p>
          </button>
          <button disabled={busy || n < 1} onClick={() => void pay('card')} className="w-full rounded-xl p-4 text-left disabled:opacity-40" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <div className="flex justify-between"><span className="text-sm font-medium text-white">Debit or credit card</span><span className="text-sm text-white">{fees ? fmtMoney(fees.card.charge) : '…'}</span></div>
            <p className="text-xs text-gray-400 mt-0.5">Includes the card processor's fee of {fees ? fmtMoney(fees.card.tenantFee) : '…'} (2.9% + 30¢) · instant</p>
          </button>
        </div>
        <p className="text-[11px] text-gray-500 mt-4">Payments are processed by Stripe and paid to {`your landlord's`} account. {`Paid for ${fmtDate(lease.balance.periodDate, 'MMMM yyyy')}`}.</p>
      </div>
    </div>
  );
}
