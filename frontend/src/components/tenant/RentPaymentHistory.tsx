import { useEffect, useState } from 'react';
import { getRentPayments } from '../../api/client';
import type { RentPayment } from '../../types';
import { RENT_PAYMENT_METHOD_LABELS } from '../../types';
import { fmtMoney } from '../../lib/money';

const monthOf = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Every rent payment logged on a lease, newest first — the month it paid, when it came in, how, and what went to back rent. */
export default function RentPaymentHistory({ leaseId, refreshKey = 0 }: { leaseId: string; refreshKey?: number }) {
  const [payments, setPayments] = useState<RentPayment[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => { setPayments(null); getRentPayments({ leaseId }).then(setPayments).catch(() => setPayments([])); }, [leaseId, refreshKey]);

  if (!payments) return <p className="text-xs text-gray-600">Loading payments…</p>;
  if (!payments.length) return <p className="text-xs text-gray-600">No payments logged for this lease yet.</p>;
  const yearAgo = Date.now() - 365 * 86400000;
  const received12 = payments.filter(p => p.status === 'RECEIVED' && new Date(p.paidDate).getTime() >= yearAgo).reduce((s, p) => s + Number(p.amount), 0);
  const list = all ? payments : payments.slice(0, 12);
  return (
    <div>
      <p className="text-xs text-gray-500 mb-2">{payments.length} payment{payments.length === 1 ? '' : 's'} logged · {fmtMoney(received12)} received in the last 12 months</p>
      <div className="overflow-x-auto">
        <table className="text-xs w-full max-w-3xl">
          <thead>
            <tr className="text-gray-500 text-left">
              <th className="pb-1 font-normal">Rent for</th>
              <th className="pb-1 font-normal">Received</th>
              <th className="pb-1 font-normal text-right">Amount</th>
              <th className="pb-1 font-normal text-right">To back rent</th>
              <th className="pb-1 pl-4 font-normal">How</th>
              <th className="pb-1 pl-4 font-normal">Status</th>
              <th className="pb-1 pl-4 font-normal">Notes</th>
            </tr>
          </thead>
          <tbody>
            {list.map(p => (
              <tr key={p.id} className="border-t border-white/5">
                <td className="py-1 text-gray-200">{monthOf(p.periodDate)}</td>
                <td className="py-1 text-gray-400">{day(p.paidDate)}</td>
                <td className="py-1 text-right text-emerald-500">{fmtMoney(Number(p.amount))}</td>
                <td className="py-1 text-right text-gray-500">{Number(p.appliedToArrears) > 0 ? fmtMoney(Number(p.appliedToArrears)) : '—'}</td>
                <td className="py-1 pl-4 text-gray-400">{RENT_PAYMENT_METHOD_LABELS[p.method] ?? p.method}{p.bankAccount ? ` → ${p.bankAccount.name}` : ''}</td>
                <td className={`py-1 pl-4 ${p.status === 'RECEIVED' ? 'text-emerald-500' : 'text-amber-500'}`}>{p.status === 'RECEIVED' ? 'received' : 'pending'}</td>
                <td className="py-1 pl-4 text-gray-500 truncate max-w-[220px]">{p.notes || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {payments.length > 12 && <button onClick={() => setAll(v => !v)} className="text-xs text-gray-500 hover:text-gray-300 mt-1">{all ? 'Show fewer' : `Show all ${payments.length}`}</button>}
    </div>
  );
}
