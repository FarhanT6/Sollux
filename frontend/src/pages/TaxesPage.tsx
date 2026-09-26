import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import IncomeTaxTab from '../components/taxes/IncomeTaxTab';
import ContractorsTab from '../components/taxes/ContractorsTab';
import {
  getTaxAssessments, readTaxBill, saveTaxAssessment, updateTaxAssessment, deleteTaxAssessment, taxBillUrl, getProperties, getLoans, type FilePayload,
} from '../api/client';
import type { Property, TaxAssessment, TaxStatus } from '../types';
import { PageHeader, EmptyState } from '../components/ui';
import { fmtDate, todayISO } from '../lib/date';
import { fmtMoney } from '../lib/money';
import { filesToPayload } from '../lib/files';
import { describeApiError } from '../lib/apiError';

/**
 * Property taxes for every property: which years are on file and which are
 * missing, what is due next, and each year's bill. Upload a tax bill (PDF or
 * photos) and Sollux reads the parcel, year, installments and due dates and
 * matches the property; a second bill for the same year updates it.
 */

type Form = {
  id?: string; propertyId: string; taxYear: string; apn: string; taxingAuthority: string; assessedValue: string; annualTaxAmount: string;
  installment1Amount: string; installment1Due: string; installment1Paid: string; installment2Amount: string; installment2Due: string; installment2Paid: string;
  status: TaxStatus; escrowLoanId: string; notes: string;
};
const EMPTY: Form = { propertyId: '', taxYear: '', apn: '', taxingAuthority: '', assessedValue: '', annualTaxAmount: '', installment1Amount: '', installment1Due: '', installment1Paid: '',
  installment2Amount: '', installment2Due: '', installment2Paid: '', status: 'UNPAID', escrowLoanId: '', notes: '' };

const STATUS: Record<TaxStatus, { label: string; pill: string }> = {
  PAID: { label: 'Paid', pill: 'pill-green' }, PARTIALLY_PAID: { label: 'Part paid', pill: 'pill-amber' },
  UNPAID: { label: 'Unpaid', pill: 'pill-gray' }, DELINQUENT: { label: 'Delinquent', pill: 'pill-red' },
};
const d10 = (v?: string | null) => (v ? String(v).slice(0, 10) : '');
const s = (v: unknown) => (v == null ? '' : String(v));
const numOrNull = (v: string) => (v === '' ? null : Number(v));
const input = 'input-dark text-sm w-full';
const label = 'text-xs text-gray-500 block mb-1';

/** "2026-2027", "2026-27" and "2026" sort together by their first year. */
const yearKey = (y: string) => Number((y.match(/\d{4}/) ?? ['0'])[0]);

const TABS = [
  { key: 'property', label: 'Property tax' },
  { key: 'income', label: 'Income tax — federal & state' },
  { key: 'w9', label: 'W-9s & 1099s' },
] as const;
type TabKey = typeof TABS[number]['key'];

export default function TaxesPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabKey) || 'property';
  return (
    <div>
      <PageHeader title="Taxes" subtitle="Property tax, federal and state income tax, and the W-9s and 1099s behind them" />
      <div className="px-6 pt-4 flex gap-1 flex-wrap">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setParams({ tab: t.key })}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium ${tab === t.key ? 'bg-gold-500 text-white' : 'text-gray-400 hover:text-gray-200'}`}
            style={tab === t.key ? undefined : { background: 'rgba(255,255,255,0.05)' }}>{t.label}</button>
        ))}
      </div>
      {tab === 'property' && <PropertyTaxTab />}
      {tab === 'income' && <div className="px-6 py-5"><IncomeTaxTab /></div>}
      {tab === 'w9' && <div className="px-6 py-5"><ContractorsTab /></div>}
    </div>
  );
}

function PropertyTaxTab() {
  const [taxes, setTaxes] = useState<TaxAssessment[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loans, setLoans] = useState<{ id: string; lender: string; propertyId?: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [pages, setPages] = useState<FilePayload[]>([]);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [t, p, l] = await Promise.all([getTaxAssessments(), getProperties(), getLoans({ isActive: true }).catch(() => [])]);
      setTaxes(t); setProperties(p); setLoans(l as any);
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  // The three newest tax years on file are the grid's columns.
  const years = useMemo(() => [...new Set(taxes.map(t => t.taxYear))].sort((a, b) => yearKey(b) - yearKey(a) || b.localeCompare(a)).slice(0, 3), [taxes]);
  const byProp = useMemo(() => {
    const m = new Map<string, Map<string, TaxAssessment>>();
    for (const t of taxes) {
      if (!m.has(t.propertyId)) m.set(t.propertyId, new Map());
      m.get(t.propertyId)!.set(t.taxYear, t);
    }
    return m;
  }, [taxes]);

  const today = todayISO();
  const upcoming = useMemo(() => {
    const out: { t: TaxAssessment; n: 1 | 2; due: string; amount: number | null }[] = [];
    for (const t of taxes) {
      if (t.status === 'PAID' || t.escrowLoanId) continue;
      if (t.installment1Due && !t.installment1Paid) out.push({ t, n: 1, due: d10(t.installment1Due), amount: t.installment1Amount != null ? Number(t.installment1Amount) : null });
      if (t.installment2Due && !t.installment2Paid) out.push({ t, n: 2, due: d10(t.installment2Due), amount: t.installment2Amount != null ? Number(t.installment2Amount) : null });
    }
    return out.sort((a, b) => a.due.localeCompare(b.due));
  }, [taxes]);
  const overdue = upcoming.filter(u => u.due < today);
  const latestYear = years[0];
  const missingLatest = latestYear ? properties.filter(p => !byProp.get(p.id)?.has(latestYear)) : [];
  const annualTotal = latestYear ? taxes.filter(t => t.taxYear === latestYear).reduce((sum, t) => sum + Number(t.annualTaxAmount ?? 0), 0) : 0;

  function startNew(propertyId = '', taxYear = '') {
    setForm({ ...EMPTY, propertyId, taxYear }); setPages([]); setNote(null); setError(null);
  }
  function startEdit(t: TaxAssessment) {
    setForm({
      id: t.id, propertyId: t.propertyId, taxYear: t.taxYear, apn: s(t.apn), taxingAuthority: s(t.taxingAuthority), assessedValue: s(t.assessedValue),
      annualTaxAmount: s(t.annualTaxAmount), installment1Amount: s(t.installment1Amount), installment1Due: d10(t.installment1Due), installment1Paid: d10(t.installment1Paid),
      installment2Amount: s(t.installment2Amount), installment2Due: d10(t.installment2Due), installment2Paid: d10(t.installment2Paid),
      status: t.status, escrowLoanId: s(t.escrowLoanId), notes: s(t.notes),
    });
    setPages([]); setNote(null); setError(null);
  }
  const setF = (p: Partial<Form>) => setForm(f => (f ? { ...f, ...p } : f));

  async function autofill() {
    if (!form || !pages.length) return;
    setReading(true); setError(null); setNote(null);
    try {
      const { fields: f, match } = await readTaxBill(pages);
      setForm(prev => prev && ({
        ...prev,
        propertyId: prev.propertyId || (match?.propertyId ?? ''), taxYear: f.taxYear ?? prev.taxYear, apn: f.apn ?? '', taxingAuthority: f.taxingAuthority ?? '',
        assessedValue: s(f.assessedValue), annualTaxAmount: s(f.annualTaxAmount), installment1Amount: s(f.installment1Amount), installment1Due: f.installment1Due ?? '',
        installment1Paid: f.installment1Paid ?? '', installment2Amount: s(f.installment2Amount), installment2Due: f.installment2Due ?? '', installment2Paid: f.installment2Paid ?? '',
        status: f.status ?? 'UNPAID', notes: f.notes ?? prev.notes,
      }));
      setNote(match?.propertyId
        ? `Matched ${match.propertyName}${f.propertyAddress ? ` from ${f.propertyAddress}` : ''}. Check the figures, then save.`
        : `${f.propertyAddress ? `No property matched "${f.propertyAddress}" — pick it below. ` : ''}Check the figures, then save.`);
    } catch (e) { setError(describeApiError(e, 'Could not read the tax bill.')); }
    finally { setReading(false); }
  }

  async function save() {
    if (!form) return;
    if (!form.propertyId || !form.taxYear.trim() || !(Number(form.annualTaxAmount) > 0)) { setError('Property, tax year and the annual tax are needed.'); return; }
    setSaving(true); setError(null);
    const body: Record<string, any> = {
      propertyId: form.propertyId, taxYear: form.taxYear.trim(), apn: form.apn || null, taxingAuthority: form.taxingAuthority || null,
      assessedValue: numOrNull(form.assessedValue), annualTaxAmount: Number(form.annualTaxAmount),
      installment1Amount: numOrNull(form.installment1Amount), installment1Due: form.installment1Due || null, installment1Paid: form.installment1Paid || null,
      installment2Amount: numOrNull(form.installment2Amount), installment2Due: form.installment2Due || null, installment2Paid: form.installment2Paid || null,
      status: form.status, escrowLoanId: form.escrowLoanId || null, notes: form.notes || null,
      ...(pages.length ? { file: pages[0] } : {}),
    };
    try {
      if (form.id) await updateTaxAssessment(form.id, body as any); else await saveTaxAssessment(body);
      setForm(null); setPages([]); await load();
    } catch (e) { setError(describeApiError(e, 'Could not save.')); }
    finally { setSaving(false); }
  }

  async function markPaid(t: TaxAssessment, n: 1 | 2) {
    const other = n === 1 ? t.installment2Paid || !t.installment2Due : t.installment1Paid;
    await updateTaxAssessment(t.id, { [`installment${n}Paid`]: today, status: other ? 'PAID' : 'PARTIALLY_PAID' } as any);
    await load();
  }
  async function openBill(t: TaxAssessment) {
    const w = window.open('', '_blank');
    const url = await taxBillUrl(t.id);
    if (w) w.location.href = url; else window.location.href = url;
  }

  const propName = (id: string) => { const p = properties.find(x => x.id === id); return p ? (p.nickname || p.address) : '—'; };

  return (
    <div>
      <div className="px-6 py-5">
        <div className="flex justify-end mb-3"><button onClick={() => startNew()} className="btn btn-primary text-xs">+ Add or upload a tax bill</button></div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <div className="stat-card"><p className="text-xs text-gray-500">{latestYear ? `${latestYear} total` : 'Annual total'}</p><p className="text-lg font-semibold text-white">{fmtMoney(annualTotal)}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Installments still to pay</p><p className="text-lg font-semibold text-white">{upcoming.length}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Past due</p><p className={`text-lg font-semibold ${overdue.length ? 'text-red-400' : 'text-white'}`}>{overdue.length}</p></div>
          <div className="stat-card"><p className="text-xs text-gray-500">Missing {latestYear ?? 'bills'}</p><p className={`text-lg font-semibold ${missingLatest.length ? 'text-amber-400' : 'text-white'}`}>{latestYear ? `${missingLatest.length} of ${properties.length}` : properties.length}</p></div>
        </div>

        {form && (
          <div className="card p-4 mb-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-white">{form.id ? 'Edit tax record' : 'New tax record'}</p>
              <button onClick={() => setForm(null)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)' }}>
              <p className="text-xs text-gray-400 mb-2">Add the tax bill — a PDF from the county site, or photos of the paper bill — and let Sollux fill the record in.</p>
              <div className="flex items-center gap-2 flex-wrap">
                <label className="btn text-xs cursor-pointer">Add bill
                  <input type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={async e => { const f = await filesToPayload(e.target.files); setPages(p => [...p, ...f]); e.target.value = ''; }} />
                </label>
                {pages.map((p, i) => <span key={i} className="text-xs text-gray-400 px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.05)' }}>{p.name} <button onClick={() => setPages(ps => ps.filter((_, j) => j !== i))} className="text-gray-600 hover:text-red-400 ml-1">✕</button></span>)}
                {pages.length > 0 && <button onClick={autofill} disabled={reading} className="btn btn-primary text-xs disabled:opacity-50">{reading ? 'Reading…' : 'Fill in from bill'}</button>}
              </div>
              {note && <p className="text-xs text-emerald-400 mt-2">{note}</p>}
              {pages.length > 1 && <p className="text-xs text-gray-600 mt-1">All pages are read; the first file is kept as the bill on file.</p>}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="col-span-2">
                <span className={label}>Property</span>
                <select className={input} value={form.propertyId} onChange={e => setF({ propertyId: e.target.value })}>
                  <option value="">— Pick —</option>
                  {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}{p.city ? `, ${p.city}` : ''}{p.state ? ` ${p.state}` : ''}</option>)}
                </select>
              </div>
              <div><span className={label}>Tax year</span><input className={input} value={form.taxYear} onChange={e => setF({ taxYear: e.target.value })} placeholder="2026-2027" /></div>
              <div><span className={label}>APN / parcel</span><input className={input} value={form.apn} onChange={e => setF({ apn: e.target.value })} /></div>
              <div className="col-span-2"><span className={label}>Taxing authority</span><input className={input} value={form.taxingAuthority} onChange={e => setF({ taxingAuthority: e.target.value })} placeholder="San Diego County Treasurer-Tax Collector" /></div>
              <div><span className={label}>Assessed value</span><input type="number" step="0.01" className={input} value={form.assessedValue} onChange={e => setF({ assessedValue: e.target.value })} /></div>
              <div><span className={label}>Annual tax</span><input type="number" step="0.01" className={input} value={form.annualTaxAmount} onChange={e => setF({ annualTaxAmount: e.target.value })} /></div>
              <div><span className={label}>1st installment</span><input type="number" step="0.01" className={input} value={form.installment1Amount} onChange={e => setF({ installment1Amount: e.target.value })} /></div>
              <div><span className={label}>Due</span><input type="date" className={input} value={form.installment1Due} onChange={e => setF({ installment1Due: e.target.value })} /></div>
              <div><span className={label}>Paid on</span><input type="date" className={input} value={form.installment1Paid} onChange={e => setF({ installment1Paid: e.target.value })} /></div>
              <div />
              <div><span className={label}>2nd installment</span><input type="number" step="0.01" className={input} value={form.installment2Amount} onChange={e => setF({ installment2Amount: e.target.value })} /></div>
              <div><span className={label}>Due</span><input type="date" className={input} value={form.installment2Due} onChange={e => setF({ installment2Due: e.target.value })} /></div>
              <div><span className={label}>Paid on</span><input type="date" className={input} value={form.installment2Paid} onChange={e => setF({ installment2Paid: e.target.value })} /></div>
              <div><span className={label}>Status</span><select className={input} value={form.status} onChange={e => setF({ status: e.target.value as TaxStatus })}>{(Object.keys(STATUS) as TaxStatus[]).map(k => <option key={k} value={k}>{STATUS[k].label}</option>)}</select></div>
              <div className="col-span-2">
                <span className={label}>Paid by lender escrow?</span>
                <select className={input} value={form.escrowLoanId} onChange={e => setF({ escrowLoanId: e.target.value })}>
                  <option value="">No — I pay it</option>
                  {loans.filter(l => !form.propertyId || !l.propertyId || l.propertyId === form.propertyId).map(l => <option key={l.id} value={l.id}>Yes — {l.lender}</option>)}
                </select>
              </div>
              <div className="col-span-2"><span className={label}>Notes</span><input className={input} value={form.notes} onChange={e => setF({ notes: e.target.value })} /></div>
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              {form.id && <button onClick={async () => { if (confirm('Delete this tax record?')) { await deleteTaxAssessment(form.id!); setForm(null); await load(); } }} className="text-xs text-red-400 hover:text-red-300 mr-auto">Delete</button>}
              <button onClick={() => setForm(null)} className="btn text-xs">Cancel</button>
              <button onClick={save} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        )}

        {upcoming.length > 0 && (
          <div className="card p-4 mb-5">
            <p className="section-label">Due next</p>
            <div className="space-y-1.5">
              {upcoming.slice(0, 8).map((u, i) => (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className={`w-28 text-xs ${u.due < today ? 'text-red-400' : 'text-gray-300'}`}>{fmtDate(u.due, 'MMM d, yyyy')}</span>
                  <span className="flex-1 text-gray-300">{propName(u.t.propertyId)} <span className="text-gray-500">· {u.t.taxYear} · {u.n === 1 ? '1st' : '2nd'} installment</span></span>
                  <span className="text-white w-28 text-right">{u.amount != null ? fmtMoney(u.amount) : '—'}</span>
                  <button onClick={() => markPaid(u.t, u.n)} className="text-xs text-emerald-400 hover:text-emerald-300 w-20 text-right">✓ Paid</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {loading ? <p className="text-sm text-gray-500">Loading…</p>
          : properties.length === 0 ? <EmptyState icon="🏛️" title="No properties" body="Add properties first." />
          : (
            <div className="card overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th className="pl-4">Property</th>
                    {years.length === 0 && <th>Tax year</th>}
                    {years.map(y => <th key={y} className="text-right">{y}</th>)}
                    <th className="pr-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {properties.map(p => (
                    <tr key={p.id}>
                      <td className="pl-4">
                        <Link to={`/portfolio/${p.id}`} className="text-gray-200 hover:text-white">{p.nickname || p.address}</Link>
                        <span className="block text-xs text-gray-600">{[p.city, p.state].filter(Boolean).join(', ')}</span>
                      </td>
                      {years.length === 0 && <td className="text-xs text-gray-600">Nothing on file</td>}
                      {years.map(y => {
                        const t = byProp.get(p.id)?.get(y);
                        if (!t) return <td key={y} className="text-right"><button onClick={() => startNew(p.id, y)} className="text-xs text-amber-400/80 hover:text-amber-300">+ Add</button></td>;
                        return (
                          <td key={y} className="text-right">
                            <button onClick={() => startEdit(t)} className="text-right">
                              <span className="block text-white">{fmtMoney(t.annualTaxAmount)}</span>
                              <span className={`pill ${t.escrowLoanId ? 'pill-blue' : STATUS[t.status].pill}`}>{t.escrowLoanId ? 'Escrow' : STATUS[t.status].label}</span>
                            </button>
                            {t.hasDocument && <button onClick={() => openBill(t)} className="block ml-auto text-xs text-amber-400 hover:text-amber-300 mt-0.5">📄 Bill</button>}
                          </td>
                        );
                      })}
                      <td className="pr-4 text-right"><button onClick={() => startNew(p.id)} className="text-xs text-gray-500 hover:text-gray-300">+ Year</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  );
}
