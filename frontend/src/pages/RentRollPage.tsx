import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getLeases, createRentPayment, getProperties, getUnits } from '../api/client';
import type { Lease, Property, Unit } from '../types';
import { format } from 'date-fns';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export default function RentRollPage({ embedded }: { embedded?: boolean } = {}) {
  const [leases, setLeases] = useState<Lease[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterPropId, setFilterPropId] = useState('');
  const [filterStatus, setFilterStatus] = useState('ACTIVE');
  const [showPayForm, setShowPayForm] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payMethod, setPayMethod] = useState('ZELLE');
  const [payNotes, setPayNotes] = useState('');
  const [saving, setSaving] = useState(false);

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

  async function logPayment(leaseId: string) {
    if (!payAmount || !payDate) return;
    setSaving(true);
    try {
      const now = new Date();
      await createRentPayment({
        leaseId,
        periodDate: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)).toISOString(),
        amount: parseFloat(payAmount),
        paidDate: payDate,
        method: payMethod,
        notes: payNotes || undefined,
      });
      const updated = await getLeases({ status: filterStatus || undefined });
      setLeases(updated);
      setShowPayForm(null);
      setPayAmount('');
      setPayNotes('');
    } finally { setSaving(false); }
  }

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
                const tenants = lease.leaseTenants?.map(lt => lt.tenant.fullName).join(', ') || '—';
                const prop = lease.unit?.property;
                const arrears = Number(lease.arrearsBalance);
                return (
                  <tr key={lease.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="font-medium text-white">{prop?.nickname || prop?.address || '—'}</div>
                      <div className="text-xs text-gray-500">{lease.unit?.unitLabel}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-300">{tenants}</td>
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
                      {lease.endDate ? format(new Date(lease.endDate), 'MMM d, yyyy') : 'M-to-M'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {showPayForm === lease.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            placeholder="Amount"
                            value={payAmount}
                            onChange={e => setPayAmount(e.target.value)}
                            className="input-dark text-xs w-24"
                          />
                          <input
                            type="date"
                            value={payDate}
                            onChange={e => setPayDate(e.target.value)}
                            className="input-dark text-xs w-32"
                          />
                          <select value={payMethod} onChange={e => setPayMethod(e.target.value)} className="input-dark text-xs w-24">
                            <option value="ZELLE">Zelle</option>
                            <option value="CHECK">Check</option>
                            <option value="CASH">Cash</option>
                            <option value="ACH">ACH</option>
                            <option value="OTHER">Other</option>
                          </select>
                          <button onClick={() => logPayment(lease.id)} disabled={saving} className="btn-primary text-xs px-3 py-1.5">
                            {saving ? '…' : 'Log'}
                          </button>
                          <button onClick={() => setShowPayForm(null)} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setShowPayForm(lease.id)}
                          className="text-xs text-amber-400 hover:text-amber-300"
                        >
                          Log payment
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
