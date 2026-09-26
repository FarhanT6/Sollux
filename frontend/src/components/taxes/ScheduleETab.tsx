import { useEffect, useState } from 'react';
import { getScheduleE, downloadScheduleECsv, type ScheduleE } from '../../api/client';
import { fmtMoney } from '../../lib/money';
import { describeApiError } from '../../lib/apiError';

/**
 * The year-end tax package: Schedule E, Part I, per property — rents
 * received and every expense line, from what Sollux holds, on a cash basis.
 * A worksheet for the preparer: estimates and exclusions are listed under
 * each property, and depreciation is left to them.
 */
export default function ScheduleETab() {
  const last = new Date().getFullYear() - 1;
  const [year, setYear] = useState(last);
  const [data, setData] = useState<ScheduleE | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [focus, setFocus] = useState<string>('all');

  useEffect(() => { setData(null); setErr(null); getScheduleE(year).then(setData).catch(e => setErr(describeApiError(e, 'Could not build the worksheet.'))); }, [year]);

  async function csv() {
    const blob = await downloadScheduleECsv(year);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `schedule-e-${year}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const props = data ? (focus === 'all' ? data.properties : data.properties.filter(p => p.propertyId === focus)) : [];
  const cell = (n: number) => (n ? fmtMoney(n) : <span className="text-gray-700">—</span>);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <select className="input-dark text-sm" value={year} onChange={e => setYear(Number(e.target.value))}>
          {[0, 1, 2, 3].map(i => <option key={i} value={last + 1 - i}>{last + 1 - i}</option>)}
        </select>
        {data && (
          <select className="input-dark text-sm" value={focus} onChange={e => setFocus(e.target.value)}>
            <option value="all">All properties</option>
            {data.properties.map(p => <option key={p.propertyId} value={p.propertyId}>{p.name}</option>)}
          </select>
        )}
        <button onClick={csv} disabled={!data} className="btn text-xs ml-auto disabled:opacity-40">Download CSV for your preparer</button>
      </div>
      <p className="text-xs text-gray-500">Schedule E, Part I — cash basis: rent when received, bills when paid. A worksheet to hand your preparer, not a filed return.</p>
      {err && <p className="text-xs text-red-400">{err}</p>}
      {!data && !err && <p className="text-sm text-gray-500">Building…</p>}
      {data && data.properties.length === 0 && <p className="text-sm text-gray-500">Nothing recorded for {year}.</p>}
      {data && props.length > 0 && (
        <div className="overflow-x-auto card">
          <table className="table-base text-xs">
            <thead>
              <tr>
                <th className="text-left">Line</th>
                {props.map(p => <th key={p.propertyId} className="text-right whitespace-nowrap">{p.name}</th>)}
                {focus === 'all' && props.length > 1 && <th className="text-right">Total</th>}
              </tr>
            </thead>
            <tbody>
              {data.lines.map(l => (
                <tr key={l.key} className={l.key === 'rents' ? 'font-semibold' : ''}>
                  <td className="whitespace-nowrap"><span className="text-gray-500 mr-2">{l.line}</span>{l.label}</td>
                  {props.map(p => <td key={p.propertyId} className="text-right">{l.key === 'depreciation' ? <span className="text-gray-600">preparer</span> : cell(p.lines[l.key])}</td>)}
                  {focus === 'all' && props.length > 1 && <td className="text-right font-medium">{cell(data.totals[l.key])}</td>}
                </tr>
              ))}
              <tr className="font-semibold border-t border-white/10">
                <td><span className="text-gray-500 mr-2">20</span>Total expenses</td>
                {props.map(p => <td key={p.propertyId} className="text-right">{fmtMoney(p.totalExpenses)}</td>)}
                {focus === 'all' && props.length > 1 && <td className="text-right">{fmtMoney(data.totalExpenses)}</td>}
              </tr>
              <tr className="font-semibold">
                <td><span className="text-gray-500 mr-2">21</span>Income or (loss) before depreciation</td>
                {props.map(p => <td key={p.propertyId} className={`text-right ${p.net < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{fmtMoney(p.net)}</td>)}
                {focus === 'all' && props.length > 1 && <td className={`text-right ${data.net < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{fmtMoney(data.net)}</td>}
              </tr>
              <tr>
                <td className="text-gray-500">Capital improvements (depreciate, not expensed)</td>
                {props.map(p => <td key={p.propertyId} className="text-right text-gray-400">{cell(p.capitalImprovements)}</td>)}
                {focus === 'all' && props.length > 1 && <td />}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {data && props.length > 0 && (
        <div className="space-y-2">
          {props.map(p => p.notes.length > 0 && (
            <div key={p.propertyId} className="text-xs">
              <p className="text-gray-300 font-medium">{p.name}</p>
              <ul className="list-disc pl-5 text-gray-500">{p.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
