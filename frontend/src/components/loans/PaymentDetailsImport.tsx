import { useState } from 'react';
import { readLoanPaymentDetails, applyLoanPaymentDetails, type LoanSheetRead, type FilePayload } from '../../api/client';
import { filesToPayload } from '../../lib/files';
import { fmtMoney } from '../../lib/money';
import { methodsShort } from '../../lib/loanPayment';
import { describeApiError } from '../../lib/apiError';

/**
 * Fill in how each loan is paid from the owner's loan sheet (CSV, PDF or a
 * photo). Every row is paired with a loan that already exists; the owner
 * checks the pairs and applies. Nothing here adds or removes a loan, and
 * amounts, rates and terms are left alone.
 */
export default function PaymentDetailsImport({ onDone }: { onDone: (updated: number | null) => void }) {
  const [files, setFiles] = useState<FilePayload[]>([]);
  const [read, setRead] = useState<LoanSheetRead | null>(null);
  const [picks, setPicks] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState<'read' | 'apply' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function doRead() {
    setBusy('read'); setErr(null);
    try {
      const r = await readLoanPaymentDetails(files);
      setRead(r); setPicks(r.rows.map(x => x.loanId));
    } catch (e) { setErr(describeApiError(e, 'Could not read the sheet.')); }
    finally { setBusy(null); }
  }

  async function apply() {
    if (!read) return;
    const items = read.rows.map((x, i) => ({ loanId: picks[i], row: x.row })).filter((x): x is { loanId: string; row: typeof x.row } => !!x.loanId);
    setBusy('apply'); setErr(null);
    try { const r = await applyLoanPaymentDetails(items); onDone(r.updated); }
    catch (e) { setErr(describeApiError(e, 'Could not save.')); }
    finally { setBusy(null); }
  }

  const taken = new Map<string, number>();
  picks.forEach(p => p && taken.set(p, (taken.get(p) ?? 0) + 1));
  const clash = [...taken.values()].some(n => n > 1);
  const matched = picks.filter(Boolean).length;

  return (
    <div className="card p-4 mb-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white">Import payment details</p>
          <p className="text-xs text-gray-500">Due day, grace, how it's paid, where checks go and the lender's account — from your loan sheet. Only existing loans are updated.</p>
        </div>
        <button onClick={() => onDone(null)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
      </div>

      {!read && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="btn text-xs cursor-pointer">Add sheet (CSV, PDF or photo)
            <input type="file" accept=".csv,text/csv,application/pdf,image/*" multiple className="hidden"
              onChange={async e => { const x = await filesToPayload(e.target.files); setFiles(p => [...p, ...x]); e.target.value = ''; }} />
          </label>
          {files.map((f, i) => <span key={i} className="text-xs text-gray-400 px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.05)' }}>{f.name} <button onClick={() => setFiles(ps => ps.filter((_, j) => j !== i))} className="text-gray-600 hover:text-red-400 ml-1">✕</button></span>)}
          {files.length > 0 && <button onClick={doRead} disabled={busy === 'read'} className="btn btn-primary text-xs disabled:opacity-50">{busy === 'read' ? 'Reading…' : 'Read sheet'}</button>}
        </div>
      )}

      {read && (
        <>
          <p className="text-xs text-gray-400">{read.rows.length} rows · {matched} paired with a loan. Check each pair — pick “Skip” for a row that isn't one of your loans.</p>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Sheet row</th><th>Your loan</th><th>Due</th><th>How it's paid</th><th>Mail to / lender's account</th></tr></thead>
              <tbody>
                {read.rows.map(({ row }, i) => (
                  <tr key={i}>
                    <td className="text-xs">
                      <div className="text-gray-200">{row.lender}</div>
                      <div className="text-gray-500">{[row.propertyAddress, row.paymentAmount ? fmtMoney(row.paymentAmount) : null].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="text-xs min-w-[14rem]">
                      <select className={`input-dark text-xs w-full ${picks[i] && (taken.get(picks[i]!) ?? 0) > 1 ? 'border-red-500' : ''}`} value={picks[i] ?? ''}
                        onChange={e => setPicks(p => p.map((x, j) => (j === i ? e.target.value || null : x)))}>
                        <option value="">Skip</option>
                        {read.loans.map(l => <option key={l.id} value={l.id}>{l.lender}{l.property ? ` — ${l.property}` : ''}{l.monthlyPayment ? ` (${fmtMoney(l.monthlyPayment)})` : ''}</option>)}
                      </select>
                    </td>
                    <td className="text-xs whitespace-nowrap">{row.dueDay ? `Day ${row.dueDay}` : '—'}{row.gracePeriodDays ? ` · ${row.gracePeriodDays}d grace` : ''}</td>
                    <td className="text-xs">
                      <div>{methodsShort(row.paymentMethods) || '—'}</div>
                      {row.paymentInstructions && <div className="text-gray-500">{row.paymentInstructions}</div>}
                      {row.paymentUrl && <div className="text-gray-500 break-all">{row.paymentUrl.replace(/^https?:\/\//, '').slice(0, 40)}</div>}
                    </td>
                    <td className="text-xs">
                      {row.mailingAddress && <div>{row.mailingAddress}</div>}
                      {(row.payeeBankName || row.payeeAccountLast4) && <div className="text-gray-500">{[row.payeeBankName, row.payeeAccountLast4 ? `••${row.payeeAccountLast4}` : null].filter(Boolean).join(' ')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {clash && <p className="text-xs text-red-400">Two rows point at the same loan — change or skip one.</p>}
        </>
      )}

      {err && <p className="text-xs text-red-400">{err}</p>}
      {read && (
        <div className="flex justify-end gap-2">
          <button onClick={() => { setRead(null); setPicks([]); }} className="btn text-xs">Start over</button>
          <button onClick={apply} disabled={busy === 'apply' || clash || !matched} className="btn btn-primary text-xs disabled:opacity-50">{busy === 'apply' ? 'Saving…' : `Apply to ${matched} loan${matched === 1 ? '' : 's'}`}</button>
        </div>
      )}
    </div>
  );
}
