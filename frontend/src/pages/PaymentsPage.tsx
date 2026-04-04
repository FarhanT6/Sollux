import { useEffect, useState } from 'react';
import { getPayments } from '../api/client';
import type { Payment } from '../types';
import { PageHeader, Pill, EmptyState, Skeleton } from '../components/ui';
import { format } from 'date-fns';

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getPayments({}).then(setPayments).finally(() => setLoading(false));
  }, []);

  const total = payments.reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div>
      <PageHeader
        title="Payment history"
        subtitle={`${payments.length} payments · $${total.toLocaleString('en-US', { minimumFractionDigits: 2 })} total`}
      />
      <div className="px-6 py-5">
        {loading ? <Skeleton className="h-64" /> :
          payments.length === 0 ? <EmptyState icon="💳" title="No payments yet" body="Payment history will appear here after accounts are synced." /> : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Utility</th>
                  <th>Amount</th>
                  <th>Date</th>
                  <th>Confirmation #</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id}>
                    <td className="text-gray-500 text-xs">{p.utilityAccount?.property?.nickname || p.utilityAccount?.property?.address}</td>
                    <td className="font-medium">{p.utilityAccount?.providerName}</td>
                    <td className="font-semibold">${Number(p.amount).toFixed(2)}</td>
                    <td className="text-gray-500">{format(new Date(p.paymentDate), 'MMM d, yyyy')}</td>
                    <td><span className="font-mono text-xs text-gray-400">{p.confirmationNumber || '—'}</span></td>
                    <td><Pill color={p.status === 'PAID' ? 'green' : p.status === 'PENDING' ? 'amber' : 'red'}>{p.status}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </div>
    </div>
  );
}
