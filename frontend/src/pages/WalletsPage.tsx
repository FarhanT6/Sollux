import { useEffect, useState } from 'react';
import { getWallets, updateWallet, addWalletMovement, deleteWalletMovement, getBankAccounts, depositChecks, undoCheckDeposit, type WalletsT, type WalletT, type WalletMovementType } from '../api/client';
import type { BankAccount } from '../types';
import { fmtMoney } from '../lib/money';
import { fmtDate, todayISO } from '../lib/date';
import { describeApiError } from '../lib/apiError';
import { bankAccountLabel } from '../lib/bankAccountLabel';

/**
 * Cash, checks & apps: what's sitting in cash, checks not yet deposited, Venmo,
 * Cash App, PayPal and Apple Cash (backend services/wallets.ts). A rent check or
 * money order stays on hand until it is marked deposited into a bank account. Rent logged by that method since the wallet's
 * start date counts in; a "transferred to your bank" email from the app takes it
 * out to that bank account; the owner records the rest — cash deposited or
 * spent, money moved between apps, a correction.
 */

const TYPE_LABEL: Record<string, string> = {
  RENT: 'Rent received', CHECK_DEPOSIT: 'Deposited', TO_BANK: 'To a bank account', SPENT: 'Spent', TO_WALLET: 'Moved to another app / cash',
  FROM_WALLET: 'Moved in from another app / cash', ADJUSTMENT: 'Correction', OTHER_IN: 'Other money in',
};

export default function WalletsPage() {
  const [data, setData] = useState<WalletsT | null>(null);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    void getWallets().then(setData).catch(e => setErr(describeApiError(e, 'Could not load balances.')));
    void getBankAccounts().then(b => setBanks(b.filter(x => x.accountType !== 'CREDIT_CARD'))).catch(() => {});
  }, []);
  if (!data) return err ? <p className="text-sm text-red-400">{err}</p> : <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="rounded-xl p-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
        <p className="text-sm font-semibold text-white">Cash, checks and payment apps: {fmtMoney(data.total)}</p>
        <p className="text-xs text-gray-500 mt-0.5">Rent you log as cash, a check or money order, Venmo, Cash App, PayPal or Apple Cash adds to that balance. A check stays under Checks until you mark it deposited (or pick the bank account when you log it). When an app emails you that money was transferred to your bank, it's taken out to that account on its own. Record the rest yourself: cash deposited or spent, money moved between apps, a correction.</p>
      </div>
      {err && <p className="text-sm text-red-400">{err}</p>}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {data.wallets.map(w => (
          <button key={w.id} onClick={() => setOpen(open === w.id ? null : w.id)} className={`stat-card text-left ${open === w.id ? 'ring-1 ring-amber-400/60' : ''}`}>
            <p className="text-xs text-gray-500">{w.label}</p>
            <p className={`text-lg font-semibold ${w.balance < 0 ? 'text-red-400' : 'text-white'}`}>{fmtMoney(w.balance)}</p>
            <p className="text-xs text-gray-500">{w.kind === 'CHECK' ? `${w.onHand?.length ?? 0} on hand · ${fmtMoney(w.movedOut)} deposited` : `${fmtMoney(w.rentIn)} rent in · ${fmtMoney(w.movedOut)} out`}</p>
          </button>
        ))}
      </div>
      {open && <WalletDetail w={data.wallets.find(x => x.id === open)!} all={data.wallets} banks={banks} onChange={setData} />}
    </div>
  );
}

function WalletDetail({ w, all, banks, onChange }: { w: WalletT; all: WalletT[]; banks: BankAccount[]; onChange: (d: WalletsT) => void }) {
  const [form, setForm] = useState({ date: todayISO(), amount: '', type: (w.kind === 'CASH' ? 'TO_BANK' : 'TO_BANK') as WalletMovementType, bankAccountId: '', toWalletId: '', description: '' });
  const [opening, setOpening] = useState(String(w.openingBalance || ''));
  const [startedAt, setStartedAt] = useState(w.startedAt);
  const [err, setErr] = useState('');
  const input = 'input-dark text-sm w-full';
  const label = 'block text-xs text-gray-500 mb-1';

  async function add() {
    const amount = Number(form.amount);
    if (!amount) { setErr('Enter the amount.'); return; }
    if (form.type === 'TO_WALLET' && !form.toWalletId) { setErr('Choose where it went.'); return; }
    setErr('');
    try {
      onChange(await addWalletMovement(w.id, { date: form.date, amount, type: form.type, bankAccountId: form.type === 'TO_BANK' ? form.bankAccountId || null : null, toWalletId: form.type === 'TO_WALLET' ? form.toWalletId : null, description: form.description || null }));
      setForm(f => ({ ...f, amount: '', description: '' }));
    } catch (e) { setErr(describeApiError(e, 'Not saved.')); }
  }

  return (
    <div className="rounded-xl p-4 space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
      {w.kind === 'CHECK' && <ChecksOnHand w={w} banks={banks} onChange={onChange} />}
      <div className="flex flex-wrap items-end gap-3">
        <p className="text-sm font-semibold text-white mr-auto">{w.label}</p>
        <div><span className={label}>Counting from</span><input type="date" className="input-dark text-sm" value={startedAt} onChange={e => setStartedAt(e.target.value)} /></div>
        <div><span className={label}>Balance on that day</span><input type="number" step="0.01" className="input-dark text-sm w-32" value={opening} onChange={e => setOpening(e.target.value)} placeholder="0.00" /></div>
        <button className="btn text-xs" disabled={Number(opening || 0) === w.openingBalance && startedAt === w.startedAt}
          onClick={async () => { try { onChange(await updateWallet(w.id, { openingBalance: Number(opening || 0), startedAt })); } catch (e) { setErr(describeApiError(e, 'Not saved.')); } }}>Save</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
        <div className="md:col-span-2"><span className={label}>Where it went (or came from)</span>
          <select className={input} value={form.type} onChange={e => setForm({ ...form, type: e.target.value as WalletMovementType })}>
            <option value="TO_BANK">{w.kind === 'CASH' || w.kind === 'CHECK' ? 'Deposited into a bank account' : 'Transferred to a bank account'}</option>
            <option value="SPENT">Spent (paid for something)</option>
            <option value="TO_WALLET">Moved to another app / cash</option>
            <option value="OTHER_IN">{w.kind === 'CHECK' ? 'A check received (not logged as rent)' : 'Other money in'}</option>
            <option value="ADJUSTMENT">Correction (+ or −)</option>
          </select>
        </div>
        {form.type === 'TO_BANK' && <div className="md:col-span-2"><span className={label}>Bank account</span>
          <select className={input} value={form.bankAccountId} onChange={e => setForm({ ...form, bankAccountId: e.target.value })}>
            <option value="">— Not recorded —</option>{banks.map(b => <option key={b.id} value={b.id}>{bankAccountLabel(b)}</option>)}
          </select></div>}
        {form.type === 'TO_WALLET' && <div className="md:col-span-2"><span className={label}>To</span>
          <select className={input} value={form.toWalletId} onChange={e => setForm({ ...form, toWalletId: e.target.value })}>
            <option value="">Choose…</option>{all.filter(x => x.id !== w.id).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select></div>}
        {(form.type === 'SPENT' || form.type === 'OTHER_IN' || form.type === 'ADJUSTMENT') && <div className="md:col-span-2"><span className={label}>What for</span><input className={input} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder={form.type === 'SPENT' ? 'e.g. paid the plumber' : ''} /></div>}
        <div><span className={label}>Amount</span><input type="number" step="0.01" className={input} value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
        <div><span className={label}>Date</span><input type="date" className={input} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></div>
        <button className="btn btn-primary text-xs" onClick={() => void add()}>Record</button>
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}

      <table className="table-base">
        <thead><tr><th className="pl-0">Date</th><th>What</th><th>Details</th><th className="text-right">Amount</th><th /></tr></thead>
        <tbody>
          {w.entries.map(e => (
            <tr key={e.id}>
              <td className="pl-0 text-gray-400 whitespace-nowrap">{fmtDate(e.date, 'MMM d, yyyy')}</td>
              <td className="text-gray-300">{e.kind === 'RENT' && e.method === 'MONEY_ORDER' ? 'Money order received' : e.kind === 'RENT' && w.kind === 'CHECK' ? 'Check received' : e.kind === 'OTHER_IN' && w.kind === 'CHECK' ? 'Check received (by hand)' : TYPE_LABEL[e.kind] ?? e.kind}{e.source === 'email' && <span className="block text-xs text-gray-600">from the app's email</span>}</td>
              <td className="text-gray-400 text-xs">{(e.kind === 'TO_BANK' || e.kind === 'CHECK_DEPOSIT') && e.bankAccountName ? `${e.kind === 'CHECK_DEPOSIT' ? `${e.description} → ` : ''}${e.bankAccountName}` : `${e.checkNumber ? `#${e.checkNumber} · ` : ''}${e.description}`}
                {(e.kind === 'RENT' || e.kind === 'OTHER_IN') && w.kind === 'CHECK' && <span className={`block ${e.deposited ? 'text-gray-600' : 'text-amber-400'}`}>{e.deposited ? `Deposited ${fmtDate(e.deposited.date, 'MMM d')}${e.deposited.bankAccountName ? ` into ${e.deposited.bankAccountName}` : ''}` : 'On hand — not deposited yet'}</span>}</td>
              <td className={`text-right tabular-nums ${e.amount < 0 ? 'text-red-300' : 'text-emerald-400'}`}>{e.amount < 0 ? '−' : '+'}{fmtMoney(Math.abs(e.amount))}</td>
              <td className="text-right">{e.movementId && <button onClick={async () => { if (confirm('Remove this entry?')) onChange(await deleteWalletMovement(e.movementId!)); }} className="text-xs text-gray-600 hover:text-red-400">✕</button>}
                {e.kind === 'CHECK_DEPOSIT' && e.rentPaymentId && <button onClick={async () => { if (confirm('Not deposited after all? The check goes back on hand.')) onChange(await undoCheckDeposit(e.rentPaymentId!)); }} className="text-xs text-gray-600 hover:text-amber-400" title="Undo the deposit">Undo</button>}</td>
            </tr>
          ))}
          {!w.entries.length && <tr><td colSpan={5} className="pl-0 text-sm text-gray-500">Nothing since {fmtDate(w.startedAt, 'MMM d, yyyy')}.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** The checks not deposited yet: tick the ones going to the bank together, choose the account, Deposit. */
function ChecksOnHand({ w, banks, onChange }: { w: WalletT; banks: BankAccount[]; onChange: (d: WalletsT) => void }) {
  const onHand = w.onHand ?? [];
  // Rent checks by their payment, checks recorded here by their entry.
  const keyOf = (c: { rentPaymentId: string | null; movementId: string | null }) => c.rentPaymentId ? `r:${c.rentPaymentId}` : `m:${c.movementId}`;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bankAccountId, setBankAccountId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [err, setErr] = useState('');
  const total = onHand.filter(c => picked.has(keyOf(c))).reduce((t, c) => t + c.amount, 0);
  const [done, setDone] = useState('');
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function deposit() {
    if (!picked.size) { setErr('Tick the checks you deposited.'); return; }
    if (!bankAccountId) { setErr('Choose the bank account.'); return; }
    setErr('');
    try {
      const keys = [...picked];
      onChange(await depositChecks(keys.filter(k => k.startsWith('r:')).map(k => k.slice(2)), bankAccountId, date, keys.filter(k => k.startsWith('m:')).map(k => k.slice(2))));
      setDone(`Deposited ${fmtMoney(total)}. It shows as pending on that account (Settings → Banking) until the bank has it.`);
      setPicked(new Set());
    }
    catch (e) { setErr(describeApiError(e, 'Not saved.')); }
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-white">Checks on hand {onHand.length > 0 && <span className="text-gray-500 font-normal">· {onHand.length} · {fmtMoney(onHand.reduce((t, c) => t + c.amount, 0))}</span>}</p>
      {!onHand.length ? <p className="text-xs text-gray-500">None — every check logged since {fmtDate(w.startedAt, 'MMM d, yyyy')} has been deposited. Log a check or money order as rent and it waits here until it's deposited.</p> : (
        <>
          <table className="table-base">
            <thead><tr><th className="pl-0 w-8"><input type="checkbox" checked={picked.size === onHand.length} onChange={e => setPicked(e.target.checked ? new Set(onHand.map(keyOf)) : new Set())} /></th><th>Received</th><th>Check</th><th>From</th><th className="text-right">Amount</th></tr></thead>
            <tbody>
              {onHand.map(c => (
                <tr key={keyOf(c)} className="cursor-pointer" onClick={() => toggle(keyOf(c))}>
                  <td className="pl-0"><input type="checkbox" checked={picked.has(keyOf(c))} onChange={() => toggle(keyOf(c))} onClick={e => e.stopPropagation()} /></td>
                  <td className="text-gray-400 whitespace-nowrap">{fmtDate(c.date, 'MMM d, yyyy')}</td>
                  <td className="text-gray-300">{c.checkNumber ? `#${c.checkNumber}` : '—'}</td>
                  <td className="text-gray-400 text-xs">{c.description}{c.manual && <span className="block text-gray-600" title="Recorded here, not as a rent payment — log it as rent on the tenant to count toward their rent">recorded here, not as rent</span>}</td>
                  <td className="text-right tabular-nums text-white">{fmtMoney(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-end gap-3">
            <div><span className="block text-xs text-gray-500 mb-1">Deposited into</span>
              <select className="input-dark text-sm" value={bankAccountId} onChange={e => setBankAccountId(e.target.value)}>
                <option value="">Choose…</option>{banks.map(b => <option key={b.id} value={b.id}>{bankAccountLabel(b)}</option>)}
              </select></div>
            <div><span className="block text-xs text-gray-500 mb-1">On</span><input type="date" className="input-dark text-sm" value={date} onChange={e => setDate(e.target.value)} /></div>
            <button className="btn btn-primary text-xs disabled:opacity-50" disabled={!picked.size} onClick={() => void deposit()}>
              {picked.size ? `Deposit ${picked.size} check${picked.size === 1 ? '' : 's'} · ${fmtMoney(total)}` : 'Deposit'}
            </button>
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
        </>
      )}
      {done && <p className="text-xs text-emerald-400">{done}</p>}
    </div>
  );
}
