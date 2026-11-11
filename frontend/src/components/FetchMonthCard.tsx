import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getFetchMonth, fetchMonthMissing, type FetchMonth, type FetchMonthAccount, type FetchMonthState } from '../api/client';
import { fmtMoney } from '../lib/money';
import { fmtDate, fmtMoment } from '../lib/date';
import { describeApiError } from '../lib/apiError';
import { toast } from '../lib/toast';

const STATES: { key: FetchMonthState; label: string; color: string; hint: string }[] = [
  { key: 'late', label: 'Late', color: '#ef4444', hint: 'Expected more than 5 days ago and not on file' },
  { key: 'due', label: 'Due now', color: '#F5A623', hint: 'Expected in the last few days: Sollux is looking for it' },
  { key: 'no-history', label: 'No statement yet', color: '#a78bfa', hint: 'Nothing on file to learn its billing day from' },
  { key: 'coming', label: 'Not out yet', color: '#6b7280', hint: 'Expected later this month' },
  { key: 'got', label: 'On file', color: '#22c55e', hint: 'This month’s statement is in' },
  { key: 'not-this-month', label: 'Not billed this month', color: '#374151', hint: 'Bills every two months or longer' },
];
const VIA: Record<string, string> = { portal: 'fetched from the website', email: 'from email', upload: 'uploaded', typed: 'typed in' };
const monthLabel = (m: string) => fmtDate(`${m}-01`, 'MMMM yyyy');
const box = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' };

/**
 * This month's statements: every active account, whether its statement for
 * the month is on file (and how it came in), or when it should be out and why
 * it is not here yet, with Fetch now. Above it, when the automatic fetch last
 * ran — it is what was failing when statements stopped coming in by themselves.
 */
export default function FetchMonthCard() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [data, setData] = useState<FetchMonth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({ 'not-this-month': false, got: false });
  const [busy, setBusy] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(() => getFetchMonth(month).then(d => { setData(d); setError(null); return d; })
    .catch(e => { setError(describeApiError(e, 'Could not load this month’s statements')); return null; }), [month]);
  useEffect(() => { void load(); }, [load]);
  // While something is being fetched, refresh every few seconds.
  const running = !!data?.accounts.some(a => a.running);
  useEffect(() => {
    if (!running) return;
    timer.current = window.setInterval(() => void load(), 5000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [running, load]);

  const groups = useMemo(() => {
    const by = new Map<FetchMonthState, FetchMonthAccount[]>();
    for (const a of data?.accounts ?? []) by.set(a.state, [...(by.get(a.state) ?? []), a]);
    return STATES.map(s => ({ ...s, rows: by.get(s.key) ?? [] })).filter(g => g.rows.length);
  }, [data]);

  if (!data) return error ? <div className="card p-5"><p className="text-xs text-red-400">{error}</p></div> : null;

  const total = data.accounts.length;
  const fetchableLate = data.accounts.filter(a => (a.state === 'late' || a.state === 'due' || a.state === 'no-history') && a.fetchable && a.syncEnabled && !a.running && !a.waitingForCode);
  const isThisMonth = data.month === data.months[0];
  const last = data.schedule.lastRunAt ? new Date(data.schedule.lastRunAt) : null;
  const scheduleStale = !last || Date.now() - last.getTime() > (data.schedule.everyHours + 1) * 3_600_000;
  const workersDown = data.workers && data.workers.state !== 'ok' && data.workers.state !== 'busy';

  async function fetchSome(ids?: string[], key = 'all') {
    setBusy(key);
    try {
      const r = await fetchMonthMissing(ids);
      toast(r.queued ? `Fetching ${r.accounts} account${r.accounts === 1 ? '' : 's'}${r.queued < r.accounts ? ` in ${r.queued} sign-in${r.queued === 1 ? '' : 's'}` : ''}.` : 'Nothing to fetch: each is already being fetched or has no login.');
      await load();
    } catch (e) { toast(describeApiError(e, 'Could not start the fetch.'), 'error'); }
    finally { setBusy(null); }
  }

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Statements by month</h2>
        <div className="flex items-center gap-2">
          <select className="input-dark text-xs py-1" value={data.month} onChange={e => setMonth(e.target.value)}>
            {data.months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          {isThisMonth && fetchableLate.length > 0 && (
            <button className="btn btn-primary text-xs whitespace-nowrap disabled:opacity-50" disabled={busy !== null} onClick={() => void fetchSome(undefined)}>
              {busy === 'all' ? 'Starting…' : `Fetch the missing (${fetchableLate.length})`}
            </button>
          )}
        </div>
      </div>

      {/* Whether the automatic fetch is running at all. */}
      {workersDown ? (
        <p className="text-xs mt-2 rounded-lg px-3 py-2" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5' }}>{data.workers.message}</p>
      ) : (
        <p className={`text-xs mt-1 ${scheduleStale ? 'text-amber-400' : 'text-gray-500'}`}>
          {last ? `Automatic fetching last checked every account on ${fmtMoment(last.toISOString())}` : 'Automatic fetching has not run since this update was deployed'}
          {` · it checks every ${data.schedule.everyHours} hours and fetches each account once its next statement is due by its own billing days.`}
        </p>
      )}

      {total === 0 ? <p className="text-xs text-gray-500 mt-3">No active accounts.</p> : (
        <>
          {/* One bar for the month: each account a slice, by where it stands. */}
          <div className="flex h-2 mt-4 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }} role="img"
            aria-label={STATES.map(s => `${data.counts[s.key]} ${s.label.toLowerCase()}`).join(', ')}>
            {STATES.map(s => data.counts[s.key] ? <div key={s.key} style={{ width: `${(data.counts[s.key] / total) * 100}%`, background: s.color }} title={`${s.label}: ${data.counts[s.key]}`} /> : null)}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
            {STATES.filter(s => data.counts[s.key]).map(s => (
              <span key={s.key} className="flex items-center gap-1.5 text-gray-400" title={s.hint}>
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: s.color }} />{s.label} <span className="text-gray-200">{data.counts[s.key]}</span>
              </span>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            {groups.map(g => {
              const shown = open[g.key] ?? true;
              return (
                <div key={g.key}>
                  <button className="text-xs text-gray-300 flex items-center gap-1.5" onClick={() => setOpen(o => ({ ...o, [g.key]: !shown }))}>
                    <span className="text-gray-500">{shown ? '▾' : '▸'}</span>
                    <span className="w-2 h-2 rounded-full inline-block" style={{ background: g.color }} />
                    {g.label} · {g.rows.length}
                    <span className="text-gray-600 hidden sm:inline">— {g.hint}</span>
                  </button>
                  {shown && (
                    <div className="mt-1.5 rounded-lg divide-y divide-white/5" style={box}>
                      {g.rows.map(a => <Row key={a.id} a={a} busy={busy === a.id} canFetch={isThisMonth && busy === null} onFetch={() => void fetchSome([a.id], a.id)} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ a, busy, canFetch, onFetch }: { a: FetchMonthAccount; busy: boolean; canFetch: boolean; onFetch: () => void }) {
  const accountPage = `/properties/${a.propertyId}/utilities/${a.id}`;
  const missing = a.state === 'late' || a.state === 'due' || a.state === 'no-history';
  return (
    <div className="px-3 py-2.5 flex flex-wrap sm:flex-nowrap items-start justify-between gap-x-3 gap-y-1.5">
      <div className="min-w-0">
        <p className="text-sm text-gray-100">
          <Link to={accountPage} className="hover:underline">{a.providerName}{a.last4 ? ` ··${a.last4}` : ''}</Link>
          <span className="text-gray-500"> · {a.place}{a.personal ? ' · personal' : ''}</span>
        </p>
        {a.got ? (
          <p className="text-xs text-gray-500">
            {fmtDate(a.got.statementDate, 'MMM d')} statement{a.got.amountDue != null ? ` · ${fmtMoney(a.got.amountDue)}` : ''} · {VIA[a.got.via]} on {fmtMoment(a.got.addedAt)}
          </p>
        ) : (
          <p className={`text-xs ${a.state === 'late' ? 'text-red-300/90' : 'text-gray-500'}`}>{a.why}</p>
        )}
        {!a.got && a.nextTry && missing && !a.running && <p className="text-xs text-gray-600">Next automatic try about {fmtMoment(a.nextTry)}</p>}
      </div>
      <div className="shrink-0">
        {a.running ? <span className="text-xs text-amber-400">Fetching…</span>
          : a.waitingForCode ? <Link to={accountPage} className="btn text-xs">Enter code</Link>
          : !a.got && a.state !== 'not-this-month' && !a.fetchable && a.syncEnabled ? <Link to={accountPage} className="btn text-xs whitespace-nowrap">Add login</Link>
          : !a.got && a.state !== 'not-this-month' && a.fetchable && a.syncEnabled && canFetch
            ? <button className="btn text-xs whitespace-nowrap disabled:opacity-50" disabled={busy} onClick={onFetch}>{busy ? 'Starting…' : 'Fetch now'}</button>
          : null}
      </div>
    </div>
  );
}
