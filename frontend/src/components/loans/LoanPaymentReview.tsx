import { useCallback, useEffect, useState } from 'react';
import {
  getOutgoingTransactions, getLoanCandidates, matchOutgoingTransaction, applyOutgoingTransaction,
  ignoreOutgoingTransaction, restoreOutgoingTransaction,
} from '../../api/client';
import type { OutgoingTransaction } from '../../types';
import { fmtMoney } from '../../lib/money';
import { fmtDate } from '../../lib/date';
import { describeApiError } from '../../lib/apiError';

type Candidate = { loanId: string; lender: string; property?: string | null; expected: number; likely: boolean };
const candLabel = (c: Candidate) => [c.lender, c.property, c.expected ? `${fmtMoney(c.expected)}/mo` : null].filter(Boolean).join(' · ');

const box = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' };
const monthLabel = (k?: string | null) => (k ? fmtDate(`${k}-01`, 'MMMM yyyy') : null);

/** Where the money left: a "you sent" email, or the bank account's line. */
function SourceTag({ t }: { t: OutgoingTransaction }) {
  const acct = t.bankAccount?.last4 ? ` ··${t.bankAccount.last4}` : '';
  return t.source === 'email'
    ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 shrink-0">Email{acct}</span>
    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-400 shrink-0">Bank{acct}</span>;
}

/**
 * Loan payments Sollux found but was not sure of: a debit on a bank account,
 * or a "You sent $X to …" Zelle / Venmo / Cash App / PayPal email, that names
 * a lender (or a property on a memo) without pinning one loan. The owner logs
 * it on the loan it looks like, picks another loan, or says it was not a loan
 * payment. Below it, what was logged on its own in the last 60 days, so a
 * payment read from an email or the bank can be found and checked.
 */
export default function LoanPaymentReview() {
  const [waiting, setWaiting] = useState<OutgoingTransaction[] | null>(null);
  const [logged, setLogged] = useState<OutgoingTransaction[]>([]);
  const [ignored, setIgnored] = useState<OutgoingTransaction[]>([]);
  const [showLogged, setShowLogged] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [w, l, i] = await Promise.all([
        getOutgoingTransactions({ matchType: 'LOAN', status: ['SUGGESTED', 'UNMATCHED'] }),
        getOutgoingTransactions({ matchType: 'LOAN', status: 'APPLIED', days: 60 }),
        getOutgoingTransactions({ matchType: 'LOAN', status: 'IGNORED', days: 120 }),
      ]);
      setWaiting(w); setLogged(l); setIgnored(i); setError(null);
    } catch (e) {
      setError(describeApiError(e, 'Could not load payments to check'));
      setWaiting([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (waiting === null) return null;
  const emailCount = logged.filter(t => t.source === 'email' || /^(Zelle|Venmo|Cash App|PayPal|Apple Cash) to /.test(t.name)).length;

  return (
    <div className="mt-8">
      <div className="flex items-baseline gap-3 mb-1">
        <h2 className="text-sm font-semibold text-white">Payments to check</h2>
        {waiting.length > 0 && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-400">{waiting.length}</span>}
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Loan payments Sollux found in your bank accounts and in &ldquo;You sent money&rdquo; Zelle, Venmo, Cash App and PayPal emails.
        When it is sure (the lender&rsquo;s name and the payment amount, one loan), it logs them on its own; these it was not sure of.
      </p>
      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

      {waiting.length === 0 ? (
        <p className="text-xs text-gray-600 rounded-xl px-4 py-3" style={box}>Nothing to check.</p>
      ) : (
        <div className="space-y-2">
          {waiting.map(t => <WaitingRow key={t.id} t={t} onDone={load} />)}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
        <button className="text-xs text-gray-500 hover:text-gray-300" onClick={() => setShowLogged(v => !v)}>
          {showLogged ? '▾' : '▸'} Logged from the bank and emails, last 60 days ({logged.length}{emailCount ? `, ${emailCount} from emails` : ''})
        </button>
        {ignored.length > 0 && (
          <button className="text-xs text-gray-500 hover:text-gray-300" onClick={() => setShowIgnored(v => !v)}>
            {showIgnored ? '▾' : '▸'} Not loan payments ({ignored.length})
          </button>
        )}
      </div>

      {showLogged && (
        <div className="mt-2 rounded-xl px-4 py-2 divide-y divide-white/5" style={box}>
          {logged.length === 0 && <p className="text-xs text-gray-600 py-1">None in the last 60 days.</p>}
          {logged.map(t => (
            <div key={t.id} className="py-1.5 text-xs flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="text-gray-500 w-20 shrink-0">{fmtDate(t.date, 'MMM d')}</span>
              <span className="text-emerald-500 w-24 shrink-0">{fmtMoney(t.amount)}</span>
              <span className="text-gray-200">{t.loan?.lender ?? 'Loan'}{t.loggedFor ? <span className="text-gray-500"> · for {monthLabel(t.loggedFor)}</span> : null}</span>
              <SourceTag t={t} />
              <span className="text-gray-600 truncate min-w-0 basis-full sm:basis-auto sm:flex-1" title={t.name}>{t.name}</span>
            </div>
          ))}
        </div>
      )}

      {showIgnored && (
        <div className="mt-2 rounded-xl px-4 py-2 divide-y divide-white/5" style={box}>
          {ignored.map(t => (
            <div key={t.id} className="py-1.5 text-xs flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="text-gray-500 w-20 shrink-0">{fmtDate(t.date, 'MMM d')}</span>
              <span className="text-gray-300 w-24 shrink-0">{fmtMoney(t.amount)}</span>
              <span className="text-gray-500 truncate min-w-0 flex-1" title={t.name}>{t.name}</span>
              <button className="text-amber-500 hover:text-amber-400" onClick={() => restoreOutgoingTransaction(t.id).then(load).catch(e => setError(describeApiError(e, 'Could not restore it')))}>Put back</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WaitingRow({ t, onDone }: { t: OutgoingTransaction; onDone: () => void }) {
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [loanId, setLoanId] = useState(t.loanId ?? '');
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The loans it could be, best first, then every other active loan.
  useEffect(() => {
    let live = true;
    getLoanCandidates(t.id).then(c => { if (live) setCands(c); }).catch(() => { if (live) setCands([]); });
    return () => { live = false; };
  }, [t.id]);

  const chosen = cands?.find(c => c.loanId === loanId);
  const expected = chosen?.expected ?? (loanId === t.loanId ? t.loan?.expected ?? null : null);
  const off = expected && expected > 0 ? Math.round((t.amount - expected) * 100) / 100 : null;

  const run = async (fn: () => Promise<unknown>, fail: string) => {
    setBusy(true); setErr(null);
    try { await fn(); onDone(); } catch (e) { setErr(describeApiError(e, fail)); } finally { setBusy(false); }
  };
  const log = () => run(async () => {
    if (!loanId) throw new Error('Pick the loan first');
    if (loanId !== t.loanId) await matchOutgoingTransaction(t.id, { loanId });
    await applyOutgoingTransaction(t.id, month || undefined);
  }, 'Could not log the payment');

  return (
    <div className="rounded-xl px-4 py-3" style={box}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-gray-400 shrink-0">{fmtDate(t.date)}</span>
        <span className="text-white font-semibold shrink-0">{fmtMoney(t.amount)}</span>
        <SourceTag t={t} />
        <span className="text-gray-400 break-words min-w-0 basis-full sm:basis-auto sm:flex-1">{t.name}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <label className="text-gray-500">Loan</label>
        <select className="input-dark text-xs py-1 max-w-full sm:max-w-[22rem]" value={loanId} onChange={e => setLoanId(e.target.value)} disabled={busy}>
          {!loanId && <option value="">Pick a loan…</option>}
          {cands === null && t.loan && <option value={t.loan.id}>{t.loan.lender}</option>}
          {cands?.some(c => c.likely) && (
            <optgroup label="Looks like">
              {cands.filter(c => c.likely).map(c => <option key={c.loanId} value={c.loanId}>{candLabel(c)}</option>)}
            </optgroup>
          )}
          {cands?.some(c => !c.likely) && (
            <optgroup label="Other loans">
              {cands.filter(c => !c.likely).map(c => <option key={c.loanId} value={c.loanId}>{candLabel(c)}</option>)}
            </optgroup>
          )}
        </select>
        <label className="text-gray-500 ml-1" title="Leave blank: the month the memo names, else the due date it answers">For</label>
        <input type="month" className="input-dark text-xs py-1 w-36" value={month} onChange={e => setMonth(e.target.value)} disabled={busy} placeholder="Auto" />
        {!month && <span className="text-gray-600">auto</span>}
        <span className="flex-1" />
        <button className="btn btn-primary text-xs disabled:opacity-50" disabled={busy || !loanId} onClick={log}>{busy ? 'Logging…' : 'Log payment'}</button>
        <button className="btn text-xs disabled:opacity-50" disabled={busy} onClick={() => run(() => ignoreOutgoingTransaction(t.id), 'Could not set it aside')}>Not a loan payment</button>
      </div>
      {off !== null && Math.abs(off) > 1 && (
        <p className="text-xs text-amber-500/80 mt-1.5">{fmtMoney(Math.abs(off))} {off > 0 ? 'more' : 'less'} than this loan&rsquo;s {fmtMoney(expected)} payment.</p>
      )}
      {err && <p className="text-xs text-red-400 mt-1.5">{err}</p>}
    </div>
  );
}
