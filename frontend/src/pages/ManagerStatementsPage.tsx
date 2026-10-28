import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  readManagerStatement, importManagerStatement, applyReconciliationStatement, deleteReconciliationStatement,
  getReconciliationStatements, getReconciliationDocumentUrl, getLeases, getLoans, getProperties,
  type ManagerStatementDraft, type ManagerDraftLine, type ManagerLineKind,
} from '../api/client';
import type { Lease, Loan, Property, ReconciliationStatement } from '../types';
import { fmtMoney } from '../lib/money';
import { fmtDate } from '../lib/date';
import { fileToPayload } from '../lib/files';
import { describeApiError } from '../lib/apiError';

/**
 * Manager statements: upload the property manager's monthly owner
 * statement and Sollux reads it — rent collected, the management fee,
 * repairs, loan payments, what was sent to you — and matches each line to
 * the property, tenant or loan (backend services/managerStatement.ts). You
 * check the lines; applying records the rent, the loan payments and the
 * costs, which then show in Costs and the Overview. Rent already on record
 * for that tenant and month is left out so nothing counts twice.
 */

const KIND_LABEL: Record<ManagerLineKind, string> = {
  RENT: 'Rent collected', MANAGEMENT_FEE: 'Management fee', REPAIR: 'Repair / maintenance', UTILITY: 'Utility',
  LOAN_PAYMENT: 'Loan payment', OTHER_EXPENSE: 'Other cost', OWNER_DRAW: 'Sent to you', OTHER: 'Other (not recorded)',
};
const COST_KINDS: ManagerLineKind[] = ['MANAGEMENT_FEE', 'REPAIR', 'UTILITY', 'OTHER_EXPENSE'];
const CATEGORY_OF: Partial<Record<ManagerLineKind, string>> = { MANAGEMENT_FEE: 'PROPERTY_MANAGEMENT', REPAIR: 'REPAIRS_MAINTENANCE', UTILITY: 'UTILITIES', OTHER_EXPENSE: 'OTHER' };

export default function ManagerStatementsPage() {
  const [list, setList] = useState<ReconciliationStatement[] | null>(null);
  const [draft, setDraft] = useState<ManagerStatementDraft | null>(null);
  const [reading, setReading] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => getReconciliationStatements().then(setList).catch(e => setError(describeApiError(e, 'Could not load statements.'))), []);
  useEffect(() => { void load(); }, [load]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setReading(file.name); setError('');
    try {
      const p = await fileToPayload(file);
      setDraft(await readManagerStatement(p.data, p.name));
    } catch (e) { setError(describeApiError(e, 'Could not read that statement.')); }
    finally { setReading(''); }
  }

  async function openFile(id: string) {
    try { const { url } = await getReconciliationDocumentUrl(id); window.open(url, '_blank', 'noopener,noreferrer'); }
    catch (e) { setError(describeApiError(e, 'Could not open the file.')); }
  }

  if (draft) return <Review draft={draft} onCancel={() => setDraft(null)} onDone={() => { setDraft(null); void load(); }} />;

  return (
    <div>
      <div className="rounded-xl p-5 mb-5 flex flex-wrap items-center gap-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex-1 min-w-[240px]">
          <p className="font-semibold text-white">Upload a manager's statement</p>
          <p className="text-xs text-gray-500 mt-0.5">The monthly owner statement from your property manager, as a PDF or a photo. Sollux reads every line and matches it to your properties, tenants and loans; you check it before anything is recorded.</p>
        </div>
        <label className={`btn-primary text-sm px-4 py-2 cursor-pointer ${reading ? 'opacity-60 pointer-events-none' : ''}`}>
          {reading ? `Reading ${reading}…` : 'Choose file'}
          <input type="file" accept="application/pdf,image/*" className="hidden" onChange={e => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {list && !list.length && <p className="text-sm text-gray-500">No statements yet.</p>}
      {!!list?.length && (
        <div className="rounded-xl overflow-hidden" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-gray-500"><th className="text-left px-4 py-2 font-medium">Statement</th><th className="text-left px-4 py-2 font-medium">Manager</th><th className="text-right px-4 py-2 font-medium">Net</th><th className="text-left px-4 py-2 font-medium">Status</th><th /></tr></thead>
            <tbody>
              {list.map(s => (
                <tr key={s.id} className="border-t border-white/5">
                  <td className="px-4 py-2 text-gray-200">{fmtDate(s.statementDate)}</td>
                  <td className="px-4 py-2 text-gray-300">{s.profile?.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-200">{fmtMoney(s.netAmount)}</td>
                  <td className="px-4 py-2">{s.status === 'APPLIED' ? <span className="text-xs text-emerald-400">Recorded {s.appliedAt ? fmtDate(s.appliedAt) : ''}</span> : <span className="text-xs text-amber-400">Not recorded yet</span>}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap text-xs">
                    {s.documentS3Key && <button onClick={() => void openFile(s.id)} className="text-gray-400 hover:text-white mr-3">File</button>}
                    {s.status !== 'APPLIED' && <button onClick={async () => { try { await applyReconciliationStatement(s.id); void load(); } catch (e) { setError(describeApiError(e, 'Could not record it.')); } }} className="text-amber-400 hover:text-amber-300 mr-3">Record</button>}
                    {s.status !== 'APPLIED' && <button onClick={async () => { if (confirm('Delete this statement?')) { await deleteReconciliationStatement(s.id); void load(); } }} className="text-gray-500 hover:text-red-400">Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Review({ draft, onCancel, onDone }: { draft: ManagerStatementDraft; onCancel: () => void; onDone: () => void }) {
  const [lines, setLines] = useState<ManagerDraftLine[]>(draft.lines);
  const [manager, setManager] = useState(draft.manager ?? '');
  const [date, setDate] = useState(draft.statementDate ?? draft.periodEnd ?? new Date().toISOString().slice(0, 10));
  const [properties, setProperties] = useState<Property[]>([]);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    void getProperties().then(setProperties).catch(() => {});
    void getLeases().then(setLeases).catch(() => {});
    void getLoans({ isActive: true }).then(setLoans).catch(() => {});
  }, []);

  const set = (i: number, patch: Partial<ManagerDraftLine>) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const propName = useMemo(() => new Map(properties.map(p => [p.id, p.nickname || p.address])), [properties]);
  const leaseLabel = (l: Lease) => {
    const names = (l as any).leaseTenants?.map((t: any) => t.tenant?.fullName).filter(Boolean).join(', ') || 'No tenant';
    return `${names} · ${l.unit?.unitLabel ?? ''} · ${l.unit?.property?.nickname || l.unit?.property?.address || ''}${l.status !== 'ACTIVE' ? ' (ended)' : ''}`;
  };
  const included = lines.filter(l => l.include);
  const sum = (f: (l: ManagerDraftLine) => boolean) => included.filter(f).reduce((t, l) => t + l.amount, 0);

  async function save() {
    if (!manager.trim()) { setErr('Name the manager.'); return; }
    setSaving(true); setErr('');
    try {
      const r = await importManagerStatement({ profileId: draft.profileId, managerName: manager.trim(), statementDate: date, documentKey: draft.documentKey, lines });
      await applyReconciliationStatement(r.id);
      onDone();
    } catch (e) { setErr(describeApiError(e, 'Could not record the statement.')); }
    finally { setSaving(false); }
  }

  const input = 'input-dark text-xs w-full';
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div><label className="block text-xs text-gray-500 mb-1">Manager</label><input className="input-dark text-sm w-56" value={manager} onChange={e => setManager(e.target.value)} /></div>
        <div><label className="block text-xs text-gray-500 mb-1">Statement date</label><input type="date" className="input-dark text-sm" value={date} onChange={e => setDate(e.target.value)} /></div>
        <div className="text-xs text-gray-400 ml-auto flex gap-4">
          <span>Collected <span className="text-emerald-400 tabular-nums">{fmtMoney(sum(l => l.direction === 'IN'))}</span></span>
          <span>Costs <span className="text-red-400 tabular-nums">{fmtMoney(sum(l => l.direction === 'OUT' && l.kind !== 'OWNER_DRAW'))}</span></span>
          <span>Sent to you <span className="text-white tabular-nums">{fmtMoney(draft.totals.toOwner)}</span></span>
        </div>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Check each line. Rent is recorded on the tenant's lease, loan payments on the loan, and fees and repairs as the property's costs. Lines left unticked are kept on the statement but not recorded{lines.some(l => l.alreadyRecorded) ? ' — rent already on record for that tenant and month starts unticked' : ''}.
      </p>

      <div className="rounded-xl overflow-x-auto" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
        <table className="w-full text-xs" style={{ minWidth: 900 }}>
          <thead><tr className="text-gray-500">
            <th className="px-3 py-2 w-8" /><th className="text-left px-2 py-2 font-medium">Date</th><th className="text-left px-2 py-2 font-medium">Line</th>
            <th className="text-left px-2 py-2 font-medium w-44">What it is</th><th className="text-left px-2 py-2 font-medium w-72">Recorded on</th><th className="text-right px-3 py-2 font-medium">Amount</th>
          </tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={`border-t border-white/5 ${l.include ? '' : 'opacity-50'}`}>
                <td className="px-3 py-2"><input type="checkbox" checked={l.include} onChange={e => set(i, { include: e.target.checked })} /></td>
                <td className="px-2 py-2 text-gray-400 whitespace-nowrap">{l.date ? fmtDate(l.date) : '—'}</td>
                <td className="px-2 py-2 text-gray-200">
                  {l.description}
                  {(l.payee || l.propertyHint) && <div className="text-gray-500">{[l.payee, l.propertyHint].filter(Boolean).join(' · ')}</div>}
                  {l.alreadyRecorded && <div className="text-amber-400">Already recorded for this tenant and month</div>}
                </td>
                <td className="px-2 py-2">
                  <select className={input} value={l.kind} onChange={e => { const k = e.target.value as ManagerLineKind; set(i, { kind: k, category: CATEGORY_OF[k] ?? null, include: k !== 'OWNER_DRAW' && k !== 'OTHER' && l.include }); }}>
                    {(Object.keys(KIND_LABEL) as ManagerLineKind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                  </select>
                </td>
                <td className="px-2 py-2">
                  {l.kind === 'RENT' ? (
                    <select className={input} value={l.leaseId ?? ''} onChange={e => set(i, { leaseId: e.target.value || null })}>
                      <option value="">Choose the lease…</option>
                      {leases.map(x => <option key={x.id} value={x.id}>{leaseLabel(x)}</option>)}
                    </select>
                  ) : l.kind === 'LOAN_PAYMENT' ? (
                    <select className={input} value={l.loanId ?? ''} onChange={e => set(i, { loanId: e.target.value || null })}>
                      <option value="">Choose the loan…</option>
                      {loans.map(x => <option key={x.id} value={x.id}>{x.lender}{x.accountLast4 ? ` ••${x.accountLast4}` : ''}{x.propertyId && propName.get(x.propertyId) ? ` · ${propName.get(x.propertyId)}` : ''}</option>)}
                    </select>
                  ) : COST_KINDS.includes(l.kind) ? (
                    <select className={input} value={l.propertyId ?? ''} onChange={e => set(i, { propertyId: e.target.value || null })}>
                      <option value="">Choose the property…</option>
                      {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
                    </select>
                  ) : <span className="text-gray-600">Not recorded</span>}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${l.direction === 'IN' ? 'text-emerald-400' : 'text-gray-200'}`}>{l.direction === 'IN' ? '+' : '−'}{fmtMoney(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {err && <p className="text-sm text-red-400 mt-3">{err}</p>}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onCancel} className="btn-ghost text-sm">Cancel</button>
        <button onClick={() => void save()} disabled={saving} className="btn-primary text-sm px-4 py-2">{saving ? 'Recording…' : `Record ${included.length} line${included.length === 1 ? '' : 's'}`}</button>
      </div>
    </div>
  );
}
