import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTenants, createTenant, deleteTenant, getProperties } from '../api/client';
import type { Tenant, Property } from '../types';

function formatPhone(phone?: string | null): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return phone;
}
function telHref(phone?: string | null): string {
  return `tel:${(phone ?? '').replace(/\D/g, '')}`;
}

// A tenant can carry multiple leases over time; pick the one that best
// represents "where they live now" for display, filtering, and sorting —
// the active lease if there is one, otherwise the most recently started.
function primaryLeaseTenant(t: Tenant) {
  const lts = t.leaseTenants || [];
  const active = lts.filter(lt => lt.lease?.status === 'ACTIVE');
  const pool = active.length > 0 ? active : lts;
  return [...pool].sort((a, b) =>
    new Date(b.lease?.startDate ?? 0).getTime() - new Date(a.lease?.startDate ?? 0).getTime()
  )[0];
}

export default function TenantsPage({ embedded }: { embedded?: boolean } = {}) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [filterPropId, setFilterPropId] = useState('');

  useEffect(() => {
    Promise.all([getTenants(), getProperties()])
      .then(([t, p]) => { setTenants(t); setProperties(p); })
      .finally(() => setLoading(false));
  }, []);

  // Group + sort tenants by property, then unit — matching the same
  // property/unit grouping used on Rent Roll and Budget, so the list reads
  // as a walk through the portfolio instead of an alphabetical jumble.
  const sorted = useMemo(() => {
    const withLocation = tenants.map(t => {
      const plt = primaryLeaseTenant(t);
      const property = plt?.lease?.unit?.property;
      const unit = plt?.lease?.unit;
      return { tenant: t, property, unit, hasActiveLease: plt?.lease?.status === 'ACTIVE' };
    });

    return withLocation
      .filter(x => !filterPropId || x.property?.id === filterPropId)
      .sort((a, b) => {
        const propA = a.property?.nickname || a.property?.address || '￿';
        const propB = b.property?.nickname || b.property?.address || '￿';
        if (propA !== propB) return propA.localeCompare(propB);
        const unitA = a.unit?.unitLabel || '';
        const unitB = b.unit?.unitLabel || '';
        if (unitA !== unitB) return unitA.localeCompare(unitB);
        return a.tenant.fullName.localeCompare(b.tenant.fullName);
      });
  }, [tenants, filterPropId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.fullName.trim()) return;
    setSaving(true);
    try {
      const t = await createTenant(form);
      setTenants(prev => [...prev, t].sort((a, b) => a.fullName.localeCompare(b.fullName)));
      setShowForm(false);
      setForm({ fullName: '', email: '', phone: '', notes: '' });
    } finally { setSaving(false); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this tenant? This will not delete their lease history.')) return;
    await deleteTenant(id);
    setTenants(prev => prev.filter(t => t.id !== id));
  }

  return (
    <div className={embedded ? '' : 'p-6'}>
      {!embedded ? (
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-white">Tenants</h1>
            <p className="text-sm text-gray-400 mt-0.5">{sorted.length} of {tenants.length} tenants</p>
          </div>
          <button onClick={() => setShowForm(v => !v)} className="btn-primary text-sm">
            {showForm ? 'Cancel' : '+ Add Tenant'}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between mb-4">
          <p className="section-label mb-0">{sorted.length} of {tenants.length} tenants</p>
          <button onClick={() => setShowForm(v => !v)} className="btn text-xs">
            {showForm ? 'Cancel' : '+ Add tenant'}
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-4">
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

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl p-5 mb-5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Full Name *</label>
              <input value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))} className="input-dark w-full" required />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Email</label>
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="input-dark w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Phone</label>
              <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input-dark w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Notes</label>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input-dark w-full" />
            </div>
          </div>
          <button type="submit" disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Add Tenant'}</button>
        </form>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : tenants.length === 0 ? (
        <div className="text-center py-16 text-gray-500">No tenants yet</div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-16 text-gray-500">No tenants match your filters</div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
              <tr className="text-left text-gray-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Unit / Property</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Leases</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {sorted.map(({ tenant: t, property, unit, hasActiveLease }) => {
                const activeLeases = t.leaseTenants?.filter(lt => lt.lease?.status === 'ACTIVE') || [];
                return (
                  <tr key={t.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3 font-medium">
                      <Link to={`/tenants/${t.id}`} className="text-white hover:text-amber-400">{t.fullName}</Link>
                    </td>
                    <td className="px-4 py-3">
                      {property ? (
                        <>
                          <div className={hasActiveLease ? 'text-white' : 'text-gray-500'}>
                            {unit?.unitLabel ? `${unit.unitLabel} · ` : ''}{property.nickname || property.address}
                          </div>
                          <div className="text-xs text-gray-500">{property.city}, {property.state}</div>
                        </>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {t.email ? <a href={`mailto:${t.email}`} className="text-amber-400 hover:text-amber-300" onClick={e => e.stopPropagation()}>{t.email}</a> : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {t.phone ? <a href={telHref(t.phone)} className="text-amber-400 hover:text-amber-300" onClick={e => e.stopPropagation()}>{formatPhone(t.phone)}</a> : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {activeLeases.length > 0 ? (
                        <span className="text-xs bg-green-900/40 text-green-300 px-2 py-0.5 rounded-full">
                          {activeLeases.length} active
                        </span>
                      ) : (
                        <span className="text-gray-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => handleDelete(t.id)} className="text-xs text-red-500 hover:text-red-400">Remove</button>
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
