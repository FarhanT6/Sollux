import { useEffect, useState } from 'react';
import { createCreditCard, updateCreditCard, getBankAccounts, getProperties, type CreditCardT } from '../../api/client';
import type { Property } from '../../types';
import { describeApiError } from '../../lib/apiError';

/**
 * Every term of a credit card, grouped the way the issuer's disclosures
 * are: the card, its limits and balance, rates, billing cycle, fees,
 * rewards, autopay and authorized users. Only the last four digits of the
 * card number are ever asked for.
 */

type F = Record<string, string | boolean>;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const toForm = (c?: CreditCardT | null): F => {
  const s = (v: unknown) => (v == null ? '' : String(v));
  const d = (v: unknown) => (v ? String(v).slice(0, 10) : '');
  return {
    name: s(c?.name), issuer: s(c?.issuer), network: s(c?.network), last4: s(c?.last4), cardholderName: s(c?.cardholderName),
    isBusiness: !!c?.isBusiness, propertyId: s(c?.propertyId), status: c?.status ?? 'ACTIVE', openedDate: d(c?.openedDate), expiration: s(c?.expiration),
    creditLimit: s(c?.creditLimit), cashAdvanceLimit: s(c?.cashAdvanceLimit), currentBalance: s(c?.currentBalance),
    statementClosingDay: s(c?.statementClosingDay), paymentDueDay: s(c?.paymentDueDay),
    purchaseApr: s(c?.purchaseApr), cashAdvanceApr: s(c?.cashAdvanceApr), balanceTransferApr: s(c?.balanceTransferApr), penaltyApr: s(c?.penaltyApr),
    introApr: s(c?.introApr), introAprType: s(c?.introAprType), introAprEndDate: d(c?.introAprEndDate),
    annualFee: s(c?.annualFee), annualFeeMonth: s(c?.annualFeeMonth), foreignTransactionFee: s(c?.foreignTransactionFee), lateFee: s(c?.lateFee),
    balanceTransferFee: s(c?.balanceTransferFee), cashAdvanceFee: s(c?.cashAdvanceFee),
    rewardsProgram: s(c?.rewardsProgram), rewardsType: s(c?.rewardsType), rewardsBalance: s(c?.rewardsBalance), rewardsCentsPerPoint: s(c?.rewardsCentsPerPoint), rewardsEarnRates: s(c?.rewardsEarnRates),
    autopay: c?.autopay ?? 'NONE', autopayAmount: s(c?.autopayAmount), autopayFromBankAccountId: s(c?.autopayFromBankAccountId), bankAccountId: s(c?.bankAccountId),
    authorizedUsers: (c?.authorizedUsers ?? []).map(u => `${u.name}${u.last4 ? ` ${u.last4}` : ''}`).join('\n'),
    loginUrl: s(c?.loginUrl), phone: s(c?.phone), notes: s(c?.notes),
  };
};

export default function CardEditor({ card, onDone }: { card?: CreditCardT | null; onDone: (saved: CreditCardT | null) => void }) {
  const [f, setF] = useState<F>(toForm(card));
  const [banks, setBanks] = useState<{ id: string; name: string; last4?: string | null; accountType?: string }[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { void getBankAccounts().then((b: any) => setBanks(b)); void getProperties().then(setProperties); }, []);
  const set = (k: string, v: string | boolean) => setF(x => ({ ...x, [k]: v }));
  const str = (k: string) => String(f[k] ?? '');
  const num = (k: string) => (str(k) === '' ? null : Number(str(k)));
  const int = (k: string) => (str(k) === '' ? null : Math.trunc(Number(str(k))));
  const input = 'input-dark text-sm w-full';
  const label = 'text-xs text-gray-500 block mb-1';
  const Field = ({ k, l, type = 'text', step, placeholder, span }: { k: string; l: string; type?: string; step?: string; placeholder?: string; span?: string }) => (
    <div className={span}><span className={label}>{l}</span><input type={type} step={step} className={input} value={str(k)} placeholder={placeholder} onChange={e => set(k, e.target.value)} /></div>
  );

  async function save() {
    if (!str('name').trim()) { setErr('Give the card a name.'); return; }
    if (str('last4') && !/^\d{4}$/.test(str('last4'))) { setErr('Last four digits only.'); return; }
    if (str('expiration') && !/^\d{2}\/\d{2}$/.test(str('expiration'))) { setErr('Expiration as MM/YY.'); return; }
    setSaving(true); setErr(null);
    const users = str('authorizedUsers').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const m = l.match(/^(.*?)\s*(\d{4})?$/);
      return { name: (m?.[1] ?? l).trim(), last4: m?.[2] ?? null };
    });
    const body = {
      name: str('name').trim(), issuer: str('issuer') || null, network: str('network') || null, last4: str('last4') || null, cardholderName: str('cardholderName') || null,
      isBusiness: !!f.isBusiness, propertyId: str('propertyId') || null, status: str('status'), openedDate: str('openedDate') || null, expiration: str('expiration') || null,
      creditLimit: num('creditLimit'), cashAdvanceLimit: num('cashAdvanceLimit'),
      ...(str('currentBalance') !== String(card?.currentBalance ?? '') ? { currentBalance: num('currentBalance') } : {}),
      statementClosingDay: int('statementClosingDay'), paymentDueDay: int('paymentDueDay'),
      purchaseApr: num('purchaseApr'), cashAdvanceApr: num('cashAdvanceApr'), balanceTransferApr: num('balanceTransferApr'), penaltyApr: num('penaltyApr'),
      introApr: num('introApr'), introAprType: str('introAprType') || null, introAprEndDate: str('introAprEndDate') || null,
      annualFee: num('annualFee'), annualFeeMonth: int('annualFeeMonth'), foreignTransactionFee: num('foreignTransactionFee'), lateFee: num('lateFee'),
      balanceTransferFee: num('balanceTransferFee'), cashAdvanceFee: num('cashAdvanceFee'),
      rewardsProgram: str('rewardsProgram') || null, rewardsType: str('rewardsType') || null, rewardsBalance: num('rewardsBalance'),
      rewardsCentsPerPoint: num('rewardsCentsPerPoint'), rewardsEarnRates: str('rewardsEarnRates') || null,
      autopay: str('autopay'), autopayAmount: num('autopayAmount'), autopayFromBankAccountId: str('autopayFromBankAccountId') || null, bankAccountId: str('bankAccountId') || null,
      authorizedUsers: users.length ? users : null, loginUrl: str('loginUrl') || null, phone: str('phone') || null, notes: str('notes') || null,
    };
    try {
      const saved = card ? await updateCreditCard(card.id, body) : await createCreditCard(body);
      onDone(saved);
    } catch (e) { setErr(describeApiError(e, 'Could not save the card.')); }
    finally { setSaving(false); }
  }

  // Called as functions, not rendered as components: a component declared
  // in here would be a new type each render and the input would lose focus.
  const Section = (title: string, children: React.ReactNode) => (
    <div>
      <p className="section-label">{title}</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{children}</div>
    </div>
  );

  return (
    <div className="card p-4 mb-5 space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white">{card ? `Edit ${card.name}` : 'New credit card'}</p>
        <button onClick={() => onDone(null)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
      </div>
      {!card && <p className="text-xs text-gray-500">Fill in what you know. Uploading a statement fills in the rates, limit, cycle and rewards for you.</p>}

      {Section("Card", <>
        {Field({ k: "name", l: "Name", placeholder: "Chase Sapphire Preferred", span: "col-span-2" })}
        {Field({ k: "issuer", l: "Issuer", placeholder: "Chase" })}
        <div><span className={label}>Network</span><select className={input} value={str('network')} onChange={e => set('network', e.target.value)}><option value="">—</option>{['Visa', 'Mastercard', 'American Express', 'Discover'].map(x => <option key={x}>{x}</option>)}</select></div>
        {Field({ k: "last4", l: "Last 4 digits", placeholder: "1234" })}
        {Field({ k: "expiration", l: "Expires (MM/YY)", placeholder: "08/29" })}
        {Field({ k: "cardholderName", l: "Cardholder" })}
        {Field({ k: "openedDate", l: "Opened", type: "date" })}
        <div><span className={label}>Status</span><select className={input} value={str('status')} onChange={e => set('status', e.target.value)}><option value="ACTIVE">Active</option><option value="FROZEN">Frozen</option><option value="CLOSED">Closed</option></select></div>
        <div className="flex items-end pb-2"><label className="text-xs text-gray-400 flex items-center gap-2"><input type="checkbox" checked={!!f.isBusiness} onChange={e => set('isBusiness', e.target.checked)} /> Business card</label></div>
        {f.isBusiness && <div className="col-span-2"><span className={label}>Used for property (optional)</span><select className={input} value={str('propertyId')} onChange={e => set('propertyId', e.target.value)}><option value="">—</option>{properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}</select></div>}
      </>)}

      {Section("Limits & balance", <>
        {Field({ k: "creditLimit", l: "Credit limit", type: "number", step: "0.01" })}
        {Field({ k: "cashAdvanceLimit", l: "Cash advance limit", type: "number", step: "0.01" })}
        {Field({ k: "currentBalance", l: "Balance right now", type: "number", step: "0.01", placeholder: "from the app / site" })}
        <div className="flex items-end pb-2 text-xs text-gray-600">{card?.balanceAsOf ? `Entered ${String(card.balanceAsOf).slice(0, 10)}. A newer statement replaces it.` : 'Optional. Statements keep it current.'}</div>
      </>)}

      {Section("Rates (APR %)", <>
        {Field({ k: "purchaseApr", l: "Purchases", type: "number", step: "0.01" })}
        {Field({ k: "cashAdvanceApr", l: "Cash advances", type: "number", step: "0.01" })}
        {Field({ k: "balanceTransferApr", l: "Balance transfers", type: "number", step: "0.01" })}
        {Field({ k: "penaltyApr", l: "Penalty", type: "number", step: "0.01" })}
        {Field({ k: "introApr", l: "Promotional rate", type: "number", step: "0.01", placeholder: "0" })}
        <div><span className={label}>Promo applies to</span><select className={input} value={str('introAprType')} onChange={e => set('introAprType', e.target.value)}><option value="">—</option><option value="PURCHASE">Purchases</option><option value="BALANCE_TRANSFER">Balance transfers</option><option value="BOTH">Both</option></select></div>
        {Field({ k: "introAprEndDate", l: "Promo ends", type: "date" })}
      </>)}

      {Section("Billing cycle", <>
        {Field({ k: "statementClosingDay", l: "Statement closes on day", type: "number", placeholder: "1–31" })}
        {Field({ k: "paymentDueDay", l: "Payment due on day", type: "number", placeholder: "1–31" })}
      </>)}

      {Section("Fees", <>
        {Field({ k: "annualFee", l: "Annual fee", type: "number", step: "0.01" })}
        <div><span className={label}>Annual fee posts in</span><select className={input} value={str('annualFeeMonth')} onChange={e => set('annualFeeMonth', e.target.value)}><option value="">—</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></div>
        {Field({ k: "lateFee", l: "Late fee (up to)", type: "number", step: "0.01" })}
        {Field({ k: "foreignTransactionFee", l: "Foreign transaction fee %", type: "number", step: "0.01" })}
        {Field({ k: "balanceTransferFee", l: "Balance transfer fee %", type: "number", step: "0.01" })}
        {Field({ k: "cashAdvanceFee", l: "Cash advance fee %", type: "number", step: "0.01" })}
      </>)}

      {Section("Rewards", <>
        {Field({ k: "rewardsProgram", l: "Program", placeholder: "Ultimate Rewards", span: "col-span-2" })}
        <div><span className={label}>Type</span><select className={input} value={str('rewardsType')} onChange={e => set('rewardsType', e.target.value)}><option value="">—</option><option value="POINTS">Points</option><option value="MILES">Miles</option><option value="CASHBACK">Cash back ($)</option></select></div>
        {Field({ k: "rewardsBalance", l: f.rewardsType === 'CASHBACK' ? 'Cash back balance ($)' : 'Balance', type: "number", step: "0.01" })}
        {Field({ k: "rewardsCentsPerPoint", l: "Worth (¢ per point)", type: "number", step: "0.01", placeholder: f.rewardsType === 'CASHBACK' ? '100' : '1.0' })}
        {Field({ k: "rewardsEarnRates", l: "Earn rates", placeholder: "3x dining, 2x travel, 1x everything else", span: "col-span-2 md:col-span-3" })}
      </>)}

      {Section("Paying it", <>
        <div><span className={label}>Autopay</span><select className={input} value={str('autopay')} onChange={e => set('autopay', e.target.value)}>
          <option value="NONE">Off</option><option value="MINIMUM">Minimum payment</option><option value="STATEMENT_BALANCE">Statement balance</option><option value="FULL_BALANCE">Full balance</option><option value="FIXED">Fixed amount</option></select></div>
        {f.autopay === 'FIXED' && Field({ k: "autopayAmount", l: "Autopay amount", type: "number", step: "0.01" })}
        <div className="col-span-2"><span className={label}>Paid from</span><select className={input} value={str('autopayFromBankAccountId')} onChange={e => set('autopayFromBankAccountId', e.target.value)}><option value="">—</option>{banks.filter(b => b.accountType !== 'CREDIT_CARD').map(b => <option key={b.id} value={b.id}>{b.name}{b.last4 ? ` ••${b.last4}` : ''}</option>)}</select></div>
        <div className="col-span-2"><span className={label}>Linked payment-source entry</span><select className={input} value={str('bankAccountId')} onChange={e => set('bankAccountId', e.target.value)}><option value="">—</option>{banks.filter(b => b.accountType === 'CREDIT_CARD').map(b => <option key={b.id} value={b.id}>{b.name}{b.last4 ? ` ••${b.last4}` : ''}</option>)}</select></div>
        {Field({ k: "loginUrl", l: "Login / pay link", span: "col-span-2" })}
        {Field({ k: "phone", l: "Customer service phone" })}
      </>)}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div><span className={label}>Authorized users, one per line: name then last 4</span><textarea rows={3} className={input} value={str('authorizedUsers')} onChange={e => set('authorizedUsers', e.target.value)} placeholder={'Fahima Talukder 5678'} /></div>
        <div><span className={label}>Notes</span><textarea rows={3} className={input} value={str('notes')} onChange={e => set('notes', e.target.value)} /></div>
      </div>

      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={() => onDone(null)} className="btn text-xs">Cancel</button>
        <button onClick={save} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : 'Save card'}</button>
      </div>
    </div>
  );
}
