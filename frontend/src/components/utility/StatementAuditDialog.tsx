import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fixAuditedStatement, getStatementAudit, startStatementAudit, type StatementAudit, type StatementAuditFinding } from '../../api/client';
import { describeApiError } from '../../lib/apiError';
import { fmtMoney } from '../../lib/money';
import { fmtDate } from '../../lib/date';

const FIELD: Record<StatementAuditFinding['field'], string> = {
  charge: "Period's charge",
  pastDue: 'Past due carried in',
  total: 'Total due',
  dueDate: 'Due date',
  payments: 'Payments received',
  unreadable: 'Could not read the PDF',
};
const show = (f: StatementAuditFinding, v: number | string | null) =>
  v == null ? '—' : typeof v === 'number' ? fmtMoney(v) : f.field === 'dueDate' ? fmtDate(v) : String(v);

/**
 * Check statements against their PDFs: every account's newest statements
 * are read again (nothing saved) and set against what Sollux shows. Each
 * difference can be fixed by re-reading that statement for real.
 */
export default function StatementAuditDialog({ onClose, onFixed }: { onClose: () => void; onFixed: () => void }) {
  const [run, setRun] = useState<StatementAudit | null | undefined>(undefined);
  const [perAccount, setPerAccount] = useState(3);
  const [err, setErr] = useState('');
  const [fixing, setFixing] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState<Record<string, string>>({});

  const load = useCallback(() => getStatementAudit().then(setRun).catch(e => setErr(describeApiError(e, 'Could not load the last check.'))), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!run?.running) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [run?.running, load]);

  async function start() {
    setErr(''); setOutcome({});
    try { await startStatementAudit({ perAccount }); await load(); }
    catch (e) { setErr(describeApiError(e, 'Could not start the check.')); }
  }

  async function fix(ids: string[]) {
    setFixing(s => new Set([...s, ...ids]));
    for (const id of ids) {
      try {
        const r = await fixAuditedStatement(id);
        setOutcome(o => ({ ...o, [id]: r.outcome === 'filed' ? 'Fixed' : r.outcome === 'review' ? 'Sent to Import review — you entered this bill by hand' : `Not changed (${r.outcome})` }));
      } catch (e) {
        setOutcome(o => ({ ...o, [id]: describeApiError(e, 'Could not fix it.') }));
      }
      setFixing(s => { const n = new Set(s); n.delete(id); return n; });
    }
    await load();
    onFixed();
  }

  // Account → statement → findings, statements newest first.
  const groups = useMemo(() => {
    const byAcct = new Map<string, { f: StatementAuditFinding; byStmt: Map<string, StatementAuditFinding[]> }>();
    for (const f of run?.findings ?? []) {
      const g = byAcct.get(f.accountId) ?? { f, byStmt: new Map() };
      g.byStmt.set(f.statementId, [...(g.byStmt.get(f.statementId) ?? []), f]);
      byAcct.set(f.accountId, g);
    }
    return [...byAcct.values()]
      .map(g => ({ ...g, stmts: [...g.byStmt.entries()].sort((a, b) => b[1][0].statementDate.localeCompare(a[1][0].statementDate)) }))
      .sort((a, b) => a.f.provider.localeCompare(b.f.provider));
  }, [run]);
  const fixed = new Set(run?.fixed ?? []);
  const fixable = [...new Set((run?.findings ?? []).filter(f => f.fixable && !fixed.has(f.statementId)).map(f => f.statementId))];
  const disagreeing = new Set((run?.findings ?? []).filter(f => f.field !== 'unreadable').map(f => f.statementId)).size;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <div className="p-5 pb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">Check statements against their PDFs</p>
            <p className="text-xs text-gray-500 mt-0.5">Each account's newest statements are read again from the PDF — nothing is saved — and compared with what Sollux shows: the charge, past due, total, due date and payments the bill says it received.</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">✕</button>
        </div>

        <div className="px-5 pb-3 flex flex-wrap items-center gap-2 text-xs">
          <label className="text-gray-400">Newest
            <select className="input-dark mx-1.5 text-xs" value={perAccount} onChange={e => setPerAccount(Number(e.target.value))} disabled={!!run?.running}>
              {[1, 3, 6, 12].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            {perAccount === 1 ? 'statement' : 'statements'} per account
          </label>
          <button onClick={() => void start()} disabled={run === undefined || !!run?.running} className="btn-primary text-xs px-3 py-1.5 disabled:opacity-40">
            {run?.running ? 'Checking…' : run ? 'Check again' : 'Start check'}
          </button>
          <span className="text-gray-600">Each PDF is one AI read (metered in Settings → AI usage).</span>
        </div>

        <div className="px-5 pb-5 overflow-y-auto space-y-3">
          {err && <p className="text-xs text-red-400">{err}</p>}
          {run === undefined && <p className="text-xs text-gray-500">Loading…</p>}
          {run === null && <p className="text-xs text-gray-500">No check has been run yet.</p>}
          {run && (
            <div className="text-xs text-gray-400">
              {run.running
                ? <>Checking {run.checked} of {run.total} statements across {run.accounts} accounts…
                    <div className="mt-1.5 h-1 rounded bg-white/10 overflow-hidden"><div className="h-full bg-amber-400 transition-all" style={{ width: `${run.total ? (run.checked / run.total) * 100 : 0}%` }} /></div></>
                : <>Checked {run.checked} statements across {run.accounts} accounts, {fmtDate(run.finishedAt ?? run.startedAt)}. {disagreeing === 0 && run.failed === 0
                    ? <span className="text-emerald-400">Every one matches its PDF.</span>
                    : <span>{disagreeing} disagree with their PDF{run.failed ? `; ${run.failed} could not be read` : ''}.</span>}</>}
            </div>
          )}
          {fixable.length > 1 && !run?.running && (
            <button onClick={() => void fix(fixable)} disabled={fixing.size > 0} className="btn text-xs disabled:opacity-40">
              {fixing.size ? `Fixing… ${fixing.size} left` : `Fix all ${fixable.length} by re-reading them`}
            </button>
          )}

          {groups.map(g => (
            <div key={g.f.accountId} className="rounded-lg p-3 space-y-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <Link to={`/properties/${g.f.propertyId}/utilities/${g.f.accountId}`} className="text-sm text-white hover:text-amber-300 font-medium">
                {g.f.provider}{g.f.last4 ? ` ··${g.f.last4}` : ''} <span className="text-gray-500 font-normal">· {g.f.property}</span>
              </Link>
              {g.stmts.map(([sid, fs]) => (
                <div key={sid} className="border-t border-white/5 pt-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-300">Bill of {fmtDate(fs[0].statementDate)}</span>
                    {fixed.has(sid) || outcome[sid]
                      ? <span className={`text-xs ${outcome[sid] && outcome[sid] !== 'Fixed' ? 'text-amber-300' : 'text-emerald-400'}`}>{outcome[sid] ?? 'Fixed'}</span>
                      : fs.some(f => f.fixable)
                        ? <button onClick={() => void fix([sid])} disabled={fixing.has(sid)} className="text-xs text-amber-400 hover:text-amber-300 font-medium disabled:opacity-40">{fixing.has(sid) ? 'Re-reading…' : 'Fix — re-read it'}</button>
                        : fs[0].ownerEdited ? <span className="text-xs text-gray-500">You edited this bill — open it to choose</span> : null}
                  </div>
                  {fs.map((f, i) => (
                    <div key={i} className="mt-1 text-xs">
                      {f.field === 'unreadable'
                        ? <p className="text-red-400">{FIELD.unreadable}{f.note ? `: ${f.note}` : ''}</p>
                        : <p className="text-gray-400"><span className="text-gray-300">{FIELD[f.field]}</span> — Sollux <span className="tabular-nums text-red-300">{show(f, f.stored)}</span>, PDF <span className="tabular-nums text-emerald-300">{show(f, f.read)}</span></p>}
                      {f.note && f.field !== 'unreadable' && <p className="text-gray-600">{f.note}</p>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
