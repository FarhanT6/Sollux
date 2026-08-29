import { useEffect, useMemo, useState } from 'react';
import {
  getLegalMatters, getLegalSummary, createLegalMatter, updateLegalMatter, deleteLegalMatter,
  addLegalEvent, deleteLegalEvent, addLegalFee, updateLegalFee, deleteLegalFee,
  getLegalDocuments, addLegalDocument, getLegalDocumentUrl, deleteLegalDocument,
  getProperties, getLeases,
} from '../api/client';
import type { LegalMatter, LegalSummary, LegalFee, Property, Lease, Document, DocumentCategory } from '../types';
import {
  LEGAL_MATTER_TYPES, LEGAL_STATUSES, LEGAL_STATUS_LABELS, LEGAL_CLOSED_STATUSES,
  LEGAL_EVENT_TYPES, LEGAL_EVENT_LABELS, LEGAL_FEE_CATEGORIES, LEGAL_FEE_LABELS,
  LEGAL_PRIORITIES, LEGAL_DOC_CATEGORIES, DOCUMENT_CATEGORY_LABELS,
} from '../types';
import { PageHeader } from '../components/ui';
import { fmtDate } from '../lib/date';

const money = (n?: number | string | null) =>
  n == null || n === '' ? '—'
    : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const today = () => new Date().toISOString().slice(0, 10);

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve((e.target!.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Status drives the pill colour: red while something is actively against you,
// amber while it is live but quiet, green once it is finished.
function statusPill(status: string): string {
  if (['SETTLED', 'CLOSED', 'DISMISSED'].includes(status)) return 'pill-green';
  if (['JUDGMENT', 'IN_LITIGATION', 'AWAITING_HEARING', 'APPEAL', 'COLLECTIONS'].includes(status)) return 'pill-red';
  if (status === 'ON_HOLD') return 'pill-gray';
  return 'pill-amber';
}

const PRIORITY_PILL: Record<string, string> = {
  URGENT: 'pill-red', HIGH: 'pill-amber', MEDIUM: 'pill-gray', LOW: 'pill-gray',
};

const EMPTY_FORM = {
  title: '', matterType: 'Eviction', status: 'OPEN', priority: 'MEDIUM',
  propertyId: '', leaseId: '',
  filedDate: '', closedDate: '', nextHearingDate: '', responseDueDate: '', statuteDeadline: '',
  attorney: '', attorneyFirm: '', attorneyEmail: '', attorneyPhone: '',
  court: '', jurisdiction: '', judge: '', caseNumber: '',
  opposingParty: '', opposingCounsel: '',
  claimAmount: '', judgmentAmount: '', amountCollected: '', settlementAmount: '',
  outcome: '', description: '', notes: '',
};
type MatterForm = typeof EMPTY_FORM;

export default function LegalPage({ embedded, propertyId }: { embedded?: boolean; propertyId?: string } = {}) {
  const [matters, setMatters] = useState<LegalMatter[]>([]);
  const [summary, setSummary] = useState<LegalSummary | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [loading, setLoading] = useState(true);

  const [showClosed, setShowClosed] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);  // matter id, or 'new'
  const [form, setForm] = useState<MatterForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  async function load() {
    const [m, s] = await Promise.all([
      getLegalMatters(propertyId ? { propertyId } : undefined),
      getLegalSummary(),
    ]);
    setMatters(m);
    setSummary(s);
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([
      load(),
      getProperties().then(setProperties),
      getLeases({ status: 'ACTIVE' }).then(setLeases),
    ]).finally(() => setLoading(false));
  }, [propertyId]);

  const visible = useMemo(() => {
    let list = matters;
    if (!showClosed) list = list.filter(m => !LEGAL_CLOSED_STATUSES.includes(m.status));
    if (typeFilter) list = list.filter(m => m.matterType === typeFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(m =>
        [m.title, m.caseNumber, m.opposingParty, m.attorney, m.attorneyFirm, m.court, m.matterType]
          .some(v => v?.toLowerCase().includes(q)));
    }
    return list;
  }, [matters, showClosed, typeFilter, search]);

  const typesPresent = useMemo(
    () => [...new Set(matters.map(m => m.matterType))].sort(), [matters]);

  function openNew() {
    setForm({ ...EMPTY_FORM, propertyId: propertyId ?? '' });
    setEditing('new');
  }

  function openEdit(m: LegalMatter) {
    setForm({
      title: m.title, matterType: m.matterType, status: m.status, priority: m.priority ?? 'MEDIUM',
      propertyId: m.propertyId ?? '', leaseId: m.leaseId ?? '',
      filedDate: m.filedDate?.slice(0, 10) ?? '',
      closedDate: m.closedDate?.slice(0, 10) ?? '',
      nextHearingDate: m.nextHearingDate?.slice(0, 10) ?? '',
      responseDueDate: m.responseDueDate?.slice(0, 10) ?? '',
      statuteDeadline: m.statuteDeadline?.slice(0, 10) ?? '',
      attorney: m.attorney ?? '', attorneyFirm: m.attorneyFirm ?? '',
      attorneyEmail: m.attorneyEmail ?? '', attorneyPhone: m.attorneyPhone ?? '',
      court: m.court ?? '', jurisdiction: m.jurisdiction ?? '', judge: m.judge ?? '',
      caseNumber: m.caseNumber ?? '',
      opposingParty: m.opposingParty ?? '', opposingCounsel: m.opposingCounsel ?? '',
      claimAmount: m.claimAmount != null ? String(m.claimAmount) : '',
      judgmentAmount: m.judgmentAmount != null ? String(m.judgmentAmount) : '',
      amountCollected: m.amountCollected != null ? String(m.amountCollected) : '',
      settlementAmount: m.settlementAmount != null ? String(m.settlementAmount) : '',
      outcome: m.outcome ?? '', description: m.description ?? '', notes: m.notes ?? '',
    });
    setEditing(m.id);
  }

  async function saveMatter() {
    if (!form.title.trim()) return;
    // Blank string means "not set" for every optional field; sending "" would
    // store an empty value or fail date parsing.
    const num = (v: string) => (v === '' ? null : Number(v));
    const str = (v: string) => (v.trim() === '' ? null : v.trim());
    const payload: any = {
      title: form.title.trim(), matterType: form.matterType, status: form.status,
      priority: form.priority || null,
      propertyId: str(form.propertyId), leaseId: str(form.leaseId),
      filedDate: form.filedDate || null, closedDate: form.closedDate || null,
      nextHearingDate: form.nextHearingDate || null,
      responseDueDate: form.responseDueDate || null,
      statuteDeadline: form.statuteDeadline || null,
      attorney: str(form.attorney), attorneyFirm: str(form.attorneyFirm),
      attorneyEmail: str(form.attorneyEmail), attorneyPhone: str(form.attorneyPhone),
      court: str(form.court), jurisdiction: str(form.jurisdiction), judge: str(form.judge),
      caseNumber: str(form.caseNumber),
      opposingParty: str(form.opposingParty), opposingCounsel: str(form.opposingCounsel),
      claimAmount: num(form.claimAmount), judgmentAmount: num(form.judgmentAmount),
      amountCollected: num(form.amountCollected), settlementAmount: num(form.settlementAmount),
      outcome: str(form.outcome), description: str(form.description), notes: str(form.notes),
    };
    setSaving(true);
    try {
      if (editing === 'new') {
        const created = await createLegalMatter(payload);
        setExpanded(created.id);
      } else if (editing) {
        await updateLegalMatter(editing, payload);
      }
      setEditing(null);
      await load();
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Could not save that matter.');
    } finally { setSaving(false); }
  }

  async function removeMatter(m: LegalMatter) {
    const counts = [
      m.events?.length ? `${m.events.length} timeline entries` : '',
      m.fees?.length ? `${m.fees.length} fee records` : '',
    ].filter(Boolean);
    const extra = counts.length ? `\n\nThis also deletes ${counts.join(' and ')}.` : '';
    if (!confirm(`Delete "${m.title}"?${extra}\n\nUploaded documents are kept and unlinked. This cannot be undone.`)) return;
    await deleteLegalMatter(m.id);
    await load();
  }

  if (loading) return <div className="px-6 py-12 text-center text-sm text-gray-500">Loading…</div>;

  return (
    <div className={embedded ? '' : ''}>
      {!embedded && (
        <PageHeader title="Legal" subtitle="Evictions, lawsuits, contracts, counsel and court costs" />
      )}

      <div className={embedded ? 'space-y-4' : 'px-6 py-5 space-y-4'}>
        {summary && !propertyId && <LegalSummaryCards summary={summary} />}

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search title, case #, party, attorney…"
            className="input-dark text-xs flex-1 min-w-48" />
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="input-dark text-xs">
            <option value="">All types</option>
            {typesPresent.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-gray-400">
            <input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} />
            Show closed
          </label>
          <button onClick={openNew} className="btn btn-primary text-xs">+ New matter</button>
        </div>

        {editing === 'new' && (
          <MatterForm form={form} setForm={setForm} properties={properties} leases={leases}
            saving={saving} onSave={saveMatter} onCancel={() => setEditing(null)} isNew />
        )}

        {visible.length === 0 ? (
          <div className="text-center py-12 text-sm text-gray-500">
            {matters.length === 0
              ? 'No legal matters yet. Track evictions, lawsuits, contracts and attorney costs here.'
              : 'No matters match those filters.'}
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map(m => (
              <MatterCard
                key={m.id} matter={m}
                expanded={expanded === m.id}
                onToggle={() => setExpanded(expanded === m.id ? null : m.id)}
                editing={editing === m.id}
                form={form} setForm={setForm} saving={saving}
                properties={properties} leases={leases}
                onEdit={() => openEdit(m)}
                onSave={saveMatter}
                onCancelEdit={() => setEditing(null)}
                onDelete={() => removeMatter(m)}
                onChanged={load}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Summary ────────────────────────────────────────────────────────────────

function LegalSummaryCards({ summary }: { summary: LegalSummary }) {
  const uncollected = summary.judgmentsAwarded - summary.judgmentsCollected;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Stat label="Open matters" value={String(summary.openMatters)}
          sub={summary.totalMatters > summary.openMatters ? `${summary.totalMatters} total` : undefined} />
        <Stat label="Legal costs" value={money(summary.totalFees)} tone={summary.totalFees > 0 ? 'red' : undefined}
          sub={summary.unpaidFees > 0 ? `${money(summary.unpaidFees)} unpaid` : 'all paid'} />
        <Stat label="Claim exposure" value={money(summary.claimExposure)}
          tone={summary.claimExposure > 0 ? 'amber' : undefined} sub="on open matters" />
        <Stat label="Judgments" value={money(summary.judgmentsAwarded)} tone="green"
          sub={uncollected > 0 ? `${money(uncollected)} uncollected` : 'fully collected'} />
      </div>

      {(summary.overdueDeadlines > 0 || summary.upcoming.length > 0) && (
        <div className="card p-3">
          <p className="text-xs font-medium text-gray-300 mb-2">
            Deadlines
            {summary.overdueDeadlines > 0 && (
              <span className="text-red-400"> · {summary.overdueDeadlines} already passed</span>
            )}
          </p>
          {summary.upcoming.length === 0 ? (
            <p className="text-xs text-gray-600">Nothing due in the next 30 days</p>
          ) : (
            <div className="space-y-1">
              {summary.upcoming.map((u, i) => (
                <p key={i} className="text-xs text-gray-400">
                  <span className="text-amber-400">{fmtDate(u.date)}</span>
                  {' · '}{u.kind} — {u.title}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'red' | 'green' | 'amber';
}) {
  const color = tone === 'red' ? 'text-red-400' : tone === 'green' ? 'text-emerald-400'
    : tone === 'amber' ? 'text-amber-400' : 'text-white';
  return (
    <div className="card px-4 py-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-lg font-semibold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-600">{sub}</p>}
    </div>
  );
}

// ─── Matter card ────────────────────────────────────────────────────────────

function MatterCard({
  matter: m, expanded, onToggle, editing, form, setForm, saving, properties, leases,
  onEdit, onSave, onCancelEdit, onDelete, onChanged,
}: {
  matter: LegalMatter; expanded: boolean; onToggle: () => void; editing: boolean;
  form: MatterForm; setForm: (f: MatterForm | ((f: MatterForm) => MatterForm)) => void;
  saving: boolean; properties: Property[]; leases: Lease[];
  onEdit: () => void; onSave: () => void; onCancelEdit: () => void;
  onDelete: () => void; onChanged: () => Promise<void>;
}) {
  const fees = m.fees ?? [];
  const totalFees = fees.reduce((s, f) => s + Number(f.amount), 0);
  const unpaidFees = fees.filter(f => !f.isPaid).reduce((s, f) => s + Number(f.amount), 0);
  const tenants = m.lease?.leaseTenants?.map(lt => lt.tenant.fullName).join(', ');

  const now = new Date();
  const overdue = (d?: string | null) => d != null && new Date(d) < now;

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <button onClick={onToggle} className="text-sm font-semibold text-white hover:text-amber-400 text-left">
                {m.title}
              </button>
              <span className={`pill text-xs ${statusPill(m.status)}`}>
                {LEGAL_STATUS_LABELS[m.status] ?? m.status}
              </span>
              {m.priority && m.priority !== 'MEDIUM' && (
                <span className={`pill text-xs ${PRIORITY_PILL[m.priority] ?? 'pill-gray'}`}>{m.priority}</span>
              )}
            </div>
            <p className="text-xs text-gray-500">
              {m.matterType}
              {m.caseNumber && ` · Case ${m.caseNumber}`}
              {m.property && ` · ${m.property.nickname || m.property.address}`}
              {tenants && ` · ${tenants}`}
            </p>
            {m.opposingParty && <p className="text-xs text-gray-600">v. {m.opposingParty}</p>}
            <div className="flex flex-wrap gap-x-3 text-xs mt-1">
              {m.nextHearingDate && (
                <span className={overdue(m.nextHearingDate) ? 'text-gray-600' : 'text-amber-400'}>
                  Hearing {fmtDate(m.nextHearingDate)}
                </span>
              )}
              {m.responseDueDate && (
                <span className={overdue(m.responseDueDate) ? 'text-red-400' : 'text-gray-400'}>
                  Response due {fmtDate(m.responseDueDate)}
                </span>
              )}
              {m.statuteDeadline && (
                <span className={overdue(m.statuteDeadline) ? 'text-red-400' : 'text-gray-400'}>
                  Deadline {fmtDate(m.statuteDeadline)}
                </span>
              )}
            </div>
          </div>

          <div className="text-right flex-shrink-0">
            {m.claimAmount != null && <p className="text-sm font-semibold text-white">{money(m.claimAmount)} claimed</p>}
            {m.judgmentAmount != null && <p className="text-xs text-emerald-400">{money(m.judgmentAmount)} judgment</p>}
            {m.settlementAmount != null && <p className="text-xs text-emerald-400">{money(m.settlementAmount)} settled</p>}
            {totalFees > 0 && (
              <p className="text-xs text-red-400">
                {money(totalFees)} costs{unpaidFees > 0 && ` · ${money(unpaidFees)} unpaid`}
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-3 mt-2 text-xs">
          <button onClick={onToggle} className="text-amber-400 hover:text-amber-300">
            {expanded ? 'Hide detail' : 'Detail'}
          </button>
          <button onClick={onEdit} className="text-gray-500 hover:text-gray-300">Edit</button>
          <button onClick={onDelete} className="text-gray-600 hover:text-red-400">Delete</button>
        </div>
      </div>

      {editing && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <MatterForm form={form} setForm={setForm} properties={properties} leases={leases}
            saving={saving} onSave={onSave} onCancel={onCancelEdit} />
        </div>
      )}

      {expanded && !editing && (
        <MatterDetail matter={m} onChanged={onChanged} />
      )}
    </div>
  );
}

// ─── Detail: timeline, fees, documents ──────────────────────────────────────

function MatterDetail({ matter: m, onChanged }: { matter: LegalMatter; onChanged: () => Promise<void> }) {
  const [docs, setDocs] = useState<Document[]>([]);
  const [uploading, setUploading] = useState(false);
  const [docCategory, setDocCategory] = useState('LEGAL');
  const [evForm, setEvForm] = useState({ date: today(), eventType: 'HEARING', title: '', notes: '', isCompleted: true });
  const [feeForm, setFeeForm] = useState({
    date: today(), category: 'HOURLY', description: '', amount: '', hours: '', hourlyRate: '',
    payee: '', invoiceNumber: '', isPaid: false,
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => { getLegalDocuments(m.id).then(setDocs); }, [m.id]);

  async function saveEvent() {
    if (!evForm.title.trim()) return;
    setBusy(true);
    try {
      await addLegalEvent(m.id, { ...evForm, title: evForm.title.trim() } as any);
      setEvForm({ date: today(), eventType: 'HEARING', title: '', notes: '', isCompleted: true });
      await onChanged();
    } finally { setBusy(false); }
  }

  async function saveFee() {
    const amount = Number(feeForm.amount);
    if (!feeForm.amount || Number.isNaN(amount)) return;
    setBusy(true);
    try {
      await addLegalFee(m.id, {
        date: feeForm.date, category: feeForm.category,
        description: feeForm.description || null, amount,
        hours: feeForm.hours ? Number(feeForm.hours) : null,
        hourlyRate: feeForm.hourlyRate ? Number(feeForm.hourlyRate) : null,
        payee: feeForm.payee || null, invoiceNumber: feeForm.invoiceNumber || null,
        isPaid: feeForm.isPaid,
      } as any);
      setFeeForm({ date: today(), category: 'HOURLY', description: '', amount: '', hours: '', hourlyRate: '', payee: '', invoiceNumber: '', isPaid: false });
      await onChanged();
    } finally { setBusy(false); }
  }

  // Hours × rate is the number people actually have off an invoice; filling the
  // total from it saves re-doing the arithmetic, but never overwrites a total
  // that was typed in directly.
  function syncFeeAmount(next: typeof feeForm) {
    const h = Number(next.hours), r = Number(next.hourlyRate);
    if (next.category === 'HOURLY' && h > 0 && r > 0) next.amount = String(Math.round(h * r * 100) / 100);
    return next;
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const fileData = await readFileAsBase64(file);
      await addLegalDocument(m.id, { fileData, filename: file.name, category: docCategory });
      setDocs(await getLegalDocuments(m.id));
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Could not upload that document.');
    } finally { setUploading(false); }
  }

  async function openDoc(docId: string) {
    const { url } = await getLegalDocumentUrl(m.id, docId);
    window.open(url, '_blank');
  }

  async function removeDoc(docId: string, title: string) {
    if (!confirm(`Delete "${title}"?`)) return;
    await deleteLegalDocument(m.id, docId);
    setDocs(await getLegalDocuments(m.id));
  }

  async function toggleFeePaid(fee: LegalFee) {
    await updateLegalFee(m.id, fee.id, { isPaid: !fee.isPaid } as any);
    await onChanged();
  }

  const events = m.events ?? [];
  const fees = m.fees ?? [];
  const sectionStyle = { borderTop: '1px solid rgba(255,255,255,0.06)' };

  return (
    <div style={{ background: 'rgba(255,255,255,0.02)' }}>
      {/* Case facts */}
      <div className="px-4 py-3" style={sectionStyle}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2 text-xs">
          <Field label="Counsel" value={[m.attorney, m.attorneyFirm].filter(Boolean).join(' · ')} />
          <Field label="Contact" value={[m.attorneyEmail, m.attorneyPhone].filter(Boolean).join(' · ')} />
          <Field label="Court" value={[m.court, m.jurisdiction].filter(Boolean).join(' · ')} />
          <Field label="Judge" value={m.judge} />
          <Field label="Opposing counsel" value={m.opposingCounsel} />
          <Field label="Filed" value={m.filedDate ? fmtDate(m.filedDate) : null} />
          <Field label="Closed" value={m.closedDate ? fmtDate(m.closedDate) : null} />
          <Field label="Collected" value={m.amountCollected != null ? money(m.amountCollected) : null} />
          <Field label="Outcome" value={m.outcome} />
        </div>
        {m.description && <p className="text-xs text-gray-400 mt-2 whitespace-pre-wrap">{m.description}</p>}
        {m.notes && <p className="text-xs text-gray-500 mt-2 whitespace-pre-wrap">{m.notes}</p>}
      </div>

      {/* Timeline */}
      <div className="px-4 py-3" style={sectionStyle}>
        <p className="text-xs font-medium text-gray-300 mb-2">Timeline</p>
        {events.length === 0 ? (
          <p className="text-xs text-gray-600 mb-2">Nothing recorded yet</p>
        ) : (
          <div className="space-y-1.5 mb-3">
            {events.map(e => (
              <div key={e.id} className="flex items-start gap-2 text-xs group">
                <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${e.isCompleted ? 'bg-gray-600' : 'bg-amber-400'}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-gray-300">
                    <span className="text-gray-500">{fmtDate(e.date)}</span>
                    {' · '}{LEGAL_EVENT_LABELS[e.eventType] ?? e.eventType}
                    {!e.isCompleted && <span className="text-amber-400"> · scheduled</span>}
                  </p>
                  <p className="text-gray-400">{e.title}</p>
                  {e.outcome && <p className="text-gray-600">{e.outcome}</p>}
                  {e.notes && <p className="text-gray-600">{e.notes}</p>}
                </div>
                <button onClick={async () => { await deleteLegalEvent(m.id, e.id); await onChanged(); }}
                  className="text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100">✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 flex-wrap items-center">
          <input type="date" value={evForm.date} onChange={e => setEvForm(f => ({ ...f, date: e.target.value }))} className="input-dark text-xs w-36" />
          <select value={evForm.eventType} onChange={e => setEvForm(f => ({ ...f, eventType: e.target.value }))} className="input-dark text-xs">
            {LEGAL_EVENT_TYPES.map(t => <option key={t} value={t}>{LEGAL_EVENT_LABELS[t]}</option>)}
          </select>
          <input value={evForm.title} onChange={e => setEvForm(f => ({ ...f, title: e.target.value }))}
            placeholder="What happened / what is scheduled" className="input-dark text-xs flex-1 min-w-40" />
          <label className="flex items-center gap-1 text-xs text-gray-500">
            <input type="checkbox" checked={!evForm.isCompleted}
              onChange={e => setEvForm(f => ({ ...f, isCompleted: !e.target.checked }))} />
            Upcoming
          </label>
          <button onClick={saveEvent} disabled={busy || !evForm.title.trim()} className="btn text-xs disabled:opacity-40">Add</button>
        </div>
      </div>

      {/* Fees */}
      <div className="px-4 py-3" style={sectionStyle}>
        <p className="text-xs font-medium text-gray-300 mb-2">Fees &amp; costs</p>
        {fees.length === 0 ? (
          <p className="text-xs text-gray-600 mb-2">Nothing recorded yet</p>
        ) : (
          <div className="overflow-x-auto mb-3">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-1 pr-3">Date</th>
                  <th className="py-1 pr-3">Type</th>
                  <th className="py-1 pr-3">Payee</th>
                  <th className="py-1 pr-3">Detail</th>
                  <th className="py-1 pr-3 text-right">Amount</th>
                  <th className="py-1 pr-3">Paid</th>
                  <th className="py-1 w-6"></th>
                </tr>
              </thead>
              <tbody>
                {fees.map(f => (
                  <tr key={f.id} className="border-t border-white/5">
                    <td className="py-1.5 pr-3 text-gray-400 whitespace-nowrap">{fmtDate(f.date)}</td>
                    <td className="py-1.5 pr-3 text-gray-400">{LEGAL_FEE_LABELS[f.category] ?? f.category}</td>
                    <td className="py-1.5 pr-3 text-gray-400">{f.payee || '—'}</td>
                    <td className="py-1.5 pr-3 text-gray-500">
                      {f.description || '—'}
                      {f.hours != null && f.hourlyRate != null && (
                        <span className="text-gray-600"> ({f.hours}h × {money(f.hourlyRate)})</span>
                      )}
                      {f.invoiceNumber && <span className="text-gray-600"> · #{f.invoiceNumber}</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-medium text-white whitespace-nowrap">{money(f.amount)}</td>
                    <td className="py-1.5 pr-3">
                      <button onClick={() => toggleFeePaid(f)}
                        className={f.isPaid ? 'text-emerald-400' : 'text-amber-400 hover:text-amber-300'}>
                        {f.isPaid ? `Paid ${f.paidDate ? fmtDate(f.paidDate, 'MMM d') : ''}` : 'Mark paid'}
                      </button>
                    </td>
                    <td className="py-1.5">
                      <button onClick={async () => { await deleteLegalFee(m.id, f.id); await onChanged(); }}
                        className="text-gray-700 hover:text-red-400">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex gap-2 flex-wrap items-center">
          <input type="date" value={feeForm.date} onChange={e => setFeeForm(f => ({ ...f, date: e.target.value }))} className="input-dark text-xs w-36" />
          <select value={feeForm.category} onChange={e => setFeeForm(f => syncFeeAmount({ ...f, category: e.target.value }))} className="input-dark text-xs">
            {LEGAL_FEE_CATEGORIES.map(c => <option key={c} value={c}>{LEGAL_FEE_LABELS[c]}</option>)}
          </select>
          <input value={feeForm.payee} onChange={e => setFeeForm(f => ({ ...f, payee: e.target.value }))} placeholder="Payee" className="input-dark text-xs w-32" />
          {feeForm.category === 'HOURLY' && (
            <>
              <input type="number" step="0.1" value={feeForm.hours} onChange={e => setFeeForm(f => syncFeeAmount({ ...f, hours: e.target.value }))} placeholder="Hours" className="input-dark text-xs w-20" />
              <input type="number" value={feeForm.hourlyRate} onChange={e => setFeeForm(f => syncFeeAmount({ ...f, hourlyRate: e.target.value }))} placeholder="Rate" className="input-dark text-xs w-20" />
            </>
          )}
          <input type="number" value={feeForm.amount} onChange={e => setFeeForm(f => ({ ...f, amount: e.target.value }))} placeholder="Amount" className="input-dark text-xs w-24" />
          <input value={feeForm.description} onChange={e => setFeeForm(f => ({ ...f, description: e.target.value }))} placeholder="Description" className="input-dark text-xs flex-1 min-w-32" />
          <label className="flex items-center gap-1 text-xs text-gray-500">
            <input type="checkbox" checked={feeForm.isPaid} onChange={e => setFeeForm(f => ({ ...f, isPaid: e.target.checked }))} />
            Paid
          </label>
          <button onClick={saveFee} disabled={busy || !feeForm.amount} className="btn text-xs disabled:opacity-40">Add</button>
        </div>
      </div>

      {/* Documents */}
      <div className="px-4 py-3" style={sectionStyle}>
        <p className="text-xs font-medium text-gray-300 mb-2">Documents</p>
        {docs.length === 0 ? (
          <p className="text-xs text-gray-600 mb-2">Nothing uploaded yet</p>
        ) : (
          <div className="space-y-1 mb-3">
            {docs.map(d => (
              <div key={d.id} className="flex items-center gap-2 text-xs group">
                <span className="pill pill-gray text-xs">{DOCUMENT_CATEGORY_LABELS[d.category] ?? d.category}</span>
                <button onClick={() => openDoc(d.id)} className="text-amber-400 hover:text-amber-300 truncate flex-1 text-left">
                  {d.title}
                </button>
                <span className="text-gray-600 flex-shrink-0">{fmtDate(d.createdAt)}</span>
                <button onClick={() => removeDoc(d.id, d.title)}
                  className="text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 flex-shrink-0">✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 flex-wrap items-center">
          <select value={docCategory} onChange={e => setDocCategory(e.target.value)} className="input-dark text-xs">
            {LEGAL_DOC_CATEGORIES.map(c => <option key={c} value={c}>{DOCUMENT_CATEGORY_LABELS[c as DocumentCategory] ?? c}</option>)}
          </select>
          <label className="btn text-xs cursor-pointer">
            {uploading ? 'Uploading…' : 'Upload document'}
            <input type="file" accept=".pdf,image/*" className="hidden" disabled={uploading}
              onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
          </label>
          <span className="text-xs text-gray-600">Contracts, filings, correspondence, judgments</span>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div>
      <span className="text-gray-600">{label}: </span>
      <span className="text-gray-300">{value}</span>
    </div>
  );
}

// ─── Create / edit form ─────────────────────────────────────────────────────

function MatterForm({ form, setForm, properties, leases, saving, onSave, onCancel, isNew }: {
  form: MatterForm;
  setForm: (f: MatterForm | ((f: MatterForm) => MatterForm)) => void;
  properties: Property[]; leases: Lease[];
  saving: boolean; onSave: () => void; onCancel: () => void; isNew?: boolean;
}) {
  const set = (k: keyof MatterForm) => (e: { target: { value: string } }) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  // Only leases on the selected property — picking a tenant from an unrelated
  // building is almost always a mistake.
  const relevantLeases = form.propertyId
    ? leases.filter(l => l.unit?.property?.id === form.propertyId)
    : leases;

  return (
    <div className="px-4 py-3 space-y-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <input value={form.title} onChange={set('title')} placeholder="Matter title *" className="input-dark text-xs sm:col-span-2" />
        <input list="legal-matter-types" value={form.matterType} onChange={set('matterType')} placeholder="Type" className="input-dark text-xs" />
        <datalist id="legal-matter-types">
          {LEGAL_MATTER_TYPES.map(t => <option key={t} value={t} />)}
        </datalist>
        <select value={form.status} onChange={set('status')} className="input-dark text-xs">
          {LEGAL_STATUSES.map(s => <option key={s} value={s}>{LEGAL_STATUS_LABELS[s]}</option>)}
        </select>

        <select value={form.propertyId} onChange={e => setForm(f => ({ ...f, propertyId: e.target.value, leaseId: '' }))} className="input-dark text-xs">
          <option value="">— No property —</option>
          {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
        </select>
        <select value={form.leaseId} onChange={set('leaseId')} className="input-dark text-xs">
          <option value="">— No tenant —</option>
          {relevantLeases.map(l => (
            <option key={l.id} value={l.id}>
              {l.leaseTenants?.map(lt => lt.tenant.fullName).join(', ') || l.unit?.unitLabel}
            </option>
          ))}
        </select>
        <select value={form.priority} onChange={set('priority')} className="input-dark text-xs">
          {LEGAL_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <input value={form.caseNumber} onChange={set('caseNumber')} placeholder="Case number" className="input-dark text-xs" />
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1">Counsel</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <input value={form.attorney} onChange={set('attorney')} placeholder="Attorney" className="input-dark text-xs" />
          <input value={form.attorneyFirm} onChange={set('attorneyFirm')} placeholder="Firm" className="input-dark text-xs" />
          <input value={form.attorneyEmail} onChange={set('attorneyEmail')} placeholder="Email" className="input-dark text-xs" />
          <input value={form.attorneyPhone} onChange={set('attorneyPhone')} placeholder="Phone" className="input-dark text-xs" />
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1">Court &amp; parties</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <input value={form.court} onChange={set('court')} placeholder="Court" className="input-dark text-xs" />
          <input value={form.jurisdiction} onChange={set('jurisdiction')} placeholder="Jurisdiction / county" className="input-dark text-xs" />
          <input value={form.judge} onChange={set('judge')} placeholder="Judge" className="input-dark text-xs" />
          <input value={form.opposingParty} onChange={set('opposingParty')} placeholder="Opposing party" className="input-dark text-xs" />
          <input value={form.opposingCounsel} onChange={set('opposingCounsel')} placeholder="Opposing counsel" className="input-dark text-xs" />
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1">Dates</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          <DateField label="Filed" value={form.filedDate} onChange={set('filedDate')} />
          <DateField label="Next hearing" value={form.nextHearingDate} onChange={set('nextHearingDate')} />
          <DateField label="Response due" value={form.responseDueDate} onChange={set('responseDueDate')} />
          <DateField label="Filing deadline" value={form.statuteDeadline} onChange={set('statuteDeadline')} />
          <DateField label="Closed" value={form.closedDate} onChange={set('closedDate')} />
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1">Amounts</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <input type="number" value={form.claimAmount} onChange={set('claimAmount')} placeholder="Amount claimed" className="input-dark text-xs" />
          <input type="number" value={form.judgmentAmount} onChange={set('judgmentAmount')} placeholder="Judgment awarded" className="input-dark text-xs" />
          <input type="number" value={form.amountCollected} onChange={set('amountCollected')} placeholder="Collected so far" className="input-dark text-xs" />
          <input type="number" value={form.settlementAmount} onChange={set('settlementAmount')} placeholder="Settlement" className="input-dark text-xs" />
        </div>
      </div>

      <textarea value={form.description} onChange={set('description')} rows={2}
        placeholder="What this matter is about" className="input-dark text-xs w-full" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input value={form.outcome} onChange={set('outcome')} placeholder="Outcome" className="input-dark text-xs" />
        <input value={form.notes} onChange={set('notes')} placeholder="Internal notes" className="input-dark text-xs" />
      </div>

      <div className="flex justify-end gap-3">
        <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
        <button onClick={onSave} disabled={saving || !form.title.trim()} className="btn btn-primary text-xs disabled:opacity-40">
          {saving ? '…' : isNew ? 'Create matter' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

function DateField({ label, value, onChange }: {
  label: string; value: string; onChange: (e: { target: { value: string } }) => void;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-gray-600 mb-0.5">{label}</span>
      <input type="date" value={value} onChange={onChange} className="input-dark text-xs w-full" />
    </label>
  );
}
