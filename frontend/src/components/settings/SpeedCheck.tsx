import { useState } from 'react';
import { getSpeedCheck, type SpeedCheckResult } from '../../api/client';
import { describeApiError } from '../../lib/apiError';
import { lastOpen } from '../../lib/loadTiming';
import { fmtMoment } from '../../lib/date';

type Verdict = { label: string; value: string; tone: 'good' | 'warn' | 'bad'; note?: string };
const TONE = { good: 'text-emerald-400', warn: 'text-amber-400', bad: 'text-red-400' } as const;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
const ago = (sec: number) => (sec < 120 ? `${sec} seconds ago` : sec < 7200 ? `${Math.round(sec / 60)} minutes ago` : sec < 172800 ? `${Math.round(sec / 3600)} hours ago` : `${Math.round(sec / 86400)} days ago`);

/** What each measurement means, in a line, and whether it is the slow part. */
function verdicts(r: SpeedCheckResult & { totalMs: number; tokenMs: number }): Verdict[] {
  const db = r.database;
  const net = Math.max(0, r.totalMs - r.serverMs);
  const woke = r.server.upSeconds < 180 && r.totalMs > 5000;
  const paused = db.firstTripMs > 300 && db.firstTripMs > db.tripMs * 5;
  return [
    {
      label: 'Server', value: `started ${ago(r.server.upSeconds)}`,
      tone: woke ? 'bad' : r.server.upSeconds < 180 ? 'warn' : 'good',
      note: woke
        ? 'It was asleep and started for this visit — that is the wait. On Render, a web service on the Free instance type sleeps after 15 minutes without visits; Starter keeps it running.'
        : r.server.upSeconds < 180 ? 'Started moments ago — an update was just deployed, or it was asleep. The last open above tells which: a long "server\'s first answer" with no update just before means it sleeps.' : undefined,
    },
    {
      label: 'Database, one trip', value: `${ms(db.tripMs)}${db.region ? ` · ${db.provider ?? ''} ${db.region}`.trimEnd() : ''}`,
      tone: db.tripMs < 8 ? 'good' : db.tripMs < 30 ? 'warn' : 'bad',
      note: db.tripMs >= 30
        ? `Far from the server: each page asks the database several times, so this adds up to seconds. Put the database in the same region as the server (on Neon, a project in the server's region; on Render, the service's region) — no bigger plan needed.`
        : db.tripMs >= 8 ? 'A little far: same-region trips take 1–5 ms.' : 'Same region as the server.',
    },
    ...(paused ? [{
      label: 'Database wake-up', value: ms(db.firstTripMs), tone: 'bad' as const,
      note: 'The database was paused and woke for this check. Neon\'s Free plan pauses it after 5 minutes idle (the background worker\'s heartbeat normally keeps it awake — check that the worker is running); a paid Neon plan can turn pausing off.',
    }] : []),
    { label: 'Your connection to the server', value: ms(net), tone: net < 400 ? 'good' : net < 1200 ? 'warn' : 'bad', note: net >= 1200 ? 'Slow between this device and the server: try another network to compare.' : undefined },
    { label: 'Sign-in check', value: ms(r.tokenMs + r.signInMs), tone: r.tokenMs + r.signInMs < 500 ? 'good' : 'warn', note: r.tokenMs > 800 ? 'Getting a fresh sign-in token was slow (Clerk).' : undefined },
    { label: 'Overview summary', value: ms(r.summaryMs), tone: r.summaryMs < 300 ? 'good' : r.summaryMs < 1000 ? 'warn' : 'bad' },
  ];
}

/** What a slow step of the last open means. */
const STEP_NOTE: Record<string, (ms: number) => string | null> = {
  app: ms => (ms > 3000 ? 'Downloading the app was slow. The first open after an update downloads the new version; if every open is slow here, it is the connection.' : null),
  signin: ms => (ms > 2000 ? 'Signing in (Clerk) was slow — usually a slow connection to Clerk, or the browser restoring the session.' : null),
  server: ms => (ms > 5000 ? 'The server took this long to answer its first request: it was asleep (or an update was deploying) and had to start. If this happens on the first open after a while without an update, the sollux-api service on Render is on the Free instance type, which sleeps after 15 minutes without visits — Starter keeps it running.' : null),
  draw: ms => (ms > 3000 ? 'The rest of the Overview\'s data was slow to come back.' : null),
};

/** The last time the app opened on this device, step by step (lib/loadTiming.ts). */
function LastOpenCard() {
  const last = lastOpen();
  if (!last) return <p className="text-xs text-gray-600 mt-3">The next time you open the app on this device, how long each step took will show here.</p>;
  const slow = [...last.steps].sort((a, b) => b.ms - a.ms)[0];
  return (
    <div className="mt-3">
      <p className="text-xs text-gray-300">Last time the app opened here ({fmtMoment(new Date(last.at).toISOString())}): <span className={last.total > 6000 ? 'text-red-400' : last.total > 3000 ? 'text-amber-400' : 'text-emerald-400'}>{ms(last.total)}</span> until the Overview showed</p>
      <div className="flex h-2 mt-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
        {last.steps.map((st, i) => st.ms > 0 && <div key={st.key} title={`${st.label}: ${ms(st.ms)}`} style={{ width: `${(st.ms / Math.max(1, last.total)) * 100}%`, background: ['#60a5fa', '#a78bfa', '#F5A623', '#22c55e'][i] }} />)}
      </div>
      <div className="mt-1.5 space-y-1">
        {last.steps.map((st, i) => {
          const note = STEP_NOTE[st.key]?.(st.ms);
          return (
            <div key={st.key} className="text-xs">
              <div className="flex justify-between gap-3">
                <span className="text-gray-400 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full inline-block" style={{ background: ['#60a5fa', '#a78bfa', '#F5A623', '#22c55e'][i] }} />{st.label}</span>
                <span className={note ? 'text-red-400' : st === slow && last.total > 3000 ? 'text-amber-400' : 'text-gray-300'}>{ms(st.ms)}</span>
              </div>
              {note && <p className="text-gray-500 mt-0.5">{note}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Settings → Account: why the app is slow to open, measured here and on the
 * server (routes/speed.ts) — a sleeping server, a database far from it or
 * paused, or this device's connection — each with what fixes it.
 */
export default function SpeedCheck() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<(SpeedCheckResult & { totalMs: number; tokenMs: number }) | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setRunning(true); setErr(null);
    try {
      const clerk = (window as unknown as { Clerk?: { session?: { getToken: () => Promise<string | null> } } }).Clerk;
      const t0 = performance.now();
      await clerk?.session?.getToken().catch(() => null);
      const tokenMs = performance.now() - t0;
      const t1 = performance.now();
      const r = await getSpeedCheck();
      setResult({ ...r, totalMs: performance.now() - t1, tokenMs });
    } catch (e) { setErr(describeApiError(e, 'The check did not finish.')); }
    finally { setRunning(false); }
  }

  const list = result ? verdicts(result) : [];
  const worst = list.find(v => v.tone === 'bad') ?? list.find(v => v.tone === 'warn');
  return (
    <div className="card p-5 mb-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Speed check</h2>
        <button className="btn text-xs disabled:opacity-50" disabled={running} onClick={() => void run()}>{running ? 'Checking…' : result ? 'Check again' : 'Check speed'}</button>
      </div>
      <p className="text-xs text-gray-500 mt-1">When the app is slow to open: how long each step of the last open took on this device, and — with Check speed — the server, the database and your connection now, with which part is slow and what fixes it.</p>
      <LastOpenCard />
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
      {result && (
        <div className="mt-3 space-y-2">
          <p className={`text-xs ${worst ? TONE[worst.tone] : TONE.good}`}>
            {worst ? `Slowest part: ${worst.label.toLowerCase()}.` : 'Everything measured is quick.'} This check took {ms(result.totalMs + result.tokenMs)} in all.
          </p>
          {list.map(v => (
            <div key={v.label} className="text-xs border-t border-white/5 pt-2">
              <div className="flex justify-between gap-3">
                <span className="text-gray-400">{v.label}</span>
                <span className={TONE[v.tone]}>{v.value}</span>
              </div>
              {v.note && <p className="text-gray-500 mt-0.5">{v.note}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
