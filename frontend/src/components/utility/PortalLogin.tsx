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
/** A biller's lookup page (bills by account number and a name or customer ID, no sign-in) — as backend/src/lib/providerDirectory.ts isLookupPage. */
const isLookupPage = (url: string) => /invoicecloud\.com\/.*customerlocator/i.test(url)
  || /munisselfservice\.com\/.*(utilitybilling|customeraccountlink)/i.test(url)
  || /\/(quick-?pay|guest-?pay|pay-?as-?guest|bill-?lookup|find-?my-?(bill|account))\b/i.test(url);

export default function PortalLogin({ account, website, onClose, onSaved }: {
  account: { id: string; providerName: string; hasCredentials?: boolean; lookupName?: string | null; lookupCustomerId?: string | null };
  website: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const phone = usePhone();
  const [url, setUrl] = useState(website ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(account.lookupName ?? '');
  const [customerId, setCustomerId] = useState(account.lookupCustomerId ?? '');
  const [busy, setBusy] = useState(false);
  // A lookup page needs a customer ID (Tyler Munis) or the name on the bill (InvoiceCloud), not a login.
  const lookup = isLookupPage(url);
  const byCustomer = lookup && (/munisselfservice\.com/i.test(url) || !!account.lookupCustomerId);
  const canSave = lookup ? !!(byCustomer ? customerId : name).trim() : !!username && !!password;

  async function save(fetchNow: boolean) {
    setBusy(true);
    try {
      const loginUrl = url.trim() ? (/^https?:\/\//.test(url.trim()) ? url.trim() : `https://${url.trim()}`) : undefined;
      await updateUtility(account.id, {
        ...(username && password ? { username, password } : {}),
        ...(loginUrl ? { loginUrl } : {}),
        lookupName: name.trim() || null,
        lookupCustomerId: customerId.trim() || null,
      });
      if (fetchNow) {
        await syncUtility(account.id);
        toast(lookup ? `Looking up ${account.providerName} bills…` : `Signing in to ${account.providerName} to fetch statements…`);
      } else toast(lookup ? 'Saved.' : 'Portal login saved.');
      onSaved();
      onClose();
    } catch (e: any) {
      alert(e?.response?.data?.error ?? 'Could not save the login.');
    } finally { setBusy(false); }
  }

  const note = (
    <p className="text-xs text-gray-500 leading-relaxed" style={phone ? { margin: '0 16px 16px' } : undefined}>
      {lookup
        ? `This website is a bill lookup page: Sollux finds the bills with the account number and the ${byCustomer ? 'customer ID' : 'name on the bill'}, and never signs in. A username and password are not needed.`
        : <>Stored encrypted. Sollux signs in only to read and download statements — it can't pay, change settings or send anything.
          If the portal texts a code, Sollux asks you for it.
          {account.hasCredentials ? ' A login is already saved; entering a new one replaces it.' : ''}</>}
    </p>
  );

  if (phone) return (
    <Sheet open onClose={onClose} title="Portal login" right={{ label: 'Save', onClick: () => void save(true), disabled: !canSave, busy }}>
      <Section header={account.providerName}>
        <Field label="Website"><input inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="provider.com" value={url} onChange={e => setUrl(e.target.value)} /></Field>
        {lookup ? (byCustomer
          ? <Field label="Customer ID"><input autoCorrect="off" inputMode="numeric" placeholder="As the bill prints it" value={customerId} onChange={e => setCustomerId(e.target.value)} /></Field>
          : <Field label="Name on the bill"><input autoCorrect="off" placeholder="As the bill prints it" value={name} onChange={e => setName(e.target.value)} /></Field>
        ) : <>
          <Field label="Username"><input autoCapitalize="off" autoCorrect="off" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} /></Field>
          <Field label="Password"><input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></Field>
        </>}
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
        <label className="block"><span className="text-xs text-gray-400">Website (where you sign in, or the bill lookup page)</span>
          <input className="input-dark w-full text-sm mt-1" placeholder="https://provider.com" value={url} onChange={e => setUrl(e.target.value)} /></label>
        {lookup ? (byCustomer
          ? <label className="block"><span className="text-xs text-gray-400">Customer ID</span>
            <input className="input-dark w-full text-sm mt-1" placeholder="As the bill prints it" value={customerId} onChange={e => setCustomerId(e.target.value)} /></label>
          : <label className="block"><span className="text-xs text-gray-400">Name on the bill</span>
            <input className="input-dark w-full text-sm mt-1" placeholder="As the bill prints it, e.g. JANE SMITH" value={name} onChange={e => setName(e.target.value)} /></label>
        ) : <>
          <label className="block"><span className="text-xs text-gray-400">Username or email</span>
            <input className="input-dark w-full text-sm mt-1" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} /></label>
          <label className="block"><span className="text-xs text-gray-400">Password</span>
            <input type="password" className="input-dark w-full text-sm mt-1" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
        </>}
        {note}
      </div>
    </Modal>
  );
}
