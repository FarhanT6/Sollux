import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getOpex, previewOpex, saveOpexSetup, estimateOpex, getOpexPortfolio, getProperties, startTaxLookup,
  type OpexConfig, type OpexResponse, type OpexPeriod, type OpexEstimate, type OpexSource, type OpexPer, type OpexLine,
} from '../api/client';
import type { Property } from '../types';
import { PageHeader } from '../components/ui';
import { fmtMoney } from '../lib/money';
import { fmtDate } from '../lib/date';
import { describeApiError } from '../lib/apiError';

/**
 * Operating expenses, property by property. Before the statement is made the
 * owner says what goes in: which utility accounts, whether late fees and
 * penalties are their own line, which recorded expense categories, the
 * mortgage (below NOI, as cash flow), and amounts for what Sollux does not
 * track — maintenance, management, vacancy, reserves. Taxes and insurance
 * come from the records; where there are none, the county lookup or an
 * estimate fills them in (an insurance estimate for a property with no
 * policy, from what is published for its place, type and size).
 */

const PERIODS: { key: OpexPeriod; label: string }[] = [{ key: 'last12', label: 'Last 12 months' }, { key: 'ytd', label: 'This year' }, { key: 'lastYear', label: 'Last year' }];
const CATEGORY_LABELS: Record<string, string> = {
  UTILITIES: 'Utilities (logged)', REPAIRS_MAINTENANCE: 'Repairs & maintenance', LANDSCAPING: 'Landscaping', PROPERTY_MANAGEMENT: 'Property management',
  LEGAL: 'Legal & professional', HOA: 'HOA (logged)', SUPPLIES: 'Supplies', TRAVEL: 'Travel', ADVERTISING: 'Advertising', HANDYMAN: 'Handyman',
  PERMITS: 'Permits & licenses', CITATIONS_FINES: 'Citations & fines', OTHER: 'Other',
};
const GROUP_ORDER = ['Utilities', 'HOA', 'Fees & penalties', 'Taxes & insurance', 'Operating', 'Your amounts'];
const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

export default function OperatingExpensesPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [pid, setPid] = useState<string>('all');
  const [period, setPeriod] = useState<OpexPeriod>('last12');
  useEffect(() => { void getProperties().then(p => setProperties(p.filter(x => x.status !== 'SOLD'))); }, []);

  return (
    <div>
      <PageHeader title="Operating expenses" subtitle="What each property costs to run, and what it nets" />
      <div className="px-4 md:px-8 pb-10 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <select className="input-dark text-sm" value={pid} onChange={e => setPid(e.target.value)}>
            <option value="all">All properties</option>
            {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
          </select>
          <div className="flex gap-1">
            {PERIODS.map(p => <button key={p.key} onClick={() => setPeriod(p.key)} className={`btn text-xs ${period === p.key ? 'btn-primary' : ''}`}>{p.label}</button>)}
          </div>
        </div>
        {pid === 'all' ? <Portfolio period={period} onOpen={setPid} /> : <PropertyOpex key={pid} propertyId={pid} period={period} />}
      </div>
    </div>
  );
}

function Portfolio({ period, onOpen }: { period: OpexPeriod; onOpen: (id: string) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getOpexPortfolio>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setData(null); getOpexPortfolio(period).then(setData).catch(e => setError(describeApiError(e, 'Could not load.'))); }, [period]);
  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;
  const sum = (f: (s: OpexResponse['statement']) => number) => data.properties.reduce((t, r) => t + f(r.statement), 0);
  return (
    <div className="card overflow-x-auto">
      <table className="table-base">
        <thead><tr><th className="pl-4">Property</th><th className="text-right">Rent</th><th className="text-right">Operating expenses</th><th className="text-right">NOI</th><th className="text-right">Expense ratio</th><th className="pr-4"></th></tr></thead>
        <tbody>
          {data.properties.map(r => (
            <tr key={r.property.id}>
              <td className="pl-4"><button onClick={() => onOpen(r.property.id)} className="text-gray-200 hover:text-white text-left">{r.property.name}</button>
                {r.statement.missing.length > 0 && <span className="block text-xs text-amber-400">No {r.statement.missing.join(' or ')} figure</span>}</td>
              <td className="text-right">{fmtMoney(r.statement.income.period)}</td>
              <td className="text-right">{fmtMoney(r.statement.totals.period)}</td>
              <td className={`text-right ${r.statement.noi.period < 0 ? 'text-red-400' : 'text-white'}`}>{fmtMoney(r.statement.noi.period)}</td>
              <td className="text-right">{pct(r.statement.ratio)}</td>
              <td className="pr-4 text-right"><button onClick={() => onOpen(r.property.id)} className="text-xs text-amber-400 hover:text-amber-300">{r.configured ? 'Open' : 'Set up'}</button></td>
            </tr>
          ))}
          <tr>
            <td className="pl-4 font-semibold text-white">Portfolio · {data.period}</td>
            <td className="text-right font-semibold">{fmtMoney(sum(s => s.income.period))}</td>
            <td className="text-right font-semibold">{fmtMoney(sum(s => s.totals.period))}</td>
            <td className="text-right font-semibold text-white">{fmtMoney(sum(s => s.noi.period))}</td>
            <td className="text-right">{sum(s => s.income.period) > 0 ? pct(sum(s => s.totals.period) / sum(s => s.income.period)) : '—'}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PropertyOpex({ propertyId, period }: { propertyId: string; period: OpexPeriod }) {
  const [data, setData] = useState<OpexResponse | null>(null);
  const [config, setConfig] = useState<OpexConfig | null>(null);
  const [setup, setSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [estimating, setEstimating] = useState<'insurance' | 'tax' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const first = useRef(true);

  async function load() {
    try {
      const r = await getOpex(propertyId, period);
      setData(r); setConfig(r.config);
      // Not set up yet: start with the questions.
      if (first.current) { setSetup(!r.configured); first.current = false; }
    } catch (e) { setError(describeApiError(e, 'Could not load.')); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [period]);

  // Every change to the setup re-prices the statement, a moment after the last one.
  useEffect(() => {
    if (!setup || !config) return;
    const t = setTimeout(() => { previewOpex(propertyId, period, config).then(setData).catch(() => {}); }, 400);
    return () => clearTimeout(t);
  }, [config, setup, propertyId, period]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!data || !config) return <p className="text-sm text-gray-500">Loading…</p>;
  const f = data.facts;
  const c = config;
  const set = (p: Partial<OpexConfig>) => setConfig(prev => ({ ...(prev ?? {}), ...p }));

  async function save() {
    setSaving(true);
    try { await saveOpexSetup(propertyId, c); setSetup(false); await load(); }
    catch (e) { setError(describeApiError(e, 'Could not save.')); }
    finally { setSaving(false); }
  }
  async function estimate(kind: 'insurance' | 'tax') {
    setEstimating(kind); setNote(null);
    try {
      await estimateOpex(propertyId, kind);
      const nextCfg: OpexConfig = { ...c, [kind === 'tax' ? 'taxes' : 'insurance']: { source: 'estimate' } };
      setConfig(nextCfg);
      setData(await previewOpex(propertyId, period, nextCfg));
    } catch (e) { setNote(describeApiError(e, 'The estimate did not come back; try again.')); }
    finally { setEstimating(null); }
  }
  async function lookupTax() {
    setNote(null);
    try { await startTaxLookup(propertyId); setNote('Looking the parcel up on the county site — it takes a few minutes. Reopen this page afterwards and the tax bill will be on file.'); }
    catch (e) { setNote(describeApiError(e, 'Could not start the lookup.')); }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
      {setup && (
        <div className="lg:col-span-2 card p-4 space-y-5 min-w-0">
          <div>
            <p className="text-sm font-semibold text-white">What goes into {data.property.name}'s statement</p>
            <p className="text-xs text-gray-500 mt-0.5">The statement on the right changes as you choose. Saved for next time.</p>
          </div>

          <Section title="Utility accounts" hint="Each account's bills in the period.">
            {f.utilities.length === 0 && <p className="text-xs text-gray-500">No utility accounts on this property.</p>}
            {f.utilities.map(u => (
              <Check key={u.id} on={c.utilities?.[u.id] !== false} onChange={on => set({ utilities: { ...(c.utilities ?? {}), [u.id]: on } })}
                label={u.name} right={u.bills ? fmtMoney(u.total) : 'no bills'} />
            ))}
          </Section>

          <Section title="Late fees & penalties" hint={`Fees charged on those bills in the period: ${fmtMoney(f.utilities.reduce((t, u) => t + (c.utilities?.[u.id] === false ? 0 : u.fees), 0))}.`}>
            <Radio value={c.lateFees ?? 'separate'} onChange={v => set({ lateFees: v as any })} options={[['separate', 'Include, as their own line'], ['exclude', 'Leave out (count the service only)']]} />
          </Section>

          <Section title="Property tax" hint={f.tax.annual != null ? `${fmtMoney(f.tax.annual)} a year from the ${f.tax.source}.` : 'No tax bill on file for this property.'}>
            <SourcePicker value={c.taxes} records={f.tax.annual} estimate={f.estimates?.tax ?? null} onChange={v => set({ taxes: v })}
              extra={f.tax.annual == null && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {data.property.apn
                    ? <button onClick={() => void lookupTax()} className="btn text-xs">Look up on the county site</button>
                    : <Link to="/taxes" className="btn text-xs">Add the parcel number (Taxes → Parcel)</Link>}
                  <button onClick={() => void estimate('tax')} disabled={!!estimating} className="btn text-xs disabled:opacity-50">{estimating === 'tax' ? 'Estimating…' : 'Estimate it'}</button>
                </div>
              )} />
          </Section>

          <Section title="Insurance" hint={f.insurance.annual != null ? `${fmtMoney(f.insurance.annual)} a year from ${f.insurance.source}.` : 'No policy on file. Get an estimate of what a landlord policy here would cost, or type a quote you have.'}>
            <SourcePicker value={c.insurance} records={f.insurance.annual} estimate={f.estimates?.insurance ?? null} onChange={v => set({ insurance: v })}
              extra={(
                <button onClick={() => void estimate('insurance')} disabled={!!estimating} className="btn text-xs mt-2 disabled:opacity-50">
                  {estimating === 'insurance' ? 'Estimating… (up to a minute)' : f.estimates?.insurance ? 'Estimate again' : f.insurance.annual != null ? 'Compare with an estimate' : 'Get an insurance estimate'}
                </button>
              )} />
            {f.estimates?.insurance && <EstimateCard e={f.estimates.insurance} kind="insurance" />}
          </Section>
          {f.estimates?.tax && <EstimateCard e={f.estimates.tax} kind="tax" />}
          {note && <p className="text-xs text-amber-300">{note}</p>}

          <Section title="Recorded expenses" hint="Expenses logged on this property, by category.">
            {f.categories.length === 0 && <p className="text-xs text-gray-500">None logged in the period.</p>}
            {f.categories.map(x => (
              <Check key={x.category} on={c.categories?.[x.category] !== false} onChange={on => set({ categories: { ...(c.categories ?? {}), [x.category]: on } })}
                label={CATEGORY_LABELS[x.category] ?? x.category} right={fmtMoney(x.total)} />
            ))}
          </Section>

          <Section title="Mortgage & improvements" hint="Neither is an operating expense; shown below NOI as cash flow.">
            <Check on={!!c.debtService} onChange={on => set({ debtService: on })} label={`Mortgage / debt service${f.debt.lenders.length ? ` (${f.debt.lenders.join(', ')})` : ''}`}
              right={f.debt.paid ? fmtMoney(f.debt.paid) : f.debt.monthlyPI ? `${fmtMoney(f.debt.monthlyPI)}/mo` : 'none on file'} />
            <Check on={!!c.capex} onChange={on => set({ capex: on })} label="Capital improvements" right={fmtMoney(f.capex)} />
          </Section>

          <ManualLines config={c} set={set} suggestions={data.suggestions} rent={f.rentIncome} months={f.months} />

          <div className="flex justify-end gap-2">
            {data.configured && <button onClick={() => { setConfig(data.config); setSetup(false); void load(); }} className="btn text-xs">Cancel</button>}
            <button onClick={() => void save()} disabled={saving} className="btn btn-primary text-xs disabled:opacity-50">{saving ? 'Saving…' : 'Save and show statement'}</button>
          </div>
        </div>
      )}

      <div className={`min-w-0 ${setup ? 'lg:col-span-3' : 'lg:col-span-5'}`}>
        <StatementCard data={data} onSetup={() => setSetup(true)} setupOpen={setup} />
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-300 uppercase tracking-wide">{title}</p>
      {hint && <p className="text-xs text-gray-500 mb-1.5">{hint}</p>}
      <div className="space-y-1">{children}</div>
    </div>
  );
}
function Check({ on, onChange, label, right }: { on: boolean; onChange: (on: boolean) => void; label: string; right?: string }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} />
      <span className={`flex-1 ${on ? 'text-gray-200' : 'text-gray-500 line-through'}`}>{label}</span>
      {right && <span className="text-xs text-gray-500">{right}</span>}
    </label>
  );
}
function Radio({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return <>{options.map(([k, l]) => (
    <label key={k} className="flex items-center gap-2 text-sm cursor-pointer"><input type="radio" checked={value === k} onChange={() => onChange(k)} /><span className="text-gray-200">{l}</span></label>
  ))}</>;
}

function SourcePicker({ value, records, estimate, onChange, extra }: {
  value?: { source: OpexSource; manualAnnual?: number | null }; records: number | null; estimate: OpexEstimate | null;
  onChange: (v: { source: OpexSource; manualAnnual?: number | null }) => void; extra?: React.ReactNode;
}) {
  const source = value?.source ?? (records != null ? 'records' : 'none');
  const opts: [OpexSource, string][] = [
    ...(records != null ? [['records', `From Sollux's records (${fmtMoney(records)}/yr)`] as [OpexSource, string]] : []),
    ...(estimate ? [['estimate', `The estimate (${fmtMoney(estimate.typical)}/yr)`] as [OpexSource, string]] : []),
    ['manual', 'An amount I type in'],
    ['none', 'Leave out'],
  ];
  return (
    <div>
      <Radio value={source} onChange={v => onChange({ source: v as OpexSource, manualAnnual: value?.manualAnnual ?? null })} options={opts} />
      {source === 'manual' && (
        <div className="flex items-center gap-2 mt-1 pl-6">
          <span className="text-xs text-gray-500">$</span>
          <input type="number" step="1" className="input-dark text-sm w-32" value={value?.manualAnnual ?? ''} placeholder="per year"
            onChange={e => onChange({ source: 'manual', manualAnnual: e.target.value === '' ? null : Number(e.target.value) })} />
          <span className="text-xs text-gray-500">a year</span>
        </div>
      )}
      {extra}
    </div>
  );
}

function EstimateCard({ e, kind }: { e: OpexEstimate; kind: 'insurance' | 'tax' }) {
  return (
    <div className="rounded-lg p-3 text-xs space-y-1" style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)' }}>
      <p className="text-gray-200">{kind === 'insurance' ? 'Insurance' : 'Property tax'} estimate: <span className="text-white font-semibold">{fmtMoney(e.typical)}</span> a year <span className="text-gray-500">({fmtMoney(e.low)}–{fmtMoney(e.high)}) · {fmtDate(e.at)}</span></p>
      <p className="text-gray-400">{e.basis}</p>
      {kind === 'insurance' && <p className="text-gray-500">An estimate from published averages, not a quote. For a real premium, ask{e.contacts?.length ? ':' : ' a local independent agent.'}</p>}
      {e.contacts?.length ? <ul className="list-disc pl-5 text-gray-400">{e.contacts.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
      {e.sources?.length ? <p className="text-gray-500">Sources: {e.sources.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" className="text-amber-400 hover:text-amber-300 mr-2">{s.title}</a>)}</p> : null}
    </div>
  );
}

function ManualLines({ config, set, suggestions, rent, months }: {
  config: OpexConfig; set: (p: Partial<OpexConfig>) => void; suggestions: OpexResponse['suggestions']; rent: number; months: number;
}) {
  const lines = config.manual ?? [];
  const upd = (id: string, p: Partial<{ label: string; amount: number; per: OpexPer }>) => set({ manual: lines.map(l => (l.id === id ? { ...l, ...p } : l)) });
  const asYear = (amount: number, per: OpexPer) => (per === 'month' ? amount * 12 : per === 'year' ? amount : (amount / 100) * (months ? rent * 12 / months : 0));
  return (
    <Section title="Not tracked in Sollux" hint="Add what this property costs that has no records here. A share of rent follows the rent.">
      {lines.map(l => (
        <div key={l.id} className="flex flex-wrap items-center gap-2 pb-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <input className="input-dark text-sm w-full" value={l.label} onChange={e => upd(l.id, { label: e.target.value })} />
          <input type="number" step="0.01" className="input-dark text-sm w-24" value={l.amount || ''} onChange={e => upd(l.id, { amount: Number(e.target.value) || 0 })} />
          <select className="input-dark text-sm w-28" value={l.per} onChange={e => upd(l.id, { per: e.target.value as OpexPer })}>
            <option value="month">$ a month</option><option value="year">$ a year</option><option value="pctRent">% of rent</option>
          </select>
          <span className="text-xs text-gray-500 flex-1 text-right">{fmtMoney(asYear(l.amount, l.per))}/yr</span>
          <button onClick={() => set({ manual: lines.filter(x => x.id !== l.id) })} className="text-gray-600 hover:text-red-400 text-xs">✕</button>
        </div>
      ))}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {suggestions.map(s => (
          <button key={s.id} title={s.hint} onClick={() => set({ manual: [...lines, { id: s.id, label: s.label, amount: s.typical, per: s.per }] })} className="btn text-xs">+ {s.label}</button>
        ))}
        <button onClick={() => set({ manual: [...lines, { id: `custom-${Date.now()}`, label: 'Other', amount: 0, per: 'month' }] })} className="btn text-xs">+ Something else</button>
      </div>
    </Section>
  );
}

function StatementCard({ data, onSetup, setupOpen }: { data: OpexResponse; onSetup: () => void; setupOpen: boolean }) {
  const s = data.statement;
  const groups = useMemo(() => GROUP_ORDER.map(g => ({ g, lines: s.lines.filter(l => l.group === g) })).filter(x => x.lines.length), [s]);
  const csv = () => {
    const rows: (string | number)[][] = [['Line', 'Group', `${data.period.label}`, 'Monthly', 'Annual', 'Source']];
    rows.push(['Rent (scheduled)', 'Income', s.income.period, s.income.monthly, s.income.annual, 'records']);
    for (const l of s.lines) rows.push([l.label, l.group, l.period, l.monthly, l.annual, l.source]);
    rows.push(['Total operating expenses', '', s.totals.period, s.totals.monthly, s.totals.annual, '']);
    rows.push(['Net operating income', '', s.noi.period, s.noi.monthly, s.noi.annual, '']);
    for (const l of s.belowNoi) rows.push([l.label, 'Below NOI', l.period, l.monthly, l.annual, l.source]);
    if (s.cashFlow) rows.push(['Cash flow', '', s.cashFlow.period, s.cashFlow.monthly, s.cashFlow.annual, '']);
    const blob = new Blob([rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `operating-expenses-${data.property.name.replace(/\W+/g, '-')}-${data.period.key}.csv`; a.click();
  };
  const Row = ({ label, m, strong, red, note, source }: { label: string; m: { period: number; monthly: number; annual: number }; strong?: boolean; red?: boolean; note?: string; source?: string }) => (
    <tr>
      <td className="pl-4">
        <span className={strong ? 'font-semibold text-white' : 'text-gray-300'}>{label}</span>
        {source === 'estimate' && <span className="pill pill-amber ml-2">estimate</span>}
        {source === 'manual' && <span className="pill pill-gray ml-2">typed in</span>}
        {note && <span className="block text-xs text-gray-600">{note}</span>}
      </td>
      {(['period', 'monthly', 'annual'] as const).map(k => <td key={k} className={`text-right ${k === 'monthly' ? 'hidden sm:table-cell ' : ''}${strong ? 'font-semibold' : ''} ${red && m[k] < 0 ? 'text-red-400' : strong ? 'text-white' : ''}`}>{fmtMoney(m[k])}</td>)}
    </tr>
  );
  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2 p-4 pb-2">
        <div className="flex-1">
          <p className="text-sm font-semibold text-white">{data.property.name}</p>
          <p className="text-xs text-gray-500">{data.period.label} · {fmtDate(data.period.start)} – {fmtDate(new Date(new Date(data.period.end).getTime() - 864e5).toISOString().slice(0, 10))}</p>
        </div>
        {!setupOpen && <button onClick={onSetup} className="btn text-xs">Change what's included</button>}
        <button onClick={csv} className="btn text-xs">CSV</button>
        <button onClick={() => window.print()} className="btn text-xs">Print</button>
      </div>
      {s.missing.length > 0 && (
        <p className="mx-4 mb-2 text-xs text-amber-400">No {s.missing.map(m => (m === 'taxes' ? 'property tax' : 'insurance')).join(' or ')} figure yet — {setupOpen ? 'choose one on the left' : <button onClick={onSetup} className="underline">add one</button>}. NOI is overstated until it is in.</p>
      )}
      <div className="overflow-x-auto px-3">
        <table className="table-base">
          <thead><tr><th className="pl-4">Line</th><th className="text-right">{data.period.label}</th><th className="text-right hidden sm:table-cell">Monthly</th><th className="text-right pr-4">Annual</th></tr></thead>
          <tbody>
            <Row label="Rent (scheduled)" m={s.income} strong />
            {groups.map(({ g, lines }) => (
              <GroupRows key={g} title={g} lines={lines} Row={Row} />
            ))}
            <Row label="Total operating expenses" m={s.totals} strong />
            <Row label="Net operating income (NOI)" m={s.noi} strong red />
            {s.belowNoi.map(l => <Row key={l.key} label={l.label} m={l} note={l.note} />)}
            {s.cashFlow && <Row label="Cash flow" m={s.cashFlow} strong red />}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 p-4 text-xs text-gray-400">
        <span>Expense ratio {pct(s.ratio)}</span>
        {s.perUnit && <span>{fmtMoney(s.perUnit.annual)} a year per unit</span>}
        {s.perSqft && <span>{fmtMoney(s.perSqft.annual)} a year per sq ft</span>}
        {s.notes.map((n, i) => <span key={i} className="text-gray-500">{n}</span>)}
      </div>
    </div>
  );
}

function GroupRows({ title, lines, Row }: { title: string; lines: OpexLine[]; Row: (p: any) => JSX.Element }) {
  return (
    <>
      <tr><td colSpan={4} className="pl-4 pt-3 text-xs uppercase tracking-wide text-gray-500">{title}</td></tr>
      {lines.map(l => <Row key={l.key} label={l.label} m={l} note={l.note} source={l.source} />)}
    </>
  );
}
