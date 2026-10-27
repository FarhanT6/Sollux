import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getInsuranceReview, getInsuranceClaims, saveInsuranceClaim, updateInsuranceClaim, deleteInsuranceClaim, getProperties,
  type InsuranceReview, type InsuranceClaim, type InsPropertyReview,
} from '../api/client';
import type { Property } from '../types';
import { PageHeader } from '../components/ui';
import { fmtDate } from '../lib/date';
import { fmtMoney } from '../lib/money';
import { describeApiError } from '../lib/apiError';

/**
 * Insurance across the portfolio: what each property is covered for and
 * what it costs a year, where cover is missing or thin (no property policy,
 * a rental with no liability, a dwelling limit under 80% of the building's
 * value, no mortgagee, actual-cash-value cover), renewals coming up with
 * their premium change, and the claims log.
 */

const SEV: Record<string, string> = { ALERT: 'text-red-400', WARNING: 'text-amber-400', INFO: 'text-gray-400' };
const TYPE_LABEL: Record<string, string> = {
  PROPERTY: 'Property', LIABILITY: 'Liability', FLOOD: 'Flood', UMBRELLA: 'Umbrella', BUSINESS: 'Business', RENTERS: 'Renters', AUTO: 'Auto', OTHER: 'Other',
};
const CAUSES = ['WATER', 'FIRE', 'WIND', 'HAIL', 'FLOOD', 'THEFT', 'VANDALISM', 'LIABILITY', 'OTHER'] as const;
const STATUSES: Record<string, { label: string; pill: string }> = {
  OPEN: { label: 'Open', pill: 'pill-amber' }, IN_REVIEW: { label: 'In review', pill: 'pill-amber' }, APPROVED: { label: 'Approved', pill: 'pill-blue' },
  PAID: { label: 'Paid', pill: 'pill-green' }, DENIED: { label: 'Denied', pill: 'pill-red' }, CLOSED: { label: 'Closed', pill: 'pill-gray' },
};
const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const s = (v: unknown) => (v == null ? '' : String(v));
const d10 = (v?: string | null) => (v ? String(v).slice(0, 10) : '');
const n = (v: string) => (v === '' ? null : Number(v));
const input = 'input-dark text-sm w-full';
const label = 'text-xs text-gray-500 block mb-1';

type ClaimForm = {
  id?: string; propertyId: string; policyId: string; claimNumber: string; dateOfLoss: string; reportedOn: string; cause: string; description: string; status: string;
  amountClaimed: string; amountPaid: string; deductibleApplied: string; adjusterName: string; adjusterPhone: string; adjusterEmail: string; nextStep: string; nextStepDate: string; notes: string;
};
const EMPTY: ClaimForm = {
  propertyId: '', policyId: '', claimNumber: '', dateOfLoss: '', reportedOn: '', cause: 'WATER', description: '', status: 'OPEN', amountClaimed: '', amountPaid: '',
  deductibleApplied: '', adjusterName: '', adjusterPhone: '', adjusterEmail: '', nextStep: '', nextStepDate: '', notes: '',
};

export default function InsurancePage() {
  const [review, setReview] = useState<InsuranceReview | null>(null);
  const [claims, setClaims] = useState<InsuranceClaim[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [form, setForm] = useState<ClaimForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [loadError, setLoadError] = useState<string | null>(null);
  async function load() {
    try {
      const [r, c, p] = await Promise.all([getInsuranceReview(), getInsuranceClaims().catch(() => []), getProperties()]);
      setReview(r); setClaims(c); setProperties(p); setLoadError(null);
    } catch (e) { setLoadError(describeApiError(e, 'Could not load insurance.')); }
  }
  useEffect(() => { void load(); }, []);

  const policiesOf = (propertyId: string) => review?.properties.find(p => p.propertyId === propertyId)?.policies ?? [];
  const setF = (p: Partial<ClaimForm>) => setForm(f => (f ? { ...f, ...p } : f));
  function edit(c?: InsuranceClaim) {
    setError(null);
    if (!c) { setForm({ ...EMPTY, propertyId: properties[0]?.id ?? '' }); return; }
    setForm({
      id: c.id, propertyId: c.propertyId, policyId: s(c.policyId), claimNumber: s(c.claimNumber), dateOfLoss: d10(c.dateOfLoss), reportedOn: d10(c.reportedOn), cause: c.cause,
      description: s(c.description), status: c.status, amountClaimed: s(c.amountClaimed), amountPaid: s(c.amountPaid), deductibleApplied: s(c.deductibleApplied),
      adjusterName: s(c.adjusterName), adjusterPhone: s(c.adjusterPhone), adjusterEmail: s(c.adjusterEmail), nextStep: s(c.nextStep), nextStepDate: d10(c.nextStepDate), notes: s(c.notes),
    });
  }
  async function save() {
    if (!form) return;
    if (!form.propertyId) { setError('Which property?'); return; }
    setSaving(true); setError(null);
    const body = {
      propertyId: form.propertyId, policyId: form.policyId || null, claimNumber: form.claimNumber || null, dateOfLoss: form.dateOfLoss || null, reportedOn: form.reportedOn || null,
      cause: form.cause, description: form.description || null, status: form.status, amountClaimed: n(form.amountClaimed), amountPaid: n(form.amountPaid),
      deductibleApplied: n(form.deductibleApplied), adjusterName: form.adjusterName || null, adjusterPhone: form.adjusterPhone || null, adjusterEmail: form.adjusterEmail || null,
      nextStep: form.nextStep || null, nextStepDate: form.nextStepDate || null, notes: form.notes || null,
    };
    try {
      if (form.id) await updateInsuranceClaim(form.id, body); else await saveInsuranceClaim(body);
      setForm(null); await load();
    } catch (e) { setError(describeApiError(e, 'Could not save the claim.')); }
    finally { setSaving(false); }
  }
  async function remove() {
    if (form?.id && confirm('Delete this claim?')) { await deleteInsuranceClaim(form.id); setForm(null); await load(); }
  }

  const t = review?.totals;
  return (
    <div>
      <PageHeader title="Insurance" subtitle="Coverage, gaps, renewals and claims across your properties" />
      <div className="px-4 md:px-8 pb-10 space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="stat-card"><p className="text-xs text-gray-500">Premiums a year</p><p className="text-lg font-semibold text-white">{fmtMoney(t?.annualPremium ?? 0)}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Policies in force</p><p className="text-lg font-semibold text-white">{t?.policies ?? 0}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Gaps to look at</p><p className={`text-lg font-semibold ${(t?.alerts ?? 0) ? 'text-red-400' : (t?.warnings ?? 0) ? 'text-amber-400' : 'text-white'}`}>{(t?.alerts ?? 0) + (t?.warnings ?? 0)}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Renewing in 60 days</p><p className="text-lg font-semibold text-white">{t?.renewalsSoon ?? 0}</p></div>
        </div>

        {review && review.renewals.length > 0 && (
          <div className="card p-4">
            <p className="section-label">Renewals</p>
            <div className="space-y-1.5">
              {review.renewals.map(r => (
                <div key={r.policyId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
                  <span className={`w-28 text-xs ${r.days < 0 ? 'text-red-400' : r.days <= 30 ? 'text-amber-400' : 'text-gray-300'}`}>{fmtDate(r.expirationDate)}</span>
                  <span className="flex-1 min-w-[12rem] text-gray-300">{r.name} <span className="text-gray-500">· {r.carrier} · {TYPE_LABEL[r.policyType] ?? cap(r.policyType)}</span></span>
                  <span className="text-xs text-gray-500">{r.days < 0 ? `expired ${-r.days} days ago` : `in ${r.days} days`}</span>
                  <span className="text-white w-28 text-right">{r.annualPremium != null ? `${fmtMoney(r.annualPremium)}/yr` : '—'}</span>
                  {r.premiumChange != null && <span className={`text-xs w-24 text-right ${r.premiumChange > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{r.premiumChange > 0 ? '+' : ''}{fmtMoney(r.premiumChange)}</span>}
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-600 mt-2">Import the renewal offer or declarations page when it arrives (Import, or the policy's billing account) so the new term is on file.</p>
          </div>
        )}

        {loadError ? <p className="text-sm text-red-400">{loadError}</p> : !review ? <p className="text-sm text-gray-500">Loading…</p> : review.properties.map(p => <PropertyCard key={p.propertyId} p={p} />)}

        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-white">Claims</p>
            <button onClick={() => edit()} className="btn text-xs">+ Log a claim</button>
          </div>
          {claims.length === 0 && !form && <p className="text-xs text-gray-500">No claims on file. A claim logged here keeps its status, payments, adjuster and next step, and is reminded on its next-step date.</p>}
          <div className="space-y-2">
            {claims.map(c => {
              const paid = Number(c.amountPaid ?? 0), claimed = Number(c.amountClaimed ?? 0);
              return (
                <button key={c.id} onClick={() => edit(c)} className="w-full text-left rounded-lg p-3 hover:bg-white/[0.03]" style={{ background: 'rgba(255,255,255,0.02)' }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-white">{c.property?.nickname || c.property?.address}</span>
                    <span className="text-xs text-gray-500">{cap(c.cause)}{c.dateOfLoss ? ` · loss ${fmtDate(c.dateOfLoss)}` : ''}{c.claimNumber ? ` · #${c.claimNumber}` : ''}</span>
                    <span className={`pill ${STATUSES[c.status]?.pill ?? 'pill-gray'} ml-auto`}>{STATUSES[c.status]?.label ?? c.status}</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    {claimed ? `Claimed ${fmtMoney(claimed)}` : ''}{paid ? ` · paid ${fmtMoney(paid)}` : ''}{c.deductibleApplied != null ? ` · deductible ${fmtMoney(c.deductibleApplied)}` : ''}
                    {c.adjusterName ? ` · adjuster ${c.adjusterName}${c.adjusterPhone ? ` ${c.adjusterPhone}` : ''}` : ''}
                  </p>
                  {c.nextStep && <p className="text-xs text-amber-300 mt-0.5">Next: {c.nextStep}{c.nextStepDate ? ` by ${fmtDate(c.nextStepDate)}` : ''}</p>}
                </button>
              );
            })}
          </div>

          {form && (
            <div className="mt-4 space-y-3 border-t pt-4" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="col-span-2">
                  <span className={label}>Property</span>
                  <select className={input} value={form.propertyId} onChange={e => setF({ propertyId: e.target.value, policyId: '' })}>
                    <option value="">— Pick —</option>
                    {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <span className={label}>Policy</span>
                  <select className={input} value={form.policyId} onChange={e => setF({ policyId: e.target.value })}>
                    <option value="">—</option>
                    {policiesOf(form.propertyId).map(p => <option key={p.id} value={p.id}>{p.carrier} {p.policyNumber ?? ''} ({TYPE_LABEL[p.policyType] ?? p.policyType})</option>)}
                  </select>
                </div>
                <div><span className={label}>Claim number</span><input className={input} value={form.claimNumber} onChange={e => setF({ claimNumber: e.target.value })} /></div>
                <div><span className={label}>Cause</span><select className={input} value={form.cause} onChange={e => setF({ cause: e.target.value })}>{CAUSES.map(c => <option key={c} value={c}>{cap(c)}</option>)}</select></div>
                <div><span className={label}>Date of loss</span><input type="date" className={input} value={form.dateOfLoss} onChange={e => setF({ dateOfLoss: e.target.value })} /></div>
                <div><span className={label}>Reported on</span><input type="date" className={input} value={form.reportedOn} onChange={e => setF({ reportedOn: e.target.value })} /></div>
                <div className="col-span-2 md:col-span-4"><span className={label}>What happened</span><input className={input} value={form.description} onChange={e => setF({ description: e.target.value })} placeholder="Water heater leak in unit B" /></div>
                <div><span className={label}>Status</span><select className={input} value={form.status} onChange={e => setF({ status: e.target.value })}>{Object.entries(STATUSES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
                <div><span className={label}>Amount claimed</span><input type="number" step="0.01" className={input} value={form.amountClaimed} onChange={e => setF({ amountClaimed: e.target.value })} /></div>
                <div><span className={label}>Paid so far</span><input type="number" step="0.01" className={input} value={form.amountPaid} onChange={e => setF({ amountPaid: e.target.value })} /></div>
                <div><span className={label}>Deductible applied</span><input type="number" step="0.01" className={input} value={form.deductibleApplied} onChange={e => setF({ deductibleApplied: e.target.value })} /></div>
                <div><span className={label}>Adjuster</span><input className={input} value={form.adjusterName} onChange={e => setF({ adjusterName: e.target.value })} /></div>
                <div><span className={label}>Adjuster phone</span><input className={input} value={form.adjusterPhone} onChange={e => setF({ adjusterPhone: e.target.value })} /></div>
                <div className="col-span-2"><span className={label}>Adjuster email</span><input className={input} value={form.adjusterEmail} onChange={e => setF({ adjusterEmail: e.target.value })} /></div>
                <div className="col-span-2 md:col-span-3"><span className={label}>Next step</span><input className={input} value={form.nextStep} onChange={e => setF({ nextStep: e.target.value })} placeholder="Send the plumber's invoice to the adjuster" /></div>
                <div><span className={label}>By</span><input type="date" className={input} value={form.nextStepDate} onChange={e => setF({ nextStepDate: e.target.value })} /></div>
                <div className="col-span-2 md:col-span-4"><span className={label}>Notes</span><input className={input} value={form.notes} onChange={e => setF({ notes: e.target.value })} /></div>
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                {form.id && <button onClick={() => void remove()} className="text-xs text-red-400 hover:text-red-300 mr-auto">Delete</button>}
                <button onClick={() => setForm(null)} className="btn text-xs">Cancel</button>
                <button onClick={() => void save()} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PropertyCard({ p }: { p: InsPropertyReview }) {
  const chips: [string, boolean][] = [['Property', p.coverage.property], ['Liability', p.coverage.liability], ['Flood', p.coverage.flood], ['Umbrella', p.coverage.umbrella]];
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Link to={`/portfolio/${p.propertyId}`} className="text-sm font-semibold text-white hover:text-amber-300">{p.name}</Link>
        <span className="text-xs text-gray-500">{p.state ?? ''}</span>
        <span className="ml-auto text-sm text-white">{fmtMoney(p.annualPremium)}<span className="text-xs text-gray-500">/yr</span></span>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {chips.map(([k, on]) => <span key={k} className={`pill ${on ? 'pill-green' : 'pill-gray'}`}>{on ? '✓' : '—'} {k}</span>)}
        {p.openClaims > 0 && <span className="pill pill-amber">{p.openClaims} open claim{p.openClaims === 1 ? '' : 's'}</span>}
      </div>
      {p.coverageRatio != null && (
        <div className="mb-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Dwelling cover {fmtMoney(p.dwellingLimit)} vs {fmtMoney(p.replacementProxy)} ({p.replacementSource})</span>
            <span className={p.coverageRatio < 0.8 ? 'text-amber-400' : 'text-emerald-400'}>{Math.round(p.coverageRatio * 100)}%</span>
          </div>
          <div className="h-1.5 rounded" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <div className="h-1.5 rounded" style={{ width: `${Math.min(p.coverageRatio, 1.25) / 1.25 * 100}%`, background: p.coverageRatio < 0.8 ? '#F5A623' : '#34c759' }} />
          </div>
        </div>
      )}
      {p.policies.length > 0 && (
        <div className="space-y-1 mb-2">
          {p.policies.map(l => (
            <div key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
              <span className="w-24 text-xs text-gray-500">{TYPE_LABEL[l.policyType] ?? cap(l.policyType)}</span>
              <span className="flex-1 min-w-[10rem] text-gray-300">{l.carrier}{l.policyNumber ? <span className="text-gray-500"> · {l.policyNumber}</span> : null}</span>
              <span className="text-xs text-gray-500">
                {[l.dwellingLimit != null && `dwelling ${fmtMoney(l.dwellingLimit)}`, l.liabilityLimit != null && `liability ${fmtMoney(l.liabilityLimit)}`, l.deductible != null && `deductible ${fmtMoney(l.deductible)}`,
                  l.windHailDollars != null && `wind ${fmtMoney(l.windHailDollars)}`, l.expirationDate && `to ${fmtDate(l.expirationDate)}`].filter(Boolean).join(' · ')}
              </span>
              <span className="text-white w-24 text-right">{l.annualPremium != null ? fmtMoney(l.annualPremium) : '—'}</span>
            </div>
          ))}
        </div>
      )}
      {p.flags.length > 0 && (
        <ul className="space-y-1 mt-2">
          {p.flags.map((f, i) => <li key={i} className={`text-xs ${SEV[f.severity]}`}>{f.severity === 'INFO' ? '•' : '!'} {f.text}</li>)}
        </ul>
      )}
      {p.premiumPerThousand != null && p.annualPremium > 0 && <p className="text-xs text-gray-600 mt-2">{fmtMoney(p.premiumPerThousand)} a year per $1,000 of value.</p>}
    </div>
  );
}
