import { useEffect, useRef, useState } from 'react';
import PortalLogin from './utility/PortalLogin';
import { getAiSpend, setAiBudget, getAiTest, startAiTest, getPortalTests, testPortal, cancelFetch, type AiSpend, type AiTestState, type PortalTestAccount, type WorkerStatus, type QueueSnapshot } from '../api/client';
import { fmtMoney } from '../lib/money';
import { fmtMoment } from '../lib/date';
import PortalCodeBanner from './utility/PortalCodeBanner';
import ConnectorCard from './ConnectorCard';
import { toast } from '../lib/toast';

/** A Claude call often costs a fraction of a cent; fmtMoney would show $0.00. */
const fmtCost = (n: number) => (n >= 1 ? fmtMoney(n) : `$${n.toFixed(n >= 0.01 ? 3 : 4)}`);

const STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: 'Waiting', color: '#6b7280' },
  running: { label: 'Running…', color: '#F5A623' },
  ok: { label: 'Working', color: '#22c55e' },
  problem: { label: 'Problem', color: '#ef4444' },
  skipped: { label: 'Skipped', color: '#6b7280' },
};

/**
 * AI usage: what Claude has cost this month, by feature, against the budget;
 * a test run of every feature that calls Claude, on the owner's own data;
 * and statement fetching tested account by account.
 */
export default function AiSpendPanel() {
  const [spend, setSpend] = useState<AiSpend | null>(null);
  const [test, setTest] = useState<AiTestState | null>(null);
  const [portal, setPortal] = useState<Awaited<ReturnType<typeof getPortalTests>> | null>(null);
  // An account without a login, being given one from here.
  const [loginFor, setLoginFor] = useState<PortalTestAccount | null>(null);
  const [showUnfetched, setShowUnfetched] = useState(true);
  const timer = useRef<number | null>(null);
  const portalTimer = useRef<number | null>(null);

  const load = () => {
    getAiSpend().then(setSpend).catch(() => {});
    getPortalTests().then(setPortal).catch(() => {});
    return getAiTest().then(t => { setTest(t); return t; }).catch(() => null);
  };
  // Poll while a test run is going.
  const poll = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const t = await load();
      if (t?.run && !t.run.finishedAt) poll();
    }, 3000);
  };
  useEffect(() => { void load().then(t => { if (t?.run && !t.run.finishedAt) poll(); }); return () => { if (timer.current) window.clearTimeout(timer.current); }; }, []);

  // While a fetch is queued or running, refresh its status every few seconds.
  const fetching = !!portal?.accounts.some(a => a.run && (a.run.state === 'queued' || a.run.state === 'running'));
  useEffect(() => {
    if (!fetching) return;
    portalTimer.current = window.setInterval(() => {
      getPortalTests().then(p => {
        setPortal(p);
        if (!p.accounts.some(a => a.run && (a.run.state === 'queued' || a.run.state === 'running'))) void getAiSpend().then(setSpend).catch(() => {});
      }).catch(() => {});
    }, 4000);
    return () => { if (portalTimer.current) window.clearInterval(portalTimer.current); };
  }, [fetching]);

  async function run(only?: string) {
    try { await startAiTest(only); toast('Test run started — each feature runs once on your own data.'); await load(); poll(); }
    catch (e: any) { toast(e?.response?.data?.error ?? 'Could not start the test run.', 'error'); }
  }
  async function cancel(a: PortalTestAccount) {
    try { await cancelFetch(a.id); toast('Cancelled — it stops within a few seconds.'); await getPortalTests().then(setPortal); }
    catch (e: any) { toast(e?.response?.data?.error ?? 'Could not cancel it.', 'error'); }
  }
  async function fetchNow(a: PortalTestAccount) {
    try { await testPortal(a.id); await getPortalTests().then(setPortal); }
    catch (e: any) { toast(e?.response?.data?.error ?? 'Could not start it.', 'error'); }
  }

  if (!spend) return <p className="text-sm text-gray-500">Loading…</p>;
  const running = !!test?.run && !test.run.finishedAt;
  const pct = spend.budget ? Math.min(100, (spend.spent / spend.budget) * 100) : 0;
  const testTotal = test?.run?.results.reduce((s, r) => s + (r.cost ?? 0), 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex items-baseline justify-between">
          <p className="text-sm text-gray-200">Claude this month</p>
          <p className="text-2xl font-semibold text-white">{fmtCost(spend.spent)}<span className="text-xs text-gray-500">{spend.budget != null ? ` of ${fmtMoney(spend.budget)} ${spend.scope === 'account' ? 'included in your plan' : 'budget'}` : ' · no budget cap'}</span></p>
        </div>
        {spend.budget != null && (
          <div className="h-1.5 mt-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct >= 90 ? '#ef4444' : '#F5A623' }} />
          </div>
        )}
        <p className="text-xs text-gray-500 mt-3">
          Models: {spend.primaryModel} first{spend.fallbackModel ? `, ${spend.fallbackModel} when an answer fails its check` : ', no fallback'}.
          {spend.scope === 'account'
            ? 'Bill reading, portal fetches and insights draw on this allowance. When it is used up they pause until the 1st; bills can still be added by hand or read as plain text.'
            : 'App-wide, across every account. When the budget is reached Claude stops for the month and Sollux falls back to plain text reading and templates. Each customer also has their plan’s own allowance (AI_ALLOWANCE_STARTER / _PRO / _PORTFOLIO).'}
        </p>
        {spend.scope === 'app' && <BudgetEditor current={spend.budget} onSaved={b => setSpend(s => (s ? { ...s, budget: b } : s))} />}
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold text-white mb-3">Where it went</h2>
        {spend.features.length === 0 ? <p className="text-xs text-gray-500">No Claude calls this month.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-gray-500 text-left"><th className="py-1.5 pr-2 font-medium">Feature</th><th className="pr-2 font-medium text-right">Calls</th><th className="pr-2 font-medium text-right">Each</th><th className="pr-2 font-medium text-right">Cached</th><th className="font-medium text-right">Total</th></tr></thead>
              <tbody>
                {spend.features.map(f => (
                  <tr key={f.feature + f.test} className="border-t border-white/5">
                    <td className="py-1.5 pr-2 text-gray-200">{f.name}{f.test && <span className="text-gray-500"> · test</span>}{f.fallbacks > 0 && <span className="text-amber-400"> · {f.fallbacks} fallback{f.fallbacks === 1 ? '' : 's'}</span>}</td>
                    <td className="pr-2 text-right text-gray-300">{f.calls}</td>
                    <td className="pr-2 text-right text-gray-300">{fmtCost(f.avgCost)}</td>
                    <td className="pr-2 text-right text-gray-500">{f.cachedShare ? `${Math.round(f.cachedShare * 100)}%` : '—'}</td>
                    <td className="text-right text-white">{fmtCost(f.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card p-5">
        <div className="flex items-center justify-between gap-3 mb-1">
          <h2 className="text-sm font-semibold text-white">Test every AI feature</h2>
          <button className="btn btn-primary text-xs" disabled={running || !test?.apiKey} onClick={() => void run()}>{running ? 'Running…' : 'Run all tests'}</button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Each feature runs once on your own documents and data, and shows whether it worked, which model answered, and what it cost. Usually well under $1 for the whole run.
          {!test?.apiKey && ' — ANTHROPIC_API_KEY is not set on the server.'}
        </p>
        <div className="space-y-2">
          {(test?.run?.results ?? test?.checks.map(c => ({ ...c, status: 'pending' as const })) ?? []).map(r => {
            const st = STATUS[r.status] ?? STATUS.pending;
            const res = r as typeof r & { detail?: string; cost?: number; calls?: number; models?: string[]; fellBack?: boolean; ms?: number };
            return (
              <div key={r.key} className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-gray-100">{r.name}</p>
                  <span className="text-xs whitespace-nowrap" style={{ color: st.color }}>{st.label}</span>
                </div>
                {res.detail && <p className="text-xs text-gray-400 mt-1">{res.detail}</p>}
                {res.calls != null && (
                  <p className="text-xs text-gray-500 mt-1">
                    {res.calls} call{res.calls === 1 ? '' : 's'} · {fmtCost(res.cost ?? 0)}{res.models?.length ? ` · ${res.models.join(', ')}` : ''}{res.fellBack ? ' · used the fallback' : ''}{res.ms != null ? ` · ${(res.ms / 1000).toFixed(1)}s` : ''}
                    {!running && <button className="ml-2 underline text-gray-400" onClick={() => void run(r.key)}>Run again</button>}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {test?.run?.finishedAt && <p className="text-xs text-gray-400 mt-3">Test run finished {fmtMoment(test.run.finishedAt)} · {fmtCost(testTotal)} in all.</p>}
      </div>

      <ConnectorCard />

      <div className="card p-5">
        <h2 className="text-sm font-semibold text-white mb-1">Statement fetching</h2>
        <p className="text-xs text-gray-500 mb-3">
          Accounts Sollux can fetch from the provider's website. The first fetch from a portal is Claude working the site out; the steps that got to the statements are saved as a recipe and replayed next time without Claude, so later fetches cost a fraction.
          {portal && ` This month: ${portal.monthCalls} Claude turns, ${fmtCost(portal.monthCost)}.`}
        </p>
        {portal?.workers && portal.workers.state !== 'ok' && portal.workers.state !== 'busy' && (
          <div className="rounded-lg p-3 mb-3 text-xs" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5' }}>
            <p className="font-semibold">Statements can't be fetched right now</p>
            <p className="mt-0.5">{portal.workers.message}</p>
          </div>
        )}
        {/* Inactive accounts (syncing off) are not fetched, so they are not listed; just counted. */}
        {portal && portal.accounts.some(a => !a.syncEnabled) && (
          <p className="text-xs text-gray-500 mb-2">{portal.accounts.filter(a => !a.syncEnabled).length} inactive account{portal.accounts.filter(a => !a.syncEnabled).length === 1 ? '' : 's'} not shown — turn one back on from its account page to fetch it.</p>
        )}
        {!portal?.accounts.some(a => a.syncEnabled && !a.needs) ? <p className="text-xs text-gray-500">No active account has a portal login yet — add one below.</p> : (
          <div className="space-y-2">
            {portal.accounts.filter(a => a.syncEnabled && !a.needs).map(a => {
              const shared = portal.sharedRecipes.length > 0;
              return (
                <div key={a.id} className="flex items-start justify-between gap-3 py-2 border-t border-white/5 first:border-0">
                  <div className="min-w-0">
                    <p className="text-sm text-gray-100">{a.providerName}{a.last4 ? ` ··${a.last4}` : ''} <span className="text-gray-500">· {a.place}</span></p>
                    <p className="text-xs text-gray-500">
                      {a.recipe ? `Recipe saved · replayed ${a.recipe.successes}×${a.recipe.failures ? `, broke ${a.recipe.failures}×` : ''}` : shared ? 'No recipe for this account yet (may use the provider\'s)' : 'No recipe yet — the first fetch records one'}
                      {a.lastAgentRunAt ? ` · last run ${fmtMoment(a.lastAgentRunAt)}` : ''}
                      {a.lastSyncStatus ? ` · ${a.lastSyncStatus.toLowerCase()}` : ''}
                    </p>
                    <RunLine a={a} workers={portal.workers} queue={portal.queue} onCodeSent={() => void getPortalTests().then(setPortal)} />
                  </div>
                  {a.run && (a.run.state === 'queued' || a.run.state === 'running') ? (
                    <div className="flex flex-col items-end gap-1">
                      <button className="btn text-xs whitespace-nowrap" disabled>Fetching…</button>
                      <button className="text-xs text-gray-400 hover:text-red-300" onClick={() => void cancel(a)}>Cancel</button>
                    </div>
                  ) : (
                    <button className="btn text-xs whitespace-nowrap" onClick={() => void fetchNow(a)}>Fetch now</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* Accounts with nothing to fetch with yet: say why, and fix it here. */}
        {(() => {
          const rest = (portal?.accounts ?? []).filter(a => a.syncEnabled && (a.needs === 'login' || a.needs === 'name'));
          if (!rest.length) return null;
          return (
            <div className="mt-4 pt-3 border-t border-white/5">
              <button className="text-left w-full" onClick={() => setShowUnfetched(v => !v)}>
                <p className="text-xs text-gray-300">{showUnfetched ? '▾' : '▸'} Not fetched yet · {rest.length}</p>
                <p className="text-xs text-gray-500">Nothing saved to fetch with yet: a portal login, or — for billers that find bills by account number, like City of Oceanside — the bill lookup page and its customer number or name. Their bills still come in by email or upload.</p>
              </button>
              {showUnfetched && (
                <div className="mt-2 divide-y divide-white/5">
                  {rest.map(a => (
                    <div key={a.id} className="flex items-center justify-between gap-3 py-2">
                      <p className="text-sm text-gray-200 min-w-0 truncate">{a.providerName}{a.last4 ? ` ··${a.last4}` : ''} <span className="text-gray-500">· {a.place}</span></p>
                      <button className="btn text-xs whitespace-nowrap" onClick={() => setLoginFor(a)}>{a.needs === 'name' ? 'Add lookup details' : 'Add login or lookup page'}</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
        {loginFor && (
          <PortalLogin account={{ id: loginFor.id, providerName: loginFor.providerName, hasCredentials: loginFor.hasCredentials, lookupName: loginFor.lookupName, lookupCustomerId: loginFor.lookupCustomerId }}
            website={loginFor.website} onClose={() => setLoginFor(null)} onSaved={() => void getPortalTests().then(setPortal)} />
        )}
      </div>

      {spend.recent.length > 0 && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-white mb-3">Latest calls</h2>
          <div className="space-y-1">
            {spend.recent.slice(0, 20).map((r, i) => (
              <div key={i} className="flex justify-between gap-3 text-xs">
                <span className="text-gray-400 truncate">{fmtMoment(r.createdAt)} · {r.name}{r.test ? ' · test' : ''}{r.fellBack ? ' · fallback' : ''} · {r.model}</span>
                <span className="text-gray-200 whitespace-nowrap">{fmtCost(r.costUsd)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The account's latest fetch, live: queued, what it is doing now, the code it needs, or how it ended. */
function RunLine({ a, workers, queue, onCodeSent }: { a: PortalTestAccount; workers?: WorkerStatus; queue?: QueueSnapshot | null; onCodeSent: () => void }) {
  // What the worker is on while this press waits: "fetching SDG&E ··1234 (from the schedule, 3 min)".
  const busyWith = queue?.active.length
    ? `The worker is busy with ${queue.active.map(j => `${j.account} (${j.kind}${j.since ? `, ${Math.max(1, Math.round((Date.now() - new Date(j.since).getTime()) / 60000))} min so far` : ''})`).join(', ')}${queue.waiting > 1 ? `; ${queue.waiting - 1} other${queue.waiting === 2 ? '' : 's'} waiting` : ''}. Yours goes next.`
    : null;
  const r = a.run;
  if (!a.syncEnabled) return <p className="text-xs text-amber-400 mt-0.5">Syncing is turned off for this account (marked inactive).</p>;
  if (!r) return a.lastSyncError && a.lastSyncStatus === 'FAILED' ? <p className="text-xs text-red-400 mt-0.5">{a.lastSyncError}</p> : null;
  const live = r.state === 'queued' || r.state === 'running';
  return (
    <div className="mt-1 space-y-1.5">
      {r.state === 'queued' && (
        <p className="text-xs" style={{ color: r.stuck ? '#ef4444' : '#F5A623' }}>
          {busyWith ?? (r.stuck ? `Still queued after 2 minutes. ${workers?.message ?? 'The background worker (sollux-workers on Render) is not running or is busy.'}` : 'Queued — starting in a moment…')}
        </p>
      )}
      {r.state === 'running' && <p className="text-xs text-amber-400 flex items-center gap-1.5"><span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />{r.progress ?? 'Working…'}</p>}
      {live && a.mfaPrompt && <PortalCodeBanner accountId={a.id} prompt={a.mfaPrompt} requestedAt={a.mfaRequestedAt} providerName={a.providerName} onSent={onCodeSent} />}
      {r.state === 'done' && <p className="text-xs text-green-400">Finished {fmtMoment(r.completedAt)}: {r.progress ?? (r.statementsFound ? `${r.statementsFound} statements` : 'nothing new')}{r.costUsd != null ? ` · ${fmtCost(r.costUsd)}` : ''}</p>}
      {r.state === 'failed' && <p className="text-xs text-red-400">Stopped {r.completedAt ? fmtMoment(r.completedAt) : ''}: {r.error ?? 'the run failed.'}{r.costUsd ? ` · ${fmtCost(r.costUsd)}` : ''}</p>}
    </div>
  );
}

/** The app-wide monthly cap, set here rather than on Render (it wins over AI_MONTHLY_BUDGET). */
function BudgetEditor({ current, onSaved }: { current: number | null; onSaved: (b: number | null) => void }) {
  const [value, setValue] = useState(current != null ? String(current) : '');
  const [saving, setSaving] = useState(false);
  async function save(v: number | null) {
    setSaving(true);
    try { await setAiBudget(v); onSaved(v); toast(v == null ? 'No monthly cap.' : `Monthly budget set to ${fmtMoney(v)}.`); }
    catch { toast('Could not change the budget.', 'error'); }
    finally { setSaving(false); }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      <span className="text-xs text-gray-400">Monthly budget $</span>
      <input type="number" min={0} step={5} value={value} onChange={e => setValue(e.target.value)} className="input-dark text-sm w-24" />
      <button disabled={saving || value === '' || Number(value) < 0} onClick={() => void save(Number(value))} className="btn btn-primary text-xs disabled:opacity-50">{saving ? '…' : 'Save'}</button>
      <button disabled={saving} onClick={() => void save(null)} className="text-xs text-gray-500 hover:text-gray-300">No cap</button>
    </div>
  );
}
