import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import BackLink from '../components/ui/BackLink';
import { format } from 'date-fns';
import {
  getTenant, updateTenant, deleteTenant,
  updateLease, uploadLeaseDocument, deleteLeaseAgreement, getLeaseDocumentUrl,
  getLeaseDocuments, addLeaseDocument, getLeaseDocumentViewUrl, deleteLeaseDocument,
  getImprovements,
} from '../api/client';
import type { Tenant, Lease, LeaseTenant, RentPayment, Improvement, Document } from '../types';
import { DOCUMENT_CATEGORY_LABELS } from '../types';
import { fmtDate } from '../lib/date';
import UtilityReimbursementPanel from '../components/tenant/UtilityReimbursementPanel';
import LeaseSummary from '../components/tenant/LeaseSummary';
import { usePhone, Screen, Section, Row, Sheet, Field, BarButton, Icon } from '../ios';
import { openUrl } from '../lib/native';

const money = (n?: number | string | null) =>
  n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

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
  const phone = usePhone();
  const [actions, setActions] = useState(false);

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
        const start = lease.startDate ? new Date(lease.startDate).getTime() : 0;
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

  const leases = tenant.leaseTenants.filter(lt => lt.lease);

  // A phone: contact you can tap to call or email, then each lease.
  if (phone) return (
    <Screen title={tenant.fullName} back
      right={<BarButton label="Tenant actions" onClick={() => setActions(true)}><Icon.Ellipsis /></BarButton>}>
      <Section header="Contact">
        <Row title="Phone" chevron={false}
          value={tenant.phone ? <span className="ios-tint">{formatPhone(tenant.phone)}</span> : '—'}
          onClick={tenant.phone ? () => void openUrl(telHref(tenant.phone)) : undefined} />
        <Row title="Email" chevron={false}
          value={tenant.email ? <span className="ios-tint">{tenant.email}</span> : '—'}
          onClick={tenant.email ? () => void openUrl(`mailto:${tenant.email}`) : undefined} />
        {tenant.notes && <Row title={tenant.notes} wrap chevron={false} />}
      </Section>

      {leases.length === 0 && <Section header="Leases"><Row title="No leases on file" chevron={false} /></Section>}
      {leases.map(lt => (
        <LeaseCard key={lt.lease!.id} lease={lt.lease!} maintenance={maintenanceByLease[lt.lease!.id] ?? []} onChanged={load} />
      ))}

      <Sheet open={actions} onClose={() => setActions(false)} title={tenant.fullName} left={null}
        right={{ label: 'Done', onClick: () => setActions(false) }}>
        <Section>
          <Row title="Edit contact" onClick={() => { setActions(false); setEditingContact(true); }} />
        </Section>
        <Section footer="Removes them from every lease. This cannot be undone.">
          <Row title="Delete tenant" destructive chevron={false} onClick={() => { setActions(false); void handleDeleteTenant(); }} />
        </Section>
      </Sheet>

      <Sheet open={editingContact} onClose={() => { setEditingContact(false); load(); }} title="Contact"
        right={{ label: 'Save', onClick: () => void saveContact(), disabled: !contactForm.fullName, busy: savingContact }}>
        <Section>
          <Field label="Name"><input value={contactForm.fullName} onChange={e => setContactForm(f => ({ ...f, fullName: e.target.value }))} /></Field>
          <Field label="Phone"><input type="tel" inputMode="tel" value={contactForm.phone} onChange={e => setContactForm(f => ({ ...f, phone: e.target.value }))} /></Field>
          <Field label="Email"><input type="email" inputMode="email" autoCapitalize="off" value={contactForm.email} onChange={e => setContactForm(f => ({ ...f, email: e.target.value }))} /></Field>
        </Section>
        <Section header="Notes">
          <Field label=""><textarea value={contactForm.notes} onChange={e => setContactForm(f => ({ ...f, notes: e.target.value }))} /></Field>
        </Section>
      </Sheet>
    </Screen>
  );

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-1">
        <div>
          <BackLink fallback="/tenants" className="text-xs text-gray-500 hover:text-gray-300">&larr; Back</BackLink>
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
          {leases.map(lt => (
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
  // The rent field is the rent; utilities billed on top are added back when saving.
  const utilities = (lease.utilityCharges ?? []).reduce((s, c) => s + Number(c.amount), 0);
  const [form, setForm] = useState({
    rentAmount: String(Math.round((Number(lease.rentAmount ?? 0) - utilities) * 100) / 100),
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
  const phone = usePhone();

  async function save() {
    setSaving(true);
    try {
      await updateLease(lease.id, {
        rentAmount: parseFloat(form.rentAmount) ? Math.round((parseFloat(form.rentAmount) + utilities) * 100) / 100 : undefined,
        securityDeposit: form.securityDeposit ? parseFloat(form.securityDeposit) : null,
        startDate: form.startDate || null,
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
    void openUrl(url);
  }

  const arrears = Number(lease.arrearsBalance ?? 0);
  const term = lease.leaseType === 'FIXED_TERM' ? `${fmtDate(lease.startDate)} – ${fmtDate(lease.endDate)}` : (lease.startDate ? `Month-to-month from ${fmtDate(lease.startDate)}` : 'Month-to-month');
  const ordinal = (d: number) => `${d}${d === 1 || d === 21 || d === 31 ? 'st' : d === 2 || d === 22 ? 'nd' : d === 3 || d === 23 ? 'rd' : 'th'}`;

  if (phone) return (
    <>
      <Section header={[property?.nickname || property?.address || 'Lease', lease.unit?.unitLabel ? `Unit ${lease.unit.unitLabel}` : null].filter(Boolean).join(' · ')}
        action={property ? { label: 'Property', to: `/portfolio/${property.id}?tab=Tenants` } : undefined}>
        <Row title="Rent" chevron={false} value={<span className="strong">{money(lease.rentAmount)}/mo{lease.rentDueDay ? ` · ${ordinal(lease.rentDueDay)}` : ''}</span>} />
        <Row title="Status" chevron={false} value={<span className={lease.status === 'ACTIVE' ? 'ios-green' : lease.status === 'PENDING' ? 'ios-tint' : ''}>{lease.status.charAt(0) + lease.status.slice(1).toLowerCase()}</span>} />
        <Row title="Term" chevron={false} wrap subtitle={term} />
        {lease.status === 'ACTIVE' && lease.endDate && new Date(lease.endDate) < new Date() && <Row title="Holdover since" chevron={false} value={<span className="ios-red">{fmtDate(lease.endDate)}</span>} />}
        <Row title="Security deposit" chevron={false} value={money(lease.securityDeposit)} />
        <Row title="Arrears" chevron={false} value={<span className={arrears > 0 ? 'ios-red strong' : ''}>{money(arrears)}</span>} />
        {(lease.leaseTenants?.length ?? 0) > 1 && <Row title="On this lease" wrap chevron={false} subtitle={lease.leaseTenants!.map(lt => lt.tenant?.fullName).filter(Boolean).join(', ')} />}
        {(lease.lateFeeAmount != null || lease.lateFeePercent != null) && (
          <Row title="Late fee" chevron={false} value={`${lease.lateFeeAmount != null ? money(lease.lateFeeAmount) : `${lease.lateFeePercent}%`}${lease.lateFeeGraceDays ? ` after ${lease.lateFeeGraceDays}d` : ''}`} />
        )}
        {(lease.scheduledIncreases ?? []).filter(i => !i.applied).slice(0, 1).map(i => (
          <Row key={i.id} title="Next increase" chevron={false}
            value={<span className="ios-green">{fmtDate(i.effectiveDate)} → {i.newAmount != null ? money(i.newAmount) : i.percent != null ? `+${i.percent}${i.percentMax != null ? `–${i.percentMax}` : ''}%` : '—'}</span>} />
        ))}
        {(lease.utilityCharges?.length ?? 0) > 0 && <Row title="Utilities billed with rent" wrap chevron={false} subtitle={lease.utilityCharges!.map(u => `${u.category.toLowerCase()} ${money(u.amount)}`).join(', ')} />}
        {(lease.paymentAliases?.length ?? 0) > 0 && <Row title="Rent also arrives from" wrap chevron={false} subtitle={lease.paymentAliases!.map(a => a.name).join(', ')} />}
        {lease.notes && <Row title={lease.notes} wrap chevron={false} />}
        <Row title="Edit lease" tinted chevron={false} onClick={() => setEditing(true)} />
      </Section>

      <div className="ios-embedded" style={{ marginBottom: 24 }}>
        <LeaseSummary details={lease.termsJson} />
        <LeaseDocuments leaseId={lease.id} legacyUrl={lease.documentUrl} onLegacyRemoved={onChanged} />
        <UtilityReimbursementPanel leaseId={lease.id} />
      </div>

      {(lease.rentPayments?.length ?? 0) > 0 && (
        <Section header="Payments">
          {lease.rentPayments!.map(p => (
            <Row key={p.id} chevron={false} title={fmtDate(p.paidDate)} subtitle={[p.method, p.notes].filter(Boolean).join(' · ') || undefined}
              value={<span className="strong">{money(p.amount)}</span>} />
          ))}
        </Section>
      )}
      {maintenance.length > 0 && (
        <Section header="Maintenance during this lease">
          {maintenance.map(m => (
            <Row key={m.id} chevron={false} title={m.description} subtitle={[fmtDate(m.startDate), m.category].filter(Boolean).join(' · ')} value={money(m.cost)} />
          ))}
        </Section>
      )}

      <Sheet open={editing} onClose={() => setEditing(false)} title="Edit lease"
        right={{ label: 'Save', onClick: () => void save(), busy: saving }}>
        <Section>
          <Field label="Rent / mo"><input type="number" inputMode="decimal" value={form.rentAmount} onChange={e => setForm(f => ({ ...f, rentAmount: e.target.value }))} /></Field>
          <Field label="Deposit"><input type="number" inputMode="decimal" value={form.securityDeposit} onChange={e => setForm(f => ({ ...f, securityDeposit: e.target.value }))} /></Field>
          <Field label="Status">
            <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as any }))}>
              {['ACTIVE', 'ENDED', 'PENDING', 'TERMINATED'].map(st => <option key={st} value={st}>{st.charAt(0) + st.slice(1).toLowerCase()}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select value={form.leaseType} onChange={e => setForm(f => ({ ...f, leaseType: e.target.value as any }))}>
              <option value="MONTH_TO_MONTH">Month-to-month</option>
              <option value="FIXED_TERM">Fixed term</option>
            </select>
          </Field>
          <Field label="Starts"><input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} /></Field>
          <Field label="Ends"><input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} /></Field>
        </Section>
        <Section header="Notes">
          <Field label=""><textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
        </Section>
        <Section header="Lease agreement">
          {lease.documentUrl ? (
            <>
              <Row title="View lease agreement" onClick={() => void viewDocument()} />
              <Row title="Remove agreement" destructive chevron={false}
                onClick={async () => { if (confirm('Remove the lease agreement from this lease?')) { await deleteLeaseAgreement(lease.id); onChanged(); } }} />
            </>
          ) : (
            <label className="ios-row" style={{ cursor: 'pointer' }}>
              <span className="ios-row-title ios-tint">{uploading ? 'Uploading…' : 'Upload lease agreement (PDF)'}</span>
              <input type="file" accept="application/pdf" hidden disabled={uploading}
                onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0])} />
            </label>
          )}
        </Section>
      </Sheet>
    </>
  );

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-white">
            {property ? <Link to={`/portfolio/${property.id}`} className="hover:text-amber-400">{property.nickname || property.address}</Link> : 'Unknown property'}
            {lease.unit?.unitLabel && <span className="text-gray-500"> · Unit {lease.unit.unitLabel}</span>}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {lease.leaseType === 'FIXED_TERM' ? `${fmtDate(lease.startDate)} – ${fmtDate(lease.endDate)}` : (lease.startDate ? `Month-to-month from ${fmtDate(lease.startDate)}` : 'Month-to-month')}
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
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3 text-sm">
            <div><p className="text-xs text-gray-500">Rent</p><p className="text-white font-medium">{money(lease.rentAmount)}/mo{lease.rentDueDay ? <span className="text-xs text-gray-500 font-normal"> · due the {lease.rentDueDay}{lease.rentDueDay === 1 ? 'st' : lease.rentDueDay === 2 ? 'nd' : lease.rentDueDay === 3 ? 'rd' : 'th'}</span> : null}</p></div>
            <div><p className="text-xs text-gray-500">Security deposit</p><p className="text-gray-300">{money(lease.securityDeposit)}</p></div>
            <div><p className="text-xs text-gray-500">Arrears</p><p className={arrears > 0 ? 'text-red-400 font-medium' : 'text-gray-300'}>{money(arrears)}</p></div>
            {(lease.leaseTenants?.length ?? 0) > 1 && (
              <div><p className="text-xs text-gray-500">On this lease</p><p className="text-gray-300">{lease.leaseTenants!.map(lt => lt.tenant?.fullName).filter(Boolean).join(', ')}</p></div>
            )}
            {(lease.lateFeeAmount != null || lease.lateFeePercent != null) && (
              <div><p className="text-xs text-gray-500">Late fee</p><p className="text-gray-300">
                {lease.lateFeeAmount != null ? money(lease.lateFeeAmount) : `${lease.lateFeePercent}% of rent`}
                {lease.lateFeeGraceDays ? <span className="text-gray-500"> · after {lease.lateFeeGraceDays} day grace</span> : null}
              </p></div>
            )}
            {lease.status === 'ACTIVE' && lease.endDate && new Date(lease.endDate) < new Date() && (
              <div><p className="text-xs text-gray-500">Term</p><p className="text-red-400">Holdover since {fmtDate(lease.endDate)}</p></div>
            )}
            {(lease.scheduledIncreases ?? []).filter(i => !i.applied).slice(0, 1).map(i => (
              <div key={i.id}><p className="text-xs text-gray-500">Next increase</p><p className="text-emerald-400">
                {fmtDate(i.effectiveDate)} → {i.newAmount != null ? money(i.newAmount) : i.percent != null ? `+${i.percent}${i.percentMax != null ? `–${i.percentMax}` : ''}%` : '—'}
              </p></div>
            ))}
            {(lease.utilityCharges?.length ?? 0) > 0 && (
              <div><p className="text-xs text-gray-500">Utilities billed with rent</p><p className="text-gray-300">{lease.utilityCharges!.map(u => `${u.category.toLowerCase()} ${money(u.amount)}`).join(', ')}</p></div>
            )}
            {(lease.paymentAliases?.length ?? 0) > 0 && (
              <div><p className="text-xs text-gray-500">Rent also arrives from</p><p className="text-gray-300">{lease.paymentAliases!.map(a => a.name).join(', ')}</p></div>
            )}
            {lease.notes && <div className="sm:col-span-2 lg:col-span-3"><p className="text-xs text-gray-500">Notes</p><p className="text-gray-300">{lease.notes}</p></div>}
          </div>
          <LeaseSummary details={lease.termsJson} />
          <LeaseDocuments leaseId={lease.id} legacyUrl={lease.documentUrl} onLegacyRemoved={onChanged} />
        </>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
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

      {editing && (
        <div className="mt-3 flex items-center gap-2 text-xs">
          {lease.documentUrl ? (
            <>
              <button onClick={viewDocument} className="text-amber-400 hover:text-amber-300">📄 View lease agreement</button>
              <button onClick={async () => { if (confirm('Remove the lease agreement from this lease?')) { await deleteLeaseAgreement(lease.id); onChanged(); } }}
                className="text-gray-600 hover:text-red-400">Remove</button>
            </>
          ) : (
            <label className="text-gray-500 hover:text-gray-300 cursor-pointer">
              {uploading ? 'Uploading…' : '+ Upload lease agreement (PDF)'}
              <input type="file" accept="application/pdf" className="hidden" disabled={uploading}
                onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0])} />
            </label>
          )}
        </div>
      )}

      {/* Utility reimbursement — only for leases where the tenant repays a share */}
      <UtilityReimbursementPanel leaseId={lease.id} />

      {/* Payment history */}
      {lease.rentPayments && lease.rentPayments.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer">Payment history ({lease.rentPayments.length})</summary>
          <div className="overflow-x-auto">
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
          </div>
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


/**
 * The lease's attachments — agreement, application, ID, screening — the
 * same list the property hub's edit form keeps, shown here where the
 * tenant is looked up, with view, upload and remove. The pre-categorised
 * agreement link, when one exists and nothing else does, is shown too.
 */
function LeaseDocuments({ leaseId, legacyUrl, onLegacyRemoved }: { leaseId: string; legacyUrl?: string | null; onLegacyRemoved: () => void }) {
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [category, setCategory] = useState('LEASE');
  const [busy, setBusy] = useState(false);
  const reload = () => getLeaseDocuments(leaseId).then(setDocs).catch(() => setDocs([]));
  useEffect(() => { reload(); }, [leaseId]);

  async function upload(file: File) {
    setBusy(true);
    try {
      const base64 = await readFileAsBase64(file);
      await addLeaseDocument(leaseId, { fileData: base64, filename: file.name, category });
      await reload();
    } finally { setBusy(false); }
  }
  async function view(id: string) {
    const { url } = await getLeaseDocumentViewUrl(leaseId, id);
    window.open(url, '_blank');
  }
  async function remove(id: string) {
    if (!confirm('Delete this document?')) return;
    await deleteLeaseDocument(leaseId, id);
    await reload();
    onLegacyRemoved();
  }
  async function viewLegacy() {
    const { url } = await getLeaseDocumentUrl(leaseId);
    window.open(url, '_blank');
  }

  const categories = Object.entries(DOCUMENT_CATEGORY_LABELS).filter(([k]) => ['LEASE', 'APPLICATION', 'IDENTITY', 'SCREENING', 'OTHER'].includes(k));

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-1.5">
        <p className="text-xs text-gray-500">Documents</p>
        <select value={category} onChange={e => setCategory(e.target.value)} className="input-dark text-xs py-0.5">
          {categories.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <label className={`text-xs cursor-pointer ${busy ? 'text-gray-600' : 'text-amber-400 hover:text-amber-300'}`}>
          {busy ? 'Uploading…' : '+ Add file'}
          <input type="file" accept="application/pdf,image/*" className="hidden" disabled={busy}
            onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </div>
      {docs == null ? (
        <p className="text-xs text-gray-600">Loading…</p>
      ) : docs.length === 0 && !legacyUrl ? (
        <p className="text-xs text-gray-600">No documents attached</p>
      ) : (
        <div className="space-y-1">
          {docs.length === 0 && legacyUrl && (
            <div className="flex items-center gap-2 text-xs">
              <span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)' }}>Lease agreement</span>
              <button onClick={viewLegacy} className="text-gray-300 hover:text-amber-400">View</button>
              <button onClick={async () => { if (confirm('Remove the lease agreement from this lease?')) { await deleteLeaseAgreement(leaseId); onLegacyRemoved(); } }}
                className="text-gray-600 hover:text-red-400 ml-auto">✕</button>
            </div>
          )}
          {docs.map(d => (
            <div key={d.id} className="flex items-center gap-2 text-xs group">
              <span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)' }}>{DOCUMENT_CATEGORY_LABELS[d.category as keyof typeof DOCUMENT_CATEGORY_LABELS] ?? d.category}</span>
              <button onClick={() => view(d.id)} className="text-gray-300 hover:text-amber-400 truncate max-w-[260px]">{d.title}</button>
              <span className="text-gray-600">{fmtDate(d.createdAt)}</span>
              <button onClick={() => remove(d.id)} className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 ml-auto">✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
