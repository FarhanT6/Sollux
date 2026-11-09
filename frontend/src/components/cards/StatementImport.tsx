import { useState } from 'react';
import { readCardStatement, saveCardStatement, createCreditCard, type FilePayload, type CreditCardT } from '../../api/client';
import { filesToPayload } from '../../lib/files';
import { fmtMoney } from '../../lib/money';
import { fmtDate } from '../../lib/date';
import { describeApiError } from '../../lib/apiError';
import DriveButton from '../DriveButton';

/**
 * Upload credit card statements: its summary, rates and transactions are
 * read from the PDF's own text when they add up (no AI used), else by
 * Claude; the owner checks the figures and saves. Each PDF is one statement
 * (photos together are the pages of one), so a year of statements goes up
 * at once and each is read and saved on its own. A statement files under
 * the card whose last four digits it prints (or whose name it carries) — or
 * under a new card set up from it — and the newest statement keeps the
 * card's terms, limit and cycle current.
 */

type Status = 'waiting' | 'reading' | 'read' | 'saving' | 'saved' | 'error';
interface Item { key: number; files: FilePayload[]; fields: Record<string, any> | null; cardId: string; status: Status; err: string | null; needsAi?: boolean }

const isPdf = (f: FilePayload) => /\.pdf$/i.test(f.name) || f.data.startsWith('JVBER');
const addsUp = (f: Record<string, any> | null) => {
  if (!f || f.previousBalance == null || f.newBalance == null) return false;
  const computed = Number(f.previousBalance) - Number(f.paymentsCredits ?? 0) + Number(f.purchases ?? 0) + Number(f.cashAdvances ?? 0)
    + Number(f.balanceTransfers ?? 0) + Number(f.feesCharged ?? 0) + Number(f.interestCharged ?? 0);
  return Math.abs(computed - Number(f.newBalance)) <= 0.02;
};
// Two statements of one card with no card on file yet: the second files under the card the first created.
const cardKey = (f: Record<string, any>) => f.last4 ? `#${f.last4}` : `${f.issuer ?? ''}|${f.cardName ?? ''}`.toLowerCase();

function payload(fields: Record<string, any>) {
  const statement = {
    periodStart: fields.periodStart, closingDate: fields.closingDate, dueDate: fields.dueDate, previousBalance: fields.previousBalance,
    paymentsCredits: fields.paymentsCredits, purchases: fields.purchases, balanceTransfers: fields.balanceTransfers, cashAdvances: fields.cashAdvances,
    feesCharged: fields.feesCharged, interestCharged: fields.interestCharged, newBalance: Number(fields.newBalance), minimumPayment: fields.minimumPayment,
    creditLimit: fields.creditLimit, availableCredit: fields.availableCredit, purchaseApr: fields.purchaseApr, cashAdvanceApr: fields.cashAdvanceApr,
    rewardsEarned: fields.rewardsEarned, rewardsBalance: fields.rewardsBalance, daysInCycle: fields.daysInCycle != null ? Math.trunc(fields.daysInCycle) : null,
    minPayoffMonths: fields.minPayoffMonths != null ? Math.trunc(fields.minPayoffMonths) : null, minPayoffTotal: fields.minPayoffTotal,
    pastDueAmount: fields.pastDueAmount ?? null, feesYtd: fields.feesYtd ?? null, interestYtd: fields.interestYtd ?? null,
    promotions: Array.isArray(fields.promotions) ? fields.promotions : null,
  };
  const terms = {
    cashAdvanceLimit: fields.cashAdvanceLimit, balanceTransferApr: fields.balanceTransferApr, penaltyApr: fields.penaltyApr, introApr: fields.introApr,
    introAprType: fields.introAprType, introAprEndDate: fields.introAprEndDate, rewardsProgram: fields.rewardsProgram, rewardsType: fields.rewardsType,
    issuer: fields.issuer, network: fields.network, cardholderName: fields.cardholderName, last4: fields.last4, authorizedUsers: fields.authorizedUsers,
    lateFee: fields.lateFee, annualFee: fields.annualFee, foreignTransactionFee: fields.foreignTransactionFee, balanceTransferFee: fields.balanceTransferFee,
    cashAdvanceFee: fields.cashAdvanceFee, phone: fields.phone, loginUrl: fields.loginUrl,
  };
  return { statement, terms, transactions: fields.transactions ?? [] };
}

export default function StatementImport({ cards, fixedCardId, onDone }: { cards: CreditCardT[]; fixedCardId?: string; onDone: (cardId: string | null) => void }) {
  const [files, setFiles] = useState<FilePayload[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Backfilling old statements: the free reader only, so nothing spends AI credits; what it can't read waits.
  const [noAi, setNoAi] = useState(() => { try { return localStorage.getItem('card-upload-no-ai') === '1'; } catch { return false; } });
  const setNoAiKept = (v: boolean) => { setNoAi(v); try { localStorage.setItem('card-upload-no-ai', v ? '1' : '0'); } catch { /* not kept */ } };

  const patch = (key: number, p: Partial<Item>) => setItems(xs => xs.map(x => (x.key === key ? { ...x, ...p } : x)));

  async function readAll() {
    setErr(null); setBusy(true);
    // Each PDF is a statement; photos together are the pages of one.
    const pdfs = files.filter(isPdf), photos = files.filter(f => !isPdf(f));
    const groups = [...pdfs.map(f => [f]), ...(photos.length ? [photos] : [])];
    const queue: Item[] = groups.map((g, i) => ({ key: Date.now() + i, files: g, fields: null, cardId: fixedCardId ?? '', status: 'waiting', err: null }));
    setItems(queue); setFiles([]);
    if (queue.length === 1) setOpen(queue[0].key);
    for (const it of queue) {
      patch(it.key, { status: 'reading' });
      await readOne(it, noAi);
    }
    setBusy(false);
  }

  async function readOne(it: Item, freeOnly: boolean) {
    patch(it.key, { status: 'reading', err: null, needsAi: false });
    try {
      const r = await readCardStatement(it.files, { noAi: freeOnly });
      patch(it.key, { status: 'read', fields: r.fields, cardId: fixedCardId ?? r.cardId ?? '__new' });
    } catch (e: any) {
      const needsAi = !!e?.response?.data?.needsAi;
      patch(it.key, { status: 'error', needsAi, err: needsAi ? 'Not read — the free reader could not read it' : describeApiError(e, 'Could not read the statement.') });
    }
  }

  async function saveItems(keys: number[]) {
    setErr(null); setBusy(true);
    const created = new Map<string, string>();
    let lastCard: string | null = null;
    // Oldest first, so the newest statement is the one that sets the card's terms.
    const todo = items.filter(x => keys.includes(x.key) && x.fields)
      .sort((a, b) => String(a.fields!.closingDate ?? '').localeCompare(String(b.fields!.closingDate ?? '')));
    for (const it of todo) {
      const f = it.fields!;
      if (!f.closingDate || f.newBalance == null) { patch(it.key, { status: 'error', err: 'The closing date and new balance are needed — open it and fill them in.' }); continue; }
      patch(it.key, { status: 'saving', err: null });
      try {
        let id = it.cardId;
        if (!id || id === '__new') {
          id = created.get(cardKey(f)) ?? '';
          if (!id) {
            const card = await createCreditCard({
              name: [f.issuer, f.cardName].filter(Boolean).join(' ') || 'Credit card', issuer: f.issuer ?? null, network: f.network ?? null,
              last4: f.last4 ?? null, cardholderName: f.cardholderName ?? null,
            });
            id = card.id;
            created.set(cardKey(f), id);
          }
        }
        await saveCardStatement(id, { ...payload(f), files: it.files });
        patch(it.key, { status: 'saved', cardId: id });
        lastCard = id;
      } catch (e) { patch(it.key, { status: 'error', err: describeApiError(e, 'Could not save the statement.') }); }
    }
    setBusy(false);
    return lastCard;
  }

  const readyKeys = items.filter(x => x.status === 'read' && addsUp(x.fields)).map(x => x.key);
  const unsaved = items.filter(x => x.status !== 'saved');
  const allSaved = items.length > 0 && unsaved.length === 0;
  const savedCard = items.find(x => x.status === 'saved')?.cardId ?? null;

  return (
    <div className="card p-4 mb-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white">Upload statements</p>
        <button onClick={() => onDone(savedCard)} className="text-xs text-gray-500 hover:text-gray-300">{allSaved ? 'Done' : 'Cancel'}</button>
      </div>
      {!busy && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="btn text-xs cursor-pointer">Add statement PDFs or photos
            <input type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={async e => { const x = await filesToPayload(e.target.files); setFiles(p => [...p, ...x]); e.target.value = ''; }} />
          </label>
          {/* Statements kept in Google Drive: pick files, or a whole folder of them. */}
          <DriveButton multiple folders className="btn text-xs" label="From Google Drive" onFiles={async fs => { const x = await filesToPayload(fs); setFiles(p => [...p, ...x]); }} />
          {files.map((f, i) => <span key={i} className="text-xs text-gray-400 px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.05)' }}>{f.name} <button onClick={() => setFiles(ps => ps.filter((_, j) => j !== i))} className="text-gray-600 hover:text-red-400 ml-1">✕</button></span>)}
          {files.length > 0 && (
            <button onClick={() => void readAll()} className="btn btn-primary text-xs">
              {files.filter(isPdf).length > 1 ? `Read ${files.filter(isPdf).length + (files.some(f => !isPdf(f)) ? 1 : 0)} statements` : 'Read statement'}
            </button>
          )}
        </div>
      )}
      {files.length > 1 && <p className="text-xs text-gray-600">Each PDF is read as its own statement; photos together are the pages of one statement.</p>}
      {!busy && files.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer" title="For backfilling old statements: nothing is sent to the AI">
          <input type="checkbox" checked={noAi} onChange={e => setNoAiKept(e.target.checked)} />
          No AI — free reader only. A statement it can't read is set aside (you can read it with AI one by one).
        </label>
      )}

      {items.length > 1 && (
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <span className="text-gray-400">
            {items.filter(x => x.status === 'saved').length} saved · {items.filter(x => ['read', 'saving'].includes(x.status)).length} read · {items.filter(x => ['waiting', 'reading'].includes(x.status)).length} to read{items.some(x => x.status === 'error') ? ` · ${items.filter(x => x.status === 'error').length} need a look` : ''}
          </span>
          {readyKeys.length > 0 && !busy && (
            <button onClick={() => void saveItems(readyKeys)} className="btn btn-primary text-xs">Save {readyKeys.length === items.filter(x => x.status !== 'saved').length ? 'all ' : ''}{readyKeys.length} that add up</button>
          )}
        </div>
      )}

      <div className="space-y-2">
        {items.map(it => {
          const f = it.fields;
          const isOpen = open === it.key || items.length === 1;
          return (
            <div key={it.key} className="rounded-lg p-3 text-xs" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <button onClick={() => setOpen(isOpen && items.length > 1 ? null : it.key)} className="text-left text-gray-300 hover:text-white min-w-0">
                  <span className="text-gray-500">{it.files.map(x => x.name).join(', ')}</span>
                  {f && <> · {[f.issuer, f.cardName].filter(Boolean).join(' ') || 'Card'}{f.last4 ? ` ••${f.last4}` : ''} · {f.closingDate ? `closed ${fmtDate(f.closingDate, 'MMM d, yyyy')}` : 'closing date?'} · {f.newBalance != null ? fmtMoney(f.newBalance) : 'balance?'}</>}
                </button>
                <span className={it.status === 'error' ? 'text-red-400' : it.status === 'saved' ? 'text-emerald-400' : it.status === 'read' && !addsUp(f) ? 'text-amber-400' : 'text-gray-500'}>
                  {it.status === 'waiting' ? 'Waiting…' : it.status === 'reading' ? 'Reading…' : it.status === 'saving' ? 'Saving…' : it.status === 'saved' ? 'Saved'
                    : it.status === 'error' ? (it.err ?? 'Failed') : addsUp(f) ? `Adds up${f?.readBy === 'text' ? ' · no AI used' : ''}` : "Doesn't add up — open to check"}
                  {it.status === 'error' && it.needsAi && !busy && <button onClick={() => void readOne(it, false)} className="ml-2 text-amber-400 hover:text-amber-300">Read with AI</button>}
                </span>
              </div>
              {isOpen && f && it.status !== 'saved' && (
                <Editor fields={f} cards={cards} fixedCardId={fixedCardId} cardId={it.cardId}
                  setFields={nf => patch(it.key, { fields: nf })} setCardId={c => patch(it.key, { cardId: c })}
                  saving={it.status === 'saving'} onSave={async () => { const id = await saveItems([it.key]); if (id && items.length === 1) onDone(id); }} />
              )}
            </div>
          );
        })}
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}

function Editor({ fields, setFields, cardId, setCardId, cards, fixedCardId, saving, onSave }: {
  fields: Record<string, any>; setFields: (f: Record<string, any>) => void; cardId: string; setCardId: (id: string) => void;
  cards: CreditCardT[]; fixedCardId?: string; saving: boolean; onSave: () => void;
}) {
  const set = (k: string, v: string) => setFields({ ...fields, [k]: v === '' ? null : k.endsWith('Date') || k === 'periodStart' ? v : Number(v) });
  const input = 'input-dark text-sm w-full';
  const label = 'text-xs text-gray-500 block mb-1';
  const cell = (k: string, l: string, type = 'number') => (
    <div key={k}><span className={label}>{l}</span><input type={type} step="0.01" className={input} value={fields[k] ?? ''} onChange={e => set(k, e.target.value)} /></div>
  );
  const txns: any[] = fields.transactions ?? [];
  const charges = txns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const credits = txns.filter(t => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  const computed = Number(fields.previousBalance ?? 0) - Number(fields.paymentsCredits ?? 0) + Number(fields.purchases ?? 0) + Number(fields.cashAdvances ?? 0)
    + Number(fields.balanceTransfers ?? 0) + Number(fields.feesCharged ?? 0) + Number(fields.interestCharged ?? 0);

  return (
    <div className="mt-3 space-y-3">
      <div className="text-gray-300">
        {fields.periodStart ? `${fmtDate(fields.periodStart, 'MMM d')} – ` : ''}{fields.closingDate ? fmtDate(fields.closingDate, 'MMM d, yyyy') : 'closing date?'}
        {' · '}{txns.length} transactions ({fmtMoney(charges)} charged, {fmtMoney(credits)} paid or credited)
        {fields.purchaseApr != null ? ` · ${fields.purchaseApr}% APR` : ''}{fields.rewardsBalance != null ? ` · ${Number(fields.rewardsBalance).toLocaleString()} rewards` : ''}
        {fields.readBy === 'text' && <p className="mt-1 text-emerald-400">Read from the statement's own text — no AI credits used.{txns.length === 0 && fields.previousBalance !== fields.newBalance ? ' Its transactions could not be read without AI; the summary is complete.' : ''}</p>}
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
      {fields.previousBalance != null && fields.newBalance != null && (
        Math.abs(computed - Number(fields.newBalance)) > 0.02
          ? <p className="text-amber-400">The summary doesn't add up: previous balance − payments + charges + fees + interest = {fmtMoney(computed)}, but the new balance reads {fmtMoney(fields.newBalance)}. Check the figures against the statement.</p>
          : <p className="text-emerald-400">✓ The summary adds up to the new balance.</p>
      )}
      {(Array.isArray(fields.promotions) && fields.promotions.length > 0) && (
        <div className="text-gray-400">
          <span className="text-gray-500">Promotional balances: </span>
          {fields.promotions.map((p: any, i: number) => <span key={i} className="mr-3">{fmtMoney(p.balance)} — pay in full by {fmtDate(p.payBy, 'MMM d, yyyy')}</span>)}
        </div>
      )}
      {Number(fields.pastDueAmount ?? 0) > 0 && <p className="text-red-400">Past due: {fmtMoney(fields.pastDueAmount)}</p>}
      {txns.length > 0 && (
        <details>
          <summary className="text-gray-500 cursor-pointer">{txns.length} transactions read</summary>
          <div className="max-h-64 overflow-y-auto mt-2">
            <table className="table-base">
              <tbody>{txns.map((t, i) => <tr key={i}><td className="text-xs whitespace-nowrap">{t.date}</td><td className="text-xs">{t.description}{t.reference && <span className="block text-gray-600">Ref {t.reference}</span>}</td><td className="text-xs text-gray-500">{t.kind?.replace('_', ' ').toLowerCase()}{t.category ? ` · ${t.category}` : ''}</td><td className={`text-xs text-right ${t.amount < 0 ? 'text-emerald-400' : ''}`}>{fmtMoney(t.amount)}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
      <div className="flex justify-end">
        <button onClick={onSave} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : 'Save statement'}</button>
      </div>
    </div>
  );
}
