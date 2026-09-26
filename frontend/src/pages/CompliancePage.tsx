import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getComplianceItems, readCitation, createComplianceItem, updateComplianceItem, deleteComplianceItem,
  complianceDocumentUrl, payComplianceItem, getProperties, type FilePayload,
} from '../api/client';
import type { ComplianceItem, ComplianceKind, ComplianceStatus, ComplianceViolation, Property } from '../types';
import { COMPLIANCE_KIND_LABELS, COMPLIANCE_STATUS_LABELS, CITATION_LEVEL_LABELS } from '../types';
import { PageHeader, EmptyState } from '../components/ui';
import { fmtDate, todayISO } from '../lib/date';
import { fmtMoney } from '../lib/money';
import { filesToPayload } from '../lib/files';
import { describeApiError } from '../lib/apiError';

/**
 * Citations, orders to comply, permits and inspections across every
 * property. A citation is a deadline first: the date to correct by, the
 * date to pay by, and what happens if either passes. Photograph or scan the
 * pages and Sollux fills in the form; check it and save.
 */

type Form = {
  id?: string; propertyId: string; kind: ComplianceKind; title: string; agency: string; caseNumber: string; referenceNumber: string;
  level: string; issuedDate: string; violationDate: string; dueDate: string; paymentDueDate: string; fineAmount: string; apn: string;
  escalation: string; status: ComplianceStatus; violations: ComplianceViolation[]; contactName: string; contactPhone: string; contactEmail: string; notes: string;
};

const EMPTY: Form = {
  propertyId: '', kind: 'CITATION', title: '', agency: '', caseNumber: '', referenceNumber: '', level: '', issuedDate: '', violationDate: '',
  dueDate: '', paymentDueDate: '', fineAmount: '', apn: '', escalation: '', status: 'OPEN', violations: [], contactName: '', contactPhone: '', contactEmail: '', notes: '',
};

const d10 = (v?: string | null) => (v ? String(v).slice(0, 10) : '');
const daysUntil = (iso?: string | null) => {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const due = new Date(y!, m! - 1, d!).getTime();
  const [ty, tm, td] = todayISO().split('-').map(Number);
  return Math.round((due - new Date(ty!, tm! - 1, td!).getTime()) / 86400000);
};
const OPEN: ComplianceStatus[] = ['OPEN', 'IN_PROGRESS', 'APPEALED'];

function Deadline({ label, iso, done }: { label: string; iso?: string | null; done: boolean }) {
  if (!iso) return null;
  const left = daysUntil(iso);
  const tone = done ? 'text-gray-500' : left == null ? 'text-gray-400' : left < 0 ? 'text-red-400' : left <= 7 ? 'text-amber-400' : 'text-gray-300';
  return (
    <p className={`text-xs ${tone}`}>
      {label} {fmtDate(iso, 'MMM d, yyyy')}
      {!done && left != null && <span className="ml-1">({left < 0 ? `${-left}d overdue` : left === 0 ? 'today' : `${left}d left`})</span>}
    </p>
  );
}

export default function CompliancePage({ propertyId: fixedPropertyId }: { propertyId?: string } = {}) {
  const [items, setItems] = useState<ComplianceItem[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [propFilter, setPropFilter] = useState(fixedPropertyId ?? '');
  const [form, setForm] = useState<Form | null>(null);
  const [pages, setPages] = useState<FilePayload[]>([]);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [paying, setPaying] = useState<{ id: string; amount: string; date: string; description: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [list, props] = await Promise.all([getComplianceItems(fixedPropertyId ? { propertyId: fixedPropertyId } : undefined), getProperties()]);
      setItems(list); setProperties(props);
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [fixedPropertyId]);

  const shown = useMemo(() => items
    .filter(i => (filter === 'open' ? OPEN.includes(i.status) : true))
    .filter(i => (propFilter ? i.propertyId === propFilter : true)), [items, filter, propFilter]);

  const openCount = items.filter(i => OPEN.includes(i.status)).length;
  const owedTotal = items.filter(i => OPEN.includes(i.status)).reduce((t, i) => t + (i.owed ?? 0), 0);
  const overdue = items.filter(i => OPEN.includes(i.status) && (daysUntil(i.dueDate) ?? 1) < 0).length;

  function startNew() {
    setForm({ ...EMPTY, propertyId: fixedPropertyId ?? propFilter ?? '' }); setPages([]); setError(null); setNote(null);
  }
  function startEdit(i: ComplianceItem) {
    setForm({
      id: i.id, propertyId: i.propertyId, kind: i.kind, title: i.title, agency: i.agency ?? '', caseNumber: i.caseNumber ?? '', referenceNumber: i.referenceNumber ?? '',
      level: i.level ?? '', issuedDate: d10(i.issuedDate), violationDate: d10(i.violationDate), dueDate: d10(i.dueDate), paymentDueDate: d10(i.paymentDueDate),
      fineAmount: i.fineAmount != null ? String(i.fineAmount) : '', apn: i.apn ?? '', escalation: i.escalation ?? '', status: i.status,
      violations: i.violations ?? [], contactName: i.contactName ?? '', contactPhone: i.contactPhone ?? '', contactEmail: i.contactEmail ?? '', notes: i.notes ?? '',
    });
    setPages([]); setError(null); setNote(null);
  }

  async function addPages(list: FileList | null) {
    const added = await filesToPayload(list);
    setPages(p => [...p, ...added]);
  }

  async function autofill() {
    if (!form || pages.length === 0) return;
    setReading(true); setError(null); setNote(null);
    try {
      const { fields: f, match } = await readCitation(pages);
      setForm(prev => prev && ({
        ...prev,
        kind: f.kind ?? prev.kind, title: f.title ?? prev.title, agency: f.agency ?? '', caseNumber: f.caseNumber ?? '', referenceNumber: f.referenceNumber ?? '',
        level: f.level ?? '', issuedDate: f.issuedDate ?? '', violationDate: f.violationDate ?? '', dueDate: f.dueDate ?? '', paymentDueDate: f.paymentDueDate ?? '',
        fineAmount: f.fineAmount != null ? String(f.fineAmount) : '', apn: f.apn ?? '', escalation: f.escalation ?? '', violations: f.violations ?? [],
        contactName: f.contactName ?? '', contactPhone: f.contactPhone ?? '', contactEmail: f.contactEmail ?? '', notes: f.notes ?? '',
        propertyId: prev.propertyId || (match?.propertyId ?? ''),
      }));
      setNote(match?.propertyId
        ? `Read ${pages.length} page${pages.length === 1 ? '' : 's'}. Matched ${match.propertyName} from the violation address${f.violationAddress ? ` (${f.violationAddress})` : ''} — check the fields, then save.`
        : `Read ${pages.length} page${pages.length === 1 ? '' : 's'}.${f.violationAddress ? ` No property matched "${f.violationAddress}" — pick it below.` : ''} Check the fields, then save.`);
    } catch (err) {
      setError(describeApiError(err, 'Could not read those pages.'));
    } finally { setReading(false); }
  }

  async function save() {
    if (!form) return;
    if (!form.propertyId) { setError('Pick the property.'); return; }
    if (!form.title.trim()) { setError('Give it a title.'); return; }
    setSaving(true); setError(null);
    const body = {
      propertyId: form.propertyId, kind: form.kind, title: form.title.trim(), agency: form.agency || null, caseNumber: form.caseNumber || null,
      referenceNumber: form.referenceNumber || null, level: form.level || null, issuedDate: form.issuedDate || null, violationDate: form.violationDate || null,
      dueDate: form.dueDate || null, paymentDueDate: form.paymentDueDate || null, fineAmount: form.fineAmount ? Number(form.fineAmount) : null,
      apn: form.apn || null, escalation: form.escalation || null, status: form.status, violations: form.violations,
      contactName: form.contactName || null, contactPhone: form.contactPhone || null, contactEmail: form.contactEmail || null, notes: form.notes || null,
      ...(pages.length ? { files: pages } : {}),
    };
    try {
      if (form.id) await updateComplianceItem(form.id, body); else await createComplianceItem(body);
      setForm(null); setPages([]); await load();
    } catch (err) {
      setError(describeApiError(err, 'Could not save.'));
    } finally { setSaving(false); }
  }

  async function setStatus(i: ComplianceItem, status: ComplianceStatus) {
    await updateComplianceItem(i.id, { status });
    await load();
  }

  async function openDoc(i: ComplianceItem, n: number) {
    const w = window.open('', '_blank');
    const url = await complianceDocumentUrl(i.id, n);
    if (w) w.location.href = url; else window.location.href = url;
  }

  async function recordPayment() {
    if (!paying) return;
    const amount = Number(paying.amount);
    if (!(amount > 0)) return;
    await payComplianceItem(paying.id, { amount, date: paying.date, description: paying.description || null });
    setPaying(null); await load();
  }

  const setF = (patch: Partial<Form>) => setForm(f => (f ? { ...f, ...patch } : f));
  const input = 'input-dark text-sm w-full';
  const label = 'text-xs text-gray-500 block mb-1';

  return (
    <div>
      {!fixedPropertyId && (
        <PageHeader
          title="Compliance"
          subtitle="Citations, orders to comply, permits and inspections — with their deadlines and fines"
          action={<button onClick={startNew} className="btn btn-primary text-xs">+ Add citation or notice</button>}
        />
      )}
      <div className={fixedPropertyId ? '' : 'px-6 py-5'}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <div className="stat-card"><p className="text-xs text-gray-500">Open</p><p className="text-lg font-semibold text-white">{openCount}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Past the correction date</p><p className={`text-lg font-semibold ${overdue ? 'text-red-400' : 'text-white'}`}>{overdue}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Fines still owed</p><p className="text-lg font-semibold text-white">{fmtMoney(owedTotal)}</p></div>
        </div>

        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <div className="flex gap-1">
            {(['open', 'all'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} className={`text-xs px-3 py-1.5 rounded-lg ${filter === f ? 'text-white' : 'text-gray-500'}`}
                style={{ background: filter === f ? 'rgba(255,255,255,0.08)' : 'transparent' }}>{f === 'open' ? 'Open' : 'All'}</button>
            ))}
          </div>
          {!fixedPropertyId && (
            <select value={propFilter} onChange={e => setPropFilter(e.target.value)} className="input-dark text-xs">
              <option value="">All properties</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
            </select>
          )}
          {fixedPropertyId && <button onClick={startNew} className="btn btn-primary text-xs ml-auto">+ Add citation or notice</button>}
        </div>

        {/* ── Form ── */}
        {form && (
          <div className="card p-4 mb-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-white">{form.id ? 'Edit' : 'New'} {COMPLIANCE_KIND_LABELS[form.kind].toLowerCase()}</p>
              <button onClick={() => setForm(null)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
            </div>

            <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)' }}>
              <p className="text-xs text-gray-400 mb-2">
                Add the pages — a scanned PDF, or a photo of each page — then let Sollux fill the form in.
                {form.id ? ' New pages are added to the ones already attached.' : ''}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <label className="btn text-xs cursor-pointer">
                  Add pages or photos
                  <input type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={e => { void addPages(e.target.files); e.target.value = ''; }} />
                </label>
                {pages.map((p, i) => (
                  <span key={i} className="text-xs text-gray-400 px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.05)' }}>
                    {p.name} <button onClick={() => setPages(ps => ps.filter((_, j) => j !== i))} className="text-gray-600 hover:text-red-400 ml-1">✕</button>
                  </span>
                ))}
                {pages.length > 0 && (
                  <button onClick={autofill} disabled={reading} className="btn btn-primary text-xs disabled:opacity-50">{reading ? 'Reading…' : 'Fill in from pages'}</button>
                )}
              </div>
              {note && <p className="text-xs text-emerald-400 mt-2">{note}</p>}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <span className={label}>Property</span>
                <select value={form.propertyId} onChange={e => setF({ propertyId: e.target.value })} className={input}>
                  <option value="">— Pick —</option>
                  {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}{p.city ? `, ${p.city}` : ''}</option>)}
                </select>
              </div>
              <div>
                <span className={label}>Kind</span>
                <select value={form.kind} onChange={e => setF({ kind: e.target.value as ComplianceKind })} className={input}>
                  {(Object.keys(COMPLIANCE_KIND_LABELS) as ComplianceKind[]).map(k => <option key={k} value={k}>{COMPLIANCE_KIND_LABELS[k]}</option>)}
                </select>
              </div>
              <div>
                <span className={label}>Status</span>
                <select value={form.status} onChange={e => setF({ status: e.target.value as ComplianceStatus })} className={input}>
                  {(Object.keys(COMPLIANCE_STATUS_LABELS) as ComplianceStatus[]).map(k => <option key={k} value={k}>{COMPLIANCE_STATUS_LABELS[k]}</option>)}
                </select>
              </div>
              <div className="md:col-span-2"><span className={label}>Title</span><input className={input} value={form.title} onChange={e => setF({ title: e.target.value })} placeholder="e.g. Weeds, trash and fence — administrative citation" /></div>
              <div><span className={label}>Agency</span><input className={input} value={form.agency} onChange={e => setF({ agency: e.target.value })} placeholder="City of Redlands Code Enforcement" /></div>
              <div><span className={label}>Case #</span><input className={input} value={form.caseNumber} onChange={e => setF({ caseNumber: e.target.value })} /></div>
              <div><span className={label}>Citation / notice #</span><input className={input} value={form.referenceNumber} onChange={e => setF({ referenceNumber: e.target.value })} /></div>
              <div>
                <span className={label}>Level</span>
                <select value={form.level} onChange={e => setF({ level: e.target.value })} className={input}>
                  <option value="">—</option>
                  {Object.entries(CITATION_LEVEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div><span className={label}>Violation observed</span><input type="date" className={input} value={form.violationDate} onChange={e => setF({ violationDate: e.target.value })} /></div>
              <div><span className={label}>Issued</span><input type="date" className={input} value={form.issuedDate} onChange={e => setF({ issuedDate: e.target.value })} /></div>
              <div><span className={label}>{form.kind === 'PERMIT' ? 'Expires' : form.kind === 'INSPECTION' ? 'Inspection date' : 'Correct by'}</span><input type="date" className={input} value={form.dueDate} onChange={e => setF({ dueDate: e.target.value })} /></div>
              <div><span className={label}>Pay fine by</span><input type="date" className={input} value={form.paymentDueDate} onChange={e => setF({ paymentDueDate: e.target.value })} /></div>
              <div><span className={label}>{form.kind === 'PERMIT' ? 'Permit fee' : 'Total fine'}</span><input type="number" step="0.01" className={input} value={form.fineAmount} onChange={e => setF({ fineAmount: e.target.value })} placeholder="0.00" /></div>
              <div><span className={label}>APN</span><input className={input} value={form.apn} onChange={e => setF({ apn: e.target.value })} /></div>
              <div className="md:col-span-3"><span className={label}>If ignored</span><input className={input} value={form.escalation} onChange={e => setF({ escalation: e.target.value })} placeholder="e.g. $100 citation after 30 days, rising every 30 days" /></div>
              <div><span className={label}>Contact</span><input className={input} value={form.contactName} onChange={e => setF({ contactName: e.target.value })} /></div>
              <div><span className={label}>Phone</span><input className={input} value={form.contactPhone} onChange={e => setF({ contactPhone: e.target.value })} /></div>
              <div><span className={label}>Email</span><input className={input} value={form.contactEmail} onChange={e => setF({ contactEmail: e.target.value })} /></div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500">Violations</span>
                <button onClick={() => setF({ violations: [...form.violations, { code: '', description: '', correction: '', fine: null }] })} className="text-xs text-amber-400 hover:text-amber-300">+ Add</button>
              </div>
              {form.violations.length === 0 && <p className="text-xs text-gray-600">None listed.</p>}
              <div className="space-y-2">
                {form.violations.map((v, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2">
                    <input className={`${input} col-span-3`} placeholder="Code section" value={v.code ?? ''} onChange={e => setF({ violations: form.violations.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)) })} />
                    <input className={`${input} col-span-6`} placeholder="What must be corrected" value={v.correction || v.description || ''} onChange={e => setF({ violations: form.violations.map((x, j) => (j === i ? { ...x, correction: e.target.value } : x)) })} />
                    <input type="number" step="0.01" className={`${input} col-span-2`} placeholder="Fine" value={v.fine ?? ''} onChange={e => setF({ violations: form.violations.map((x, j) => (j === i ? { ...x, fine: e.target.value ? Number(e.target.value) : null } : x)) })} />
                    <button onClick={() => setF({ violations: form.violations.filter((_, j) => j !== i) })} className="col-span-1 text-gray-600 hover:text-red-400 text-xs">✕</button>
                  </div>
                ))}
              </div>
            </div>

            <div><span className={label}>Notes</span><textarea rows={2} className={input} value={form.notes} onChange={e => setF({ notes: e.target.value })} /></div>

            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              {form.id && (
                <button onClick={async () => { if (confirm('Delete this record? Payments logged against it stay as expenses.')) { await deleteComplianceItem(form.id!); setForm(null); await load(); } }}
                  className="text-xs text-red-400 hover:text-red-300 mr-auto">Delete</button>
              )}
              <button onClick={() => setForm(null)} className="btn text-xs">Cancel</button>
              <button onClick={save} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        )}

        {/* ── List ── */}
        {loading ? <p className="text-sm text-gray-500">Loading…</p>
          : shown.length === 0 ? (
            <EmptyState icon="📋" title={filter === 'open' ? 'Nothing open' : 'Nothing recorded'} body="Add a citation, an order to comply, a permit or an inspection — photograph the pages and Sollux fills in the rest." />
          ) : (
            <div className="space-y-2">
              {shown.map(i => {
                const done = !OPEN.includes(i.status);
                const fine = i.fineAmount != null ? Number(i.fineAmount) : null;
                return (
                  <div key={i.id} className="rounded-xl px-5 py-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex items-start gap-4 flex-wrap">
                      <div className="flex-1 min-w-[240px]">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="pill pill-gray">{COMPLIANCE_KIND_LABELS[i.kind]}</span>
                          {i.level && <span className="pill pill-amber">{CITATION_LEVEL_LABELS[i.level]}</span>}
                          <span className={`pill ${done ? 'pill-green' : i.status === 'APPEALED' ? 'pill-blue' : 'pill-red'}`}>{COMPLIANCE_STATUS_LABELS[i.status]}</span>
                        </div>
                        <p className="text-sm font-semibold text-white mt-1.5">{i.title}</p>
                        <p className="text-xs text-gray-500">
                          {i.property && !fixedPropertyId && <Link to={`/portfolio/${i.property.id}`} className="hover:text-gray-300">{i.property.nickname || i.property.address}</Link>}
                          {i.agency ? ` · ${i.agency}` : ''}{i.caseNumber ? ` · case ${i.caseNumber}` : ''}{i.referenceNumber ? ` · #${i.referenceNumber}` : ''}
                        </p>
                        {i.violations && i.violations.length > 0 && (
                          <details className="mt-1.5">
                            <summary className="text-xs text-gray-500 cursor-pointer">{i.violations.length} violation{i.violations.length === 1 ? '' : 's'}</summary>
                            <ul className="mt-1 space-y-1">
                              {i.violations.map((v, n) => (
                                <li key={n} className="text-xs text-gray-400 flex gap-2">
                                  <span className="text-gray-500 flex-shrink-0 w-40 truncate" title={v.code ?? ''}>{v.code}</span>
                                  <span className="flex-1">{v.correction || v.description}</span>
                                  {v.fine != null && <span className="text-gray-300">{fmtMoney(v.fine)}</span>}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {i.escalation && !done && <p className="text-xs text-amber-400/80 mt-1">If ignored: {i.escalation}</p>}
                        {(i.documents ?? []).length > 0 && (
                          <p className="text-xs mt-1">
                            {(i.documents ?? []).map((d, n) => (
                              <button key={n} onClick={() => openDoc(i, n)} className="text-amber-400 hover:text-amber-300 mr-3">📄 {(i.documents ?? []).length > 1 ? `Page ${n + 1}` : 'View document'}</button>
                            ))}
                          </p>
                        )}
                      </div>
                      <div className="w-48 space-y-0.5">
                        <Deadline label="Correct by" iso={i.kind === 'PERMIT' ? null : i.dueDate} done={done} />
                        <Deadline label={i.kind === 'PERMIT' ? 'Expires' : 'Inspection'} iso={i.kind === 'PERMIT' || i.kind === 'INSPECTION' ? i.dueDate : null} done={done} />
                        <Deadline label="Pay by" iso={i.paymentDueDate} done={done || (i.owed ?? 1) <= 0.01} />
                        {i.issuedDate && <p className="text-xs text-gray-600">Issued {fmtDate(i.issuedDate, 'MMM d, yyyy')}</p>}
                        {i.resolvedDate && <p className="text-xs text-emerald-500">Resolved {fmtDate(i.resolvedDate, 'MMM d, yyyy')}</p>}
                      </div>
                      <div className="w-32 text-right">
                        {fine != null && fine > 0 ? (
                          <>
                            <p className="text-base font-semibold text-white">{fmtMoney(fine)}</p>
                            {(i.paid ?? 0) > 0 && <p className="text-xs text-emerald-500">{fmtMoney(i.paid)} paid</p>}
                            {(i.owed ?? 0) > 0.01 && <p className="text-xs text-red-400">{fmtMoney(i.owed)} owed</p>}
                          </>
                        ) : <p className="text-xs text-gray-500">{i.level === 'WARNING' ? 'Warning — no fine' : 'No fine'}</p>}
                      </div>
                      <div className="flex flex-col gap-1.5 items-end">
                        <div className="flex gap-1.5">
                          <button onClick={() => startEdit(i)} className="btn text-xs">Edit</button>
                          <button onClick={() => setPaying({ id: i.id, amount: i.owed ? String(i.owed) : '', date: todayISO(), description: '' })} className="btn text-xs">Log payment</button>
                        </div>
                        {!done
                          ? <button onClick={() => setStatus(i, 'RESOLVED')} className="text-xs text-emerald-400 hover:text-emerald-300">✓ Mark resolved</button>
                          : <button onClick={() => setStatus(i, 'OPEN')} className="text-xs text-gray-500 hover:text-gray-300">↺ Reopen</button>}
                      </div>
                    </div>
                    {paying?.id === i.id && (
                      <div className="mt-3 pt-3 flex items-end gap-2 flex-wrap" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                        <div><span className={label}>Amount</span><input type="number" step="0.01" className="input-dark text-sm w-32" value={paying.amount} onChange={e => setPaying({ ...paying, amount: e.target.value })} /></div>
                        <div><span className={label}>Date</span><input type="date" className="input-dark text-sm" value={paying.date} onChange={e => setPaying({ ...paying, date: e.target.value })} /></div>
                        <div className="flex-1 min-w-[200px]"><span className={label}>Note (optional)</span><input className="input-dark text-sm w-full" value={paying.description} onChange={e => setPaying({ ...paying, description: e.target.value })} placeholder={i.kind === 'PERMIT' ? 'Permit fee' : 'Fine paid to City Treasurer'} /></div>
                        <button onClick={() => setPaying(null)} className="btn text-xs">Cancel</button>
                        <button onClick={recordPayment} className="btn btn-primary text-xs">Save payment</button>
                        <p className="text-xs text-gray-600 w-full">Saved as a {i.kind === 'PERMIT' ? 'Permits' : 'Citations & Fines'} expense on the property, linked to this record.</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
}
