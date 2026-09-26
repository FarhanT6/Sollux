import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getProjects, getProject, createProject, updateProject, deleteProject, readTransferReceipt,
  createTransfer, updateTransfer, deleteTransfer, transferReceiptUrl, getBankAccounts, type FilePayload,
} from '../api/client';
import type { DevelopmentProject, ProjectTransfer } from '../types';
import { TRANSFER_PURPOSE_LABELS } from '../types';
import { PageHeader, EmptyState } from '../components/ui';
import { fmtDate, todayISO } from '../lib/date';
import { fmtMoney, fmtCurrency } from '../lib/money';
import { fileToPayload } from '../lib/files';
import { describeApiError } from '../lib/apiError';

/**
 * Builds funded from here that are not rental properties — a 10-story
 * apartment building in Bangladesh — and every transfer sent to them: what
 * left in dollars, the fee, the rate, and what arrived in taka. Kept apart
 * from the portfolio's expenses and P&L; it is an investment, not an
 * operating cost of any property.
 */

const STATUS_LABEL: Record<string, string> = { PLANNING: 'Planning', ACTIVE: 'Under construction', ON_HOLD: 'On hold', COMPLETE: 'Complete' };
const METHODS = ['Bank wire', 'Remitly', 'Wise', 'Western Union', 'Xoom', 'MoneyGram', 'bKash', 'Cash (hand-carried)', 'Other'];
const n = (v: unknown) => (v == null || v === '' ? null : Number(v));

type ProjectForm = { id?: string; name: string; country: string; city: string; address: string; description: string; localCurrency: string; budgetUsd: string; budgetLocal: string; floors: string; status: string; startDate: string; targetDate: string; notes: string };
const EMPTY_PROJECT: ProjectForm = { name: '', country: 'Bangladesh', city: '', address: '', description: '', localCurrency: 'BDT', budgetUsd: '', budgetLocal: '', floors: '', status: 'ACTIVE', startDate: '', targetDate: '', notes: '' };

type TransferForm = { id?: string; date: string; amountUsd: string; feeUsd: string; exchangeRate: string; amountLocal: string; method: string; recipient: string; purpose: string; bankAccountId: string; reference: string; notes: string };
const EMPTY_TRANSFER: TransferForm = { date: todayISO(), amountUsd: '', feeUsd: '', exchangeRate: '', amountLocal: '', method: 'Bank wire', recipient: '', purpose: 'MATERIALS', bankAccountId: '', reference: '', notes: '' };

const input = 'input-dark text-sm w-full';
const label = 'text-xs text-gray-500 block mb-1';

function ProjectEditor({ initial, onSaved, onCancel }: { initial: ProjectForm; onSaved: (id: string) => void; onCancel: () => void }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<ProjectForm>) => setF(x => ({ ...x, ...p }));
  async function save() {
    if (!f.name.trim()) { setErr('Give the project a name.'); return; }
    const body = {
      name: f.name.trim(), country: f.country || null, city: f.city || null, address: f.address || null, description: f.description || null,
      localCurrency: (f.localCurrency || 'BDT').toUpperCase(), budgetUsd: n(f.budgetUsd), budgetLocal: n(f.budgetLocal), floors: n(f.floors),
      status: f.status, startDate: f.startDate || null, targetDate: f.targetDate || null, notes: f.notes || null,
    };
    try {
      const saved = f.id ? await updateProject(f.id, body) : await createProject(body);
      onSaved(saved.id);
    } catch (e) { setErr(describeApiError(e, 'Could not save the project.')); }
  }
  return (
    <div className="card p-4 mb-5 space-y-3">
      <p className="text-sm font-semibold text-white">{f.id ? 'Edit project' : 'New project'}</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="md:col-span-2"><span className={label}>Name</span><input className={input} value={f.name} onChange={e => set({ name: e.target.value })} placeholder="e.g. Sylhet 10-story apartment building" /></div>
        <div><span className={label}>Status</span><select className={input} value={f.status} onChange={e => set({ status: e.target.value })}>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><span className={label}>Country</span><input className={input} value={f.country} onChange={e => set({ country: e.target.value })} /></div>
        <div><span className={label}>City</span><input className={input} value={f.city} onChange={e => set({ city: e.target.value })} /></div>
        <div><span className={label}>Local currency</span><input className={input} value={f.localCurrency} onChange={e => set({ localCurrency: e.target.value })} maxLength={3} /></div>
        <div className="md:col-span-3"><span className={label}>Site address</span><input className={input} value={f.address} onChange={e => set({ address: e.target.value })} /></div>
        <div><span className={label}>Budget (USD)</span><input type="number" step="0.01" className={input} value={f.budgetUsd} onChange={e => set({ budgetUsd: e.target.value })} /></div>
        <div><span className={label}>Budget ({f.localCurrency || 'local'})</span><input type="number" step="0.01" className={input} value={f.budgetLocal} onChange={e => set({ budgetLocal: e.target.value })} /></div>
        <div><span className={label}>Floors</span><input type="number" className={input} value={f.floors} onChange={e => set({ floors: e.target.value })} /></div>
        <div><span className={label}>Started</span><input type="date" className={input} value={f.startDate} onChange={e => set({ startDate: e.target.value })} /></div>
        <div><span className={label}>Target completion</span><input type="date" className={input} value={f.targetDate} onChange={e => set({ targetDate: e.target.value })} /></div>
        <div className="md:col-span-3"><span className={label}>Description / notes</span><textarea rows={2} className={input} value={f.notes} onChange={e => set({ notes: e.target.value })} /></div>
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex justify-end gap-2"><button onClick={onCancel} className="btn text-xs">Cancel</button><button onClick={save} className="btn btn-primary text-xs">Save</button></div>
    </div>
  );
}

function ProjectList() {
  const [projects, setProjects] = useState<DevelopmentProject[] | null>(null);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  useEffect(() => { void getProjects().then(setProjects); }, []);
  return (
    <div>
      <PageHeader title="Projects" subtitle="Developments you fund outside the rental portfolio, and the money sent to them"
        action={<button onClick={() => setCreating(true)} className="btn btn-primary text-xs">+ New project</button>} />
      <div className="px-6 py-5">
        {creating && <ProjectEditor initial={EMPTY_PROJECT} onCancel={() => setCreating(false)} onSaved={id => nav(`/projects/${id}`)} />}
        {projects == null ? <p className="text-sm text-gray-500">Loading…</p>
          : projects.length === 0 && !creating ? <EmptyState icon="🏗️" title="No projects yet" body="Add the build you are funding, then log each transfer you send for it." />
          : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {projects.map(p => (
                <Link key={p.id} to={`/projects/${p.id}`} className="card p-4 block hover:opacity-90">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{p.name}</p>
                      <p className="text-xs text-gray-500">{[p.city, p.country].filter(Boolean).join(', ')}{p.floors ? ` · ${p.floors} floors` : ''}</p>
                    </div>
                    <span className="pill pill-gray">{STATUS_LABEL[p.status]}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-3">
                    <div><p className="text-xs text-gray-500">Sent</p><p className="text-sm font-semibold text-white">{fmtMoney(p.totals.sentUsd)}</p></div>
                    <div><p className="text-xs text-gray-500">Arrived</p><p className="text-sm font-semibold text-white">{fmtCurrency(p.totals.receivedLocal, p.localCurrency)}</p></div>
                    <div><p className="text-xs text-gray-500">Transfers</p><p className="text-sm font-semibold text-white">{p.transferCount ?? 0}</p></div>
                  </div>
                  {p.totals.budgetUsedPct != null && (
                    <div className="mt-3">
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                        <div className="h-full bg-gold-500" style={{ width: `${Math.min(100, p.totals.budgetUsedPct)}%` }} />
                      </div>
                      <p className="text-xs text-gray-500 mt-1">{p.totals.budgetUsedPct}% of budget</p>
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

function ProjectDetail({ id }: { id: string }) {
  const [p, setP] = useState<DevelopmentProject | null>(null);
  const [banks, setBanks] = useState<{ id: string; name: string; last4?: string | null }[]>([]);
  const [editing, setEditing] = useState(false);
  const [tf, setTf] = useState<TransferForm | null>(null);
  const [receipt, setReceipt] = useState<FilePayload | null>(null);
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [purposeFilter, setPurposeFilter] = useState('');
  const nav = useNavigate();

  async function load() { setP(await getProject(id)); }
  useEffect(() => { void load(); void getBankAccounts().then((b: any[]) => setBanks(b)); }, [id]);
  if (!p) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  const cur = p.localCurrency;
  const t = p.totals;

  const setT = (x: Partial<TransferForm>) => setTf(f => (f ? { ...f, ...x } : f));
  // What arrived follows from the rate, and the rate from what arrived.
  const onRate = (v: string) => setT({ exchangeRate: v, ...(tf?.amountUsd && v ? { amountLocal: (Number(tf.amountUsd) * Number(v)).toFixed(2) } : {}) });
  const onUsd = (v: string) => setT({ amountUsd: v, ...(tf?.exchangeRate && v ? { amountLocal: (Number(v) * Number(tf.exchangeRate)).toFixed(2) } : {}) });
  const onLocal = (v: string) => setT({ amountLocal: v, ...(tf?.amountUsd && v && !tf.exchangeRate ? { exchangeRate: (Number(v) / Number(tf.amountUsd)).toFixed(4) } : {}) });

  function edit(x: ProjectTransfer) {
    setTf({
      id: x.id, date: String(x.date).slice(0, 10), amountUsd: String(x.amountUsd ?? ''), feeUsd: x.feeUsd != null ? String(x.feeUsd) : '',
      exchangeRate: x.exchangeRate != null ? String(x.exchangeRate) : '', amountLocal: x.amountLocal != null ? String(x.amountLocal) : '',
      method: x.method ?? '', recipient: x.recipient ?? '', purpose: x.purpose ?? 'OTHER', bankAccountId: x.bankAccountId ?? '', reference: x.reference ?? '', notes: x.notes ?? '',
    });
    setReceipt(null); setErr(null);
  }

  async function pickReceipt(file: File | undefined) {
    if (!file) return;
    const payload = await fileToPayload(file);
    setReceipt(payload);
    setReading(true); setErr(null);
    try {
      const { fields: f } = await readTransferReceipt([payload]);
      setTf(prev => prev && ({
        ...prev,
        date: f.date ?? prev.date, amountUsd: f.amountUsd != null ? String(f.amountUsd) : prev.amountUsd, feeUsd: f.feeUsd != null ? String(f.feeUsd) : prev.feeUsd,
        exchangeRate: f.exchangeRate != null ? String(f.exchangeRate) : prev.exchangeRate, amountLocal: f.amountLocal != null ? String(f.amountLocal) : prev.amountLocal,
        method: f.method ?? prev.method, recipient: f.recipient ?? prev.recipient, reference: f.reference ?? prev.reference,
      }));
    } catch (e) { setErr(`${describeApiError(e, 'Could not read the receipt')} — it is still attached; fill the fields in by hand.`); }
    finally { setReading(false); }
  }

  async function saveTransfer() {
    if (!tf) return;
    if (!(Number(tf.amountUsd) > 0)) { setErr('Enter the amount sent in dollars.'); return; }
    const body = {
      date: tf.date, amountUsd: Number(tf.amountUsd), feeUsd: n(tf.feeUsd), exchangeRate: n(tf.exchangeRate), amountLocal: n(tf.amountLocal),
      method: tf.method || null, recipient: tf.recipient || null, purpose: tf.purpose || null, bankAccountId: tf.bankAccountId || null,
      reference: tf.reference || null, notes: tf.notes || null, ...(receipt ? { file: receipt } : {}),
    };
    try {
      if (tf.id) await updateTransfer(tf.id, body); else await createTransfer(p!.id, body);
      setTf(null); setReceipt(null); await load();
    } catch (e) { setErr(describeApiError(e, 'Could not save the transfer.')); }
  }

  async function openReceipt(x: ProjectTransfer) {
    const w = window.open('', '_blank');
    const url = await transferReceiptUrl(x.id);
    if (w) w.location.href = url; else window.location.href = url;
  }

  const transfers = (p.transfers ?? []).filter(x => !purposeFilter || (x.purpose || 'OTHER') === purposeFilter);

  return (
    <div>
      <PageHeader title={p.name} subtitle={[p.city, p.country].filter(Boolean).join(', ') + (p.floors ? ` · ${p.floors} floors` : '') + ` · ${STATUS_LABEL[p.status]}`}
        breadcrumb={[{ label: 'Projects', href: '/projects' }, { label: p.name }]}
        action={<div className="flex gap-2"><button onClick={() => setEditing(true)} className="btn text-xs">Edit project</button><button onClick={() => { setTf({ ...EMPTY_TRANSFER }); setReceipt(null); setErr(null); }} className="btn btn-primary text-xs">+ Log transfer</button></div>} />
      <div className="px-6 py-5">
        {editing && (
          <ProjectEditor
            initial={{ id: p.id, name: p.name, country: p.country ?? '', city: p.city ?? '', address: p.address ?? '', description: p.description ?? '', localCurrency: p.localCurrency,
              budgetUsd: p.budgetUsd != null ? String(p.budgetUsd) : '', budgetLocal: p.budgetLocal != null ? String(p.budgetLocal) : '', floors: p.floors != null ? String(p.floors) : '',
              status: p.status, startDate: p.startDate ? String(p.startDate).slice(0, 10) : '', targetDate: p.targetDate ? String(p.targetDate).slice(0, 10) : '', notes: p.notes ?? '' }}
            onCancel={() => setEditing(false)} onSaved={async () => { setEditing(false); await load(); }} />
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <div className="stat-card"><p className="text-xs text-gray-500">Sent</p><p className="text-lg font-semibold text-white">{fmtMoney(t.sentUsd)}</p><p className="text-xs text-gray-500">{p.transfers?.length ?? 0} transfers</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Fees</p><p className="text-lg font-semibold text-white">{fmtMoney(t.feesUsd)}</p><p className="text-xs text-gray-500">Total cost {fmtMoney(t.totalCostUsd)}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Arrived</p><p className="text-lg font-semibold text-white">{fmtCurrency(t.receivedLocal, cur)}</p>
            <p className="text-xs text-gray-500">{t.averageRate ? `avg ${t.averageRate} ${cur}/USD` : t.transfersWithoutRate ? `${t.transfersWithoutRate} without a rate` : ''}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Budget</p>
            <p className="text-lg font-semibold text-white">{p.budgetUsd != null ? fmtMoney(p.budgetUsd) : p.budgetLocal != null ? fmtCurrency(p.budgetLocal, cur) : '—'}</p>
            <p className="text-xs text-gray-500">{t.budgetUsedPct != null ? `${t.budgetUsedPct}% used` : 'Set one under Edit project'}</p></div>
        </div>

        {Object.keys(t.byPurpose).length > 0 && (
          <div className="card p-4 mb-5">
            <p className="section-label">Where it went</p>
            <div className="space-y-1.5">
              {Object.entries(t.byPurpose).sort((a, b) => b[1].usd - a[1].usd).map(([k, v]) => (
                <button key={k} onClick={() => setPurposeFilter(purposeFilter === k ? '' : k)} className="w-full flex items-center gap-3 text-left">
                  <span className={`text-xs w-40 ${purposeFilter === k ? 'text-amber-400' : 'text-gray-300'}`}>{TRANSFER_PURPOSE_LABELS[k] ?? k}</span>
                  <span className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                    <span className="block h-full bg-gold-500" style={{ width: `${t.sentUsd ? (v.usd / t.sentUsd) * 100 : 0}%` }} />
                  </span>
                  <span className="text-xs text-white w-28 text-right">{fmtMoney(v.usd)}</span>
                  <span className="text-xs text-gray-500 w-32 text-right">{fmtCurrency(v.local, cur)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {tf && (
          <div className="card p-4 mb-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-white">{tf.id ? 'Edit transfer' : 'New transfer'}</p>
              <label className="btn text-xs cursor-pointer">
                {reading ? 'Reading…' : receipt ? `📎 ${receipt.name}` : 'Attach receipt (fills the form)'}
                <input type="file" accept="application/pdf,image/*" className="hidden" onChange={e => { void pickReceipt(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><span className={label}>Date sent</span><input type="date" className={input} value={tf.date} onChange={e => setT({ date: e.target.value })} /></div>
              <div><span className={label}>Amount sent (USD)</span><input type="number" step="0.01" className={input} value={tf.amountUsd} onChange={e => onUsd(e.target.value)} /></div>
              <div><span className={label}>Fee (USD)</span><input type="number" step="0.01" className={input} value={tf.feeUsd} onChange={e => setT({ feeUsd: e.target.value })} /></div>
              <div><span className={label}>Rate ({cur} per USD)</span><input type="number" step="0.0001" className={input} value={tf.exchangeRate} onChange={e => onRate(e.target.value)} /></div>
              <div><span className={label}>Arrived ({cur})</span><input type="number" step="0.01" className={input} value={tf.amountLocal} onChange={e => onLocal(e.target.value)} /></div>
              <div><span className={label}>Method</span><select className={input} value={tf.method} onChange={e => setT({ method: e.target.value })}><option value="">—</option>{METHODS.map(m => <option key={m} value={m}>{m}</option>)}</select></div>
              <div><span className={label}>For</span><select className={input} value={tf.purpose} onChange={e => setT({ purpose: e.target.value })}>{Object.entries(TRANSFER_PURPOSE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
              <div><span className={label}>Paid from</span><select className={input} value={tf.bankAccountId} onChange={e => setT({ bankAccountId: e.target.value })}><option value="">—</option>{banks.map(b => <option key={b.id} value={b.id}>{b.name}{b.last4 ? ` ••${b.last4}` : ''}</option>)}</select></div>
              <div className="md:col-span-2"><span className={label}>Recipient</span><input className={input} value={tf.recipient} onChange={e => setT({ recipient: e.target.value })} placeholder="Who received it on the other side" /></div>
              <div className="md:col-span-2"><span className={label}>Confirmation / reference #</span><input className={input} value={tf.reference} onChange={e => setT({ reference: e.target.value })} /></div>
              <div className="col-span-2 md:col-span-4"><span className={label}>Notes</span><input className={input} value={tf.notes} onChange={e => setT({ notes: e.target.value })} placeholder="e.g. 3rd-floor slab, 2,000 bags of cement" /></div>
            </div>
            {err && <p className="text-xs text-red-400">{err}</p>}
            <div className="flex justify-end gap-2">
              {tf.id && <button onClick={async () => { if (confirm('Delete this transfer?')) { await deleteTransfer(tf.id!); setTf(null); await load(); } }} className="text-xs text-red-400 hover:text-red-300 mr-auto">Delete</button>}
              <button onClick={() => setTf(null)} className="btn text-xs">Cancel</button>
              <button onClick={saveTransfer} className="btn btn-primary text-xs">Save transfer</button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mb-2">
          <p className="section-label mb-0">Transfers{purposeFilter ? ` — ${TRANSFER_PURPOSE_LABELS[purposeFilter] ?? purposeFilter}` : ''}</p>
          {purposeFilter && <button onClick={() => setPurposeFilter('')} className="text-xs text-gray-500 hover:text-gray-300">Show all</button>}
        </div>
        {transfers.length === 0 ? <EmptyState icon="💸" title="No transfers yet" body="Log each transfer you send — attach the Remitly, Wise or bank receipt and the amounts fill in." />
          : (
            <div className="card overflow-x-auto">
              <table className="table-base">
                <thead><tr><th className="pl-4">Date</th><th>For</th><th>Method</th><th className="text-right">Sent</th><th className="text-right">Fee</th><th className="text-right">Rate</th><th className="text-right">Arrived</th><th>Recipient</th><th className="pr-4"></th></tr></thead>
                <tbody>
                  {transfers.map(x => (
                    <tr key={x.id}>
                      <td className="pl-4 whitespace-nowrap">{fmtDate(x.date, 'MMM d, yyyy')}</td>
                      <td>{TRANSFER_PURPOSE_LABELS[x.purpose || 'OTHER'] ?? x.purpose}</td>
                      <td className="text-gray-400">{x.method ?? '—'}{x.bankAccountName ? <span className="block text-xs text-gray-600">{x.bankAccountName}</span> : null}</td>
                      <td className="text-right text-white">{fmtMoney(x.amountUsd)}</td>
                      <td className="text-right text-gray-400">{x.feeUsd != null ? fmtMoney(x.feeUsd) : '—'}</td>
                      <td className="text-right text-gray-400">{x.exchangeRate != null ? Number(x.exchangeRate).toFixed(2) : '—'}</td>
                      <td className="text-right">{x.amountLocalComputed != null ? fmtCurrency(x.amountLocalComputed, cur) : '—'}</td>
                      <td className="text-gray-400">{x.recipient ?? '—'}{x.reference ? <span className="block text-xs text-gray-600">#{x.reference}</span> : null}</td>
                      <td className="pr-4 text-right whitespace-nowrap">
                        {x.hasDocument && <button onClick={() => openReceipt(x)} className="text-xs text-amber-400 hover:text-amber-300 mr-3">📄</button>}
                        <button onClick={() => edit(x)} className="text-xs text-gray-500 hover:text-gray-300">Edit</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        <div className="mt-8 flex justify-between items-center">
          <Link to="/projects" className="text-xs text-gray-500 hover:text-gray-300">← All projects</Link>
          <button onClick={async () => { if (confirm('Delete this project and every transfer logged for it?')) { await deleteProject(p.id); nav('/projects'); } }} className="text-xs text-red-400 hover:text-red-300">Delete project</button>
        </div>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <ProjectDetail id={id} /> : <ProjectList />;
}
