import { useEffect, useState } from 'react';
import { readTaxBill, saveTaxAssessment, type FilePayload } from '../../api/client';
import type { Property } from '../../types';
import { fileToPayload } from '../../lib/files';
import { fmtMoney } from '../../lib/money';
import { describeApiError } from '../../lib/apiError';

/**
 * Several tax bills at once: each file is read (the same reader as a single
 * bill), matched to its property by parcel number or address, and saved —
 * a second bill for a year already on file updates it. A bill that matches
 * no property, or shows no amount, is left for the owner to add by hand.
 * For counties whose sites will not let the lookup in: download the bills
 * there, drop them here.
 */
type Row = { name: string; state: 'waiting' | 'reading' | 'saved' | 'skipped' | 'failed'; note?: string };

const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export default function BulkTaxUpload({ properties, onClose, onDone, initialFiles }: { properties: Property[]; onClose: () => void; onDone: () => void; /** Handed over from Add's drop zone: read at once. */ initialFiles?: File[] }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const set = (i: number, r: Partial<Row>) => setRows(rs => rs.map((x, j) => (j === i ? { ...x, ...r } : x)));

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (initialFiles?.length && properties.length) void start(initialFiles); }, [properties.length]);

  async function start(files: FileList | File[] | null) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setRows(list.map(f => ({ name: f.name, state: 'waiting' })));
    setRunning(true);
    for (let i = 0; i < list.length; i++) {
      set(i, { state: 'reading' });
      try {
        const page: FilePayload = await fileToPayload(list[i]);
        const { fields: f, match } = await readTaxBill([page]);
        // Saved only when the property is certain; a likely match is left to the owner to confirm.
        if (!match?.propertyId || match.confidence !== 'high') {
          set(i, { state: 'skipped', note: match?.propertyId ? `Probably ${match.propertyName}, but not certain. Add it with "+ Add or upload a tax bill" to confirm.` : `No property matched${f.propertyAddress ? ` "${f.propertyAddress}"` : ''}${f.apn ? ` (parcel ${f.apn})` : ''}. Add it with "+ Add or upload a tax bill".` });
          continue;
        }
        const prop = properties.find(p => p.id === match.propertyId);
        const i1 = num(f.installment1Amount), i2 = num(f.installment2Amount);
        // The year's total as printed, or both installments; a California bill's one installment is half the year.
        const total = num(f.annualTaxAmount) ?? (i1 != null && i2 != null ? i1 + i2 : (i1 ?? i2) != null && prop?.state === 'CA' ? (i1 ?? i2)! * 2 : null);
        if (!f.taxYear || !(total && total > 0)) { set(i, { state: 'skipped', note: `Matched ${match.propertyName}, but the bill shows no ${!f.taxYear ? 'tax year' : 'amount'}. Add it by hand.` }); continue; }
        await saveTaxAssessment({
          propertyId: match.propertyId, taxYear: String(f.taxYear), apn: f.apn ?? null, taxingAuthority: f.taxingAuthority ?? null,
          assessedValue: num(f.assessedValue), annualTaxAmount: Number(total.toFixed(2)),
          installment1Amount: i1, installment1Due: f.installment1Due ?? null, installment1Paid: f.installment1Paid ?? null,
          installment2Amount: i2, installment2Due: f.installment2Due ?? null, installment2Paid: f.installment2Paid ?? null,
          status: f.status ?? 'UNPAID', notes: f.notes ?? null,
          installment1Delinquent: f.installment1Delinquent ?? null, installment2Delinquent: f.installment2Delinquent ?? null, billNumber: f.billNumber ?? null,
          landValue: num(f.landValue), improvementValue: num(f.improvementValue), marketValue: num(f.marketValue), exemptionsValue: num(f.exemptionsValue),
          exemptionsNote: f.exemptionsNote ?? null, baseYear: f.baseYear ?? null, taxRate: num(f.taxRate), penaltiesOwed: num(f.penaltiesOwed), balanceOwed: num(f.balanceOwed),
          specialAssessments: Array.isArray(f.specialAssessments) ? f.specialAssessments.filter((a: any) => a?.name && Number.isFinite(Number(a.amount))).map((a: any) => ({ ...a, amount: Number(a.amount) })) : [],
          file: page,
        });
        set(i, { state: 'saved', note: `${match.propertyName} · ${f.taxYear} · ${fmtMoney(total)}` });
      } catch (e) { set(i, { state: 'failed', note: describeApiError(e, 'Could not read it.') }); }
    }
    setRunning(false);
  }

  const color: Record<Row['state'], string> = { waiting: 'text-gray-500', reading: 'text-amber-400', saved: 'text-emerald-400', skipped: 'text-amber-400', failed: 'text-red-400' };
  const label: Record<Row['state'], string> = { waiting: 'Waiting', reading: 'Reading…', saved: 'Saved', skipped: 'Needs you', failed: 'Failed' };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={running ? undefined : onClose}>
      <div className="w-full max-w-xl max-h-[85vh] overflow-y-auto rounded-xl p-5" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <p className="font-semibold text-white">Upload several tax bills</p>
        <p className="text-xs text-gray-500 mt-1 mb-4">Download your bills from the county's tax site (for San Diego County: sdttc.com, search by parcel, "Print bill") and choose them all here. Each is read, matched to its property by parcel number or address, and saved.</p>
        {!rows.length ? (
          <label className="btn-primary text-sm px-4 py-2 cursor-pointer inline-block">
            Choose bills
            <input type="file" multiple accept="application/pdf,image/*" className="hidden" onChange={e => void start(e.target.files)} />
          </label>
        ) : (
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="text-xs flex gap-3">
                <span className={`w-20 shrink-0 ${color[r.state]}`}>{label[r.state]}</span>
                <span className="flex-1 min-w-0"><span className="text-gray-200">{r.name}</span>{r.note && <span className="block text-gray-500">{r.note}</span>}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end mt-5">
          <button disabled={running} onClick={rows.length ? onDone : onClose} className="btn-ghost text-sm">{running ? 'Reading…' : rows.length ? 'Done' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  );
}
