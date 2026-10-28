import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getInsights, markInsightRead, dismissInsight, markAllInsightsRead, runBookkeeper, getSavings, startSavingsResearch,
  type Saving, type SavingsResearch, type CompanyResearch, type InsuranceCheck,
} from '../api/client';
import type { AIInsight, InsightSeverity } from '../types';
import { PageHeader, InsightCard, EmptyState, Skeleton } from '../components/ui';
import { fmtMoney } from '../lib/money';
import { fmtDate } from '../lib/date';
import { describeApiError } from '../lib/apiError';

/**
 * Insights, by topic. Savings first: how much the owner can save a year and
 * how — what the records show (late fees, card fees, bills up on last year,
 * services at empty properties, duplicates, a high-rate loan), what each
 * company offers (promotions, a courtesy fee waiver, smaller carts, rate
 * plans — researched on the web, with sources), and each property's
 * insurance against what a typical policy there costs. Then the
 * bookkeeper's findings under late fees and bills due, utilities, loans,
 * insurance, taxes, tenants and the rest, each topic's savings on top.
 */

type Topic = 'savings' | 'late' | 'utilities' | 'loans' | 'insurance' | 'taxes' | 'tenants' | 'other';
const TOPICS: { key: Topic; label: string }[] = [
  { key: 'savings', label: 'Savings' }, { key: 'late', label: 'Late fees & bills due' }, { key: 'utilities', label: 'Utilities' },
  { key: 'loans', label: 'Loans' }, { key: 'insurance', label: 'Insurance' }, { key: 'taxes', label: 'Taxes' },
  { key: 'tenants', label: 'Tenants' }, { key: 'other', label: 'Other' },
];
const SEVERITY_RANK: Record<InsightSeverity, number> = { ALERT: 3, WARNING: 2, INFO: 1 };

/** What an insight is about, from the bookkeeper's key, else its account's category. */
function topicOf(i: AIInsight): Exclude<Topic, 'savings'> {
  const k = (i.dedupeKey ?? '').split(':')[0];
  if (['late-fee', 'overdue', 'due-soon', 'installment'].includes(k)) return 'late';
  if (['loan-maturity', 'loan-balance', 'rate-reset', 'prepay-ends'].includes(k)) return 'loans';
  if (['policy-expiring', 'claim-step'].includes(k)) return 'insurance';
  if (k.startsWith('tax-')) return 'taxes';
  if (['rent', 'rent-increase', 'lease-ending', 'notice', 'repair', 'compliance'].includes(k)) return 'tenants';
  if (['leak', 'flat', 'no-bill'].includes(k)) return 'utilities';
  const c = i.utilityAccount?.category;
  if (c === 'INSURANCE') return 'insurance';
  if (c === 'LOAN') return 'loans';
  if (c === 'TAXES') return 'taxes';
  if (c || i.insightType === 'ANOMALY' || i.insightType === 'OUTAGE') return 'utilities';
  return 'other';
}
const SAVING_TOPIC: Record<Saving['kind'], Exclude<Topic, 'savings'>> = {
  LATE_FEES: 'late', CARD_FEES: 'late', RISING_BILL: 'utilities', IDLE_SERVICE: 'utilities', DUPLICATE_SERVICE: 'utilities', INSURANCE_UP: 'insurance', HIGH_RATE_LOAN: 'loans',
};
const companyTopic = (c: CompanyResearch): Exclude<Topic, 'savings'> => (c.category === 'INSURANCE' ? 'insurance' : 'utilities');
const tacticTotal = (c: CompanyResearch) => c.tactics.reduce((t, x) => t + (x.perYear ?? 0), 0);
const overpay = (x: InsuranceCheck) => (x.high_ ? Math.max(0, Math.round(x.paying - x.typical)) : 0);

export default function InsightsPage() {
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [topic, setTopic] = useState<Topic>('savings');
  const [propFilter, setPropFilter] = useState('');
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [savings, setSavings] = useState<{ savings: Saving[]; total: number; research: SavingsResearch | null } | null>(null);
  const [researchErr, setResearchErr] = useState('');

  const loadSavings = useCallback(() => getSavings().then(setSavings).catch(() => {}), []);
  useEffect(() => {
    getInsights().then(data => setInsights(data.filter(i => !i.isDismissed))).finally(() => setLoading(false));
    void loadSavings();
  }, [loadSavings]);
  // While the research runs, follow it.
  useEffect(() => {
    if (!savings?.research?.running) return;
    const t = setInterval(() => void loadSavings(), 6000);
    return () => clearInterval(t);
  }, [savings?.research?.running, loadSavings]);

  async function research() {
    setResearchErr('');
    try { await startSavingsResearch(); await loadSavings(); }
    catch (e) { setResearchErr(describeApiError(e, 'Could not start the research.')); }
  }
  async function handleRunBookkeeper() {
    setRunning(true); setRunNote(null);
    try {
      const r = await runBookkeeper();
      setRunNote(`${r.count} item${r.count === 1 ? '' : 's'} · ${r.raised} new, ${r.refreshed} refreshed, ${r.cleared} cleared`);
      setInsights((await getInsights()).filter(i => !i.isDismissed));
    } catch { setRunNote('The bookkeeper could not run.'); }
    finally { setRunning(false); }
  }
  async function handleRead(id: string) { await markInsightRead(id); setInsights(p => p.map(i => (i.id === id ? { ...i, isRead: true } : i))); }
  async function handleDismiss(id: string) { await dismissInsight(id); setInsights(p => p.filter(i => i.id !== id)); }
  async function handleMarkAllRead() { await markAllInsightsRead(); setInsights(p => p.map(i => ({ ...i, isRead: true }))); }

  const research_ = savings?.research ?? null;
  const fromRecords = savings?.total ?? 0;
  const fromCompanies = (research_?.results ?? []).reduce((t, c) => t + tacticTotal(c), 0);
  const fromInsurance = (research_?.insurance ?? []).reduce((t, x) => t + overpay(x), 0);

  const byTopic = useMemo(() => {
    const m = new Map<Topic, AIInsight[]>();
    for (const i of insights) { const t = topicOf(i); m.set(t, [...(m.get(t) ?? []), i]); }
    return m;
  }, [insights]);
  const count = (t: Topic) => t === 'savings'
    ? (savings?.savings.length ?? 0) + (research_?.results ?? []).reduce((n, c) => n + c.tactics.length, 0) + (research_?.insurance ?? []).filter(x => x.high_).length
    : (byTopic.get(t)?.length ?? 0) + (savings?.savings ?? []).filter(s => SAVING_TOPIC[s.kind] === t).length;

  const propertyOptions = Array.from(new Map(insights.filter(i => i.property).map(i => [i.propertyId, i.property?.nickname || i.property?.address || ''])).entries());
  const unread = insights.filter(i => !i.isRead).length;

  return (
    <div>
      <PageHeader
        title="Insights"
        subtitle={`Where you can save, and what needs a hand · ${unread} unread`}
        action={<button onClick={handleMarkAllRead} disabled={unread === 0} className="btn text-xs disabled:opacity-50">Mark all read</button>}
      />
      <div className="px-4 md:px-6 py-5">
        {/* How much, at a glance */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
          <Stat label="From your records" value={fromRecords} hint="late fees, card fees, rising bills, idle and duplicate services" />
          <Stat label="From company offers" value={fromCompanies} hint={research_ ? `${research_.results.length} companies looked into` : 'not looked into yet'} />
          <Stat label="Insurance above typical" value={fromInsurance} hint={research_?.insurance ? `${research_.insurance.filter(x => x.high_).length} of ${research_.insurance.length} properties high` : 'not checked yet'} />
        </div>

        <div className="flex gap-1 mb-5 border-b border-white/10 overflow-x-auto">
          {TOPICS.map(t => (
            <button key={t.key} onClick={() => setTopic(t.key)}
              className={`px-3 py-2 text-sm whitespace-nowrap transition-colors ${topic === t.key ? 'text-amber-400 border-b-2 border-amber-400 -mb-px font-medium' : 'text-gray-400 hover:text-gray-200'}`}>
              {t.label}{count(t.key) ? <span className="ml-1.5 text-xs text-gray-500">{count(t.key)}</span> : null}
            </button>
          ))}
        </div>

        {topic === 'savings' ? (
          <div className="space-y-6">
            <ResearchBar research={research_} onStart={() => void research()} error={researchErr} />
            <SavingsGroup title="From your records" items={savings?.savings ?? null} />
            <InsuranceChecks checks={research_?.insurance ?? []} />
            <Companies list={research_?.results ?? []} />
          </div>
        ) : (
          <>
            <div className="flex gap-3 mb-4 flex-wrap items-center">
              {propertyOptions.length > 1 && (
                <select value={propFilter} onChange={e => setPropFilter(e.target.value)} className="input-dark text-xs">
                  <option value="">All properties</option>
                  {propertyOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              )}
              <button onClick={handleRunBookkeeper} disabled={running} className="btn text-xs" title="Goes over every bill, payment, policy and loan and raises what needs a hand. Runs on its own every night.">
                {running ? 'Bookkeeper running…' : 'Run bookkeeper now'}
              </button>
              {runNote && <span className="text-xs text-gray-500">{runNote}</span>}
            </div>
            {(savings?.savings ?? []).some(s => SAVING_TOPIC[s.kind] === topic) && (
              <div className="mb-6"><SavingsGroup title="Where you can save" items={(savings?.savings ?? []).filter(s => SAVING_TOPIC[s.kind] === topic)} /></div>
            )}
            {topic === 'insurance' && <div className="mb-6"><InsuranceChecks checks={research_?.insurance ?? []} /></div>}
            {(topic === 'utilities' || topic === 'insurance') && <div className="mb-6"><Companies list={(research_?.results ?? []).filter(c => companyTopic(c) === topic)} /></div>}
            <TopicInsights items={(byTopic.get(topic) ?? []).filter(i => !propFilter || i.propertyId === propFilter)} loading={loading} onRead={handleRead} onDismiss={handleDismiss} />
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-semibold tabular-nums mt-0.5 ${value > 0 ? 'text-emerald-400' : 'text-white'}`}>{fmtMoney(value)}<span className="text-xs text-gray-500 font-normal"> a year</span></p>
      <p className="text-[11px] text-gray-600 mt-0.5">{hint}</p>
    </div>
  );
}

function ResearchBar({ research, onStart, error }: { research: SavingsResearch | null; onStart: () => void; error: string }) {
  return (
    <div className="rounded-xl p-4 flex flex-wrap items-center gap-3" style={{ background: 'rgba(245,166,35,0.06)', border: '1px solid rgba(245,166,35,0.18)' }}>
      <div className="flex-1 min-w-[240px]">
        <p className="text-sm font-medium text-white">Look into every company and every policy</p>
        <p className="text-xs text-gray-400 mt-0.5">
          {research?.running
            ? `Looking… ${research.done} of ${research.total}${research.current ? ` · ${research.current}` : ''}`
            : research
              ? `Last looked ${fmtDate(research.at)}. Searches each company for promotions, retention offers, courtesy fee waivers, smaller service and discounts, and prices each property's insurance against a typical policy there.`
              : 'Searches each company you pay for promotions, retention offers, courtesy fee waivers, smaller carts or plans and discounts — with sources — and prices each property\'s insurance against what a typical policy there costs.'}
        </p>
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </div>
      <button onClick={onStart} disabled={!!research?.running} className="btn-primary text-sm px-4 py-2 disabled:opacity-60">
        {research?.running ? 'Looking…' : research ? 'Look again' : 'Look into it'}
      </button>
    </div>
  );
}

function SavingsGroup({ title, items }: { title: string; items: Saving[] | null }) {
  if (!items) return <Skeleton className="h-24" />;
  return (
    <section>
      <p className="text-sm font-semibold text-white mb-2">{title}</p>
      {!items.length ? <p className="text-sm text-gray-500">Nothing stands out in your records right now.</p> : (
        <div className="rounded-xl divide-y divide-white/5" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
          {items.map((s, i) => (
            <div key={i} className="px-4 py-3 flex gap-4 items-start">
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  {s.link ? <Link to={s.link} className="text-sm font-medium text-gray-100 hover:text-amber-400">{s.title}</Link> : <span className="text-sm font-medium text-gray-100">{s.title}</span>}
                  {s.propertyName && <span className="text-xs text-gray-500">{s.propertyName}</span>}
                </div>
                <p className="text-xs text-gray-400 mt-1">{s.detail}</p>
                <p className="text-xs text-amber-400/90 mt-0.5">{s.action}</p>
              </div>
              <Amount v={s.perYear} unit={s.kind === 'HIGH_RATE_LOAN' ? 'a year per point' : 'a year'} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function InsuranceChecks({ checks }: { checks: InsuranceCheck[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!checks.length) return null;
  const sorted = [...checks].sort((a, b) => overpay(b) - overpay(a) || b.paying - a.paying);
  return (
    <section>
      <p className="text-sm font-semibold text-white mb-2">Insurance, property by property</p>
      <div className="rounded-xl divide-y divide-white/5" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
        {sorted.map(x => (
          <div key={x.propertyId} className="px-4 py-3">
            <div className="flex gap-4 items-start">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-100">
                  {x.propertyName}
                  {x.error ? <span className="text-xs text-gray-500 font-normal"> · could not price: {x.error}</span>
                    : x.high_ ? <span className="text-xs text-red-400 font-normal"> · paying well above typical</span>
                    : <span className="text-xs text-emerald-400 font-normal"> · within the usual range</span>}
                </p>
                {!x.error && (
                  <p className="text-xs text-gray-400 mt-1">
                    You pay {fmtMoney(x.paying)} a year{x.carriers.length ? ` (${x.carriers.join(', ')})` : ''}. A typical policy there runs {fmtMoney(x.low)}–{fmtMoney(x.high)}, about {fmtMoney(x.typical)}.
                  </p>
                )}
                {x.high_ && (
                  <p className="text-xs text-amber-400/90 mt-0.5">Get two or three quotes before renewal — an independent agent can shop several carriers at once; ask about a higher deductible, roof and alarm discounts, and check the dwelling limit matches rebuild cost, not market value.</p>
                )}
                {!x.error && <button onClick={() => setOpen(o => (o === x.propertyId ? null : x.propertyId))} className="text-xs text-gray-500 hover:text-white mt-1">{open === x.propertyId ? 'Hide' : 'How this was priced, and who to call'}</button>}
                {open === x.propertyId && (
                  <div className="mt-2 text-xs text-gray-400 space-y-1.5">
                    <p>{x.basis}</p>
                    {!!x.contacts.length && <p><span className="text-gray-300">Ask for quotes:</span> {x.contacts.join(' · ')}</p>}
                    {!!x.sources.length && <p>{x.sources.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noreferrer" className="text-amber-400 hover:underline mr-3">{s.title}</a>)}</p>}
                  </div>
                )}
              </div>
              {overpay(x) > 0 && <Amount v={overpay(x)} unit="a year over typical" />}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Companies({ list }: { list: CompanyResearch[] }) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => tacticTotal(b) - tacticTotal(a) || b.monthly - a.monthly);
  return (
    <section>
      <p className="text-sm font-semibold text-white mb-2">Company by company</p>
      <div className="space-y-3">
        {sorted.map(c => (
          <div key={`${c.provider}|${c.category}`} className="rounded-xl px-4 py-3" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-baseline gap-2 flex-wrap mb-1">
              <span className="text-sm font-medium text-gray-100">{c.provider}</span>
              <span className="text-xs text-gray-500">{c.category.toLowerCase()} · {c.accounts} account{c.accounts === 1 ? '' : 's'} · {fmtMoney(c.monthly)} a month</span>
              {tacticTotal(c) > 0 && <span className="ml-auto text-sm text-emerald-400 tabular-nums">up to {fmtMoney(tacticTotal(c))} a year</span>}
            </div>
            {c.error ? <p className="text-xs text-gray-500">Could not look into it: {c.error}</p>
              : !c.tactics.length ? <p className="text-xs text-gray-500">Nothing better found right now.</p>
              : c.tactics.map((t, i) => (
                <div key={i} className="flex gap-3 items-start py-1.5 border-t border-white/5 first:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-200">{t.title} <span className="text-gray-600">· {t.effort === 'call' ? 'a phone call' : t.effort === 'online' ? 'online' : t.effort === 'form' ? 'a form' : 'switching'}{t.confidence === 'low' ? ' · unconfirmed' : ''}</span></p>
                    <p className="text-xs text-gray-400 mt-0.5">{t.how}</p>
                    {t.source && <a href={t.source} target="_blank" rel="noreferrer" className="text-[11px] text-amber-400/80 hover:underline">Source</a>}
                  </div>
                  {t.perYear != null && t.perYear > 0 && <Amount v={t.perYear} unit="a year" />}
                </div>
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function Amount({ v, unit }: { v: number; unit: string }) {
  return (
    <div className="text-right shrink-0">
      <p className="text-sm font-semibold text-emerald-400 tabular-nums">{fmtMoney(v)}</p>
      <p className="text-[11px] text-gray-500">{unit}</p>
    </div>
  );
}

function TopicInsights({ items, loading, onRead, onDismiss }: { items: AIInsight[]; loading: boolean; onRead: (id: string) => void; onDismiss: (id: string) => void }) {
  if (loading) return <>{Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-28 mb-3" />)}</>;
  if (!items.length) return <EmptyState title="Nothing here" body="Sollux keeps watching; anything that needs a hand shows up here." />;
  const groups = new Map<string, { name: string; items: AIInsight[] }>();
  for (const i of items) {
    const g = groups.get(i.propertyId) ?? { name: i.property?.nickname || i.property?.address || 'Property', items: [] };
    g.items.push(i); groups.set(i.propertyId, g);
  }
  const sorted = [...groups.values()].sort((a, b) =>
    Math.max(...b.items.map(i => SEVERITY_RANK[i.severity])) - Math.max(...a.items.map(i => SEVERITY_RANK[i.severity])) || a.name.localeCompare(b.name));
  return (
    <>
      {sorted.map(g => (
        <div key={g.name} className="mb-6">
          <div className="flex items-center gap-3 mb-3">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{g.name}</p>
            <span className="text-xs text-gray-600">{g.items.length}</span>
          </div>
          {g.items.map(i => <InsightCard key={i.id} insight={i} onRead={onRead} onDismiss={onDismiss} />)}
        </div>
      ))}
    </>
  );
}
