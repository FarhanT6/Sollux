import { useState } from 'react';
import { readCardStatement, saveCardStatement, createCreditCard, type FilePayload, type CreditCardT } from '../../api/client';
import { filesToPayload } from '../../lib/files';
import { fmtMoney } from '../../lib/money';
import { fmtDate } from '../../lib/date';
import { describeApiError } from '../../lib/apiError';

/**
 * Upload a credit card statement: Claude reads the summary, every rate and
 * every transaction; the owner checks the figures and saves. The statement
 * files under the card whose last four digits it prints — or under a new
 * card set up from it — and the newest statement keeps the card's terms,
 * limit and cycle current.
 */
export default function StatementImport({ cards, fixedCardId, onDone }: { cards: CreditCardT[]; fixedCardId?: string; onDone: (cardId: string | null) => void }) {
  const [files, setFiles] = useState<FilePayload[]>([]);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState<Record<string, any> | null>(null);
  const [cardId, setCardId] = useState<string>(fixedCardId ?? '');
  const [err, setErr] = useState<string | null>(null);

  async function read() {
    setReading(true); setErr(null);
    try {
      const r = await readCardStatement(files);
      setFields(r.fields);
      if (!fixedCardId) setCardId(r.cardId ?? '__new');
    } catch (e) { setErr(describeApiError(e, 'Could not read the statement.')); }
    finally { setReading(false); }
  }

  async function save() {
    if (!fields) return;
    if (!fields.closingDate || fields.newBalance == null) { setErr('The closing date and new balance are needed — fill them in below.'); return; }
    setSaving(true); setErr(null);
    try {
      let id = cardId;
      if (!id || id === '__new') {
        const card = await createCreditCard({
          name: [fields.issuer, fields.cardName].filter(Boolean).join(' ') || 'Credit card', issuer: fields.issuer ?? null, network: fields.network ?? null,
          last4: fields.last4 ?? null, cardholderName: fields.cardholderName ?? null,
        });
        id = card.id;
      }
      const statement = {
        periodStart: fields.periodStart, closingDate: fields.closingDate, dueDate: fields.dueDate, previousBalance: fields.previousBalance,
        paymentsCredits: fields.paymentsCredits, purchases: fields.purchases, balanceTransfers: fields.balanceTransfers, cashAdvances: fields.cashAdvances,
        feesCharged: fields.feesCharged, interestCharged: fields.interestCharged, newBalance: Number(fields.newBalance), minimumPayment: fields.minimumPayment,
        creditLimit: fields.creditLimit, availableCredit: fields.availableCredit, purchaseApr: fields.purchaseApr, cashAdvanceApr: fields.cashAdvanceApr,
        rewardsEarned: fields.rewardsEarned, rewardsBalance: fields.rewardsBalance, daysInCycle: fields.daysInCycle != null ? Math.trunc(fields.daysInCycle) : null,
        minPayoffMonths: fields.minPayoffMonths != null ? Math.trunc(fields.minPayoffMonths) : null, minPayoffTotal: fields.minPayoffTotal,
      };
      const terms = {
        cashAdvanceLimit: fields.cashAdvanceLimit, balanceTransferApr: fields.balanceTransferApr, penaltyApr: fields.penaltyApr, introApr: fields.introApr,
        introAprType: fields.introAprType, introAprEndDate: fields.introAprEndDate, rewardsProgram: fields.rewardsProgram, rewardsType: fields.rewardsType,
        issuer: fields.issuer, network: fields.network, cardholderName: fields.cardholderName, last4: fields.last4, authorizedUsers: fields.authorizedUsers,
      };
      await saveCardStatement(id, { statement, transactions: fields.transactions ?? [], terms, files });
      onDone(id);
    } catch (e) { setErr(describeApiError(e, 'Could not save the statement.')); }
    finally { setSaving(false); }
  }

  const set = (k: string, v: string) => setFields(f => (f ? { ...f, [k]: v === '' ? null : k.endsWith('Date') || k === 'periodStart' ? v : Number(v) } : f));
  const input = 'input-dark text-sm w-full';
  const label = 'text-xs text-gray-500 block mb-1';
  const cell = (k: string, l: string, type = 'number') => (
    <div key={k}><span className={label}>{l}</span><input type={type} step="0.01" className={input} value={fields?.[k] ?? ''} onChange={e => set(k, e.target.value)} /></div>
  );
  const txns: any[] = fields?.transactions ?? [];
  const charges = txns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const credits = txns.filter(t => t.amount < 0).reduce((s, t) => s - t.amount, 0);

  return (
    <div className="card p-4 mb-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white">Upload a statement</p>
        <button onClick={() => onDone(null)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <label className="btn text-xs cursor-pointer">Add statement PDF or photos
          <input type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={async e => { const x = await filesToPayload(e.target.files); setFiles(p => [...p, ...x]); setFields(null); e.target.value = ''; }} />
        </label>
        {files.map((f, i) => <span key={i} className="text-xs text-gray-400 px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.05)' }}>{f.name} <button onClick={() => { setFiles(ps => ps.filter((_, j) => j !== i)); setFields(null); }} className="text-gray-600 hover:text-red-400 ml-1">✕</button></span>)}
        {files.length > 0 && !fields && <button onClick={read} disabled={reading} className="btn btn-primary text-xs disabled:opacity-50">{reading ? 'Reading every line… (can take a minute)' : 'Read statement'}</button>}
      </div>

      {fields && (
        <>
          <div className="rounded-lg p-3 text-xs text-gray-300" style={{ background: 'rgba(255,255,255,0.03)' }}>
            {[fields.issuer, fields.cardName].filter(Boolean).join(' ') || 'Card'}{fields.last4 ? ` ••${fields.last4}` : ''} · {fields.periodStart ? `${fmtDate(fields.periodStart, 'MMM d')} – ` : ''}{fields.closingDate ? fmtDate(fields.closingDate, 'MMM d, yyyy') : 'closing date?'}
            {' · '}{txns.length} transactions ({fmtMoney(charges)} charged, {fmtMoney(credits)} paid or credited)
            {fields.purchaseApr != null ? ` · ${fields.purchaseApr}% APR` : ''}{fields.rewardsBalance != null ? ` · ${Number(fields.rewardsBalance).toLocaleString()} rewards` : ''}
          </div>
          {!fixedCardId && (
            <div className="max-w-md">
              <span className={label}>File under</span>
              <select className={input} value={cardId} onChange={e => setCardId(e.target.value)}>
                <option value="__new">A new card, set up from this statement</option>
                {cards.map(c => <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` ••${c.last4}` : ''}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {cell('periodStart', 'Period start', 'date')}{cell('closingDate', 'Closing date', 'date')}{cell('dueDate', 'Due date', 'date')}
            {cell('previousBalance', 'Previous balance')}{cell('paymentsCredits', 'Payments & credits')}
            {cell('purchases', 'Purchases')}{cell('cashAdvances', 'Cash advances')}{cell('balanceTransfers', 'Balance transfers')}
            {cell('feesCharged', 'Fees')}{cell('interestCharged', 'Interest')}
            {cell('newBalance', 'New balance')}{cell('minimumPayment', 'Minimum payment')}{cell('creditLimit', 'Credit limit')}
            {cell('availableCredit', 'Available credit')}{cell('purchaseApr', 'Purchase APR %')}
          </div>
          {fields.previousBalance != null && fields.newBalance != null && (() => {
            const computed = Number(fields.previousBalance) - Number(fields.paymentsCredits ?? 0) + Number(fields.purchases ?? 0) + Number(fields.cashAdvances ?? 0)
              + Number(fields.balanceTransfers ?? 0) + Number(fields.feesCharged ?? 0) + Number(fields.interestCharged ?? 0);
            const off = Math.abs(computed - Number(fields.newBalance));
            return off > 0.02
              ? <p className="text-xs text-amber-400">The summary doesn't add up: previous balance − payments + charges + fees + interest = {fmtMoney(computed)}, but the new balance reads {fmtMoney(fields.newBalance)}. Check the figures against the statement.</p>
              : <p className="text-xs text-emerald-400">✓ The summary adds up to the new balance.</p>;
          })()}
          {txns.length > 0 && (
            <details>
              <summary className="text-xs text-gray-500 cursor-pointer">{txns.length} transactions read</summary>
              <div className="max-h-64 overflow-y-auto mt-2">
                <table className="table-base">
                  <tbody>{txns.map((t, i) => <tr key={i}><td className="text-xs whitespace-nowrap">{t.date}</td><td className="text-xs">{t.merchant || t.description}</td><td className="text-xs text-gray-500">{t.category}</td><td className={`text-xs text-right ${t.amount < 0 ? 'text-emerald-400' : ''}`}>{fmtMoney(t.amount)}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}

      {err && <p className="text-xs text-red-400">{err}</p>}
      {fields && (
        <div className="flex justify-end gap-2">
          <button onClick={() => onDone(null)} className="btn text-xs">Cancel</button>
          <button onClick={save} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : 'Save statement'}</button>
        </div>
      )}
    </div>
  );
}
