import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader, Modal } from '../components/ui';
import BackLink from '../components/ui/BackLink';
import { getRepairs, getRepair, createRepair, updateRepair, addRepairNote, logRepairExpense, getProperties, type RepairRow, type RepairDetail, type PhotoUpload } from '../api/client';
import { REPAIR_CATEGORIES, URGENCY, REPAIR_STATUS } from '../lib/repairs';
import { shrinkPhoto } from '../lib/photos';
import { fmtMoment } from '../lib/date';
import { fmtMoney } from '../lib/money';
import { toast } from '../lib/toast';

const Pill = ({ label, color }: { label: string; color: string }) => (
  <span className="text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color, background: `${color}1f` }}>{label}</span>
);

/**
 * Repairs: what tenants reported from the portal (and what the owner
 * logged), open emergencies first.
 */
export default function RepairsPage() {
  const [filter, setFilter] = useState<'active' | 'COMPLETED' | 'all'>('active');
  const [rows, setRows] = useState<RepairRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => getRepairs(filter).then(setRows).catch(() => setRows([]));
  useEffect(() => { setRows(null); void load(); }, [filter]);

  return (
    <div>
      <PageHeader title="Repairs" subtitle="Repair requests from tenants, and repairs you log"
        action={<button className="btn btn-primary text-sm" onClick={() => setAdding(true)}>Log a repair</button>} />
      <div className="px-6 py-4 max-w-4xl">
        <div className="flex gap-2 mb-4">
          {([['active', 'Open'], ['COMPLETED', 'Completed'], ['all', 'All']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)} className={`text-xs px-3 py-1.5 rounded-full ${filter === k ? 'bg-amber-500/15 text-amber-400' : 'text-gray-400 hover:text-gray-200'}`}>{label}</button>
          ))}
        </div>
        {!rows ? <p className="text-sm text-gray-500">Loading…</p> : rows.length === 0 ? (
          <div className="card p-6 text-sm text-gray-400">
            {filter === 'active' ? 'No open repairs.' : 'Nothing here yet.'} Tenants send requests from their portal — invite them from their page under Tenants.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map(r => {
              const st = REPAIR_STATUS[r.status] ?? REPAIR_STATUS.OPEN;
              const u = URGENCY[r.urgency];
              return (
                <Link key={r.id} to={`/repairs/${r.id}`} className="card p-4 block hover:bg-white/[0.03]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white">{r.title}</p>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{r.property}{r.unit ? ` · ${r.unit}` : ''}{r.tenant ? ` · ${r.tenant}` : ''} · {fmtMoment(r.createdAt)}</p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {r.urgency !== 'ROUTINE' && <Pill label={u.label} color={u.color} />}
                      <Pill {...st} />
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mt-1.5">
                    {REPAIR_CATEGORIES[r.category] ?? r.category}
                    {r.photos ? ` · ${r.photos} photo${r.photos === 1 ? '' : 's'}` : ''}
                    {r.updates ? ` · ${r.updates} message${r.updates === 1 ? '' : 's'}` : ''}
                    {r.scheduledFor ? ` · scheduled ${fmtMoment(r.scheduledFor)}` : ''}
                    {r.cost != null ? ` · ${fmtMoney(r.cost)}` : ''}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </div>
      {adding && <NewRepairModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void load(); }} />}
    </div>
  );
}

function NewRepairModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [props, setProps] = useState<{ id: string; label: string }[]>([]);
  const [f, setF] = useState({ propertyId: '', title: '', description: '', category: 'OTHER', urgency: 'ROUTINE' });
  const [photos, setPhotos] = useState<PhotoUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { void getProperties().then((ps: any[]) => { const list = ps.map(p => ({ id: p.id, label: p.nickname || p.address })); setProps(list); setF(x => ({ ...x, propertyId: x.propertyId || list[0]?.id || '' })); }).catch(() => {}); }, []);
  async function save() {
    setBusy(true);
    try { await createRepair({ ...f, photos }); toast('Repair logged.'); onSaved(); }
    catch (e: any) { toast(e?.response?.data?.error ?? 'Could not save it.', 'error'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Log a repair" onClose={onClose} footer={<>
      <button className="btn text-sm" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary text-sm" disabled={busy || !f.propertyId || f.title.trim().length < 3 || !f.description.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
    </>}>
      <div className="space-y-3">
        <select className="input-dark w-full text-sm" value={f.propertyId} onChange={e => setF({ ...f, propertyId: e.target.value })}>{props.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        <input className="input-dark w-full text-sm" placeholder="What's wrong" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} />
        <textarea className="input-dark w-full text-sm" rows={3} placeholder="Details" value={f.description} onChange={e => setF({ ...f, description: e.target.value })} />
        <div className="grid grid-cols-2 gap-2">
          <select className="input-dark text-sm" value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>{Object.entries(REPAIR_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select className="input-dark text-sm" value={f.urgency} onChange={e => setF({ ...f, urgency: e.target.value })}>{Object.entries(URGENCY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        </div>
        <div className="flex flex-wrap gap-2">
          {photos.map((p, i) => <img key={i} src={p.data} alt="" className="w-16 h-16 object-cover rounded" />)}
          {photos.length < 6 && <button className="w-16 h-16 rounded text-gray-500" style={{ border: '1px dashed rgba(255,255,255,0.2)' }} onClick={() => fileRef.current?.click()}>+ Photo</button>}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={async e => { const fs = Array.from(e.target.files ?? []).slice(0, 6 - photos.length); const s = await Promise.all(fs.map(x => shrinkPhoto(x).catch(() => null))); setPhotos(p => [...p, ...s.filter(Boolean) as PhotoUpload[]]); e.target.value = ''; }} />
        </div>
      </div>
    </Modal>
  );
}

/** One repair: what was reported, photos, schedule and status, notes with the tenant, cost → expense. */
export function RepairDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [r, setR] = useState<RepairDetail | null>(null);
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const [vendor, setVendor] = useState('');
  const [cost, setCost] = useState('');
  const load = () => getRepair(id!).then(x => {
    setR(x);
    setVendor(x.vendor ?? ''); setCost(x.cost != null ? String(x.cost) : '');
    setWhen(x.scheduledFor ? new Date(new Date(x.scheduledFor).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  }).catch(() => navigate('/repairs', { replace: true }));
  useEffect(() => { void load(); }, [id]);
  if (!r) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  const save = (body: Parameters<typeof updateRepair>[1], msg: string) => updateRepair(r.id, body).then(() => { toast(msg); return load(); }).catch((e: any) => toast(e?.response?.data?.error ?? 'Could not save.', 'error'));
  const st = REPAIR_STATUS[r.status] ?? REPAIR_STATUS.OPEN;
  const t = r.tenant as { name: string; phone: string | null; email: string | null } | null;
  const open = r.status !== 'COMPLETED' && r.status !== 'CANCELLED';

  return (
    <div className="p-6 max-w-3xl">
      <BackLink fallback="/repairs" className="text-xs text-gray-500 hover:text-gray-300">&larr; Repairs</BackLink>
      <div className="flex items-start justify-between gap-3 mt-1">
        <h1 className="text-xl font-semibold text-white">{r.title}</h1>
        <div className="flex gap-1.5"><Pill label={URGENCY[r.urgency].label} color={URGENCY[r.urgency].color} /><Pill {...st} /></div>
      </div>
      <p className="text-xs text-gray-500 mt-1">{r.property}{r.unit ? ` · ${r.unit}` : ''} · {REPAIR_CATEGORIES[r.category] ?? r.category} · {r.createdBy === 'OWNER' ? 'logged by you' : 'from the tenant portal'} {fmtMoment(r.createdAt)}</p>

      <div className="card p-5 mt-4">
        <p className="text-sm text-gray-200 whitespace-pre-wrap">{r.description}</p>
        {(r.photos as string[]).length > 0 && <div className="flex flex-wrap gap-2 mt-3">{(r.photos as string[]).map((u, i) => <a key={i} href={u} target="_blank" rel="noreferrer"><img src={u} alt="" className="w-28 h-28 object-cover rounded-lg" /></a>)}</div>}
        <div className="grid sm:grid-cols-2 gap-3 mt-4 text-xs text-gray-400">
          {t && <p>Tenant: <span className="text-gray-200">{t.name}</span>{t.phone ? <> · <a className="text-amber-400" href={`tel:${t.phone.replace(/\D/g, '')}`}>{t.phone}</a></> : null}</p>}
          <p>Entry: <span className="text-gray-200">{r.permissionToEnter ? 'OK to enter if not home' : 'Arrange a time first'}</span></p>
          {r.availability && <p className="sm:col-span-2">Best times: <span className="text-gray-200">{r.availability}</span></p>}
        </div>
      </div>

      <div className="card p-5 mt-4 space-y-3">
        <h2 className="text-sm font-semibold text-white">Status</h2>
        <div className="flex flex-wrap gap-2">
          {Object.entries(REPAIR_STATUS).map(([k, v]) => (
            <button key={k} disabled={r.status === k} onClick={() => void save({ status: k }, `Marked ${v.label.toLowerCase()} — the tenant is told.`)}
              className="text-xs px-3 py-1.5 rounded-full" style={{ border: `1px solid ${r.status === k ? v.color : 'rgba(255,255,255,0.12)'}`, color: r.status === k ? v.color : '#9ca3af' }}>{v.label}</button>
          ))}
        </div>
        <div className="grid sm:grid-cols-3 gap-2 items-end">
          <label className="text-xs text-gray-400">Scheduled for<input type="datetime-local" className="input-dark w-full text-sm mt-1" value={when} onChange={e => setWhen(e.target.value)} /></label>
          <label className="text-xs text-gray-400">Vendor<input className="input-dark w-full text-sm mt-1" value={vendor} onChange={e => setVendor(e.target.value)} placeholder="Who's doing it" /></label>
          <button className="btn text-sm" onClick={() => void save({ scheduledFor: when ? new Date(when).toISOString() : null, vendor: vendor || null, ...(when && r.status === 'OPEN' ? { status: 'SCHEDULED' } : {}) }, when ? 'Scheduled — the tenant is told.' : 'Saved.')}>Save schedule</button>
        </div>
        <div className="grid sm:grid-cols-3 gap-2 items-end">
          <label className="text-xs text-gray-400">Cost<input inputMode="decimal" className="input-dark w-full text-sm mt-1" value={cost} onChange={e => setCost(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.00" /></label>
          <button className="btn text-sm" onClick={() => void save({ cost: cost ? Number(cost) : null }, 'Cost saved.')}>Save cost</button>
          {r.expenseId ? <p className="text-xs text-green-400">Logged as an expense ✓</p> : (
            <button className="btn text-sm" disabled={!Number(cost)} onClick={() => void logRepairExpense(r.id, Number(cost)).then(() => { toast('Logged as a repairs expense on the property.'); void load(); }).catch((e: any) => toast(e?.response?.data?.error ?? 'Could not log it.', 'error'))}>Log as expense</button>
          )}
        </div>
      </div>

      <div className="card p-5 mt-4">
        <h2 className="text-sm font-semibold text-white mb-3">Messages with the tenant</h2>
        {(r.updates as any[]).length === 0 && <p className="text-xs text-gray-500">No messages yet. Status changes and schedules are sent to the tenant automatically.</p>}
        <div className="space-y-2">
          {(r.updates as any[]).map(u => (
            <div key={u.id} className={`rounded-xl px-3 py-2 text-sm max-w-[85%] ${u.author === 'OWNER' ? 'ml-auto' : ''}`} style={{ background: u.author === 'OWNER' ? 'rgba(245,166,35,0.12)' : 'rgba(255,255,255,0.05)' }}>
              <p className="text-gray-200 whitespace-pre-wrap">{u.body}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">{u.author === 'OWNER' ? 'You' : t?.name ?? 'Tenant'} · {fmtMoment(u.createdAt)}</p>
            </div>
          ))}
        </div>
        {(open || r.tenantId) && (
          <div className="flex gap-2 mt-3">
            <input className="input-dark flex-1 text-sm" placeholder={r.tenantId ? 'Message the tenant' : 'Add a note'} value={note} onChange={e => setNote(e.target.value)} />
            <button className="btn text-sm" disabled={!note.trim()} onClick={() => void addRepairNote(r.id, note.trim()).then(() => { setNote(''); void load(); })}>Send</button>
          </div>
        )}
      </div>
    </div>
  );
}
