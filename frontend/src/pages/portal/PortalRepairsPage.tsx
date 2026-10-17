import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { usePortal } from './PortalLayout';
import { getPortalRepairs, getPortalRepair, createPortalRepair, addPortalRepairNote, type RepairRow, type RepairDetail, type PhotoUpload } from '../../api/client';
import { REPAIR_CATEGORIES, URGENCY, REPAIR_STATUS } from '../../lib/repairs';
import { shrinkPhoto } from '../../lib/photos';
import { fmtMoment } from '../../lib/date';
import { toast } from '../../lib/toast';

const Pill = ({ label, color }: { label: string; color: string }) => (
  <span className="text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color, background: `${color}1f` }}>{label}</span>
);

/** The tenant's repair requests, and the form for a new one. */
export default function PortalRepairsPage() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<RepairRow[] | null>(null);
  const load = () => getPortalRepairs().then(setRows).catch(() => setRows([]));
  useEffect(() => { void load(); }, []);
  const creating = params.get('new') === '1';

  if (creating) return <NewRepair onDone={() => { setParams({}); void load(); }} />;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Repairs</h1>
        <button className="btn btn-primary text-sm" onClick={() => setParams({ new: '1' })}>New request</button>
      </div>
      <p className="text-xs text-gray-500">For anything dangerous — fire, a gas smell, flooding — call 911 or the utility first, then let your landlord know here.</p>
      {!rows ? <p className="text-sm text-gray-500">Loading…</p> : rows.length === 0 ? <div className="card p-5 text-sm text-gray-400">No repair requests yet.</div> : rows.map(r => {
        const st = REPAIR_STATUS[r.status] ?? REPAIR_STATUS.OPEN;
        return (
          <Link key={r.id} to={`/portal/repairs/${r.id}`} className="card p-4 block">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium text-white">{r.title}</p>
              <Pill {...st} />
            </div>
            <p className="text-xs text-gray-500 mt-1">{REPAIR_CATEGORIES[r.category] ?? r.category} · {URGENCY[r.urgency]?.label} · sent {fmtMoment(r.createdAt)}{r.scheduledFor ? ` · scheduled ${fmtMoment(r.scheduledFor)}` : ''}</p>
          </Link>
        );
      })}
    </div>
  );
}

function NewRepair({ onDone }: { onDone: () => void }) {
  const { me } = usePortal();
  const fileRef = useRef<HTMLInputElement>(null);
  const [leaseId, setLeaseId] = useState(me?.leases[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('OTHER');
  const [urgency, setUrgency] = useState('ROUTINE');
  const [permissionToEnter, setPermission] = useState(true);
  const [availability, setAvailability] = useState('');
  const [photos, setPhotos] = useState<PhotoUpload[]>([]);
  const [busy, setBusy] = useState(false);

  async function addPhotos(files: FileList | null) {
    if (!files) return;
    const room = 6 - photos.length;
    const picked = Array.from(files).slice(0, room);
    const shrunk = await Promise.all(picked.map(f => shrinkPhoto(f).catch(() => null)));
    setPhotos(p => [...p, ...shrunk.filter(Boolean) as PhotoUpload[]]);
  }

  async function submit() {
    if (title.trim().length < 3 || description.trim().length < 5) { toast('Say what is wrong in a few words, and describe it.', 'error'); return; }
    setBusy(true);
    try {
      const r = await createPortalRepair({ leaseId, title: title.trim(), description: description.trim(), category, urgency, permissionToEnter, availability: availability.trim() || undefined, photos });
      toast(r.photosFailed ? `Sent — but ${r.photosFailed} photo${r.photosFailed === 1 ? '' : 's'} could not be saved.` : 'Sent to your landlord.');
      onDone();
    } catch (e: any) {
      toast(e?.response?.data?.error ?? 'The request could not be sent.', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">New repair request</h1>
        <button className="text-sm text-gray-400" onClick={onDone}>Cancel</button>
      </div>
      <div className="card p-5 space-y-4">
        {(me?.leases.length ?? 0) > 1 && (
          <label className="block"><span className="text-xs text-gray-400">Where</span>
            <select className="input-dark mt-1 w-full" value={leaseId} onChange={e => setLeaseId(e.target.value)}>{me!.leases.map(l => <option key={l.id} value={l.id}>{l.address}</option>)}</select>
          </label>
        )}
        <label className="block"><span className="text-xs text-gray-400">What's wrong</span>
          <input className="input-dark mt-1 w-full" placeholder="e.g. Kitchen sink leaking under the cabinet" value={title} onChange={e => setTitle(e.target.value)} maxLength={120} />
        </label>
        <label className="block"><span className="text-xs text-gray-400">Details</span>
          <textarea className="input-dark mt-1 w-full" rows={4} placeholder="When it started, where exactly, anything you've tried" value={description} onChange={e => setDescription(e.target.value)} />
        </label>
        <label className="block"><span className="text-xs text-gray-400">Kind</span>
          <select className="input-dark mt-1 w-full" value={category} onChange={e => setCategory(e.target.value)}>{Object.entries(REPAIR_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </label>
        <div>
          <span className="text-xs text-gray-400">How urgent</span>
          <div className="grid grid-cols-3 gap-2 mt-1">
            {Object.entries(URGENCY).map(([k, u]) => (
              <button key={k} type="button" onClick={() => setUrgency(k)} className="rounded-lg py-2 text-sm" style={{ border: `1px solid ${urgency === k ? u.color : 'rgba(255,255,255,0.1)'}`, color: urgency === k ? u.color : '#9ca3af', background: urgency === k ? `${u.color}14` : 'transparent' }}>{u.label}</button>
            ))}
          </div>
          <p className="text-[11px] text-gray-500 mt-1">{URGENCY[urgency].hint}</p>
        </div>
        <div>
          <span className="text-xs text-gray-400">Photos (up to 6)</span>
          <div className="flex flex-wrap gap-2 mt-1">
            {photos.map((p, i) => (
              <div key={i} className="relative">
                <img src={p.data} alt="" className="w-20 h-20 object-cover rounded-lg" />
                <button type="button" aria-label="Remove photo" className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black text-white text-xs" onClick={() => setPhotos(ps => ps.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            {photos.length < 6 && <button type="button" onClick={() => fileRef.current?.click()} className="w-20 h-20 rounded-lg text-2xl text-gray-500" style={{ border: '1px dashed rgba(255,255,255,0.2)' }}>+</button>}
          </div>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => { void addPhotos(e.target.files); e.target.value = ''; }} />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={permissionToEnter} onChange={e => setPermission(e.target.checked)} /> OK to enter if I'm not home
        </label>
        <label className="block"><span className="text-xs text-gray-400">Best times to come (optional)</span>
          <input className="input-dark mt-1 w-full" placeholder="e.g. weekdays after 5pm" value={availability} onChange={e => setAvailability(e.target.value)} maxLength={300} />
        </label>
        <button className="btn btn-primary w-full justify-center" disabled={busy} onClick={() => void submit()}>{busy ? 'Sending…' : 'Send to my landlord'}</button>
      </div>
    </div>
  );
}

/** One request: its status, photos and the notes between tenant and landlord. */
export function PortalRepairPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [r, setR] = useState<RepairDetail | null>(null);
  const [note, setNote] = useState('');
  const load = () => getPortalRepair(id!).then(setR).catch(() => navigate('/portal/repairs', { replace: true }));
  useEffect(() => { void load(); }, [id]);
  if (!r) return <p className="text-sm text-gray-500">Loading…</p>;
  const st = REPAIR_STATUS[r.status] ?? REPAIR_STATUS.OPEN;
  return (
    <div className="space-y-4">
      <Link to="/portal/repairs" className="text-sm text-amber-400">‹ Repairs</Link>
      <div className="card p-5">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-lg font-semibold text-white">{r.title}</h1>
          <Pill {...st} />
        </div>
        <p className="text-xs text-gray-500 mt-1">{REPAIR_CATEGORIES[r.category] ?? r.category} · {URGENCY[r.urgency]?.label} · sent {fmtMoment(r.createdAt)}</p>
        {r.scheduledFor && <p className="text-sm text-blue-300 mt-2">Scheduled for {fmtMoment(r.scheduledFor)}</p>}
        <p className="text-sm text-gray-300 mt-3 whitespace-pre-wrap">{r.description}</p>
        {(r.photos as string[]).length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">{(r.photos as string[]).map((u, i) => <a key={i} href={u} target="_blank" rel="noreferrer"><img src={u} alt="" className="w-24 h-24 object-cover rounded-lg" /></a>)}</div>
        )}
      </div>
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-white mb-3">Messages</h2>
        {(r.updates as any[]).length === 0 && <p className="text-xs text-gray-500">No messages yet.</p>}
        <div className="space-y-2">
          {(r.updates as any[]).map(u => (
            <div key={u.id} className={`rounded-xl px-3 py-2 text-sm max-w-[85%] ${u.author === 'TENANT' ? 'ml-auto' : ''}`} style={{ background: u.author === 'TENANT' ? 'rgba(245,166,35,0.12)' : 'rgba(255,255,255,0.05)' }}>
              <p className="text-gray-200 whitespace-pre-wrap">{u.body}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">{u.author === 'TENANT' ? 'You' : 'Landlord'} · {fmtMoment(u.createdAt)}</p>
            </div>
          ))}
        </div>
        {r.status !== 'COMPLETED' && r.status !== 'CANCELLED' && (
          <div className="flex gap-2 mt-3">
            <input className="input-dark flex-1" placeholder="Add a message" value={note} onChange={e => setNote(e.target.value)} />
            <button className="btn text-sm" disabled={!note.trim()} onClick={() => void addPortalRepairNote(r.id, note.trim()).then(() => { setNote(''); void load(); })}>Send</button>
          </div>
        )}
      </div>
    </div>
  );
}
