import { useState } from 'react';
import { saveTaxDefault, updateTaxDefault, deleteTaxDefault, updateProperty } from '../../api/client';
import type { Property, TaxAssessment, TaxDefault, TaxDefaultStatus } from '../../types';
import { fmtDate, todayISO } from '../../lib/date';
import { fmtMoney } from '../../lib/money';
import { describeApiError } from '../../lib/apiError';

/**
 * One parcel's property tax, everything in one place: its parcel number,
 * the roll's values and base year, this year's installments with the day
 * each turns delinquent and the penalty it then carries, every special
 * assessment (Mello-Roos marked), and each year left unpaid — its default
 * number, what redeems it today, any plan of redemption, and the day the
 * county may sell (or a certificate holder apply for a deed).
 */

const n = (v: unknown) => (v == null || v === '' ? null : Number(v));
const d10 = (v?: string | null) => (v ? String(v).slice(0, 10) : '');
const s = (v: unknown) => (v == null ? '' : String(v));
const yearKey = (y: string) => Number((y.match(/\d{4}/) ?? ['0'])[0]);

/** Whole days from today to an ISO day (negative once passed). */
function daysUntil(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const [ty, tm, td] = todayISO().split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
}
function inWords(day: string): string {
  const days = daysUntil(day);
  if (days < 0) return 'passed';
  if (days === 0) return 'today';
  if (days < 60) return `in ${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30.4);
  return months < 24 ? `in ${months} months` : `in ${(days / 365.25).toFixed(1)} years`;
}

const INST_PILL: Record<string, { label: string; pill: string }> = {
  paid: { label: 'Paid', pill: 'pill-green' }, upcoming: { label: 'Upcoming', pill: 'pill-gray' },
  due: { label: 'Due', pill: 'pill-amber' }, delinquent: { label: 'Delinquent', pill: 'pill-red' },
};
const DEFAULT_STATUS: Record<TaxDefaultStatus, { label: string; pill: string }> = {
  OPEN: { label: 'Unpaid', pill: 'pill-red' }, PLAN: { label: 'On a plan', pill: 'pill-amber' },
  REDEEMED: { label: 'Redeemed', pill: 'pill-green' }, SOLD: { label: 'Sold', pill: 'pill-gray' },
};

type DefaultForm = {
  id?: string; taxYear: string; status: TaxDefaultStatus; defaultNumber: string; defaultDate: string;
  taxAmount: string; penalties: string; costs: string; amountToRedeem: string; redeemGoodThrough: string; powerToSellDate: string;
  planInstallment: string; planNextDue: string; planRemaining: string; planBalance: string; planStarted: string;
  certificateNumber: string; certificateHolder: string; certificateRate: string; certificateIssued: string; redeemedOn: string; notes: string; sourceUrl: string;
};
const EMPTY_DEFAULT: DefaultForm = {
  taxYear: '', status: 'OPEN', defaultNumber: '', defaultDate: '', taxAmount: '', penalties: '', costs: '', amountToRedeem: '', redeemGoodThrough: '',
  powerToSellDate: '', planInstallment: '', planNextDue: '', planRemaining: '', planBalance: '', planStarted: '',
  certificateNumber: '', certificateHolder: '', certificateRate: '', certificateIssued: '', redeemedOn: '', notes: '', sourceUrl: '',
};
const input = 'input-dark text-sm w-full';
const label = 'text-xs text-gray-500 block mb-1';

export default function ParcelPanel({ property, taxes, defaults, onChanged, onEditYear, onAddYear }: {
  property: Property;
  taxes: TaxAssessment[];
  defaults: TaxDefault[];
  onChanged: () => void | Promise<void>;
  onEditYear: (t: TaxAssessment) => void;
  onAddYear: () => void;
}) {
  const [apn, setApn] = useState(property.apn ?? taxes.find(t => t.apn)?.apn ?? '');
  const [apnSaved, setApnSaved] = useState(false);
  const [form, setForm] = useState<DefaultForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showRules, setShowRules] = useState(false);

  const years = [...taxes].sort((a, b) => yearKey(b.taxYear) - yearKey(a.taxYear));
  const current = years[0];
  const state = (property.state ?? '').toUpperCase();
  const fl = state === 'FL';
  const open = defaults.filter(d => d.status === 'OPEN' || d.status === 'PLAN');

  // What it takes to be current today: unpaid installments past due, with
  // their penalties, and each unpaid year at its redemption figure.
  const owedInstallments = years.flatMap(t => (t.escrowLoanId ? [] : t.computed?.installments ?? [])
    .filter(i => i.state === 'due' || i.state === 'delinquent').map(i => (i.amount ?? 0) + i.penalty));
  // A year on a plan of redemption is current while its installments are paid.
  const owedDefaults = open.map(d => d.status === 'PLAN' ? 0 : d.computed?.stated ?? d.computed?.redemption?.total ?? n(d.amountToRedeem) ?? 0);
  const owedNow = [...owedInstallments, ...owedDefaults].reduce((t, v) => t + v, 0);
  const nextSale = open.map(d => d.computed?.powerToSell).filter((x): x is string => !!x).sort()[0];

  async function saveApn() {
    await updateProperty(property.id, { apn: apn.trim() || null } as any);
    setApnSaved(true); setTimeout(() => setApnSaved(false), 1500);
    await onChanged();
  }

  function startDefault(d?: TaxDefault) {
    setError(null);
    if (!d) { setForm({ ...EMPTY_DEFAULT }); return; }
    setForm({
      id: d.id, taxYear: d.taxYear, status: d.status, defaultNumber: s(d.defaultNumber), defaultDate: d10(d.defaultDate),
      taxAmount: s(d.taxAmount), penalties: s(d.penalties), costs: s(d.costs), amountToRedeem: s(d.amountToRedeem), redeemGoodThrough: d10(d.redeemGoodThrough),
      powerToSellDate: d10(d.powerToSellDate), planInstallment: s(d.payPlan?.installment), planNextDue: d10(d.payPlan?.nextDue), planRemaining: s(d.payPlan?.remaining),
      planBalance: s(d.payPlan?.balance), planStarted: d10(d.payPlan?.started), certificateNumber: s(d.certificateNumber), certificateHolder: s(d.certificateHolder),
      certificateRate: s(d.certificateRate), certificateIssued: d10(d.certificateIssued), redeemedOn: d10(d.redeemedOn), notes: s(d.notes), sourceUrl: s(d.sourceUrl),
    });
  }
  const setF = (p: Partial<DefaultForm>) => setForm(f => (f ? { ...f, ...p } : f));

  async function saveDefault() {
    if (!form) return;
    if (!form.taxYear.trim()) { setError('Which tax year went unpaid?'); return; }
    setSaving(true); setError(null);
    const plan = form.planInstallment || form.planNextDue || form.planRemaining || form.planBalance || form.planStarted
      ? { installment: n(form.planInstallment), nextDue: form.planNextDue || null, remaining: n(form.planRemaining), balance: n(form.planBalance), started: form.planStarted || null }
      : null;
    const body = {
      propertyId: property.id, taxYear: form.taxYear.trim(), status: form.status, defaultNumber: form.defaultNumber || null, defaultDate: form.defaultDate || null,
      taxAmount: n(form.taxAmount), penalties: n(form.penalties), costs: n(form.costs), amountToRedeem: n(form.amountToRedeem),
      redeemGoodThrough: form.redeemGoodThrough || null, powerToSellDate: form.powerToSellDate || null, payPlan: plan,
      certificateNumber: form.certificateNumber || null, certificateHolder: form.certificateHolder || null, certificateRate: n(form.certificateRate),
      certificateIssued: form.certificateIssued || null, redeemedOn: form.redeemedOn || null, notes: form.notes || null, sourceUrl: form.sourceUrl || null,
    };
    try {
      if (form.id) await updateTaxDefault(form.id, body); else await saveTaxDefault(body);
      setForm(null); await onChanged();
    } catch (e) { setError(describeApiError(e, 'Could not save.')); }
    finally { setSaving(false); }
  }
  async function removeDefault() {
    if (form?.id && confirm('Delete this unpaid-year record?')) { await deleteTaxDefault(form.id); setForm(null); await onChanged(); }
  }

  const values = current && [
    ['Land', current.landValue], ['Improvements', current.improvementValue], ...(current.marketValue != null ? [['Market (just) value', current.marketValue]] : []),
    ['Exemptions', current.exemptionsValue != null ? -Number(current.exemptionsValue) : null], ['Net taxable', current.assessedValue],
  ] as [string, unknown][];
  const specials = current?.specialAssessments ?? [];
  const specialsTotal = specials.reduce((t, a) => t + Number(a.amount || 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="col-span-2">
          <span className={label}>Parcel number (APN)</span>
          <div className="flex gap-2">
            <input className={input} value={apn} onChange={e => setApn(e.target.value)} placeholder="123-456-78-00" />
            <button onClick={() => void saveApn()} className="btn text-xs">{apnSaved ? 'Saved' : 'Save'}</button>
          </div>
          <p className="text-xs text-gray-600 mt-1">{[property.county && `${property.county} County`, property.state].filter(Boolean).join(', ') || 'Add the county and state on the property.'}</p>
        </div>
        <div className="stat-card"><p className="text-xs text-gray-500">To be current today</p><p className={`text-lg font-semibold ${owedNow > 0 ? 'text-red-400' : 'text-white'}`}>{fmtMoney(owedNow)}</p></div>
        <div className="stat-card">
          <p className="text-xs text-gray-500">{fl ? 'Earliest tax deed' : 'Earliest power to sell'}</p>
          <p className={`text-lg font-semibold ${nextSale && daysUntil(nextSale) < 365 ? 'text-red-400' : 'text-white'}`}>{nextSale ? fmtDate(nextSale) : '—'}</p>
          {nextSale && <p className="text-xs text-gray-500">{inWords(nextSale)}</p>}
        </div>
      </div>

      {/* This year */}
      {current ? (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-white">{current.computed?.calendar?.yearLabel ?? current.taxYear} {current.taxingAuthority ? <span className="text-xs text-gray-500 font-normal">· {current.taxingAuthority}</span> : null}</p>
            <div className="flex gap-3 text-xs">
              {current.sourceUrl && <a href={current.sourceUrl} target="_blank" rel="noreferrer" className="text-amber-400 hover:text-amber-300">County page</a>}
              <button onClick={() => onEditYear(current)} className="text-gray-400 hover:text-white">Edit</button>
            </div>
          </div>
          {current.escrowLoanId && <p className="text-xs text-blue-300 mb-2">Paid by the lender from escrow.</p>}
          <div>
            {(current.computed?.installments ?? []).map(i => (
              <div key={i.n} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <span className="w-16 text-gray-300">{(current.computed?.installments.length ?? 0) > 1 ? (i.n === 1 ? '1st' : '2nd') : 'Annual'}</span>
                <span className="w-28 text-white">{i.amount != null ? fmtMoney(i.amount) : '—'}{i.penalty > 0 && <span className="block text-xs text-red-400">+ {fmtMoney(i.penalty)} penalty</span>}</span>
                <span className="text-xs text-gray-400 flex-1 min-w-[12rem]">{i.due ? `Due ${fmtDate(i.due)}` : ''}{i.delinquentAfter ? ` · delinquent after ${fmtDate(i.delinquentAfter)}` : ''}</span>
                <span className={`pill ${INST_PILL[i.state].pill}`}>{i.paid ? `Paid ${fmtDate(i.paid, 'MMM d')}` : INST_PILL[i.state].label}</span>
              </div>
            ))}
          </div>
          {current.computed?.discount && (
            <p className="text-xs text-emerald-400 mt-2">Pay by {fmtDate(current.computed.discount.by)} for {Math.round(current.computed.discount.rate * 100)}% off
              {n(current.annualTaxAmount) ? ` — ${fmtMoney(Number(current.annualTaxAmount) * (1 - current.computed.discount.rate))}` : ''}.</p>
          )}
          {(n(current.penaltiesOwed) || n(current.balanceOwed)) ? (
            <p className="text-xs text-gray-400 mt-2">
              {n(current.balanceOwed) != null && <>County shows {fmtMoney(current.balanceOwed)} owing</>}
              {n(current.penaltiesOwed) ? <>, including {fmtMoney(current.penaltiesOwed)} penalties and costs</> : null}
              {current.lookedUpAt && <> (as of {fmtDate(current.lookedUpAt)})</>}.
            </p>
          ) : null}

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4">
            {values!.map(([k, v]) => (
              <div key={k}><p className="text-xs text-gray-500">{k}</p><p className="text-sm text-white">{v != null && v !== '' ? fmtMoney(v as any) : '—'}</p></div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-2 text-xs text-gray-500">
            {current.exemptionsNote && <span>Exemptions: {current.exemptionsNote}</span>}
            {current.baseYear && <span>Base year {current.baseYear}</span>}
            {n(current.taxRate) != null && <span>Rate {Number(current.taxRate).toFixed(4)}%</span>}
            {current.billNumber && <span>Bill {current.billNumber}</span>}
          </div>

          {specials.length > 0 && (
            <div className="mt-4">
              <p className="section-label">Special assessments &amp; direct charges · {fmtMoney(specialsTotal)}</p>
              <div className="space-y-1">
                {specials.map((a, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 text-gray-300">{a.name}{a.cfd && <span className="pill pill-amber ml-2">Mello-Roos</span>}{a.phone && <span className="text-xs text-gray-600 ml-2">{a.phone}</span>}</span>
                    <span className="text-white">{fmtMoney(a.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {current.computed?.calendar && (
            <button onClick={() => setShowRules(v => !v)} className="text-xs text-gray-500 hover:text-gray-300 mt-3">{showRules ? 'Hide' : 'How'} property tax works in {state}</button>
          )}
          {showRules && current.computed?.calendar && (
            <ul className="text-xs text-gray-400 mt-2 list-disc pl-5 space-y-0.5">{current.computed.calendar.notes.map((t, i) => <li key={i}>{t}</li>)}</ul>
          )}
        </div>
      ) : (
        <div className="card p-4 text-sm text-gray-400 flex items-center justify-between">No tax year on file. <button onClick={onAddYear} className="btn btn-primary text-xs">+ Add a tax year</button></div>
      )}

      {/* Years left unpaid */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold text-white">{fl ? 'Unpaid years & tax certificates' : 'Unpaid (defaulted) years'}</p>
          <button onClick={() => startDefault()} className="btn text-xs">+ Add unpaid year</button>
        </div>
        {defaults.length === 0 && !form && <p className="text-xs text-gray-500">None on file.</p>}
        <div className="space-y-3">
          {defaults.map(d => {
            const c = d.computed;
            const sale = c?.powerToSell;
            return (
              <div key={d.id} className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-white">{d.taxYear} <span className={`pill ${DEFAULT_STATUS[d.status].pill} ml-1`}>{DEFAULT_STATUS[d.status].label}</span></p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {[d.defaultNumber && `Default ${d.defaultNumber}`, (d.defaultDate || c?.timeline?.defaultDate) && `defaulted ${fmtDate(d10(d.defaultDate) || c!.timeline!.defaultDate!)}`,
                        d.certificateNumber && `certificate ${d.certificateNumber}`, d.certificateHolder && `held by ${d.certificateHolder}`,
                        n(d.certificateRate) != null && `${Number(d.certificateRate)}%`].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="text-right">
                    {d.status === 'REDEEMED' ? <p className="text-sm text-emerald-400">Redeemed{d.redeemedOn ? ` ${fmtDate(d.redeemedOn)}` : ''}</p>
                    : d.status === 'PLAN' && d.payPlan?.balance != null ? (
                      <>
                        <p className="text-base font-semibold text-white">{fmtMoney(d.payPlan.balance)}</p>
                        <p className="text-xs text-gray-500">left on the plan</p>
                      </>
                    ) : (
                      <>
                        <p className="text-base font-semibold text-white">{c?.stated != null ? fmtMoney(c.stated) : c?.redemption ? fmtMoney(c.redemption.total) : n(d.amountToRedeem) != null ? fmtMoney(d.amountToRedeem) : '—'}</p>
                        <p className="text-xs text-gray-500">{c?.stated != null ? `to redeem${d.redeemGoodThrough ? ` through ${fmtDate(d.redeemGoodThrough)}` : ''}` : c?.redemption ? 'to redeem today (estimate)' : 'to redeem'}</p>
                      </>
                    )}
                    <button onClick={() => startDefault(d)} className="text-xs text-gray-400 hover:text-white mt-1">Edit</button>
                  </div>
                </div>
                {d.status === 'OPEN' && c?.redemption && c.stated == null && (
                  <p className="text-xs text-gray-500 mt-1">{c.redemption.parts.map(p => `${p.label} ${fmtMoney(p.amount)}`).join(' + ')}</p>
                )}
                {d.payPlan && (
                  <p className="text-xs text-amber-300 mt-1">Plan of redemption{d.payPlan.started ? ` since ${fmtDate(d.payPlan.started)}` : ''}: {d.payPlan.installment != null ? fmtMoney(d.payPlan.installment) : '—'}
                    {d.payPlan.nextDue ? ` due ${fmtDate(d.payPlan.nextDue)}` : ''}{d.payPlan.remaining != null ? ` · ${d.payPlan.remaining} left` : ''}{d.payPlan.balance != null ? ` · ${fmtMoney(d.payPlan.balance)} balance` : ''}</p>
                )}
                {d.status !== 'REDEEMED' && d.status !== 'SOLD' && sale && (
                  <p className={`text-xs mt-1 ${daysUntil(sale) < 365 ? 'text-red-400' : 'text-gray-400'}`}>
                    {fl || c?.timeline?.deedEligible ? 'Tax deed application possible' : 'County may sell (power to sell)'} {daysUntil(sale) < 0 ? 'since' : 'from'} {fmtDate(sale)} — {inWords(sale)}
                    {c?.commercial && !d.powerToSellDate && !fl ? ' (3-year rule for commercial property, where the county adopted it)' : ''}
                    {d.status === 'PLAN' ? ' — held off while the plan is kept current' : ''}
                  </p>
                )}
                {c?.timeline?.certificateExpires && d.status !== 'REDEEMED' && <p className="text-xs text-gray-500 mt-0.5">Certificate void after {fmtDate(c.timeline.certificateExpires)} without a deed application.</p>}
                {d.notes && <p className="text-xs text-gray-500 mt-1">{d.notes}</p>}
              </div>
            );
          })}
        </div>

        {form && (
          <div className="mt-4 space-y-3 border-t pt-4" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><span className={label}>Tax year</span><input className={input} value={form.taxYear} onChange={e => setF({ taxYear: e.target.value })} placeholder={fl ? '2024' : '2022-23'} /></div>
              <div><span className={label}>Status</span><select className={input} value={form.status} onChange={e => setF({ status: e.target.value as TaxDefaultStatus })}>{(Object.keys(DEFAULT_STATUS) as TaxDefaultStatus[]).map(k => <option key={k} value={k}>{DEFAULT_STATUS[k].label}</option>)}</select></div>
              <div><span className={label}>{fl ? 'Delinquent since' : 'Default date'}</span><input type="date" className={input} value={form.defaultDate} onChange={e => setF({ defaultDate: e.target.value })} /></div>
              <div><span className={label}>Default number</span><input className={input} value={form.defaultNumber} onChange={e => setF({ defaultNumber: e.target.value })} placeholder="DEF230000000" /></div>
              <div><span className={label}>Tax</span><input type="number" step="0.01" className={input} value={form.taxAmount} onChange={e => setF({ taxAmount: e.target.value })} /></div>
              <div><span className={label}>Penalties</span><input type="number" step="0.01" className={input} value={form.penalties} onChange={e => setF({ penalties: e.target.value })} /></div>
              <div><span className={label}>Costs</span><input type="number" step="0.01" className={input} value={form.costs} onChange={e => setF({ costs: e.target.value })} /></div>
              <div><span className={label}>County's redemption amount</span><input type="number" step="0.01" className={input} value={form.amountToRedeem} onChange={e => setF({ amountToRedeem: e.target.value })} /></div>
              <div><span className={label}>Good through</span><input type="date" className={input} value={form.redeemGoodThrough} onChange={e => setF({ redeemGoodThrough: e.target.value })} /></div>
              <div><span className={label}>{fl ? 'Tax deed date (if stated)' : 'Power to sell (if stated)'}</span><input type="date" className={input} value={form.powerToSellDate} onChange={e => setF({ powerToSellDate: e.target.value })} /></div>
              <div><span className={label}>Redeemed on</span><input type="date" className={input} value={form.redeemedOn} onChange={e => setF({ redeemedOn: e.target.value })} /></div>
              <div />
              <div className="col-span-2 md:col-span-4 text-xs text-gray-500 -mb-1">Plan of redemption (if any)</div>
              <div><span className={label}>Installment</span><input type="number" step="0.01" className={input} value={form.planInstallment} onChange={e => setF({ planInstallment: e.target.value })} /></div>
              <div><span className={label}>Next due</span><input type="date" className={input} value={form.planNextDue} onChange={e => setF({ planNextDue: e.target.value })} /></div>
              <div><span className={label}>Installments left</span><input type="number" className={input} value={form.planRemaining} onChange={e => setF({ planRemaining: e.target.value })} /></div>
              <div><span className={label}>Plan balance</span><input type="number" step="0.01" className={input} value={form.planBalance} onChange={e => setF({ planBalance: e.target.value })} /></div>
              <div className="col-span-2 md:col-span-4 text-xs text-gray-500 -mb-1">Tax certificate / lien (Florida, Arizona …)</div>
              <div><span className={label}>Certificate number</span><input className={input} value={form.certificateNumber} onChange={e => setF({ certificateNumber: e.target.value })} /></div>
              <div><span className={label}>Holder</span><input className={input} value={form.certificateHolder} onChange={e => setF({ certificateHolder: e.target.value })} /></div>
              <div><span className={label}>Rate %</span><input type="number" step="0.001" className={input} value={form.certificateRate} onChange={e => setF({ certificateRate: e.target.value })} /></div>
              <div><span className={label}>Issued</span><input type="date" className={input} value={form.certificateIssued} onChange={e => setF({ certificateIssued: e.target.value })} /></div>
              <div className="col-span-2"><span className={label}>County page</span><input className={input} value={form.sourceUrl} onChange={e => setF({ sourceUrl: e.target.value })} placeholder="https://" /></div>
              <div className="col-span-2"><span className={label}>Notes</span><input className={input} value={form.notes} onChange={e => setF({ notes: e.target.value })} /></div>
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              {form.id && <button onClick={() => void removeDefault()} className="text-xs text-red-400 hover:text-red-300 mr-auto">Delete</button>}
              <button onClick={() => setForm(null)} className="btn text-xs">Cancel</button>
              <button onClick={() => void saveDefault()} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        )}
      </div>

      {/* Every year on file */}
      {years.length > 1 && (
        <div className="card p-4">
          <p className="section-label">History</p>
          <div className="space-y-1">
            {years.map(t => (
              <button key={t.id} onClick={() => onEditYear(t)} className="w-full flex items-center gap-3 text-sm text-left hover:bg-white/[0.02] rounded px-1">
                <span className="w-24 text-gray-300">{t.taxYear}</span>
                <span className="flex-1 text-xs text-gray-500">{t.assessedValue != null ? `net ${fmtMoney(t.assessedValue)}` : ''}</span>
                <span className="text-white">{fmtMoney(t.annualTaxAmount)}</span>
                <span className={`pill ${t.status === 'PAID' ? 'pill-green' : t.status === 'DELINQUENT' ? 'pill-red' : t.status === 'PARTIALLY_PAID' ? 'pill-amber' : 'pill-gray'}`}>{t.escrowLoanId ? 'Escrow' : t.status === 'PARTIALLY_PAID' ? 'Part paid' : t.status.charAt(0) + t.status.slice(1).toLowerCase()}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
