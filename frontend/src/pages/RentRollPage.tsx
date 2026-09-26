import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getLeases, getProperties } from '../api/client';
import type { Lease, Property } from '../types';
import { fmtDate } from '../lib/date';
import LogRentPaymentModal from '../components/tenant/LogRentPaymentModal';
import RentPaymentHistory from '../components/tenant/RentPaymentHistory';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export default function RentRollPage({ embedded }: { embedded?: boolean } = {}) {
  const [leases, setLeases] = useState<Lease[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterPropId, setFilterPropId] = useState('');
  const [filterStatus, setFilterStatus] = useState('ACTIVE');
  // The lease whose payment form is open, and the one whose history is shown.
  const [logFor, setLogFor] = useState<Lease | null>(null);
  const [openLease, setOpenLease] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    Promise.all([
      getLeases({ status: filterStatus || undefined }),
      getProperties(),
    ]).then(([l, p]) => {
      setLeases(l);
      setProperties(p);
    }).finally(() => setLoading(false));
  }, [filterStatus]);

  const filtered = (filterPropId
    ? leases.filter(l => l.unit?.property?.id === filterPropId)
    : leases
  ).slice().sort((a, b) => {
    const pa = a.unit?.property?.nickname || a.unit?.property?.address || '';
    const pb = b.unit?.property?.nickname || b.unit?.property?.address || '';
    const cmp = pa.localeCompare(pb);
    return cmp !== 0 ? cmp : (a.unit?.unitLabel || '').localeCompare(b.unit?.unitLabel || '');
  });

  const totalRent = filtered.filter(l => l.status === 'ACTIVE').reduce((s, l) => s + Number(l.rentAmount), 0);
  const totalArrears = filtered.filter(l => l.status === 'ACTIVE').reduce((s, l) => s + Number(l.arrearsBalance), 0);

  return (
    <div className={embedded ? '' : 'p-6'}>
      {!embedded ? (
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-white">Rent Roll</h1>
            <p className="text-sm text-gray-400 mt-0.5">{filtered.length} leases · {money(totalRent)}/mo · {money(totalArrears)} arrears</p>
          </div>
          <Link to="/leases/new" className="btn-primary text-sm">+ New Lease</Link>
        </div>
      ) : (
        <div className="flex items-center justify-between mb-4">
          <p className="section-label mb-0">{filtered.length} leases · {money(totalRent)}/mo · {money(totalArrears)} arrears</p>
          <Link to="/leases/new" className="btn text-xs">+ New lease</Link>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="input-dark text-sm w-40"
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="ENDED">Ended</option>
          <option value="PENDING">Pending</option>
          <option value="TERMINATED">Terminated</option>
        </select>
        <select
          value={filterPropId}
          onChange={e => setFilterPropId(e.target.value)}
          className="input-dark text-sm flex-1 max-w-xs"
        >
          <option value="">All properties</option>
          {properties.map(p => (
            <option key={p.id} value={p.id}>{p.nickname || p.address}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-500">No leases found</div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
                <tr className="text-left text-gray-400">
                  <th className="px-4 py-3">Property / Unit</th>
                  <th className="px-4 py-3">Tenant(s)</th>
                  <th className="px-4 py-3">Rent</th>
                  <th className="px-4 py-3">Arrears</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Lease end</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filtered.map(lease => {
                  const tenantList = lease.leaseTenants ?? [];
                  const prop = lease.unit?.property;
                  const arrears = Number(lease.arrearsBalance);
                  return (
                    <Fragment key={lease.id}>
                    <tr className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{prop?.nickname || prop?.address || '—'}</div>
                        <div className="text-xs text-gray-500">{lease.unit?.unitLabel}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-300">
                        {tenantList.length ? tenantList.map((lt, i) => (
                          <span key={lt.tenant.id}>
                            {i > 0 && ', '}
                            <Link to={`/tenants/${lt.tenant.id}`} className="hover:text-amber-400 hover:underline">{lt.tenant.fullName}</Link>
                          </span>
                        )) : '—'}
                      </td>
                      <td className="px-4 py-3 text-white font-medium">{money(Number(lease.rentAmount))}</td>
                      <td className="px-4 py-3">
                        {arrears > 0 ? (
                          <span className="text-red-400 font-medium">{money(arrears)}</span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                          lease.status === 'ACTIVE' ? 'bg-green-900/50 text-green-300'
                          : lease.status === 'PENDING' ? 'bg-amber-900/50 text-amber-300'
                          : 'bg-gray-800 text-gray-400'
                        }`}>{lease.status}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {lease.endDate ? fmtDate(lease.endDate, 'MMM d, yyyy') : 'M-to-M'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                          <button onClick={() => setOpenLease(o => (o === lease.id ? null : lease.id))} className="text-xs text-gray-400 hover:text-gray-200">
                            History {openLease === lease.id ? '▴' : '▾'}
                          </button>
                          <button onClick={() => setLogFor(lease)} className="text-xs text-amber-400 hover:text-amber-300">Log payment</button>
                        </div>
                      </td>
                    </tr>
                    {openLease === lease.id && (
                      <tr>
                        <td colSpan={7} className="px-4 py-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
                          <RentPaymentHistory leaseId={lease.id} refreshKey={refresh} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {logFor && (
        <LogRentPaymentModal
          target={{
            leaseId: logFor.id,
            tenant: logFor.leaseTenants?.map(lt => lt.tenant.fullName).join(', ') || 'Tenant',
            unit: logFor.unit?.unitLabel ?? '',
            property: logFor.unit?.property?.nickname || logFor.unit?.property?.address || '',
            rent: Number(logFor.rentAmount),
            arrears: Number(logFor.arrearsBalance),
          }}
          onClose={() => setLogFor(null)}
          onSaved={async () => {
            const id = logFor.id;
            setLogFor(null);
            setLeases(await getLeases({ status: filterStatus || undefined }));
            setOpenLease(id);
            setRefresh(r => r + 1);
          }}
        />
      )}
    </div>
  );
}
