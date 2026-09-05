import { useEffect, useState } from 'react';
import {
  getClickUpStatus, connectClickUp, disconnectClickUp,
  getClickUpTeams, getClickUpSpaces, getClickUpFolders, setClickUpTarget, updateClickUpSettings, syncClickUpBills,
  type ClickUpStatus,
} from '../../api/client';

/**
 * Connect ClickUp with a personal API token, then choose the folder that
 * holds property operations. One list per property is created inside it as
 * needed. The token is stored encrypted and never shown again.
 */
export default function ClickUpCard() {
  const [status, setStatus] = useState<ClickUpStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Picker state — only shown while choosing a target.
  const [picking, setPicking] = useState(false);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([]);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [teamId, setTeamId] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [folderId, setFolderId] = useState('');

  const refresh = () => getClickUpStatus().then(setStatus).catch(() => setStatus({ connected: false }));
  useEffect(() => { refresh(); }, []);

  async function connect() {
    setBusy(true); setError(null);
    try {
      const r = await connectClickUp(token);
      setToken('');
      setTeams(r.teams);
      await refresh();
      setPicking(true);
      if (r.teams.length === 1) { setTeamId(r.teams[0].id); setSpaces(await getClickUpSpaces(r.teams[0].id)); }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Could not connect. Check the token.');
    } finally { setBusy(false); }
  }

  async function startPicking() {
    setBusy(true); setError(null);
    try {
      const t = await getClickUpTeams();
      setTeams(t);
      setPicking(true);
      if (status?.team?.id) { setTeamId(status.team.id); setSpaces(await getClickUpSpaces(status.team.id)); }
      else if (t.length === 1) { setTeamId(t[0].id); setSpaces(await getClickUpSpaces(t[0].id)); }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Could not load workspaces.');
    } finally { setBusy(false); }
  }

  async function chooseTeam(id: string) {
    setTeamId(id); setSpaceId(''); setFolderId(''); setFolders([]);
    setSpaces(id ? await getClickUpSpaces(id) : []);
  }
  async function chooseSpace(id: string) {
    setSpaceId(id); setFolderId('');
    setFolders(id ? await getClickUpFolders(id) : []);
  }

  async function saveTarget() {
    const team = teams.find(t => t.id === teamId), space = spaces.find(s => s.id === spaceId), folder = folders.find(f => f.id === folderId);
    if (!team || !space || !folder) return;
    setBusy(true); setError(null);
    try {
      await setClickUpTarget({ teamId, teamName: team.name, spaceId, spaceName: space.name, folderId, folderName: folder.name });
      setPicking(false);
      await refresh();
      setNote('Operations folder set. Each property gets its own list there as tasks are added.');
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Could not save.');
    } finally { setBusy(false); }
  }

  async function toggleSync(v: boolean) {
    await updateClickUpSettings({ syncBills: v });
    await refresh();
  }

  async function syncNow() {
    setBusy(true); setNote(null); setError(null);
    try {
      const r = await syncClickUpBills();
      setNote(`${r.created} bill task${r.created === 1 ? '' : 's'} created, ${r.updated} refreshed, ${r.closed} closed.${r.skipped.length ? ` Skipped: ${r.skipped.join('; ')}` : ''}`);
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Sync failed.');
    } finally { setBusy(false); }
  }

  async function disconnect() {
    if (!confirm('Disconnect ClickUp?\n\nYour lists and tasks stay in ClickUp. Sollux just stops reading and writing them.')) return;
    setBusy(true);
    try { await disconnectClickUp(); setPicking(false); await refresh(); } finally { setBusy(false); }
  }

  const sel = 'text-xs px-2 py-1.5 rounded-lg text-gray-300 bg-white/5 border border-white/10 focus:outline-none';

  return (
    <div className="card p-5 mb-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">ClickUp</h2>
        {status?.connected && <span className="pill pill-green">&#x2713; Connected{status.user ? ` · ${status.user}` : ''}</span>}
      </div>

      {!status?.connected ? (
        <div>
          <p className="text-xs text-gray-400 mb-3">
            Property operations — repairs, vendors, follow-ups — live in ClickUp. Sollux adds what it knows: a task for every
            unpaid bill, with the amount, due date and penalty date, closed when the bill is paid.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Personal API token (ClickUp → Settings → Apps)"
              className="flex-1 text-sm px-3 py-1.5 rounded-lg text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none"
            />
            <button onClick={connect} disabled={busy || token.length < 10} className="btn btn-primary text-xs disabled:opacity-50">
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">Operations folder</p>
              <p className="text-sm text-gray-100">
                {status.folder ? `${status.team?.name ?? ''} › ${status.space?.name ?? ''} › ${status.folder.name}` : <span className="text-amber-400">Not chosen yet</span>}
              </p>
            </div>
            <button onClick={startPicking} disabled={busy} className="btn text-xs">{status.folder ? 'Change' : 'Choose folder'}</button>
          </div>

          {picking && (
            <div className="flex items-center gap-2 flex-wrap rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <select className={sel} value={teamId} onChange={e => chooseTeam(e.target.value)}>
                <option value="">Workspace…</option>
                {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <select className={sel} value={spaceId} onChange={e => chooseSpace(e.target.value)} disabled={!teamId}>
                <option value="">Space…</option>
                {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select className={sel} value={folderId} onChange={e => setFolderId(e.target.value)} disabled={!spaceId}>
                <option value="">Folder…</option>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <button onClick={saveTarget} disabled={busy || !folderId} className="btn btn-primary text-xs disabled:opacity-50">Use this folder</button>
              <button onClick={() => setPicking(false)} className="btn text-xs">Cancel</button>
              {spaceId && folders.length === 0 && <p className="text-xs text-gray-500 w-full">No folders in this space — create one in ClickUp (e.g. “Properties”) and pick it here.</p>}
            </div>
          )}

          <label className="flex items-center justify-between cursor-pointer">
            <span>
              <span className="text-sm text-gray-200">Bill tasks</span>
              <span className="block text-xs text-gray-500">A task per unpaid bill, with amount, due and penalty dates; closed when paid.</span>
            </span>
            <input type="checkbox" checked={!!status.syncBills} onChange={e => toggleSync(e.target.checked)} className="accent-amber-500" />
          </label>

          <div className="flex items-center gap-2 pt-1">
            {status.folder && status.syncBills && (
              <button onClick={syncNow} disabled={busy} className="btn text-xs disabled:opacity-50">{busy ? 'Syncing…' : '↻ Sync bill tasks now'}</button>
            )}
            <div className="flex-1" />
            <button onClick={disconnect} disabled={busy} className="btn text-xs text-red-400 border-red-500/30 hover:bg-red-500/10">Disconnect</button>
          </div>
        </div>
      )}

      {note && <p className="text-xs text-emerald-400 mt-3">{note}</p>}
      {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
    </div>
  );
}
