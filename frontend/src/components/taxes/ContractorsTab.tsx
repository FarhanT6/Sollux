import { useEffect, useState } from 'react';
import { getContractors1099, getTaxDocs, getProperties, type ContractorRow, type TaxDoc } from '../../api/client';
import type { Property } from '../../types';
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '../../types';
import { fmtMoney } from '../../lib/money';
import { TaxDocEditor, emptyDoc, docToForm, openTaxDoc, type DocForm } from './IncomeTaxTab';

/**
 * W-9s and the 1099-NECs they make possible. Anyone paid $600 or more in a
 * year for work on a rental — a handyman, a landscaper, a contractor — gets
 * a 1099-NEC from the owner by January 31, and that needs their W-9 on
 * file. Built from the year's expenses, grouped by vendor name.
 */
export default function ContractorsTab() {
  const lastYear = new Date().getFullYear() - 1;
  const [year, setYear] = useState(lastYear);
  const [rows, setRows] = useState<ContractorRow[] | null>(null);
  const [w9s, setW9s] = useState<TaxDoc[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [editing, setEditing] = useState<DocForm | null>(null);

  async function load() {
    const [c, d] = await Promise.all([getContractors1099(year), getTaxDocs()]);
    setRows(c.contractors); setW9s(d.documents.filter(x => x.formType === 'W-9'));
  }
  useEffect(() => { void load(); }, [year]);
  useEffect(() => { void getProperties().then(setProperties); }, []);

  const needing = (rows ?? []).filter(r => r.needs1099);
  const missingW9 = needing.filter(r => !r.w9).length;
  const notIssued = needing.filter(r => !r.issued1099).length;

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="text-xs text-gray-500">Tax year</span>
        <select value={year} onChange={e => setYear(Number(e.target.value))} className="input-dark text-sm">
          {[lastYear + 1, lastYear, lastYear - 1, lastYear - 2].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <button onClick={() => setEditing(emptyDoc(year, { formType: 'W-9', direction: 'RECEIVED', jurisdiction: 'FEDERAL' }))} className="btn btn-primary text-xs ml-auto">+ Add a W-9</button>
      </div>

      {editing && <TaxDocEditor initial={editing} properties={properties} loans={[]} onDone={async saved => { setEditing(null); if (saved) await load(); }} />}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <div className="stat-card"><p className="text-xs text-gray-500">Paid $600 or more in {year}</p><p className="text-lg font-semibold text-white">{needing.length}</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">Missing a W-9</p><p className={`text-lg font-semibold ${missingW9 ? 'text-amber-400' : 'text-white'}`}>{missingW9}</p></div>
        <div className="stat-card"><p className="text-xs text-gray-500">1099-NEC not yet issued</p><p className={`text-lg font-semibold ${notIssued ? 'text-amber-400' : 'text-white'}`}>{notIssued}</p><p className="text-xs text-gray-600">due Jan 31, {year + 1}</p></div>
      </div>

      <div className="card overflow-x-auto mb-5">
        <p className="section-label px-4 pt-3">Contractors paid in {year}</p>
        {rows == null ? <p className="px-4 pb-4 text-sm text-gray-500">Loading…</p>
          : rows.length === 0 ? <p className="px-4 pb-4 text-sm text-gray-500">No contractor payments in {year}. Expenses count here when they are Handyman, Repairs, Landscaping, Capital improvement, Property management or Legal, and name a vendor.</p>
          : (
            <table className="table-base">
              <thead><tr><th className="pl-4">Vendor</th><th>Work</th><th className="text-right">Paid</th><th>1099-NEC</th><th>W-9</th><th className="pr-4"></th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.vendor}>
                    <td className="pl-4 text-white">{r.vendor}<span className="block text-xs text-gray-600">{r.payments} payment{r.payments === 1 ? '' : 's'}{r.propertyCount > 1 ? ` · ${r.propertyCount} properties` : ''}</span></td>
                    <td className="text-xs text-gray-400">{r.categories.map(c => EXPENSE_CATEGORY_LABELS[c as ExpenseCategory] ?? c).join(', ')}</td>
                    <td className="text-right text-white">{fmtMoney(r.total)}</td>
                    <td>
                      {r.corporation ? <span className="pill pill-gray">Not needed — corporation</span>
                        : !r.needs1099 ? <span className="text-xs text-gray-600">Under $600</span>
                        : r.issued1099 ? <span className="pill pill-green">Issued</span>
                        : <button onClick={() => setEditing(emptyDoc(year, { formType: '1099-NEC', direction: 'ISSUED', status: 'FILED', recipientName: r.vendor, amount: String(r.total) }))} className="pill pill-amber">Needed · record it</button>}
                    </td>
                    <td>
                      {r.w9 ? <button onClick={() => openTaxDoc(r.w9!.id)} className="pill pill-green">On file{r.w9.tinLast4 ? ` ••${r.w9.tinLast4}` : ''}</button>
                        : <button onClick={() => setEditing(emptyDoc(year, { formType: 'W-9', direction: 'RECEIVED', issuerName: r.vendor }))} className={`pill ${r.needs1099 ? 'pill-red' : 'pill-gray'}`}>Missing · add</button>}
                    </td>
                    <td className="pr-4" />
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        <p className="text-xs text-gray-600 px-4 pb-3">Payments made by credit card, PayPal or a payment app are reported by the processor on a 1099-K. Those don't need a 1099-NEC from you. Name vendors the same way on every expense so their payments add up.</p>
      </div>

      <div className="card overflow-x-auto">
        <p className="section-label px-4 pt-3">W-9s on file</p>
        {w9s.length === 0 ? <p className="px-4 pb-4 text-sm text-gray-500">None yet. Ask each contractor for a W-9 before paying them, then upload it here.</p> : (
          <table className="table-base">
            <thead><tr><th className="pl-4">Name</th><th>Business</th><th>Classification</th><th>TIN</th><th>Signed</th><th className="pr-4"></th></tr></thead>
            <tbody>
              {w9s.map(d => (
                <tr key={d.id}>
                  <td className="pl-4 text-white">{d.issuerName ?? '—'}<span className="block text-xs text-gray-600">{d.direction === 'ISSUED' ? 'You gave this W-9' : 'Received'}</span></td>
                  <td className="text-gray-400">{d.businessName ?? '—'}</td>
                  <td className="text-gray-400">{d.entityType ?? '—'}</td>
                  <td className="text-gray-400">{d.tinLast4 ? `••${d.tinLast4}` : '—'}</td>
                  <td className="text-gray-400">{d.taxYear}</td>
                  <td className="pr-4 text-right whitespace-nowrap">
                    {(d.documents ?? []).length > 0 && <button onClick={() => openTaxDoc(d.id)} className="text-xs text-amber-400 hover:text-amber-300 mr-3">📄</button>}
                    <button onClick={() => setEditing(docToForm(d))} className="text-xs text-gray-500 hover:text-gray-300">Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
