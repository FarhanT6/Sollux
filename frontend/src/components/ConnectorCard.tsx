import { useEffect, useState } from 'react';
import { getConnectorDevices, createConnectorDevice, removeConnectorDevice, apiOrigin, type ConnectorDevice } from '../api/client';
import { fmtMoment } from '../lib/date';
import { toast } from '../lib/toast';

/**
 * Fetch from your computer: the Sollux connector (public/sollux-connector.mjs)
 * runs a Chrome on the owner's computer, and portal fetches go through it from
 * their home internet — sites that turn away cloud servers let it in.
 */
export default function ConnectorCard() {
  const [devices, setDevices] = useState<ConnectorDevice[] | null>(null);
  const [name, setName] = useState('My computer');
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => getConnectorDevices().then(setDevices).catch(() => setDevices([]));
  useEffect(() => { void load(); }, []);
  // While a new code waits to be used, watch for the computer to come online.
  useEffect(() => {
    if (!made) return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [made]);

  const online = devices?.find(d => d.online);
  const script = `${window.location.origin}/sollux-connector.mjs`;
  const command = made ? `curl -fsSLO ${script} && node sollux-connector.mjs --api ${apiOrigin()} --token ${made.token}` : '';

  async function create() {
    setBusy(true);
    try { const d = await createConnectorDevice(name.trim() || 'My computer'); setMade({ name: d.name, token: d.token }); await load(); }
    catch (e: any) { toast(e?.response?.data?.error ?? 'Could not create a connection code.', 'error'); }
    finally { setBusy(false); }
  }
  async function remove(d: ConnectorDevice) {
    if (!window.confirm(`Disconnect ${d.name}? Fetches go back to Sollux's own browser.`)) return;
    try { await removeConnectorDevice(d.id); await load(); } catch { toast('Could not remove it.', 'error'); }
  }
  const copy = (t: string) => void navigator.clipboard.writeText(t).then(() => toast('Copied'), () => toast('Select the text and copy it', 'error'));

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Fetch from your computer</h2>
        <span className={`text-xs ${online ? 'text-green-400' : 'text-gray-500'}`}>{online ? `● ${online.name} is online` : devices?.length ? '○ Offline' : 'Not set up'}</span>
      </div>
      <p className="text-xs text-gray-400 mt-1">
        Sites like SDG&amp;E, T-Mobile and Safeco turn away Sollux's cloud browser. Run the Sollux connector on a computer that is usually on, and fetches go through a Chrome
        window there, from your own internet. Your logins are still typed by Sollux; the connector can only control that one Chrome window, nothing else on the computer.
        When it is off, Sollux uses its own browser as before.
      </p>

      {devices && devices.length > 0 && (
        <div className="mt-3 space-y-1">
          {devices.map(d => (
            <div key={d.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-gray-200 min-w-0 truncate">
                <span className={d.online ? 'text-green-400' : 'text-gray-600'}>●</span> {d.name}
                <span className="text-gray-500"> · {d.online ? 'online' : d.lastSeenAt ? `last seen ${fmtMoment(d.lastSeenAt)}` : 'never connected'}{d.agent ? ` · ${d.agent}` : ''}</span>
              </span>
              <button className="text-gray-500 hover:text-red-300" onClick={() => void remove(d)}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {made ? (
        <div className="mt-4 rounded-lg border border-white/10 p-3 space-y-2 text-xs text-gray-300">
          <p className="text-gray-100">Connect “{made.name}”:</p>
          <p>1. It needs <a className="text-amber-400 underline" href="https://nodejs.org" target="_blank" rel="noreferrer">Node.js 22 or newer</a> and Google Chrome.</p>
          <p>2. Open Terminal (Mac) or PowerShell (Windows — type <code>curl.exe</code> instead of <code>curl</code>) on that computer and run:</p>
          <div className="flex items-start gap-2">
            <code className="flex-1 break-all rounded bg-black/40 p-2 text-[11px] text-amber-200">{command}</code>
            <button className="btn text-xs" onClick={() => copy(command)}>Copy</button>
          </div>
          <p>3. A Chrome window opens and the Terminal says “Connected”. Leave Terminal running (the Chrome window can be minimized or closed — it reopens when needed). Next time, just run <code>node sollux-connector.mjs</code> in the same folder.</p>
          <p className="text-gray-500">This code is shown once and works only for your account. {devices?.some(d => d.online) ? <span className="text-green-400">Connected ✓</span> : 'Waiting for the computer to connect…'}</p>
          <button className="text-gray-400 hover:text-gray-200" onClick={() => setMade(null)}>Done</button>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2">
          <input className="input-dark text-xs flex-1" value={name} onChange={e => setName(e.target.value)} placeholder="Name for this computer" maxLength={60} />
          <button className="btn btn-primary text-xs whitespace-nowrap" disabled={busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Connect a computer'}</button>
        </div>
      )}
    </div>
  );
}
