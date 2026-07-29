import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import {
  getTenant, updateTenant, deleteTenant,
  updateLease, uploadLeaseDocument, getLeaseDocumentUrl,
  getImprovements,
} from '../api/client';
import type { Tenant, Lease, LeaseTenant, RentPayment, Improvement } from '../types';

const money = (n?: number | string | null) =>
  n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtDate = (d?: string | null) => d ? format(new Date(d), 'MMM d, yyyy') : '—';

// Formats a 10 (or 11 with US country code) digit phone number as (***) ***-****.
// Falls back to the raw value for anything else (extensions, international, partial entry).
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

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve((e.target!.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

type FullTenant = Tenant & { leaseTenants: (LeaseTenant & { lease: Lease & { rentPayments?: RentPayment[] } })[] };

export default function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [tenant, setTenant] = useState<FullTenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingContact, setEditingContact] = useState(false);
  const [contactForm, setContactForm] = useState({ fullName: '', email: '', phone: '', notes: '' });
  const [savingContact, setSavingContact] = useState(false);
  const [maintenanceByLease, setMaintenanceByLease] = useState<Record<string, Improvement[]>>({});

  function load() {
    if (!id) return;
    getTenant(id).then(t => {
      setTenant(t as FullTenant);
      setContactForm({
        fullName: t.fullName, email: t.email ?? '', phone: t.phone ?? '', notes: t.notes ?? '',
      });
    }).finally(() => setLoading(false));
  }

  useEffect(load, [id]);

  // For each lease, load property maintenance/improvements whose window overlaps the lease period.
  useEffect(() => {
    if (!tenant) return;
    tenant.leaseTenants.forEach(lt => {
      const lease = lt.lease;
      if (!lease) return;
      const propertyId = lease.unit?.property?.id;
      if (!propertyId || maintenanceByLease[lease.id]) return;
      getImprovements({ propertyId }).then(items => {
        const start = new Date(lease.startDate).getTime();
        const end = lease.endDate ? new Date(lease.endDate).getTime() : Date.now();
        const inRange = items.filter(i => {
          const d = i.startDate || i.completionDate;
          if (!d) return false;
          const t = new Date(d).getTime();
          return t >= start && t <= end;
        });
        setMaintenanceByLease(prev => ({ ...prev, [lease.id]: inRange }));
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant]);

  async function saveContact() {
    if (!id || !contactForm.fullName) return;
    setSavingContact(true);
    try {
      await updateTenant(id, {
        fullName: contactForm.fullName,
        email: contactForm.email || undefined,
        phone: contactForm.phone || undefined,
        notes: contactForm.notes || undefined,
      });
      setEditingContact(false);
      load();
    } finally { setSavingContact(false); }
  }

  async function handleDeleteTenant() {
    if (!id || !tenant) return;
    if (!confirm(`Delete tenant "${tenant.fullName}"? This removes them from all leases. This cannot be undone.`)) return;
    await deleteTenant(id);
    navigate('/tenants');
  }

  if (loading) return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  if (!tenant) return <div className="p-6 text-gray-500 text-sm">Tenant not found</div>;

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-1">
        <div>
          <Link to="/tenants" className="text-xs text-gray-500 hover:text-gray-300">&larr; Tenants</Link>
          <h1 className="text-xl font-semibold text-white mt-1">{tenant.fullName}</h1>
        </div>
        <div className="flex items-center gap-2">
          {!editingContact && <button onClick={() => setEditingContact(true)} className="btn text-sm">Edit</button>}
          <button onClick={handleDeleteTenant} className="text-sm text-red-400 hover:text-red-300">Delete</button>
        </div>
      </div>

      {/* Contact info */}
      <div className="card p-4 mt-4">
        {!editingContact ? (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Email</p>
              {tenant.email
                ? <a href={`mailto:${tenant.email}`} className="text-amber-400 hover:text-amber-300">{tenant.email}</a>
                : <p className="text-gray-200">—</p>}
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Phone</p>
              {tenant.phone
                ? <a href={telHref(tenant.phone)} className="text-amber-400 hover:text-amber-300">{formatPhone(tenant.phone)}</a>
                : <p className="text-gray-200">—</p>}
            </div>
            {tenant.notes && <div className="col-span-2"><p className="text-xs text-gray-500 mb-0.5">Notes</p><p className="text-gray-300">{tenant.notes}</p></div>}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Full name *" value={contactForm.fullName} onChange={e => setContactForm(f => ({ ...f, fullName: e.target.value }))} className="input-dark text-sm col-span-2" />
            <input placeholder="Email" value={contactForm.email} onChange={e => setContactForm(f => ({ ...f, email: e.target.value }))} className="input-dark text-sm" />
            <input placeholder="Phone" value={contactForm.phone} onChange={e => setContactForm(f => ({ ...f, phone: e.target.value }))} className="input-dark text-sm" />
            <textarea placeholder="Notes" value={contactForm.notes} onChange={e => setContactForm(f => ({ ...f, notes: e.target.value }))} className="input-dark text-sm col-span-2" rows={2} />
            <div className="col-span-2 flex gap-2 justify-end">
              <button onClick={() => { setEditingContact(false); load(); }} className="btn text-xs">Cancel</button>
              <button onClick={saveContact} disabled={savingContact || !contactForm.fullName} className="btn btn-primary text-xs">{savingContact ? '…' : 'Save'}</button>
            </div>
          </div>
        )}
      </div>

      {/* Leases */}
      <h2 className="text-sm font-semibold text-white mt-6 mb-2">Leases</h2>
      {tenant.leaseTenants.length === 0 ? (
        <p className="text-sm text-gray-500">No leases on file for this tenant.</p>
      ) : (
        <div className="space-y-4">
          {tenant.leaseTenants.filter(lt => lt.lease).map(lt => (
            <LeaseCard key={lt.lease!.id} lease={lt.lease!} maintenance={maintenanceByLease[lt.lease!.id] ?? []} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Lease card ──────────────────────────────────────────────────────────────

function LeaseCard({ lease, maintenance, onChanged }: {
  lease: Lease & { rentPayments?: RentPayment[] };
  maintenance: Improvement[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    rentAmount: String(lease.rentAmount ?? ''),
    securityDeposit: String(lease.securityDeposit ?? ''),
    startDate: lease.startDate?.slice(0, 10) ?? '',
    endDate: lease.endDate?.slice(0, 10) ?? '',
    leaseType: lease.leaseType,
    status: lease.status,
    notes: lease.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const property = lease.unit?.property;

  async function save() {
    setSaving(true);
    try {
      await updateLease(lease.id, {
        rentAmount: parseFloat(form.rentAmount) || undefined,
        securityDeposit: form.securityDeposit ? parseFloat(form.securityDeposit) : null,
        startDate: form.startDate || undefined,
        endDate: form.endDate || null,
        leaseType: form.leaseType,
        status: form.status,
        notes: form.notes || undefined,
      });
      setEditing(false);
      onChanged();
    } finally { setSaving(false); }
  }

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const base64 = await readFileAsBase64(file);
      await uploadLeaseDocument(lease.id, base64, file.name);
      onChanged();
    } finally { setUploading(false); }
  }

  async function viewDocument() {
    const { url } = await getLeaseDocumentUrl(lease.id);
    window.open(url, '_blank');
  }

  const arrears = Number(lease.arrearsBalance ?? 0);

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-white">
            {property ? <Link to={`/portfolio/${property.id}`} className="hover:text-amber-400">{property.nickname || property.address}</Link> : 'Unknown property'}
            {lease.unit?.unitLabel && <span className="text-gray-500"> · Unit {lease.unit.unitLabel}</span>}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {lease.leaseType === 'FIXED_TERM' ? `${fmtDate(lease.startDate)} – ${fmtDate(lease.endDate)}` : `Month-to-month from ${fmtDate(lease.startDate)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`pill text-xs ${lease.status === 'ACTIVE' ? 'pill-green' : lease.status === 'PENDING' ? 'pill-amber' : 'pill-gray'}`}>{lease.status}</span>
          {lease.status === 'ACTIVE' && (
            <Link to="/finances?tab=budget" className="text-xs text-gray-500 hover:text-gray-300">View in Budget</Link>
          )}
          <button onClick={() => setEditing(e => !e)} className="text-xs text-amber-400 hover:text-amber-300">{editing ? 'Cancel' : 'Edit'}</button>
        </div>
      </div>

      {!editing ? (
        <div className="grid grid-cols-3 gap-3 mt-3 text-sm">
          <div><p className="text-xs text-gray-500">Rent</p><p className="text-white font-medium">{money(lease.rentAmount)}/mo</p></div>
          <div><p className="text-xs text-gray-500">Security deposit</p><p className="text-gray-300">{money(lease.securityDeposit)}</p></div>
          <div><p className="text-xs text-gray-500">Arrears</p><p className={arrears > 0 ? 'text-red-400 font-medium' : 'text-gray-300'}>{money(arrears)}</p></div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 mt-3">
          <input type="number" placeholder="Rent/mo" value={form.rentAmount} onChange={e => setForm(f => ({ ...f, rentAmount: e.target.value }))} className="input-dark text-sm" />
          <input type="number" placeholder="Security deposit" value={form.securityDeposit} onChange={e => setForm(f => ({ ...f, securityDeposit: e.target.value }))} className="input-dark text-sm" />
          <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as any }))} className="input-dark text-sm">
            {['ACTIVE', 'ENDED', 'PENDING', 'TERMINATED'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} className="input-dark text-sm" />
          <input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} className="input-dark text-sm" placeholder="End date" />
          <select value={form.leaseType} onChange={e => setForm(f => ({ ...f, leaseType: e.target.value as any }))} className="input-dark text-sm">
            <option value="MONTH_TO_MONTH">Month-to-month</option>
            <option value="FIXED_TERM">Fixed term</option>
          </select>
          <input placeholder="Notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input-dark text-sm col-span-3" />
          <div className="col-span-3 flex justify-end">
            <button onClick={save} disabled={saving} className="btn btn-primary text-xs">{saving ? '…' : 'Save changes'}</button>
          </div>
        </div>
      )}

      {/* Lease document */}
      <div className="mt-3 flex items-center gap-2 text-xs">
        {lease.documentUrl ? (
          <button onClick={viewDocument} className="text-amber-400 hover:text-amber-300">📄 View lease agreement</button>
        ) : (
          <label className="text-gray-500 hover:text-gray-300 cursor-pointer">
            {uploading ? 'Uploading…' : '+ Upload lease agreement (PDF)'}
            <input type="file" accept="application/pdf" className="hidden" disabled={uploading}
              onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0])} />
          </label>
        )}
      </div>

      {/* Payment history */}
      {lease.rentPayments && lease.rentPayments.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer">Payment history ({lease.rentPayments.length})</summary>
          <table className="w-full text-xs mt-2">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1 pr-4">Date</th><th className="py-1 pr-4">Amount</th><th className="py-1 pr-4">Method</th><th className="py-1">Notes</th>
              </tr>
            </thead>
            <tbody>
              {lease.rentPayments.map(p => (
                <tr key={p.id} className="border-t border-white/5">
                  <td className="py-1.5 pr-4 text-gray-300">{fmtDate(p.paidDate)}</td>
                  <td className="py-1.5 pr-4 text-white font-medium">{money(p.amount)}</td>
                  <td className="py-1.5 pr-4 text-gray-400">{p.method}</td>
                  <td className="py-1.5 text-gray-500">{p.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {/* Maintenance during this lease */}
      {maintenance.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer">Property maintenance during this lease ({maintenance.length})</summary>
          <div className="mt-2 space-y-1.5">
            {maintenance.map(m => (
              <div key={m.id} className="text-xs flex items-center justify-between">
                <span className="text-gray-300">{m.description}{m.category ? ` · ${m.category}` : ''}</span>
                <span className="text-gray-500">{fmtDate(m.startDate)} · {money(m.cost)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
