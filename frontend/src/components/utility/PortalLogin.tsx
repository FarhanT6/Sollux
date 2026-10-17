import { useState } from 'react';
import { updateUtility, syncUtility } from '../../api/client';
import { Modal } from '../ui';
import { Sheet, Section, Field, usePhone } from '../../ios';
import { toast } from '../../lib/toast';

/**
 * The provider portal sign-in for one account: where to sign in (filled in
 * from the provider directory or a bill), username and password. Saved
 * encrypted; never shown again (only "saved"). With a login Sollux fetches
 * this account's statements from the portal itself — when a bill-ready
 * email arrives, and on the account's billing cycle.
 */
export default function PortalLogin({ account, website, onClose, onSaved }: {
  account: { id: string; providerName: string; hasCredentials?: boolean };
  website: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const phone = usePhone();
  const [url, setUrl] = useState(website ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const canSave = !!username && !!password;

  async function save(fetchNow: boolean) {
    setBusy(true);
    try {
      const loginUrl = url.trim() ? (/^https?:\/\//.test(url.trim()) ? url.trim() : `https://${url.trim()}`) : undefined;
      await updateUtility(account.id, { username, password, ...(loginUrl ? { loginUrl } : {}) });
      if (fetchNow) {
        await syncUtility(account.id);
        toast(`Signing in to ${account.providerName} to fetch statements…`);
      } else toast('Portal login saved.');
      onSaved();
      onClose();
    } catch (e: any) {
      alert(e?.response?.data?.error ?? 'Could not save the login.');
    } finally { setBusy(false); }
  }

  const note = (
    <p className="text-xs text-gray-500 leading-relaxed" style={phone ? { margin: '0 16px 16px' } : undefined}>
      Stored encrypted. Sollux signs in only to read and download statements — it can't pay, change settings or send anything.
      If the portal texts a code, Sollux asks you for it.
      {account.hasCredentials ? ' A login is already saved; entering a new one replaces it.' : ''}
    </p>
  );

  if (phone) return (
    <Sheet open onClose={onClose} title="Portal login" right={{ label: 'Save', onClick: () => void save(true), disabled: !canSave, busy }}>
      <Section header={account.providerName}>
        <Field label="Website"><input inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="provider.com" value={url} onChange={e => setUrl(e.target.value)} /></Field>
        <Field label="Username"><input autoCapitalize="off" autoCorrect="off" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} /></Field>
        <Field label="Password"><input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></Field>
      </Section>
      {note}
    </Sheet>
  );

  return (
    <Modal title={`Portal login · ${account.providerName}`} onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn text-xs">Cancel</button>
        <button onClick={() => void save(false)} disabled={!canSave || busy} className="btn text-xs disabled:opacity-40">Save</button>
        <button onClick={() => void save(true)} disabled={!canSave || busy} className="btn btn-primary text-xs disabled:opacity-40">{busy ? 'Saving…' : 'Save & fetch statements'}</button>
      </>}>
      <div className="space-y-3">
        <label className="block"><span className="text-xs text-gray-400">Website (where you sign in)</span>
          <input className="input-dark w-full text-sm mt-1" placeholder="https://provider.com" value={url} onChange={e => setUrl(e.target.value)} /></label>
        <label className="block"><span className="text-xs text-gray-400">Username or email</span>
          <input className="input-dark w-full text-sm mt-1" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} /></label>
        <label className="block"><span className="text-xs text-gray-400">Password</span>
          <input type="password" className="input-dark w-full text-sm mt-1" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
        {note}
      </div>
    </Modal>
  );
}
