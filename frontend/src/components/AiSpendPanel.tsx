import { useEffect, useRef, useState } from 'react';
import { getAiSpend, getAiTest, startAiTest, getPortalTests, testPortal, type AiSpend, type AiTestState, type PortalTestAccount } from '../api/client';
import { fmtMoney } from '../lib/money';
import { fmtMoment } from '../lib/date';
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
  const timer = useRef<number | null>(null);

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

  async function run(only?: string) {
    try { await startAiTest(only); toast('Test run started — each feature runs once on your own data.'); await load(); poll(); }
    catch (e: any) { toast(e?.response?.data?.error ?? 'Could not start the test run.', 'error'); }
  }
  async function fetchNow(a: PortalTestAccount) {
    try { await testPortal(a.id); toast(`Fetching ${a.providerName} statements — this takes a few minutes.`); setTimeout(() => void load(), 60000); }
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
          <p className="text-2xl font-semibold text-white">{fmtCost(spend.spent)}<span className="text-xs text-gray-500">{spend.budget != null ? ` of ${fmtMoney(spend.budget)} budget` : ' · no budget cap'}</span></p>
        </div>
        {spend.budget != null && (
          <div className="h-1.5 mt-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct >= 90 ? '#ef4444' : '#F5A623' }} />
          </div>
        )}
        <p className="text-xs text-gray-500 mt-3">
          Models: {spend.primaryModel} first{spend.fallbackModel ? `, ${spend.fallbackModel} when an answer fails its check` : ', no fallback'}.
          When the budget is reached Claude stops for the month and Sollux falls back to plain text reading and templates — change it with AI_MONTHLY_BUDGET on Render.
        </p>
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

      <div className="card p-5">
        <h2 className="text-sm font-semibold text-white mb-1">Statement fetching</h2>
        <p className="text-xs text-gray-500 mb-3">
          Accounts with a portal login. The first fetch from a portal is Claude working the site out; the steps that got to the statements are saved as a recipe and replayed next time without Claude, so later fetches cost a fraction.
          {portal && ` This month: ${portal.monthCalls} Claude turns, ${fmtCost(portal.monthCost)}.`}
        </p>
        {!portal?.accounts.length ? <p className="text-xs text-gray-500">No account has a portal login yet — add one with “Add portal login” on an account.</p> : (
          <div className="space-y-2">
            {portal.accounts.map(a => {
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
                    {a.lastSyncError && a.lastSyncStatus === 'FAILED' && <p className="text-xs text-red-400 mt-0.5">{a.lastSyncError}</p>}
                  </div>
                  <button className="btn text-xs whitespace-nowrap" onClick={() => void fetchNow(a)}>Fetch now</button>
                </div>
              );
            })}
          </div>
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
