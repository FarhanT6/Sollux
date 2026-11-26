/**
 * Line up with the insurer's records (account page → More…, insurance accounts). The owner uploads
 * the insurer's Policy Installments and Payments Made pages; the plan shows each installment's bill
 * (on file, or to be added) with what it will charge, carry and total, the bills and payments on file
 * the records do not have, and the totals both ways. Nothing changes until Apply
 * (backend services/insurerLedger.ts).
 */
import { useState } from 'react';
import { readInsurerRecords, planInsurerRecords, applyInsurerRecords, type InsurerLedgerRead, type InsurerLineUpPlan } from '../api/client';
import { fmtMoney } from '../lib/money';
import { fmtDate } from '../lib/date';
import { describeApiError } from '../lib/apiError';

const toBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(f);
});

export default function InsurerRecordsDialog({ accountId, insurer, onClose, onApplied }: { accountId: string; insurer: string; onClose: () => void; onApplied: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [fee, setFee] = useState('0');
  const [read, setRead] = useState<InsurerLedgerRead | null>(null);
  const [plan, setPlan] = useState<InsurerLineUpPlan | null>(null);
  const [busy, setBusy] = useState<'read' | 'plan' | 'apply' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const feeNum = Math.max(0, Number(fee) || 0);

  async function readPages() {
    setBusy('read'); setErr(null);
    try {
      const r = await readInsurerRecords(accountId, await Promise.all(files.map(async f => ({ fileData: await toBase64(f), filename: f.name }))), feeNum);
      setRead(r.read); setPlan(r.plan);
    } catch (e) { setErr(describeApiError(e, 'Could not read those pages.')); }
    finally { setBusy(null); }
  }
  async function replan(next: string) {
    setFee(next);
    if (!read) return;
    setBusy('plan');
    try { setPlan(await planInsurerRecords(accountId, read, Math.max(0, Number(next) || 0))); } catch (e) { setErr(describeApiError(e, 'Could not work it out again.')); }
    finally { setBusy(null); }
  }
  async function apply() {
    if (!read) return;
    setBusy('apply'); setErr(null);
    try { await applyInsurerRecords(accountId, read, feeNum); onApplied(); }
    catch (e) { setErr(describeApiError(e, 'Could not line it up.')); setBusy(null); }
  }

  const added = plan?.payments.filter(p => !p.paymentId) ?? [];
  const corrected = plan?.payments.filter(p => p.paymentId && p.onFile) ?? [];
  // The insurer's own payments settle every installment and fee without the fee typed in: it is not charged.
  const feeNotCharged = !!plan && plan.installmentFee > 0 && Math.abs(plan.totals.owedWithoutFee) < 0.01 && plan.totals.owed > 0.005;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="card p-5 w-full max-w-3xl space-y-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div>
          <p className="text-sm font-semibold text-white">Line up with {insurer}'s records</p>
          <p className="text-xs text-gray-500 mt-1">Upload {insurer}'s <b className="text-gray-300">Policy Installments</b> and <b className="text-gray-300">Payments Made</b> pages (screenshots or a PDF). Sollux makes each installment one bill — the installment, the fees invoiced with it, and what was still unpaid when it went out — and the payments the insurer's. You see every change before anything is saved.</p>
        </div>

        {!plan && (
          <div className="space-y-3">
            <input type="file" multiple accept="image/*,application/pdf" onChange={e => setFiles(Array.from(e.target.files ?? []))} className="text-xs text-gray-400" />
            <label className="block text-xs text-gray-400">
              Installment fee added to each installment
              <span className="flex items-center gap-1 mt-1"><span className="text-gray-500">$</span><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" className="input-dark text-sm w-24" /></span>
              <span className="block text-gray-500 mt-1">Only if the insurer actually charges it — when its installments table and payments leave it out, it was not charged.</span>
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="btn text-xs">Cancel</button>
              <button onClick={() => void readPages()} disabled={!files.length || busy === 'read'} className="btn btn-primary text-xs disabled:opacity-50">{busy === 'read' ? 'Reading…' : 'Read the pages'}</button>
            </div>
          </div>
        )}

        {plan && (
          <>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-lg p-3" style={{ background: 'rgba(245,166,35,0.08)' }}>
                <p className="text-gray-400">{insurer}'s records</p>
                <p className="text-gray-100 mt-1">Billed {fmtMoney(plan.totals.billed)} · paid {fmtMoney(plan.totals.paid)} · {plan.totals.owed > 0.005 ? <span className="text-amber-300">{fmtMoney(plan.totals.owed)} owed</span> : plan.totals.owed < -0.005 ? <span className="text-emerald-400">{fmtMoney(-plan.totals.owed)} credit</span> : <span className="text-emerald-400">nothing owed</span>}</p>
              </div>
              <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <p className="text-gray-400">On file in Sollux now, the same months</p>
                <p className="text-gray-100 mt-1">Billed {fmtMoney(plan.totals.onFileBilled)} · paid {fmtMoney(plan.totals.onFilePaid)}</p>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-gray-400">
              Installment fee on each installment $
              <input value={fee} onChange={e => void replan(e.target.value)} inputMode="decimal" className="input-dark text-sm w-20" />
              {busy === 'plan' && <span className="text-gray-500">…</span>}
            </label>
            {feeNotCharged && (
              <p className="text-xs text-amber-300 rounded-lg p-3" style={{ background: 'rgba(245,166,35,0.08)' }}>
                {insurer}'s payments cover every installment and fee without the {fmtMoney(plan.installmentFee)} — so it is not being charged on these. With it, Sollux would show {fmtMoney(plan.totals.owed)} owed that {insurer} does not. Set it to 0 unless {insurer}'s records list it.
              </p>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-gray-500 text-left">
                  <th className="py-1 pr-2 font-normal">Invoiced</th><th className="py-1 pr-2 font-normal">What</th>
                  <th className="py-1 pr-2 font-normal text-right">Bill</th><th className="py-1 pr-2 font-normal text-right">Carried</th><th className="py-1 pr-2 font-normal text-right">Total</th>
                  <th className="py-1 font-normal">On file now</th>
                </tr></thead>
                <tbody>
                  {plan.bills.map(b => {
                    const same = b.onFile && b.onFile.amountDue != null && Math.abs(b.onFile.amountDue - b.charge) < 0.01 && Math.abs((b.onFile.carried ?? 0) - b.carried) < 0.01;
                    return (
                      <tr key={b.key} className="border-t border-white/5 align-top">
                        <td className="py-1.5 pr-2 text-gray-300 whitespace-nowrap">{fmtDate(b.invoiceDate, 'MMM d, yyyy')}</td>
                        <td className="py-1.5 pr-2 text-gray-400">{b.label}{b.fees.length ? <span className="block text-gray-500">+ {b.fees.map(f => `${f.label} ${fmtMoney(f.amount)}`).join(', ')}</span> : null}{b.installmentFee ? <span className="block text-gray-500">+ installment fee {fmtMoney(b.installmentFee)}</span> : null}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-gray-200">{fmtMoney(b.charge)}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-gray-400">{Math.abs(b.carried) > 0.005 ? fmtMoney(b.carried) : '—'}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-white">{fmtMoney(b.total)}</td>
                        <td className="py-1.5 text-gray-500">{!b.onFile ? <span className="text-sky-300">added</span> : same ? 'already right' : <span className="text-amber-300">{fmtMoney(b.onFile.amountDue ?? 0)}{b.onFile.carried ? ` + ${fmtMoney(b.onFile.carried)} carried` : ''} → set</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {plan.removeBills.length > 0 && (
              <div className="text-xs">
                <p className="text-red-300">Bills on file the records do not have — removed:</p>
                <ul className="mt-1 text-gray-400 space-y-0.5">{plan.removeBills.map(b => <li key={b.statementId}>{fmtDate(b.statementDate, 'MMM d, yyyy')} · {fmtMoney(b.amountDue ?? 0)}{b.payments ? ` · its ${b.payments} payment${b.payments === 1 ? '' : 's'} kept, unfiled` : ''}</li>)}</ul>
              </div>
            )}
            <div className="text-xs space-y-1">
              <p className="text-gray-400">Payments: {plan.payments.length - added.length} already on file{added.length ? `, ${added.length} added (${added.map(p => `${fmtDate(p.date, 'MMM d')} ${fmtMoney(p.amount)}`).join(', ')})` : ''}.</p>
              {corrected.length > 0 && (
                <div>
                  <p className="text-amber-300">Set to {insurer}'s date and amount:</p>
                  <ul className="mt-0.5 text-gray-400 space-y-0.5">{corrected.map(p => (
                    <li key={p.paymentId}>{fmtDate(p.onFile!.date, 'MMM d')} {fmtMoney(p.onFile!.amount)} → {fmtDate(p.date, 'MMM d')} {fmtMoney(p.amount)}{p.keptAsFee ? <span className="text-gray-500"> + {fmtMoney(p.keptAsFee)} kept as a processing fee (paid, but not toward the bill)</span> : null}</li>
                  ))}</ul>
                </div>
              )}
              {plan.removePayments.length > 0 && <p className="text-red-300">Not in the records — removed: {plan.removePayments.map(p => `${fmtDate(p.date, 'MMM d')} ${fmtMoney(p.amount)}`).join(', ')}</p>}
            </div>

            <p className="text-[11px] text-gray-500">A fee {insurer} charged is on the next invoice when it was still owed then, else with the installment it was charged on. The bills keep their PDFs and are marked as lined up with {insurer}'s records, so a later re-read does not change them.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setPlan(null); setRead(null); }} className="btn text-xs">Start over</button>
              <button onClick={() => void apply()} disabled={busy != null} className="btn btn-primary text-xs disabled:opacity-50">{busy === 'apply' ? 'Lining up…' : 'Apply'}</button>
            </div>
          </>
        )}
        {err && <p className="text-xs text-red-400">{err}</p>}
      </div>
    </div>
  );
}
