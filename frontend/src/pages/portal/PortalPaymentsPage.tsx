import { useEffect, useState } from 'react';
import { getPortalPayments, type PortalPayment } from '../../api/client';
import { fmtMoney } from '../../lib/money';
import { fmtDate } from '../../lib/date';

const METHOD: Record<string, string> = { ACH: 'Bank transfer', CARD: 'Card', CHECK: 'Check', CASH: 'Cash', ZELLE: 'Zelle', MONEY_ORDER: 'Money order', VENMO: 'Venmo', SECTION_8: 'Housing authority' };

/** Every rent payment on the tenant's leases, online or not. */
export default function PortalPaymentsPage() {
  const [rows, setRows] = useState<PortalPayment[] | null>(null);
  useEffect(() => { void getPortalPayments().then(setRows).catch(() => setRows([])); }, []);
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold text-white">Payments</h1>
      {!rows ? <p className="text-sm text-gray-500">Loading…</p> : rows.length === 0 ? <div className="card p-5 text-sm text-gray-400">No payments recorded yet.</div> : (
        <div className="card divide-y divide-white/5">
          {rows.map(p => (
            <div key={p.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm text-gray-100">{fmtDate(p.periodDate, 'MMMM yyyy')} rent</p>
                <p className="text-xs text-gray-500">{fmtDate(p.paidDate)} · {METHOD[p.method] ?? p.method.replace(/_/g, ' ').toLowerCase()}{p.online ? ' · online' : ''}{p.tenantFee ? ` · card fee ${fmtMoney(p.tenantFee)}` : ''}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-white">{fmtMoney(p.amount)}</p>
                {p.status === 'PENDING' && <p className="text-[11px] text-amber-400">Clearing</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
