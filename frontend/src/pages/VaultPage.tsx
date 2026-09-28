import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shareFile, isNative } from '../lib/native';
import { PageHeader } from '../components/ui';
import {
  getVaultKey, setupVault, rekeyVault, getVaultItems, createVaultItem, updateVaultItem, deleteVaultItem, vaultEvent, getVaultActivity,
  type VaultKeyInfo,
} from '../api/client';
import {
  VAULT_ITERATIONS, deriveKey, newDataKey, wrapDataKey, unwrapDataKey, sealRecord, openRecord,
  newRecoveryKey, normalizeRecoveryKey, passphraseProblem, randomBytes, toB64,
} from '../lib/vaultCrypto';
import { describeApiError } from '../lib/apiError';

/**
 * The vault — bank accounts, cards, logins, ID numbers — encrypted in this
 * browser with a passphrase Sollux never receives. Locks itself after five
 * idle minutes, when the tab is hidden for a minute, and on leaving the page.
 * Fields stay masked until revealed, re-mask after 20 seconds, and copied
 * values are wiped from the clipboard after 30. Every unlock, reveal and
 * copy is logged.
 */

type Kind = 'BANK_ACCOUNT' | 'CARD' | 'LOGIN' | 'ID_DOCUMENT' | 'NOTE';
type Field = { key: string; label: string; secret?: boolean; multiline?: boolean; placeholder?: string };
const KINDS: { kind: Kind; label: string; fields: Field[] }[] = [
  { kind: 'BANK_ACCOUNT', label: 'Bank accounts', fields: [
    { key: 'label', label: 'Name', placeholder: 'Chase business checking' }, { key: 'bank', label: 'Bank' }, { key: 'holder', label: 'Account holder' },
    { key: 'type', label: 'Type', placeholder: 'Checking / savings' }, { key: 'routing', label: 'Routing number', secret: true },
    { key: 'account', label: 'Account number', secret: true }, { key: 'swift', label: 'SWIFT / wire details', secret: true },
    { key: 'username', label: 'Online username', secret: true }, { key: 'password', label: 'Online password', secret: true }, { key: 'url', label: 'Login page' },
    { key: 'notes', label: 'Notes', secret: true, multiline: true },
  ] },
  { kind: 'CARD', label: 'Cards', fields: [
    { key: 'label', label: 'Name', placeholder: 'Amex Platinum' }, { key: 'issuer', label: 'Issuer' }, { key: 'nameOnCard', label: 'Name on card' },
    { key: 'number', label: 'Card number', secret: true }, { key: 'expiry', label: 'Expires (MM/YY)' }, { key: 'zip', label: 'Billing ZIP' },
    { key: 'username', label: 'Online username', secret: true }, { key: 'password', label: 'Online password', secret: true },
    { key: 'notes', label: 'Notes', secret: true, multiline: true },
  ] },
  { kind: 'LOGIN', label: 'Logins', fields: [
    { key: 'label', label: 'Name', placeholder: 'SDG&E portal' }, { key: 'url', label: 'Website' },
    { key: 'username', label: 'Username', secret: true }, { key: 'password', label: 'Password', secret: true }, { key: 'notes', label: 'Notes', secret: true, multiline: true },
  ] },
  { kind: 'ID_DOCUMENT', label: 'ID numbers', fields: [
    { key: 'label', label: 'Name', placeholder: 'Trust EIN' }, { key: 'type', label: 'Type', placeholder: 'SSN, EIN, passport, license…' },
    { key: 'number', label: 'Number', secret: true }, { key: 'issued', label: 'Issued' }, { key: 'expires', label: 'Expires' }, { key: 'notes', label: 'Notes', secret: true, multiline: true },
  ] },
  { kind: 'NOTE', label: 'Secure notes', fields: [{ key: 'label', label: 'Title' }, { key: 'text', label: 'Note', secret: true, multiline: true }] },
];
const KIND = Object.fromEntries(KINDS.map(k => [k.kind, k])) as Record<Kind, typeof KINDS[number]>;
type Rec = { id: string; kind: Kind; data: Record<string, string>; updatedAt: string };

const IDLE_MS = 5 * 60 * 1000;
const HIDDEN_MS = 60 * 1000;
const REVEAL_MS = 20 * 1000;
const CLIPBOARD_MS = 30 * 1000;
const mask = (v: string) => (v.length <= 4 ? '••••' : `•••• ${v.slice(-4)}`);
const looksLikeCvv = (k: string) => /cvv|cvc|security\s*code/i.test(k);

export default function VaultPage() {
  const [info, setInfo] = useState<VaultKeyInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dataKey, setDataKey] = useState<CryptoKey | null>(null);
  const [items, setItems] = useState<Rec[]>([]);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hiddenAt = useRef<number | null>(null);

  const loadInfo = useCallback(() => getVaultKey().then(setInfo).catch(e => setErr(describeApiError(e, 'Could not reach the vault.'))), []);
  useEffect(() => { loadInfo(); }, [loadInfo]);

  const lock = useCallback(() => { setDataKey(null); setItems([]); }, []);

  // Auto-lock: five idle minutes, a minute in another tab, or leaving the page.
  useEffect(() => {
    if (!dataKey) return;
    const bump = () => { if (lockTimer.current) clearTimeout(lockTimer.current); lockTimer.current = setTimeout(lock, IDLE_MS); };
    const vis = () => {
      if (document.hidden) hiddenAt.current = Date.now();
      else if (hiddenAt.current && Date.now() - hiddenAt.current > HIDDEN_MS) lock();
    };
    bump();
    const evs = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];
    evs.forEach(e => window.addEventListener(e, bump, { passive: true }));
    document.addEventListener('visibilitychange', vis);
    return () => { evs.forEach(e => window.removeEventListener(e, bump)); document.removeEventListener('visibilitychange', vis); if (lockTimer.current) clearTimeout(lockTimer.current); };
  }, [dataKey, lock]);
  useEffect(() => () => lock(), [lock]);

  async function openAll(key: CryptoKey) {
    const rows = await getVaultItems();
    const out: Rec[] = [];
    for (const r of rows) {
      try { out.push({ id: r.id, kind: r.kind as Kind, data: await openRecord(key, r.payload), updatedAt: r.updatedAt }); }
      catch { out.push({ id: r.id, kind: r.kind as Kind, data: { label: '(could not decrypt this record)' }, updatedAt: r.updatedAt }); }
    }
    setItems(out);
  }

  if (err && !info) return <div className="p-6 text-sm text-red-400">{err}</div>;
  if (!info) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  return (
    <div>
      <PageHeader title="Vault" subtitle="Bank accounts, cards, logins and ID numbers — encrypted in your browser; only your vault passphrase opens them" />
      <div className="px-6 py-5 max-w-5xl">
        {!info.setUp ? <Setup onDone={async (key) => { await loadInfo(); setDataKey(key); setItems([]); }} />
          : !dataKey ? <Unlock info={info} onOpen={async (key) => { setDataKey(key); await openAll(key); }} onRekeyed={loadInfo} />
          : <Open dataKey={dataKey} info={info} items={items} setItems={setItems} onLock={lock} onRekeyed={loadInfo} />}
      </div>
    </div>
  );
}

// ── First-time setup ─────────────────────────────────────────────────────────
function Setup({ onDone }: { onDone: (key: CryptoKey) => void }) {
  const [p1, setP1] = useState(''); const [p2, setP2] = useState('');
  const [recovery] = useState(newRecoveryKey);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const problem = p1 ? passphraseProblem(p1) : null;

  async function create() {
    if (passphraseProblem(p1) || p1 !== p2 || !saved) return;
    setBusy(true); setErr(null);
    try {
      const salt = toB64(randomBytes(16)), recoverySalt = toB64(randomBytes(16));
      const dk = await newDataKey();
      const [wp, wr] = await Promise.all([
        deriveKey(p1, salt).then(k => wrapDataKey(dk, k)),
        deriveKey(normalizeRecoveryKey(recovery), recoverySalt).then(k => wrapDataKey(dk, k)),
      ]);
      await setupVault({ salt, iterations: VAULT_ITERATIONS, recoverySalt, wrappedByPassphrase: wp, wrappedByRecovery: wr });
      onDone(dk);
    } catch (e) { setErr(describeApiError(e, 'Could not set up the vault.')); }
    finally { setBusy(false); }
  }
  const download = () => {
    const blob = new Blob([`Sollux vault recovery key\n\n${recovery}\n\nKeep this somewhere safe and offline. It opens your vault if you forget the passphrase. Sollux cannot recover the vault without it.\n`], { type: 'text/plain' });
    void shareFile(blob, 'sollux-vault-recovery-key.txt');
  };

  return (
    <div className="card p-5 max-w-xl space-y-4">
      <div>
        <p className="text-sm font-semibold text-white">Set up your vault</p>
        <p className="text-xs text-gray-400 mt-1">Choose a vault passphrase — different from your Sollux login. Everything you store is encrypted with it on this device before it is sent; Sollux, its servers and its AI never see the passphrase or what you store.</p>
      </div>
      <div className="space-y-2">
        <input type="password" autoComplete="new-password" className="input-dark w-full text-sm" placeholder="Vault passphrase (12+ characters)" value={p1} onChange={e => setP1(e.target.value)} />
        {problem && <p className="text-xs text-amber-400">{problem}</p>}
        <input type="password" autoComplete="new-password" className="input-dark w-full text-sm" placeholder="Type it again" value={p2} onChange={e => setP2(e.target.value)} />
        {p2 && p1 !== p2 && <p className="text-xs text-amber-400">The two don't match.</p>}
      </div>
      <div className="rounded-lg p-3 space-y-2" style={{ background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.3)' }}>
        <p className="text-xs text-amber-300 font-medium">Your recovery key — the only way back in if you forget the passphrase</p>
        <p className="font-mono text-sm text-white tracking-wider select-all">{recovery}</p>
        <div className="flex gap-2">
          <button type="button" onClick={download} className="btn text-xs">Download</button>
          <button type="button" onClick={() => navigator.clipboard?.writeText(recovery)} className="btn text-xs">Copy</button>
        </div>
        <p className="text-xs text-gray-400">Print it or keep it offline. Sollux cannot reset your vault — without the passphrase or this key, what's in it is gone for good.</p>
        <label className="flex items-center gap-2 text-xs text-gray-300"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} /> I've saved my recovery key somewhere safe</label>
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
      <button onClick={create} disabled={busy || !!passphraseProblem(p1) || p1 !== p2 || !saved} className="btn btn-primary text-xs disabled:opacity-40">{busy ? 'Encrypting…' : 'Create vault'}</button>
    </div>
  );
}

// ── Unlock (or recover) ──────────────────────────────────────────────────────
function Unlock({ info, onOpen, onRekeyed }: { info: VaultKeyInfo; onOpen: (key: CryptoKey) => void; onRekeyed: () => void }) {
  const [mode, setMode] = useState<'pass' | 'recover'>('pass');
  const [secret, setSecret] = useState('');
  const [newPass, setNewPass] = useState(''); const [newPass2, setNewPass2] = useState('');
  const [newRecovery, setNewRecovery] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<CryptoKey | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);

  async function unlock() {
    setBusy(true); setErr(null);
    try {
      const fresh = await getVaultKey(); // re-read: refused while locked out
      const key = await deriveKey(secret, fresh.salt!, fresh.iterations);
      let dk: CryptoKey;
      try { dk = await unwrapDataKey(fresh.wrappedByPassphrase!, key); }
      catch {
        const r = await vaultEvent('UNLOCK_FAILED').catch(() => ({ lockedUntil: null }));
        setErr(r.lockedUntil ? 'Wrong passphrase. Too many tries — the vault is locked for 15 minutes.' : 'Wrong passphrase.');
        return;
      }
      setSecret('');
      await vaultEvent('UNLOCK').catch(() => {});
      onOpen(dk);
    } catch (e) { setErr(describeApiError(e, 'Could not open the vault.')); }
    finally { setBusy(false); }
  }

  async function recover() {
    if (passphraseProblem(newPass) || newPass !== newPass2) return;
    setBusy(true); setErr(null);
    try {
      const fresh = await getVaultKey();
      let dk: CryptoKey;
      try { dk = await unwrapDataKey(fresh.wrappedByRecovery!, await deriveKey(normalizeRecoveryKey(secret), fresh.recoverySalt!, fresh.iterations)); }
      catch { await vaultEvent('UNLOCK_FAILED').catch(() => {}); setErr('That recovery key does not open this vault.'); return; }
      // A used recovery key is replaced, and the new passphrase set.
      const rk = newRecoveryKey();
      const salt = toB64(randomBytes(16)), recoverySalt = toB64(randomBytes(16));
      const [wp, wr] = await Promise.all([
        deriveKey(newPass, salt).then(k => wrapDataKey(dk, k)),
        deriveKey(normalizeRecoveryKey(rk), recoverySalt).then(k => wrapDataKey(dk, k)),
      ]);
      await rekeyVault({ salt, iterations: VAULT_ITERATIONS, recoverySalt, wrappedByPassphrase: wp, wrappedByRecovery: wr, recovered: true });
      // Show the new recovery key before opening; the old one no longer works.
      setNewRecovery(rk); setPendingKey(dk); setSecret('');
      await vaultEvent('UNLOCK').catch(() => {});
    } catch (e) { setErr(describeApiError(e, 'Could not recover the vault.')); }
    finally { setBusy(false); }
  }

  if (newRecovery && pendingKey) {
    return (
      <div className="card p-5 max-w-xl space-y-3">
        <p className="text-sm font-semibold text-white">New passphrase set — here is your new recovery key</p>
        <p className="font-mono text-sm text-white tracking-wider select-all">{newRecovery}</p>
        <p className="text-xs text-gray-400">The old recovery key no longer works. Save this one somewhere safe and offline before continuing.</p>
        <div className="flex gap-2">
          <button onClick={() => navigator.clipboard?.writeText(newRecovery)} className="btn text-xs">Copy</button>
          <button onClick={() => { const k = pendingKey; setNewRecovery(null); setPendingKey(null); onRekeyed(); onOpen(k); }} className="btn btn-primary text-xs">I've saved it — open the vault</button>
        </div>
      </div>
    );
  }
  return (
    <div className="card p-5 max-w-md space-y-3">
      <p className="text-sm font-semibold text-white">🔒 Vault locked</p>
      {mode === 'pass' ? (
        <form onSubmit={e => { e.preventDefault(); if (secret) unlock(); }} className="space-y-2">
          <input type="password" autoComplete="current-password" autoFocus className="input-dark w-full text-sm" placeholder="Vault passphrase" value={secret} onChange={e => setSecret(e.target.value)} />
          <button type="submit" disabled={busy || !secret} className="btn btn-primary text-xs disabled:opacity-40">{busy ? 'Unlocking…' : 'Unlock'}</button>
          <button type="button" onClick={() => { setMode('recover'); setSecret(''); setErr(null); }} className="text-xs text-gray-500 hover:text-gray-300 ml-3">Forgot passphrase?</button>
        </form>
      ) : (
        <form onSubmit={e => { e.preventDefault(); recover(); }} className="space-y-2">
          <input className="input-dark w-full text-sm font-mono" placeholder="Recovery key (XXXXX-XXXXX-…)" value={secret} onChange={e => setSecret(e.target.value)} autoFocus />
          <input type="password" autoComplete="new-password" className="input-dark w-full text-sm" placeholder="New vault passphrase" value={newPass} onChange={e => setNewPass(e.target.value)} />
          {newPass && passphraseProblem(newPass) && <p className="text-xs text-amber-400">{passphraseProblem(newPass)}</p>}
          <input type="password" autoComplete="new-password" className="input-dark w-full text-sm" placeholder="Type it again" value={newPass2} onChange={e => setNewPass2(e.target.value)} />
          <p className="text-xs text-gray-500">You'll get a new recovery key after this; the old one stops working.</p>
          <button type="submit" disabled={busy || !secret || !!passphraseProblem(newPass) || newPass !== newPass2} className="btn btn-primary text-xs disabled:opacity-40">{busy ? 'Recovering…' : 'Recover and set passphrase'}</button>
          <button type="button" onClick={() => { setMode('pass'); setSecret(''); setErr(null); }} className="text-xs text-gray-500 hover:text-gray-300 ml-3">Back</button>
        </form>
      )}
      {err && <p className="text-xs text-red-400">{err}</p>}
      <p className="text-xs text-gray-600">Locks after 5 idle minutes. Five wrong passphrases lock it for 15 minutes.</p>
      {info.iterations && info.iterations < VAULT_ITERATIONS && <p className="text-xs text-amber-400">This vault uses older settings — change the passphrase once to strengthen it.</p>}
    </div>
  );
}

// ── Unlocked ─────────────────────────────────────────────────────────────────
function Open({ dataKey, info, items, setItems, onLock, onRekeyed }: {
  dataKey: CryptoKey; info: VaultKeyInfo; items: Rec[]; setItems: (f: (x: Rec[]) => Rec[]) => void; onLock: () => void; onRekeyed: () => void;
}) {
  const [editing, setEditing] = useState<{ kind: Kind; id?: string; data: Record<string, string> } | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'items' | 'activity' | 'settings'>('items');
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const reveal = (id: string, key: string) => {
    const k = `${id}:${key}`;
    setRevealed(s => new Set(s).add(k));
    vaultEvent('REVEAL', id).catch(() => {});
    setTimeout(() => setRevealed(s => { const n = new Set(s); n.delete(k); return n; }), REVEAL_MS);
  };
  const copy = async (id: string, key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      vaultEvent('COPY', id).catch(() => {});
      setCopied(`${id}:${key}`); setTimeout(() => setCopied(null), 1500);
      // Clear the clipboard after 30 seconds, if it still holds this value.
      // On the phone reading the clipboard asks the owner's permission every
      // time, so the value is cleared without checking; on the web only if
      // it is still what was copied.
      setTimeout(async () => { try { if (isNative || (await navigator.clipboard.readText()) === value) await navigator.clipboard.writeText(''); } catch { /* permission */ } }, CLIPBOARD_MS);
    } catch { setErr('The browser would not allow copying.'); }
  };

  async function save() {
    if (!editing) return;
    setErr(null);
    const data = Object.fromEntries(Object.entries(editing.data).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    if (!data.label) { setErr('Give it a name.'); return; }
    try {
      const payload = await sealRecord(dataKey, data);
      if (editing.id) {
        const r = await updateVaultItem(editing.id, editing.kind, payload);
        setItems(xs => xs.map(x => (x.id === editing.id ? { ...x, kind: editing.kind, data, updatedAt: r.updatedAt } : x)));
      } else {
        const r = await createVaultItem(editing.kind, payload);
        setItems(xs => [...xs, { id: r.id, kind: editing.kind, data, updatedAt: r.updatedAt }]);
      }
      setEditing(null);
    } catch (e) { setErr(describeApiError(e, 'Could not save.')); }
  }
  async function remove(id: string) {
    if (!confirm('Delete this record from the vault? This cannot be undone.')) return;
    await deleteVaultItem(id);
    setItems(xs => xs.filter(x => x.id !== id));
  }

  const q = search.trim().toLowerCase();
  const shown = useMemo(() => items.filter(i => !q || Object.entries(i.data).some(([k, v]) => !KIND[i.kind]?.fields.find(f => f.key === k)?.secret && v.toLowerCase().includes(q))), [items, q]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {(['items', 'activity', 'settings'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`text-xs px-3 py-1.5 rounded-lg ${tab === t ? 'bg-amber-500/20 text-amber-300' : 'text-gray-400 hover:text-gray-200'}`}>{t === 'items' ? 'Records' : t === 'activity' ? 'Access log' : 'Security'}</button>
        ))}
        <span className="text-xs text-emerald-400 ml-2">🔓 Unlocked · locks after 5 idle minutes</span>
        <button onClick={onLock} className="btn text-xs ml-auto">🔒 Lock now</button>
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}

      {tab === 'items' && (
        <>
          <div className="flex gap-2 flex-wrap">
            <input className="input-dark text-sm w-64" placeholder="Search names, banks, sites…" value={search} onChange={e => setSearch(e.target.value)} />
            {KINDS.map(k => <button key={k.kind} onClick={() => setEditing({ kind: k.kind, data: {} })} className="btn text-xs">+ {k.label.replace(/s$/, '').replace(/ numbers$/, ' number')}</button>)}
          </div>

          {editing && (
            <div className="card p-4 space-y-3">
              <p className="text-sm font-semibold text-white">{editing.id ? 'Edit' : 'New'} — {KIND[editing.kind].label.replace(/s$/, '')}</p>
              <div className="grid md:grid-cols-2 gap-3">
                {KIND[editing.kind].fields.map(f => (
                  <div key={f.key} className={f.multiline ? 'md:col-span-2' : ''}>
                    <span className="block text-xs text-gray-500 mb-1">{f.label}{f.secret ? ' 🔒' : ''}</span>
                    {f.multiline
                      ? <textarea rows={3} className="input-dark w-full text-sm" value={editing.data[f.key] ?? ''} onChange={e => setEditing(ed => ed && { ...ed, data: { ...ed.data, [f.key]: e.target.value } })} />
                      : <input type={f.secret ? 'password' : 'text'} autoComplete="off" className="input-dark w-full text-sm" placeholder={f.placeholder} value={editing.data[f.key] ?? ''} onChange={e => setEditing(ed => ed && { ...ed, data: { ...ed.data, [f.key]: e.target.value } })} />}
                  </div>
                ))}
              </div>
              {editing.kind === 'CARD' && <p className="text-xs text-gray-500">There's no place for the 3–4 digit security code (CVV) on purpose: it's the one thing card rules say never to store, and it's on the card when you need it.</p>}
              {Object.entries(editing.data).some(([k, v]) => looksLikeCvv(k) || (editing.kind === 'CARD' && k === 'notes' && /\b(cvv|cvc)\b/i.test(v))) && <p className="text-xs text-amber-400">Please don't store the card's security code.</p>}
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditing(null)} className="btn text-xs">Cancel</button>
                <button onClick={save} className="btn btn-primary text-xs">Encrypt & save</button>
              </div>
            </div>
          )}

          {KINDS.map(k => {
            const group = shown.filter(i => i.kind === k.kind);
            if (!group.length) return null;
            return (
              <div key={k.kind}>
                <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">{k.label}</p>
                <div className="grid md:grid-cols-2 gap-3">
                  {group.map(i => (
                    <div key={i.id} className="card p-4">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <p className="text-sm font-semibold text-white">{i.data.label}</p>
                        <div className="flex gap-2 text-xs">
                          <button onClick={() => setEditing({ kind: i.kind, id: i.id, data: { ...i.data } })} className="text-gray-400 hover:text-gray-200">Edit</button>
                          <button onClick={() => remove(i.id)} className="text-red-400 hover:text-red-300">Delete</button>
                        </div>
                      </div>
                      <div className="space-y-1">
                        {k.fields.filter(f => f.key !== 'label' && i.data[f.key]).map(f => {
                          const v = i.data[f.key]!; const shownV = !f.secret || revealed.has(`${i.id}:${f.key}`);
                          return (
                            <div key={f.key} className="flex items-start gap-2 text-xs">
                              <span className="text-gray-500 w-32 shrink-0">{f.label}</span>
                              <span className={`text-gray-200 break-all flex-1 ${f.multiline ? 'whitespace-pre-wrap' : 'font-mono'}`}>{shownV ? v : f.multiline ? '••••••' : mask(v)}</span>
                              {f.secret && !shownV && <button onClick={() => reveal(i.id, f.key)} className="text-amber-400 hover:text-amber-300 shrink-0">Show</button>}
                              <button onClick={() => copy(i.id, f.key, v)} className="text-gray-400 hover:text-gray-200 shrink-0">{copied === `${i.id}:${f.key}` ? 'Copied' : 'Copy'}</button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {items.length === 0 && !editing && <p className="text-sm text-gray-500">Nothing stored yet. Add a bank account, card, login, ID number or note above.</p>}
        </>
      )}

      {tab === 'activity' && <Activity items={items} />}
      {tab === 'settings' && <Security dataKey={dataKey} info={info} onRekeyed={onRekeyed} />}
    </div>
  );
}

function Activity({ items }: { items: Rec[] }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof getVaultActivity>> | null>(null);
  useEffect(() => { getVaultActivity().then(setRows).catch(() => setRows([])); }, []);
  const name = (id: string | null) => (id ? items.find(i => i.id === id)?.data.label ?? '(deleted record)' : '');
  const LABEL: Record<string, string> = { UNLOCK: 'Unlocked', UNLOCK_FAILED: 'Wrong passphrase', REVEAL: 'Revealed a field', COPY: 'Copied a field', CREATE: 'Added', UPDATE: 'Edited', DELETE: 'Deleted', SETUP: 'Vault created', PASSPHRASE_CHANGED: 'Passphrase changed', RECOVERED: 'Recovered with the recovery key' };
  if (!rows) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <div className="card p-4">
      <p className="text-xs text-gray-500 mb-2">Every access to your vault. Anything you don't recognise: change the vault passphrase and your Sollux password.</p>
      <table className="table-base text-xs">
        <thead><tr><th className="text-left">When</th><th className="text-left">What</th><th className="text-left">Record</th><th className="text-left">From</th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id}>
            <td className="whitespace-nowrap text-gray-400">{new Date(r.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
            <td className={r.action === 'UNLOCK_FAILED' ? 'text-red-400' : 'text-gray-200'}>{LABEL[r.action] ?? r.action}</td>
            <td className="text-gray-400">{name(r.itemId)}</td>
            <td className="text-gray-600 truncate max-w-[16rem]">{r.ip ?? ''}{r.userAgent ? ` · ${r.userAgent.replace(/\(.*?\)/g, '').slice(0, 40)}` : ''}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Security({ dataKey, info, onRekeyed }: { dataKey: CryptoKey; info: VaultKeyInfo; onRekeyed: () => void }) {
  const [p1, setP1] = useState(''); const [p2, setP2] = useState('');
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function change() {
    if (passphraseProblem(p1) || p1 !== p2) return;
    setBusy(true); setMsg(null);
    try {
      const salt = toB64(randomBytes(16));
      const wp = await wrapDataKey(dataKey, await deriveKey(p1, salt));
      await rekeyVault({ salt, iterations: VAULT_ITERATIONS, recoverySalt: info.recoverySalt!, wrappedByPassphrase: wp, wrappedByRecovery: info.wrappedByRecovery! });
      setP1(''); setP2(''); setMsg('Passphrase changed. Your recovery key still works.'); onRekeyed();
    } catch (e) { setMsg(describeApiError(e, 'Could not change the passphrase.')); }
    finally { setBusy(false); }
  }
  return (
    <div className="card p-4 max-w-xl space-y-3">
      <p className="text-sm font-semibold text-white">How your vault is protected</p>
      <ul className="text-xs text-gray-400 list-disc pl-5 space-y-1">
        <li>Encrypted in this browser (AES-256-GCM) with a key made from your passphrase (PBKDF2-SHA256, 600,000 rounds). Sollux never receives the passphrase or anything readable.</li>
        <li>Encrypted a second time on the server before it is stored.</li>
        <li>Not visible to Sollux's AI, agents, imports or exports.</li>
        <li>Locks after 5 idle minutes, a minute in another tab, or leaving the page. Five wrong passphrases lock it for 15 minutes.</li>
        <li>Fields hide again after 20 seconds; copied values are cleared from the clipboard after 30.</li>
        <li>Every unlock, reveal, copy and change is in the access log.</li>
      </ul>
      <p className="text-sm font-semibold text-white pt-2">Change vault passphrase</p>
      <input type="password" autoComplete="new-password" className="input-dark w-full text-sm" placeholder="New passphrase" value={p1} onChange={e => setP1(e.target.value)} />
      {p1 && passphraseProblem(p1) && <p className="text-xs text-amber-400">{passphraseProblem(p1)}</p>}
      <input type="password" autoComplete="new-password" className="input-dark w-full text-sm" placeholder="Type it again" value={p2} onChange={e => setP2(e.target.value)} />
      <button onClick={change} disabled={busy || !!passphraseProblem(p1) || p1 !== p2} className="btn btn-primary text-xs disabled:opacity-40">{busy ? 'Re-encrypting…' : 'Change passphrase'}</button>
      {msg && <p className="text-xs text-gray-300">{msg}</p>}
    </div>
  );
}
