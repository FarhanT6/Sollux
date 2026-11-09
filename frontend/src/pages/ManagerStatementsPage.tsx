import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  readManagerStatement, importManagerStatement, applyReconciliationStatement, deleteReconciliationStatement,
  getReconciliationStatements, getReconciliationDocumentUrl, getLeases, getLoans, getProperties, getBankAccounts, getReconciliationProfiles, updateReconciliationProfile, fetchManagerStatementsFromEmail, undoReconciliationStatement, redoManagerStatements, reviewEmailedStatement, mergeManagers, type ManagerRedoSummary,
  type ManagerStatementDraft, type ManagerDraftLine, type ManagerLineKind,
} from '../api/client';
import type { BankAccount, ExpenseCategory, Lease, Loan, Property, ReconciliationProfile, ReconciliationStatement } from '../types';
import { EXPENSE_CATEGORY_LABELS } from '../types';
import { bankAccountLabel } from '../lib/bankAccountLabel';
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
 *
 * From email: a statement emailed to a connected Gmail (from the address a
 * manager uses, or reading like an owner statement) is fetched and recorded on
 * its own — rent for the month each line shows, each loan line as that month's
 * payment — skipping what an earlier statement already had. Lines it could not
 * match wait under Review.
 */

const KIND_LABEL: Record<ManagerLineKind, string> = {
  RENT: 'Rent collected', MANAGEMENT_FEE: 'Management fee', REPAIR: 'Repair / maintenance', UTILITY: 'Utility',
  LOAN_PAYMENT: 'Loan payment', OTHER_EXPENSE: 'Other cost', REIMBURSEMENT: 'Reimbursement (offsets a cost)',
  OWNER_PAYMENT: 'You paid the manager', OWNER_DRAW: 'Sent to you', OTHER: 'Other (not recorded)',
};
const COST_KINDS: ManagerLineKind[] = ['MANAGEMENT_FEE', 'REPAIR', 'UTILITY', 'OTHER_EXPENSE', 'REIMBURSEMENT'];
const CATEGORY_OF: Partial<Record<ManagerLineKind, string>> = { MANAGEMENT_FEE: 'PROPERTY_MANAGEMENT', REPAIR: 'REPAIRS_MAINTENANCE', UTILITY: 'UTILITIES', OTHER_EXPENSE: 'OTHER', REIMBURSEMENT: 'OTHER' };
// The property-cost categories a statement line can be filed under.
const PROPERTY_CATEGORIES = (Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[])
  .filter(k => !['AUTO_LOAN', 'AUTO_INSURANCE', 'CREDIT_CARD', 'MEDICAL', 'PHONE', 'STUDENT_LOAN', 'LIFE_INSURANCE', 'SUBSCRIPTIONS', 'MORTGAGE_DEBT_SERVICE'].includes(k));
/** A line's wording as the key for "the same line" (backend lib/managerStatementMatch lineKey). */
const lineKey = (d: string) => String(d ?? '').toLowerCase()
  .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
  .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b\.?(?:\s+\d{4})?/g, ' ')
  .replace(/[^a-z0-9$]+/g, ' ').replace(/\s+/g, ' ').trim();

export default function ManagerStatementsPage({ initialFile }: { /** Handed over from Add's drop zone: read at once. */ initialFile?: File } = {}) {
  const [list, setList] = useState<ReconciliationStatement[] | null>(null);
  const [draft, setDraft] = useState<(ManagerStatementDraft & { replaceId?: string | null; fromEmail?: boolean }) | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [redoing, setRedoing] = useState<string | null>(null);
  const redoNote = (r: ManagerRedoSummary) => `Recorded again from ${r.statements} statement${r.statements === 1 ? '' : 's'}: ${r.rent} rent, ${r.loanPayments} loan payment${r.loanPayments === 1 ? '' : 's'}, ${r.expenses} cost${r.expenses === 1 ? '' : 's'}.${r.notStatements ? ` ${r.notStatements} PDF${r.notStatements === 1 ? ' was' : 's were'} not a statement and ${r.notStatements === 1 ? 'was' : 'were'} set aside.` : ''}${r.needsLook ? ` ${r.needsLook} line${r.needsLook === 1 ? '' : 's'} still need${r.needsLook === 1 ? 's' : ''} you.` : ''}`;
  async function redo(profileId: string) {
    setRedoing(profileId); setError(''); setChecked(null);
    try { setChecked(redoNote(await redoManagerStatements(profileId))); await load(); }
    catch (e) { setError(describeApiError(e, 'Could not redo them.')); }
    finally { setRedoing(null); }
  }
  const [profiles, setProfiles] = useState<ReconciliationProfile[]>([]);
  const loadProfiles = useCallback(() => getReconciliationProfiles().then(setProfiles).catch(() => {}), []);
  useEffect(() => { void loadProfiles(); }, [loadProfiles]);
  const [reading, setReading] = useState('');
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);
  async function checkEmail() {
    setChecking(true); setChecked(null); setError('');
    try {
      const r = await fetchManagerStatementsFromEmail();
      setChecked(!r.mailboxes ? 'No Gmail is connected yet — connect it where bills are fetched from email.'
        : `${r.recorded ? `Recorded ${r.recorded} new statement${r.recorded === 1 ? '' : 's'}.` : 'No new statements.'}${r.already ? ` ${r.already} already fetched.` : ''} Looked through ${r.looked} email${r.looked === 1 ? '' : 's'} from the last 6 months.${r.errors.length ? ` ${r.errors.length} could not be read: ${r.errors[0]}` : ''}`);
      await load(); await loadProfiles();
    } catch (e) { setError(describeApiError(e, 'Could not check your email.')); }
    finally { setChecking(false); }
  }
  const [error, setError] = useState('');

  const load = useCallback(() => getReconciliationStatements().then(setList).catch(e => setError(describeApiError(e, 'Could not load statements.'))), []);
  useEffect(() => { void load(); }, [load]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (initialFile) void pick(initialFile); }, []);

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

  if (draft) return <Review draft={draft} onCancel={() => setDraft(null)} onDone={note => { setDraft(null); if (note) setChecked(note); void load(); }} redoNote={redoNote} />;

  // A statement's row: what it recorded, in words.
  const recordedText = (s: ReconciliationStatement) => {
    if (s.status === 'NOT_A_STATEMENT') return { text: 'Not a manager statement — nothing recorded', cls: 'text-gray-500' };
    if (s.status === 'UNDONE') return { text: 'Undone — nothing recorded', cls: 'text-gray-500' };
    if (s.status !== 'APPLIED') return { text: 'Not recorded yet', cls: 'text-amber-400' };
    const c = s.createdRecordIds ?? { rentPaymentIds: [], loanPaymentIds: [], expenseIds: [] };
    const parts = [[c.rentPaymentIds?.length ?? 0, 'rent'], [c.loanPaymentIds?.length ?? 0, 'loan payment'], [c.expenseIds?.length ?? 0, 'cost']]
      .filter(([n]) => (n as number) > 0).map(([n, w]) => `${n} ${w}${n === 1 || w === 'rent' ? '' : 's'}`);
    return parts.length ? { text: `Recorded ${parts.join(', ')}`, cls: 'text-emerald-400' } : { text: 'Nothing new — all on an earlier statement', cls: 'text-gray-400' };
  };
  const others = (list ?? []).filter(s => s.status === 'NOT_A_STATEMENT');
  const shown = (list ?? []).filter(s => showOthers || s.status !== 'NOT_A_STATEMENT');
  const emailManagers = [...new Map((list ?? []).filter(s => s.source === 'email').map(s => [s.profileId, s.profile?.name ?? 'Manager'])).entries()];
  // Each year-to-date statement repeats every earlier month, so the same unmatched lines are on all of them:
  // they are counted, and reviewed, on each manager's newest statement only.
  const newestOf = new Map<string, string>();
  for (const s of [...(list ?? [])].filter(x => x.source === 'email' && x.draftJson && x.status === 'APPLIED')
    .sort((a, b) => String(b.receivedAt ?? b.statementDate).localeCompare(String(a.receivedAt ?? a.statementDate)))) {
    if (!newestOf.has(s.profileId)) newestOf.set(s.profileId, s.id);
  }
  // A manager whose name is what another's statements are headed with ("Pacific Coast Executive Realty" for Monty James's): one manager.
  const sameAs = profiles.flatMap(p => {
    const other = (list ?? []).find(s => s.profileId !== p.id && s.source === 'email' && String(s.draftJson?.manager ?? '').trim().toLowerCase() === p.name.trim().toLowerCase());
    return other ? [{ from: p, intoId: other.profileId, intoName: other.profile?.name ?? 'the other manager' }] : [];
  });
  async function merge(fromId: string, intoId: string) {
    setRedoing(intoId); setError(''); setChecked(null);
    try { const r = await mergeManagers(fromId, intoId); setChecked(`Merged into one manager. ${redoNote(r)}`); await load(); await loadProfiles(); }
    catch (e) { setError(describeApiError(e, 'Could not merge them.')); }
    finally { setRedoing(null); }
  }

  return (
    <div>
      <div className="rounded-xl p-5 mb-5 flex flex-wrap items-center gap-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex-1 min-w-[240px]">
          <p className="font-semibold text-white">Upload a manager's statement</p>
          <p className="text-xs text-gray-500 mt-0.5">The monthly owner statement from your property manager, as a PDF or a photo. Sollux reads every line and matches it to your properties, tenants and loans; you check it before anything is recorded.</p>
          <p className="text-xs text-gray-400 mt-1.5">Statements emailed to your connected Gmail are fetched and recorded on their own each night: rent for the month each line shows, and each loan marked paid for that month. Lines already on an earlier statement, or already recorded, are skipped.</p>
        </div>
        <button onClick={() => void checkEmail()} disabled={checking} className="btn text-sm px-4 py-2 disabled:opacity-60">{checking ? 'Checking email…' : 'Check email now'}</button>
        <label className={`btn-primary text-sm px-4 py-2 cursor-pointer ${reading ? 'opacity-60 pointer-events-none' : ''}`}>
          {reading ? `Reading ${reading}…` : 'Choose file'}
          <input type="file" accept="application/pdf,image/*" className="hidden" onChange={e => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
      {checked && <p className="text-sm text-gray-300 mb-3">{checked}</p>}

      {profiles.length > 0 && (
        <div className="rounded-xl p-4 mb-5 space-y-2" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-sm font-semibold text-white">Fetched from email</p>
          <p className="text-xs text-gray-500">A PDF from these addresses is read as that manager's statement. Sollux adds the sender itself the first time it spots one; add another address if the manager uses more than one.</p>
          {profiles.map(p => <SenderRow key={p.id} profile={p} others={profiles.filter(o => o.id !== p.id)} onMerge={intoId => void merge(p.id, intoId)} onSaved={() => void loadProfiles()} />)}
        </div>
      )}

      {sameAs.map(x => (
        <div key={x.from.id} className="rounded-xl p-4 mb-3 flex flex-wrap items-center gap-3" style={{ background: '#1e1e1e', border: '1px solid rgba(245,166,35,0.35)' }}>
          <p className="text-sm text-gray-200 flex-1 min-w-[260px]">“{x.from.name}” and “{x.intoName}” look like the same manager — {x.intoName}'s statements are headed “{x.from.name}”. As two managers, some lines are counted on both.</p>
          <button disabled={!!redoing} onClick={() => void merge(x.from.id, x.intoId)} className="btn btn-primary text-xs disabled:opacity-50">{redoing === x.intoId ? 'Merging…' : 'Merge into one'}</button>
        </div>
      ))}

      {emailManagers.length > 0 && (
        <div className="rounded-xl p-4 mb-5 text-xs text-gray-400 space-y-1.5" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-sm font-semibold text-white">How the emailed statements are recorded</p>
          <p>Each statement your manager emails is listed below, oldest at the bottom. A year-to-date statement repeats every earlier month, so from each one only the lines not on an earlier statement are recorded — that's why most rows say “Nothing new”. Rent is recorded for the month on the line, loan payments as that month's payment, fees and taxes as the property's costs.</p>
          <p>A line Sollux can't match waits under <span className="text-amber-400">Review</span>. What you choose there is remembered, and every statement is recorded again with it, so earlier months fill in too. <span className="text-gray-300">Undo</span> removes what one statement recorded.</p>
          <div className="flex flex-wrap gap-2 pt-1">
            {emailManagers.map(([id, name]) => (
              <button key={id} disabled={redoing === id} onClick={() => void redo(id)} className="btn text-xs disabled:opacity-50" title="Undo and record every emailed statement from this manager again, oldest first, with what you've chosen so far">
                {redoing === id ? 'Recording again…' : `Record ${name}'s statements again`}
              </button>
            ))}
          </div>
        </div>
      )}

      {list && !list.length && <p className="text-sm text-gray-500">No statements yet.</p>}
      {!!list?.length && (
        <div className="rounded-xl overflow-hidden" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-gray-500"><th className="text-left px-4 py-2 font-medium">Statement</th><th className="text-left px-4 py-2 font-medium">Manager</th><th className="text-left px-4 py-2 font-medium">What it recorded</th><th /></tr></thead>
            <tbody>
              {shown.map(s => (
                <tr key={s.id} className="border-t border-white/5">
                  <td className="px-4 py-2 text-gray-200">{fmtDate(s.statementDate)}</td>
                  <td className="px-4 py-2 text-gray-300">{s.profile?.name}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs ${recordedText(s).cls}`}>{recordedText(s).text}</span>
                    <span className="block text-xs text-gray-500">{s.source === 'email' ? `Emailed ${s.receivedAt ? fmtDate(s.receivedAt) : ''}` : 'Uploaded'}{s.status === 'APPLIED' && s.appliedAt ? ` · recorded ${fmtDate(s.appliedAt)}` : ''}</span>
                    {!!s.draftJson?.needsLook && s.status === 'APPLIED' && newestOf.get(s.profileId) === s.id && <span className="block text-xs text-amber-400">{s.draftJson.needsLook} line{s.draftJson.needsLook === 1 ? '' : 's'} to match, across every month — review</span>}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap text-xs">
                    {s.documentS3Key && <button onClick={() => void openFile(s.id)} className="text-gray-400 hover:text-white mr-3">File</button>}
                    {s.draftJson && s.status !== 'NOT_A_STATEMENT' && (s.status === 'DRAFT' || (!!s.draftJson.needsLook && (s.source !== 'email' || newestOf.get(s.profileId) === s.id))) && <button onClick={() => setDraft({ ...s.draftJson!, replaceId: s.id, fromEmail: s.source === 'email' })} className="text-amber-400 hover:text-amber-300 mr-3">Review</button>}
                    {s.status === 'DRAFT' && !s.draftJson && <button onClick={async () => { try { await applyReconciliationStatement(s.id); void load(); } catch (e) { setError(describeApiError(e, 'Could not record it.')); } }} className="text-amber-400 hover:text-amber-300 mr-3" title="Lines another statement already recorded are skipped">Record</button>}
                    {s.status === 'APPLIED' && <button onClick={async () => { if (confirm('Remove the rent, loan payments and costs this statement recorded?')) { try { await undoReconciliationStatement(s.id); void load(); } catch (e) { setError(describeApiError(e, 'Could not undo it.')); } } }} className="text-gray-500 hover:text-white mr-3">Undo</button>}
                    {s.status !== 'APPLIED' && s.source !== 'email' && <button onClick={async () => { if (confirm('Delete this statement?')) { await deleteReconciliationStatement(s.id); void load(); } }} className="text-gray-500 hover:text-red-400">Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {others.length > 0 && (
            <button onClick={() => setShowOthers(v => !v)} className="w-full text-xs text-gray-500 hover:text-gray-300 py-2 border-t border-white/5">
              {showOthers ? 'Hide' : 'Show'} {others.length} other PDF{others.length === 1 ? '' : 's'} from your manager that {others.length === 1 ? 'was' : 'were'}n't a statement (loan letters, schedules)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const loanLabel = (x: Loan, propName: Map<string, string>) =>
  `${x.lender}${x.accountLast4 ? ` ••${x.accountLast4}` : ''}${x.propertyId && propName.get(x.propertyId) ? ` · ${propName.get(x.propertyId)}` : ''}${x.isActive ? '' : ' (paid off)'}`;

/**
 * The loan a loan line paid — or, for a line that paid two loans at once ("Loan repayment" to a lender
 * who held two loans, one since paid off), each loan's part. Remembered for lines of the same total.
 */
function LoanChoice({ line, loans, propName, input, onChange }: { line: ManagerDraftLine; loans: Loan[]; propName: Map<string, string>; input: string; onChange: (p: Partial<ManagerDraftLine>) => void }) {
  const parts = line.splits ?? null;
  const options = <>{loans.map(x => <option key={x.id} value={x.id}>{loanLabel(x, propName)}</option>)}</>;
  if (!parts) {
    return (
      <div>
        <select className={input} value={line.loanId ?? ''} onChange={e => onChange({ loanId: e.target.value || null })}>
          <option value="">Choose the loan…</option>{options}
        </select>
        <button type="button" className="text-[11px] text-gray-500 hover:text-amber-300 mt-0.5" disabled={line.recordedNow}
          onClick={() => onChange({ splits: [{ loanId: line.loanId ?? '', amount: line.amount }, { loanId: '', amount: 0 }] })}>Split between loans</button>
      </div>
    );
  }
  const sum = parts.reduce((t, p) => t + (Number(p.amount) || 0), 0);
  const setPart = (k: number, patch: Partial<{ loanId: string; amount: number }>) => {
    const next = parts.map((p, j) => (j === k ? { ...p, ...patch } : p));
    // The last part takes what is left, so the parts always add up to the line.
    if (k < next.length - 1 && patch.amount !== undefined) next[next.length - 1] = { ...next[next.length - 1], amount: Math.max(0, Math.round((line.amount - next.slice(0, -1).reduce((t, p) => t + (Number(p.amount) || 0), 0)) * 100) / 100) };
    onChange({ splits: next, loanId: next[0].loanId || null });
  };
  return (
    <div className="space-y-1">
      {parts.map((p, k) => (
        <div key={k} className="flex gap-1">
          <select className={input} value={p.loanId} onChange={e => setPart(k, { loanId: e.target.value })}><option value="">Loan…</option>{options}</select>
          <input type="number" step="0.01" className="input-dark text-xs w-24" value={p.amount || ''} onChange={e => setPart(k, { amount: Number(e.target.value) })} />
        </div>
      ))}
      <div className="flex gap-3 text-[11px]">
        <button type="button" className="text-gray-500 hover:text-amber-300" onClick={() => onChange({ splits: [...parts, { loanId: '', amount: 0 }] })}>+ another loan</button>
        <button type="button" className="text-gray-500 hover:text-red-300" onClick={() => onChange({ splits: null })}>One loan</button>
        {Math.abs(sum - line.amount) > 0.005 && <span className="text-amber-400">parts add to {sum.toFixed(2)}, not {line.amount.toFixed(2)}</span>}
      </div>
    </div>
  );
}

/** A manager's sending addresses: a PDF from one is read as their statement. */
function SenderRow({ profile, others, onMerge, onSaved }: { profile: ReconciliationProfile; others: ReconciliationProfile[]; onMerge: (intoId: string) => void; onSaved: () => void }) {
  const [v, setV] = useState(profile.emailFrom ?? '');
  const [state, setState] = useState('');
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-gray-300 w-40 truncate">{profile.name}</span>
      <input className="input-dark text-xs flex-1 min-w-[220px]" placeholder="manager@example.com" value={v} onChange={e => { setV(e.target.value); setState(''); }} />
      <button className="btn text-xs" disabled={v === (profile.emailFrom ?? '')} onClick={async () => {
        try { await updateReconciliationProfile(profile.id, { emailFrom: v }); setState('Saved'); onSaved(); } catch (e) { setState(describeApiError(e, 'Not saved')); }
      }}>Save</button>
      {others.length > 0 && (
        <select className="input-dark text-xs" value="" title="This manager is the same as another one (a person and their company): merge them"
          onChange={e => { const o = others.find(x => x.id === e.target.value); if (o && confirm(`Merge “${profile.name}” into “${o.name}”? Its statements and choices move there and every statement is recorded again, so nothing is counted twice.`)) onMerge(o.id); }}>
          <option value="">Same manager as…</option>
          {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )}
      {state && <span className="text-gray-500">{state}</span>}
    </div>
  );
}

function Review({ draft, onCancel, onDone, redoNote }: { draft: ManagerStatementDraft & { replaceId?: string | null; fromEmail?: boolean }; onCancel: () => void; onDone: (note?: string) => void; redoNote: (r: ManagerRedoSummary) => string }) {
  const [lines, setLines] = useState<ManagerDraftLine[]>(draft.lines);
  const [manager, setManager] = useState(draft.manager ?? '');
  const [date, setDate] = useState(draft.statementDate ?? draft.periodEnd ?? new Date().toISOString().slice(0, 10));
  const [properties, setProperties] = useState<Property[]>([]);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    void getProperties().then(setProperties).catch(() => {});
    void getLeases().then(setLeases).catch(() => {});
    // Paid-off loans too: an earlier month on a year-to-date statement can be a payment on a loan since paid off.
    void getLoans().then(ls => setLoans([...ls].sort((a, b) => Number(b.isActive) - Number(a.isActive)))).catch(() => {});
    void getBankAccounts().then(b => setBanks(b.filter(x => x.accountType !== 'CREDIT_CARD'))).catch(() => {});
  }, []);

  // A choice for one line fills in every line with the same wording (the same loan every month, the same fee):
  // earlier months on a year-to-date statement that were never recorded get it too, and are ticked.
  const set = (i: number, patch: Partial<ManagerDraftLine>) => setLines(ls => {
    const key = lineKey(ls[i].description);
    const { include: _inc, splits, ...shared } = patch;
    const chosen = ['leaseId', 'loanId', 'propertyId'].some(k => (patch as any)[k]) || !!splits?.length;
    const amount = ls[i].amount;
    return ls.map((l, j) => {
      if (j === i) return { ...l, ...patch };
      if (l.recordedNow || lineKey(l.description) !== key) return l;
      // A split goes to the same line of the same amount only (another month's different amount paid one loan).
      const mine = { ...shared, ...(splits !== undefined && Math.abs(l.amount - amount) < 0.005 ? { splits } : {}) };
      if (!Object.keys(mine).length) return l;
      return { ...l, ...mine, include: chosen && !l.onEarlierStatement && !l.alreadyRecorded ? true : l.include };
    });
  });
  const propName = useMemo(() => new Map(properties.map(p => [p.id, p.nickname || p.address])), [properties]);
  const leaseLabel = (l: Lease) => {
    const names = (l as any).leaseTenants?.map((t: any) => t.tenant?.fullName).filter(Boolean).join(', ') || 'No tenant';
    return `${names} · ${l.unit?.unitLabel ?? ''} · ${l.unit?.property?.nickname || l.unit?.property?.address || ''}${l.status !== 'ACTIVE' ? ' (ended)' : ''}`;
  };
  const included = lines.filter(l => l.include && !l.recordedNow && l.kind !== 'OWNER_PAYMENT');
  const sum = (f: (l: ManagerDraftLine) => boolean) => included.filter(f).reduce((t, l) => t + l.amount, 0);

  async function save() {
    if (!manager.trim()) { setErr('Name the manager.'); return; }
    setSaving(true); setErr('');
    try {
      if (draft.fromEmail && draft.replaceId) {
        // An emailed statement: the choices are remembered, and every statement from the manager is recorded again with them.
        onDone(redoNote(await reviewEmailedStatement(draft.replaceId, lines.map(l => (l.recordedNow ? { ...l, include: true } : l)))));
        return;
      }
      const r = await importManagerStatement({ profileId: draft.profileId, managerName: manager.trim(), statementDate: date, documentKey: draft.documentKey, lines: lines.filter(l => !l.recordedNow), replaceId: draft.replaceId ?? null });
      await applyReconciliationStatement(r.id);
      // The manager's emailed statements, recorded again with what was just chosen (and without what this one recorded).
      const again = await redoManagerStatements(r.profileId).catch(() => null);
      onDone(again && again.statements ? redoNote(again) : undefined);
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
        Check each line. Rent is recorded on the tenant's lease, loan payments on the loan, and fees and repairs as the property's costs. What you choose for a line is remembered for this manager: next month the same lines fill in and record themselves. Lines left unticked are kept on the statement but not recorded{lines.some(l => l.alreadyRecorded || l.onEarlierStatement) ? ' — lines on an earlier statement, and rent or loan payments already on record for that month, start unticked' : ''}.
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
                <td className="px-3 py-2"><input type="checkbox" checked={l.include} disabled={l.recordedNow} onChange={e => set(i, { include: e.target.checked })} /></td>
                <td className="px-2 py-2 text-gray-400 whitespace-nowrap">{l.date ? fmtDate(l.date) : '—'}</td>
                <td className="px-2 py-2 text-gray-200">
                  {l.description}
                  {(l.payee || l.propertyHint) && <div className="text-gray-500">{[l.payee, l.propertyHint].filter(Boolean).join(' · ')}</div>}
                  {l.recordedNow && <div className="text-emerald-400">Recorded when the email came in</div>}
                  {!l.recordedNow && l.learned && <div className="text-sky-300/80">Filled in from last time</div>}
                  {!l.recordedNow && l.onEarlierStatement && <div className="text-gray-500">On an earlier statement — already counted</div>}
                  {!l.recordedNow && !l.onEarlierStatement && l.alreadyRecorded && <div className="text-amber-400">Already recorded {l.kind === 'LOAN_PAYMENT' ? 'for this loan' : 'for this tenant'} and month</div>}
                </td>
                <td className="px-2 py-2">
                  <select className={input} value={l.kind} onChange={e => { const k = e.target.value as ManagerLineKind; set(i, { kind: k, category: CATEGORY_OF[k] ?? null, include: k === 'OWNER_PAYMENT' || (k !== 'OWNER_DRAW' && k !== 'OTHER' && l.include) }); }}>
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
                    <LoanChoice line={l} loans={loans} propName={propName} input={input} onChange={patch => set(i, patch)} />
                  ) : COST_KINDS.includes(l.kind) ? (
                    <div className="flex gap-1">
                      <select className={input} value={l.propertyId ?? ''} onChange={e => set(i, { propertyId: e.target.value || null })}>
                        <option value="">Choose the property…</option>
                        {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
                      </select>
                      <select className={input} value={l.category ?? 'OTHER'} onChange={e => set(i, { category: e.target.value })} title="What kind of cost">
                        {PROPERTY_CATEGORIES.map(k => <option key={k} value={k}>{EXPENSE_CATEGORY_LABELS[k]}</option>)}
                      </select>
                    </div>
                  ) : l.kind === 'OWNER_PAYMENT' ? (
                    <select className={input} value={l.bankAccountId ?? ''} onChange={e => set(i, { bankAccountId: e.target.value || null })} title="The account it came out of">
                      <option value="">From which account…</option>
                      {banks.map(b => <option key={b.id} value={b.id}>From {bankAccountLabel(b)}</option>)}
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
        <button onClick={() => void save()} disabled={saving} className="btn-primary text-sm px-4 py-2">{saving ? 'Recording…' : draft.fromEmail ? 'Save choices and record again' : `Record ${included.length} line${included.length === 1 ? '' : 's'}`}</button>
      </div>
    </div>
  );
}
