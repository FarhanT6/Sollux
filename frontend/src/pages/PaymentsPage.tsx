import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getPayments } from '../api/client';
import type { Payment } from '../types/index';
import { PageHeader, Pill, EmptyState, Skeleton } from '../components/ui';
import { format } from 'date-fns';

const CATEGORY_ICONS: Record<string, string> = {
  ELECTRIC: '⚡', GAS: '🔥', WATER: '💧', SEWER: '🚿',
  INTERNET: '🌐', PHONE: '📱', TV: '📺', TRASH: '🗑️',
  SOLAR: '☀️', INSURANCE: '🛡️', HOA: '🏘️', TAXES: '🏛️', OTHER: '📄',
};

interface ServiceGroup {
  providerName: string;
  utilityAccountId: string;
  propertyId: string | undefined;
  payments: Payment[];
}

interface PropertyGroup {
  label: string;
  propertyId: string | undefined;
  services: ServiceGroup[];
}

function groupPayments(payments: Payment[]): PropertyGroup[] {
  // property → service → payments
  const propMap = new Map<string, PropertyGroup>();

  for (const p of payments) {
    const propKey = p.utilityAccount?.property?.nickname || p.utilityAccount?.property?.address || 'Unknown property';
    const propId = p.utilityAccount?.propertyId || p.utilityAccount?.property?.id;

    if (!propMap.has(propKey)) {
      propMap.set(propKey, { label: propKey, propertyId: propId, services: [] });
    }
    const propGroup = propMap.get(propKey)!;

    const svcKey = p.utilityAccountId;
    let svcGroup = propGroup.services.find(s => s.utilityAccountId === svcKey);
    if (!svcGroup) {
      svcGroup = {
        providerName: p.utilityAccount?.providerName || 'Unknown',
        utilityAccountId: p.utilityAccountId,
        propertyId: propId,
        payments: [],
      };
      propGroup.services.push(svcGroup);
    }
    svcGroup.payments.push(p);
  }

  // Sort: properties alphabetically, services alphabetically, payments newest first
  const result = Array.from(propMap.values()).sort((a, b) => a.label.localeCompare(b.label));
  for (const prop of result) {
    prop.services.sort((a, b) => a.providerName.localeCompare(b.providerName));
    for (const svc of prop.services) {
      svc.payments.sort((a, b) => new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime());
    }
  }
  return result;
}

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'paid' | 'pending' | 'failed'>('all');

  useEffect(() => {
    getPayments({}).then(setPayments).finally(() => setLoading(false));
  }, []);

  const filtered = filter === 'all'
    ? payments
    : payments.filter(p => p.status.toLowerCase() === filter);

  const total = filtered.reduce((s, p) => s + Number(p.amount), 0);
  const groups = groupPayments(filtered);

  return (
    <div>
      <PageHeader
        title="Payment history"
        subtitle={`${filtered.length} payment${filtered.length !== 1 ? 's' : ''} · $${total.toLocaleString('en-US', { minimumFractionDigits: 2 })} total`}
      />

      <div className="px-6 py-5">
        {/* Filter tabs */}
        <div className="flex gap-2 mb-5">
          {(['all', 'paid', 'pending', 'failed'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                filter === f ? 'bg-[#F5A623] text-black' : 'text-gray-400 hover:text-white'
              }`}
              style={filter !== f ? { background: 'rgba(255,255,255,0.06)' } : {}}
            >
              {f === 'all' ? 'All payments' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-4">
            {[1, 2].map(i => <Skeleton key={i} className="h-48" />)}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon="💳" title="No payments yet" body="Payment history will appear here after accounts are synced." />
        ) : (
          <div className="space-y-4 pb-8">
            {groups.map(propGroup => (
              <div
                key={propGroup.label}
                className="rounded-xl overflow-hidden"
                style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                {/* Property header */}
                <div className="px-5 py-3 flex items-center justify-between"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 uppercase tracking-wider">Property</span>
                    {propGroup.propertyId ? (
                      <Link
                        to={`/properties/${propGroup.propertyId}`}
                        className="text-sm font-semibold text-white hover:text-[#F5A623] transition-colors"
                      >
                        {propGroup.label} ›
                      </Link>
                    ) : (
                      <span className="text-sm font-semibold text-white">{propGroup.label}</span>
                    )}
                  </div>
                  <span className="text-xs text-gray-500">
                    {propGroup.services.reduce((s, svc) => s + svc.payments.length, 0)} payments
                  </span>
                </div>

                {/* Services within this property */}
                <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                  {propGroup.services.map(svcGroup => {
                    const svcTotal = svcGroup.payments.reduce((s, p) => s + Number(p.amount), 0);
                    const detailUrl = svcGroup.propertyId
                      ? `/properties/${svcGroup.propertyId}/utilities/${svcGroup.utilityAccountId}`
                      : null;
                    const icon = CATEGORY_ICONS[(svcGroup.payments[0]?.utilityAccount?.category) || ''] || '💳';

                    return (
                      <div key={svcGroup.utilityAccountId}>
                        {/* Service sub-header */}
                        <div className="px-5 py-2.5 flex items-center justify-between"
                          style={{ background: 'rgba(255,255,255,0.01)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <div className="flex items-center gap-2">
                            <span className="text-base">{icon}</span>
                            {detailUrl ? (
                              <Link
                                to={detailUrl}
                                className="text-xs font-semibold text-gray-300 hover:text-[#F5A623] transition-colors"
                              >
                                {svcGroup.providerName} — View all statements ›
                              </Link>
                            ) : (
                              <span className="text-xs font-semibold text-gray-300">{svcGroup.providerName}</span>
                            )}
                          </div>
                          <span className="text-xs text-gray-500">
                            ${svcTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })} total
                          </span>
                        </div>

                        {/* Payment rows for this service */}
                        <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                          {svcGroup.payments.map(p => (
                            <div key={p.id} className="px-5 py-3.5 flex items-center gap-4">
                              {/* Date */}
                              <div className="w-28 flex-shrink-0">
                                <p className="text-sm text-gray-300">
                                  {format(new Date(p.paymentDate), 'MMM d, yyyy')}
                                </p>
                              </div>

                              {/* Method + confirmation */}
                              <div className="flex-1 min-w-0">
                                {p.paymentMethod && (
                                  <p className="text-xs text-gray-500">{p.paymentMethod}</p>
                                )}
                                {p.confirmationNumber ? (
                                  <p className="font-mono text-xs text-gray-600 mt-0.5">
                                    Conf# {p.confirmationNumber}
                                  </p>
                                ) : (
                                  !p.paymentMethod && <p className="text-xs text-gray-600">—</p>
                                )}
                              </div>

                              {/* Amount */}
                              <div className="flex-shrink-0 w-20 text-right">
                                <p className="text-sm font-semibold text-white">
                                  ${Number(p.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                </p>
                              </div>

                              {/* Status */}
                              <div className="flex-shrink-0">
                                <Pill color={p.status === 'PAID' ? 'green' : p.status === 'PENDING' ? 'amber' : 'red'}>
                                  {p.status}
                                </Pill>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
