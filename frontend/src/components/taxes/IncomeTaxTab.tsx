import { useEffect, useMemo, useState } from 'react';
import {
  getTaxDocs, getTaxChecklist, readTaxForm, createTaxDoc, updateTaxDoc, deleteTaxDoc, taxDocUrl,
  createTaxPayment, deleteTaxPayment, getProperties, getLoans,
  type TaxDoc, type TaxPay, type TaxChecklist, type FilePayload,
} from '../../api/client';
import type { Property } from '../../types';
import { fmtDate, todayISO } from '../../lib/date';
import { fmtMoney } from '../../lib/money';
import { filesToPayload } from '../../lib/files';
import { describeApiError } from '../../lib/apiError';

/**
 * Federal and state income tax for one year: what the year should have
 * (a return per jurisdiction, a 1098 per mortgage, estimated payments on
 * their dates), and every form on file. Upload a form — PDF or photos — and
 * Sollux reads it; only the last four digits of any taxpayer ID are kept.
 */

export const FORM_TYPES = ['1040', '540', '540NR', 'IT-140', 'W-2', '1098', '1098-E', '1099-NEC', '1099-MISC', '1099-INT', '1099-DIV', '1099-K', '1099-R', 'K-1', 'W-9', '1040-ES', 'NOTICE', 'OTHER'];
const DIRECTION_LABEL: Record<string, string> = { RECEIVED: 'Received', FILED: 'Filed', ISSUED: 'Issued by you' };
const JUR_LABEL = (j: string) => (j === 'FEDERAL' ? 'Federal' : j);

export type DocForm = {
  id?: string; taxYear: string; jurisdiction: string; formType: string; direction: string; status: string; issuerName: string; recipientName: string;
  businessName: string; entityType: string; tinLast4: string; address: string; propertyId: string; loanId: string; amount: string; federalWithheld: string;
  stateWithheld: string; refundOrDue: string; filedDate: string; dueDate: string; notes: string; boxes: Record<string, number | string>;
};
export const emptyDoc = (year: number, patch: Partial<DocForm> = {}): DocForm => ({
  taxYear: String(year), jurisdiction: 'FEDERAL', formType: '1098', direction: 'RECEIVED', status: 'RECEIVED', issuerName: '', recipientName: '', businessName: '',
  entityType: '', tinLast4: '', address: '', propertyId: '', loanId: '', amount: '', federalWithheld: '', stateWithheld: '', refundOrDue: '', filedDate: '', dueDate: '', notes: '', boxes: {},
  ...patch,
});
const s = (v: unknown) => (v == null ? '' : String(v));
const num = (v: string) => (v === '' ? null : Number(v));

export function docToForm(d: TaxDoc): DocForm {
  return {
    id: d.id, taxYear: String(d.taxYear), jurisdiction: d.jurisdiction, formType: d.formType, direction: d.direction, status: d.status,
    issuerName: s(d.issuerName), recipientName: s(d.recipientName), businessName: s(d.businessName), entityType: s(d.entityType), tinLast4: s(d.tinLast4),
    address: s(d.address), propertyId: s(d.propertyId), loanId: s(d.loanId), amount: s(d.amount), federalWithheld: s(d.federalWithheld), stateWithheld: s(d.stateWithheld),
    refundOrDue: s(d.refundOrDue), filedDate: s(d.filedDate).slice(0, 10), dueDate: s(d.dueDate).slice(0, 10), notes: s(d.notes), boxes: d.boxes ?? {},
  };
}

/** The form for one tax document, with upload-and-read. Shared by the income-tax and W-9 tabs. */
export function TaxDocEditor({ initial, properties, loans, onDone }: {
  initial: DocForm; properties: Property[]; loans: { id: string; lender: string; propertyId?: string | null }[]; onDone: (saved: boolean) => void;
}) {
  const [f, setF] = useState(initial);
  const [pages, setPages] = useState<FilePayload[]>([]);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<DocForm>) => setF(x => ({ ...x, ...p }));
  const isW9 = f.formType === 'W-9';
  const isReturn = f.direction === 'FILED';
  const input = 'input-dark text-sm w-full';
  const label = 'text-xs text-gray-500 block mb-1';

  async function autofill() {
    setReading(true); setErr(null); setNote(null);
    try {
      const { fields: r, match } = await readTaxForm(pages);
      setF(x => ({
        ...x, formType: r.formType ?? x.formType, taxYear: r.taxYear ? String(r.taxYear) : x.taxYear, jurisdiction: r.jurisdiction ?? x.jurisdiction,
        direction: r.direction ?? x.direction, status: r.direction === 'FILED' ? 'FILED' : 'RECEIVED', issuerName: s(r.issuerName), recipientName: s(r.recipientName),
        businessName: s(r.businessName), entityType: s(r.entityType), tinLast4: s(r.tinLast4), address: s(r.address), amount: s(r.amount),
        federalWithheld: s(r.federalWithheld), stateWithheld: s(r.stateWithheld), refundOrDue: s(r.refundOrDue), filedDate: s(r.filedDate), dueDate: s(r.dueDate),
        notes: s(r.notes), boxes: r.boxes ?? {}, loanId: s(r.loanId) || x.loanId, propertyId: x.propertyId || s(match?.propertyId),
      }));
      setNote(`Read ${pages.length} page${pages.length === 1 ? '' : 's'}${r.formType ? ` as ${r.formType}` : ''}. Only the last four digits of any tax ID are kept. Check it, then save.`);
    } catch (e) { setErr(describeApiError(e, 'Could not read the form.')); }
    finally { setReading(false); }
  }

  async function save() {
    if (!(Number(f.taxYear) > 1990) || !f.formType) { setErr('Year and form are needed.'); return; }
    setSaving(true); setErr(null);
    const body = {
      taxYear: Number(f.taxYear), jurisdiction: f.jurisdiction || 'FEDERAL', formType: f.formType, direction: f.direction, status: f.status,
      issuerName: f.issuerName || null, recipientName: f.recipientName || null, businessName: f.businessName || null, entityType: f.entityType || null,
      tinLast4: /^\d{4}$/.test(f.tinLast4) ? f.tinLast4 : null, address: f.address || null, propertyId: f.propertyId || null, loanId: f.loanId || null,
      amount: num(f.amount), federalWithheld: num(f.federalWithheld), stateWithheld: num(f.stateWithheld), refundOrDue: num(f.refundOrDue),
      filedDate: f.filedDate || null, dueDate: f.dueDate || null, notes: f.notes || null, boxes: Object.keys(f.boxes).length ? f.boxes : null,
      ...(pages.length ? { files: pages } : {}),
    };
    try {
      if (f.id) await updateTaxDoc(f.id, body); else await createTaxDoc(body);
      onDone(true);
    } catch (e) { setErr(describeApiError(e, 'Could not save.')); }
    finally { setSaving(false); }
  }

  return (
    <div className="card p-4 mb-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white">{f.id ? 'Edit' : 'New'} {isW9 ? 'W-9' : 'tax form'}</p>
        <button onClick={() => onDone(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
      </div>
      <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)' }}>
        <p className="text-xs text-gray-400 mb-2">Add the form — a PDF or photos of each page — and Sollux fills it in. Full SSNs and EINs are never saved, only the last four digits.</p>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="btn text-xs cursor-pointer">Add pages
            <input type="file" accept="application/pdf,image/*" multiple className="hidden" onChange={async e => { const x = await filesToPayload(e.target.files); setPages(p => [...p, ...x]); e.target.value = ''; }} />
          </label>
          {pages.map((p, i) => <span key={i} className="text-xs text-gray-400 px-2 py-1 rounded" style={{ background: 'rgba(255,255,255,0.05)' }}>{p.name} <button onClick={() => setPages(ps => ps.filter((_, j) => j !== i))} className="text-gray-600 hover:text-red-400 ml-1">✕</button></span>)}
          {pages.length > 0 && <button onClick={autofill} disabled={reading} className="btn btn-primary text-xs disabled:opacity-50">{reading ? 'Reading…' : 'Fill in from pages'}</button>}
        </div>
        {note && <p className="text-xs text-emerald-400 mt-2">{note}</p>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div><span className={label}>Form</span><select className={input} value={f.formType} onChange={e => set({ formType: e.target.value })}>{FORM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></div>
        <div><span className={label}>Tax year</span><input type="number" className={input} value={f.taxYear} onChange={e => set({ taxYear: e.target.value })} /></div>
        <div><span className={label}>Federal or state</span><input className={input} value={f.jurisdiction} onChange={e => set({ jurisdiction: e.target.value.toUpperCase() })} placeholder="FEDERAL or CA" /></div>
        <div><span className={label}>Direction</span><select className={input} value={f.direction} onChange={e => set({ direction: e.target.value, status: e.target.value === 'FILED' ? 'FILED' : f.status })}>{Object.entries(DIRECTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="col-span-2"><span className={label}>{isW9 ? 'Name (line 1)' : isReturn ? 'Filed with' : 'From (lender / payer / employer)'}</span><input className={input} value={f.issuerName} onChange={e => set({ issuerName: e.target.value })} /></div>
        {isW9
          ? <div className="col-span-2"><span className={label}>Business name (line 2)</span><input className={input} value={f.businessName} onChange={e => set({ businessName: e.target.value })} /></div>
          : <div className="col-span-2"><span className={label}>To (recipient / borrower)</span><input className={input} value={f.recipientName} onChange={e => set({ recipientName: e.target.value })} /></div>}
        {isW9 && <div className="col-span-2"><span className={label}>Tax classification</span><input className={input} value={f.entityType} onChange={e => set({ entityType: e.target.value })} placeholder="Individual/sole proprietor, LLC, S corporation…" /></div>}
        <div><span className={label}>TIN — last 4 only</span><input className={input} value={f.tinLast4} maxLength={4} onChange={e => set({ tinLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></div>
        {isW9 && <div className="col-span-2 md:col-span-3"><span className={label}>Address</span><input className={input} value={f.address} onChange={e => set({ address: e.target.value })} /></div>}
        {!isW9 && (
          <>
            <div><span className={label}>{isReturn ? 'Total tax' : 'Amount'}</span><input type="number" step="0.01" className={input} value={f.amount} onChange={e => set({ amount: e.target.value })} /></div>
            <div><span className={label}>Federal withheld</span><input type="number" step="0.01" className={input} value={f.federalWithheld} onChange={e => set({ federalWithheld: e.target.value })} /></div>
            <div><span className={label}>State withheld</span><input type="number" step="0.01" className={input} value={f.stateWithheld} onChange={e => set({ stateWithheld: e.target.value })} /></div>
            {isReturn && <div><span className={label}>Refund (+) / owed (−)</span><input type="number" step="0.01" className={input} value={f.refundOrDue} onChange={e => set({ refundOrDue: e.target.value })} /></div>}
            {isReturn && <div><span className={label}>Filed on</span><input type="date" className={input} value={f.filedDate} onChange={e => set({ filedDate: e.target.value })} /></div>}
            {(f.formType === 'NOTICE' || f.formType === '1040-ES') && <div><span className={label}>Due</span><input type="date" className={input} value={f.dueDate} onChange={e => set({ dueDate: e.target.value })} /></div>}
            <div className="col-span-2"><span className={label}>Property</span><select className={input} value={f.propertyId} onChange={e => set({ propertyId: e.target.value })}><option value="">—</option>{properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}</select></div>
            {(f.formType === '1098' || f.formType === '1098-E') && (
              <div className="col-span-2"><span className={label}>Loan</span><select className={input} value={f.loanId} onChange={e => set({ loanId: e.target.value })}><option value="">—</option>{loans.map(l => <option key={l.id} value={l.id}>{l.lender}{l.propertyId ? ` — ${properties.find(p => p.id === l.propertyId)?.nickname || properties.find(p => p.id === l.propertyId)?.address || ''}` : ''}</option>)}</select></div>
            )}
          </>
        )}
        <div className="col-span-2 md:col-span-4"><span className={label}>Notes</span><input className={input} value={f.notes} onChange={e => set({ notes: e.target.value })} /></div>
      </div>
      {Object.keys(f.boxes).length > 0 && (
        <details><summary className="text-xs text-gray-500 cursor-pointer">{Object.keys(f.boxes).length} other boxes read from the form</summary>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 mt-2">{Object.entries(f.boxes).map(([k, v]) => <p key={k} className="text-xs text-gray-400 flex justify-between gap-2"><span>{k}</span><span className="text-gray-200">{typeof v === 'number' ? fmtMoney(v) : v}</span></p>)}</div>
        </details>
      )}
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex justify-end gap-2">
        {f.id && <button onClick={async () => { if (confirm('Delete this form?')) { await deleteTaxDoc(f.id!); onDone(true); } }} className="text-xs text-red-400 hover:text-red-300 mr-auto">Delete</button>}
        <button onClick={() => onDone(false)} className="btn text-xs">Cancel</button>
        <button onClick={save} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

export async function openTaxDoc(id: string, n = 0) {
  const w = window.open('', '_blank');
  const url = await taxDocUrl(id, n);
  if (w) w.location.href = url; else window.location.href = url;
}

export default function IncomeTaxTab() {
  const lastYear = new Date().getFullYear() - 1;
  const [year, setYear] = useState(lastYear);
  const [docs, setDocs] = useState<TaxDoc[]>([]);
  const [payments, setPayments] = useState<TaxPay[]>([]);
  const [years, setYears] = useState<number[]>([]);
  const [check, setCheck] = useState<TaxChecklist | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loans, setLoans] = useState<{ id: string; lender: string; propertyId?: string | null }[]>([]);
  const [editing, setEditing] = useState<DocForm | null>(null);
  const [paying, setPaying] = useState<{ jurisdiction: string; period: string; dueDate: string; amount: string; paidDate: string; confirmation: string } | null>(null);

  async function load() {
    const [d, c] = await Promise.all([getTaxDocs(year), getTaxChecklist(year)]);
    setDocs(d.documents.filter(x => x.formType !== 'W-9')); setPayments(d.payments); setYears(d.years); setCheck(c);
  }
  useEffect(() => { void load(); }, [year]);
  useEffect(() => { void getProperties().then(setProperties); void getLoans({}).then((l: any) => setLoans(l)).catch(() => {}); }, []);

  const yearOptions = useMemo(() => [...new Set([lastYear + 1, lastYear, lastYear - 1, lastYear - 2, ...years])].sort((a, b) => b - a), [years, lastYear]);
  const today = todayISO();
  const byJur = useMemo(() => {
    const m = new Map<string, TaxDoc[]>();
    for (const d of docs) m.set(d.jurisdiction, [...(m.get(d.jurisdiction) ?? []), d]);
    return [...m.entries()].sort(([a], [b]) => (a === 'FEDERAL' ? -1 : b === 'FEDERAL' ? 1 : a.localeCompare(b)));
  }, [docs]);

  const done = check ? [...check.forms, ...check.returns].filter(x => x.done).length : 0;
  const total = check ? check.forms.length + check.returns.length : 0;

  async function savePayment() {
    if (!paying || !(Number(paying.amount) > 0)) return;
    await createTaxPayment({ taxYear: year, jurisdiction: paying.jurisdiction, kind: 'ESTIMATED', period: paying.period, dueDate: paying.dueDate, paidDate: paying.paidDate || null, amount: Number(paying.amount), confirmation: paying.confirmation || null });
    setPaying(null); await load();
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="text-xs text-gray-500">Tax year</span>
        <select value={year} onChange={e => setYear(Number(e.target.value))} className="input-dark text-sm">{yearOptions.map(y => <option key={y} value={y}>{y}</option>)}</select>
        <button onClick={() => setEditing(emptyDoc(year))} className="btn btn-primary text-xs ml-auto">+ Add or upload a form</button>
      </div>

      {editing && <TaxDocEditor initial={editing} properties={properties} loans={loans} onDone={async saved => { setEditing(null); if (saved) await load(); }} />}

      {check && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
          <div className="card p-4">
            <div className="flex items-center justify-between mb-2"><p className="section-label mb-0">{year} checklist</p><span className="text-xs text-gray-500">{done} of {total} on file</span></div>
            <div className="space-y-1.5">
              {check.returns.map(r => (
                <div key={r.jurisdiction} className="flex items-center gap-2 text-sm">
                  <span className={r.done ? 'text-emerald-400' : 'text-gray-600'}>{r.done ? '✓' : '○'}</span>
                  <span className="flex-1 text-gray-300">{r.label}</span>
                  {r.done
                    ? <span className="text-xs text-gray-500">{r.filedDate ? `filed ${fmtDate(r.filedDate, 'MMM d, yyyy')}` : 'filed'}{r.refundOrDue != null ? ` · ${Number(r.refundOrDue) >= 0 ? 'refund' : 'owed'} ${fmtMoney(Math.abs(Number(r.refundOrDue)))}` : ''}</span>
                    : <button onClick={() => setEditing(emptyDoc(year, { jurisdiction: r.jurisdiction, formType: r.jurisdiction === 'FEDERAL' ? '1040' : r.jurisdiction === 'CA' ? '540' : 'OTHER', direction: 'FILED', status: 'FILED' }))} className={`text-xs ${r.dueDate < today ? 'text-red-400' : 'text-amber-400'} hover:underline`}>due {fmtDate(r.dueDate, 'MMM d, yyyy')} · add</button>}
                </div>
              ))}
              {check.forms.map(x => (
                <div key={x.loanId + x.formType} className="flex items-center gap-2 text-sm">
                  <span className={x.done ? 'text-emerald-400' : 'text-gray-600'}>{x.done ? '✓' : '○'}</span>
                  <span className="flex-1 text-gray-300">{x.label}</span>
                  {x.done
                    ? <button onClick={() => x.documentId && openTaxDoc(x.documentId)} className="text-xs text-gray-500 hover:text-gray-300">on file</button>
                    : <button onClick={() => setEditing(emptyDoc(year, { formType: x.formType, loanId: x.loanId, propertyId: x.propertyId ?? '' }))} className="text-xs text-amber-400 hover:underline">add</button>}
                </div>
              ))}
              {check.forms.length === 0 && <p className="text-xs text-gray-600">No mortgages or student loans on file, so no 1098s are expected.</p>}
              <p className="text-xs text-gray-600 pt-1">States without an income tax (FL, TX, NV and others) need no return. W-2s, 1099s and K-1s aren't listed here because Sollux can't know which ones to expect. Add them as they arrive.</p>
            </div>
          </div>
          <div className="card p-4">
            <p className="section-label">Estimated payments for {year}</p>
            <div className="space-y-1.5">
              {check.estimatedPayments.map(e => (
                <div key={e.jurisdiction + e.period} className="flex items-center gap-2 text-sm">
                  <span className="w-20 text-gray-400">{JUR_LABEL(e.jurisdiction)} {e.period}</span>
                  <span className={`w-28 text-xs ${e.paid <= 0 && e.dueDate < today ? 'text-gray-500' : 'text-gray-400'}`}>due {fmtDate(e.dueDate, 'MMM d, yyyy')}</span>
                  <span className="flex-1 text-right text-white">{e.paid > 0 ? fmtMoney(e.paid) : '—'}</span>
                  <button onClick={() => setPaying({ jurisdiction: e.jurisdiction, period: e.period, dueDate: e.dueDate, amount: '', paidDate: today, confirmation: '' })} className="text-xs text-amber-400 hover:underline w-16 text-right">+ paid</button>
                </div>
              ))}
              {paying && (
                <div className="flex items-end gap-2 pt-2 flex-wrap" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <span className="text-xs text-gray-400 w-full">{JUR_LABEL(paying.jurisdiction)} {paying.period} estimated payment</span>
                  <input type="number" step="0.01" placeholder="Amount" className="input-dark text-sm w-28" value={paying.amount} onChange={e => setPaying({ ...paying, amount: e.target.value })} />
                  <input type="date" className="input-dark text-sm" value={paying.paidDate} onChange={e => setPaying({ ...paying, paidDate: e.target.value })} />
                  <input placeholder="Confirmation #" className="input-dark text-sm flex-1 min-w-[120px]" value={paying.confirmation} onChange={e => setPaying({ ...paying, confirmation: e.target.value })} />
                  <button onClick={() => setPaying(null)} className="btn text-xs">Cancel</button>
                  <button onClick={savePayment} className="btn btn-primary text-xs">Save</button>
                </div>
              )}
              {payments.filter(p => p.kind !== 'ESTIMATED' || !p.period).length > 0 && (
                <div className="pt-2 space-y-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  {payments.filter(p => p.kind !== 'ESTIMATED' || !p.period).map(p => (
                    <p key={p.id} className="text-xs text-gray-400 flex gap-2"><span className="flex-1">{JUR_LABEL(p.jurisdiction)} {p.kind.toLowerCase().replace('_', ' ')}{p.paidDate ? ` · ${fmtDate(p.paidDate, 'MMM d, yyyy')}` : ''}</span><span className="text-gray-200">{fmtMoney(p.amount)}</span><button onClick={async () => { await deleteTaxPayment(p.id); await load(); }} className="text-gray-600 hover:text-red-400">✕</button></p>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {byJur.length === 0 ? (
        <p className="text-sm text-gray-500">No {year} forms on file yet. Upload them as they arrive: 1098s from each lender, 1099s, W-2s, and the returns once filed.</p>
      ) : byJur.map(([jur, list]) => (
        <div key={jur} className="card mb-4 overflow-x-auto">
          <p className="section-label px-4 pt-3">{jur === 'FEDERAL' ? 'Federal' : `${jur} state`}</p>
          <table className="table-base">
            <thead><tr><th className="pl-4">Form</th><th>From / to</th><th>Property</th><th className="text-right">Amount</th><th className="text-right">Withheld</th><th></th><th className="pr-4"></th></tr></thead>
            <tbody>
              {list.map(d => (
                <tr key={d.id}>
                  <td className="pl-4"><span className="text-white font-medium">{d.formType}</span><span className="block text-xs text-gray-600">{DIRECTION_LABEL[d.direction]}</span></td>
                  <td>{d.issuerName ?? '—'}{d.recipientName ? <span className="block text-xs text-gray-600">to {d.recipientName}{d.tinLast4 ? ` ••${d.tinLast4}` : ''}</span> : null}</td>
                  <td className="text-gray-400">{d.property ? (d.property.nickname || d.property.address) : '—'}</td>
                  <td className="text-right text-white">{d.amount != null ? fmtMoney(d.amount) : '—'}{d.refundOrDue != null && <span className={`block text-xs ${Number(d.refundOrDue) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{Number(d.refundOrDue) >= 0 ? 'refund' : 'owed'} {fmtMoney(Math.abs(Number(d.refundOrDue)))}</span>}</td>
                  <td className="text-right text-gray-400">{d.federalWithheld != null || d.stateWithheld != null ? fmtMoney(Number(d.federalWithheld ?? 0) + Number(d.stateWithheld ?? 0)) : '—'}</td>
                  <td>{(d.documents ?? []).length > 0 && <button onClick={() => openTaxDoc(d.id)} className="text-xs text-amber-400 hover:text-amber-300">📄</button>}</td>
                  <td className="pr-4 text-right"><button onClick={() => setEditing(docToForm(d))} className="text-xs text-gray-500 hover:text-gray-300">Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
