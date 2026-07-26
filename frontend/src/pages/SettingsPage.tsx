import { useUser, useClerk } from '@clerk/clerk-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePlaidLink } from 'react-plaid-link';
import { PageHeader } from '../components/ui';
import api, {
  getGmailConnectUrl,
  getDriveConnectUrl,
  createPlaidLinkToken,
  exchangePlaidToken,
  getPlaidItems,
  deletePlaidItem,
  syncPlaidBalances,
} from '../api/client';
import type { PlaidItem } from '../api/client';

type SettingsTab = 'account' | 'notifications' | 'banking';

export default function SettingsPage() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') as SettingsTab) || 'account';
  const [gmailStatus, setGmailStatus] = useState<{ connected: boolean; accounts: { id: string; email: string; label?: string }[] } | null>(null);
  const [gmailSuccessMsg, setGmailSuccessMsg] = useState('');
  const [driveStatus, setDriveStatus] = useState<{ connected: boolean; accounts: { id: string; email: string }[] } | null>(null);
  const [driveSuccessMsg, setDriveSuccessMsg] = useState('');

  useEffect(() => {
    api.get('/gmail/status').then(r => setGmailStatus(r.data)).catch(() => {});
    api.get('/drive/status').then(r => setDriveStatus(r.data)).catch(() => {});

    if (window.location.search.includes('gmail=connected')) {
      setGmailSuccessMsg('Gmail connected successfully!');
      setTimeout(() => setGmailSuccessMsg(''), 4000);
    }
    if (window.location.search.includes('drive=connected')) {
      setDriveSuccessMsg('Google Drive connected successfully!');
      setTimeout(() => setDriveSuccessMsg(''), 4000);
    }
    // Auto-switch to banking tab when returning from Plaid OAuth redirect
    // Preserve oauth_state_id so PlaidConnectButton can detect it
    if (window.location.search.includes('oauth_state_id')) {
      const params = new URLSearchParams(window.location.search);
      params.set('tab', 'banking');
      setSearchParams(params, { replace: true });
    }
  }, []);

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle={
          tab === 'notifications' ? 'Configure how and when Sollux alerts you'
          : tab === 'banking'     ? 'Connect bank accounts for automatic daily balance snapshots'
          : 'Manage your account and subscription'
        }
      />

      <div className="flex border-b px-6" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        {(['account', 'notifications', 'banking'] as SettingsTab[]).map(t => (
          <button
            key={t}
            onClick={() => setSearchParams({ tab: t }, { replace: true })}
            className={`text-sm py-3 px-4 border-b-2 transition-colors capitalize ${
              tab === t
                ? 'border-amber-400 text-amber-400 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'banking' ? (
        <BankingTab />
      ) : tab === 'notifications' ? (
        <div className="px-6 py-5 max-w-2xl">
          <div className="card p-5 mb-4">
            <h2 className="text-sm font-semibold text-white mb-4">Alert channels</h2>
            {[
              { label: 'Email notifications', desc: 'Receive alerts and reminders to your email', id: 'email' },
              { label: 'SMS notifications', desc: 'Receive alerts via text message (Pro plan)', id: 'sms' },
              { label: 'Browser push', desc: 'Receive in-browser push notifications', id: 'push' },
            ].map(item => (
              <div key={item.id} className="flex items-center justify-between py-3 border-b border-white/8 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-100">{item.label}</p>
                  <p className="text-xs text-gray-400">{item.desc}</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" defaultChecked={item.id === 'email'} className="sr-only peer" />
                  <div className="w-9 h-5 bg-white/10 peer-checked:bg-gold-500 rounded-full transition-colors" />
                  <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
                </label>
              </div>
            ))}
          </div>

          <div className="card p-5 mb-4">
            <h2 className="text-sm font-semibold text-white mb-4">Alert types</h2>
            {[
              { label: 'Bill due reminders', desc: 'Alert when a bill is due within N days', id: 'due' },
              { label: 'Anomaly detection', desc: 'Alert when a bill is significantly above average', id: 'anomaly' },
              { label: 'Payment confirmations', desc: 'Alert when a payment is recorded', id: 'payment' },
              { label: 'Sync failures', desc: 'Alert when an account fails to sync', id: 'sync' },
            ].map(item => (
              <div key={item.id} className="flex items-center justify-between py-3 border-b border-white/8 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-100">{item.label}</p>
                  <p className="text-xs text-gray-400">{item.desc}</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" defaultChecked className="sr-only peer" />
                  <div className="w-9 h-5 bg-white/10 peer-checked:bg-gold-500 rounded-full transition-colors" />
                  <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
                </label>
              </div>
            ))}
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Reminder timing</h2>
            <div className="flex items-center gap-3">
              <p className="text-sm text-gray-400">Send reminders</p>
              <select className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200">
                <option value="3">3 days before due</option>
                <option value="5">5 days before due</option>
                <option value="7">7 days before due</option>
              </select>
            </div>
          </div>
        </div>
      ) : (
      <div className="px-6 py-5 max-w-2xl">

        <div className="card p-5 mb-4">
          <h2 className="text-sm font-semibold text-white mb-4">Profile</h2>
          <div className="space-y-3">
            <div>
              <p className="text-xs text-gray-400 mb-1">Full name</p>
              <p className="text-sm text-gray-100">{user?.fullName || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Email</p>
              <p className="text-sm text-gray-100">{user?.primaryEmailAddress?.emailAddress || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Member since</p>
              <p className="text-sm text-gray-100">{user?.createdAt ? new Date(user.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—'}</p>
            </div>
          </div>
        </div>

        <div className="card p-5 mb-4">
          <h2 className="text-sm font-semibold text-white mb-4">Subscription</h2>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-300">Pro plan</p>
              <p className="text-xs text-amber-400">Up to 10 properties · Full AI engine · Email + SMS</p>
            </div>
            <span className="pill pill-amber">Active</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button className="btn text-xs justify-center">Manage billing</button>
            <button className="btn text-xs justify-center">Upgrade to Business</button>
          </div>
        </div>

        <div className="card p-5 mb-4">
          <h2 className="text-sm font-semibold text-white mb-4">Connected accounts</h2>
          {gmailSuccessMsg && (
            <p className="text-xs text-green-400 mb-3">{gmailSuccessMsg}</p>
          )}
          {/* List all connected Gmail accounts */}
          {(gmailStatus?.accounts || []).map(acct => (
            <div key={acct.id} className="flex items-center justify-between py-2.5 border-b border-white/8 last:border-0">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 bg-red-500/10 rounded flex items-center justify-center text-xs text-gray-300">G</div>
                <div>
                  <p className="text-sm text-gray-100">{acct.email}</p>
                  {acct.label && <p className="text-xs text-gray-400">{acct.label}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="pill pill-green">&#x2713; Connected</span>
                <button
                  className="btn text-xs text-red-400 border-red-500/30 hover:bg-red-500/10"
                  onClick={() => api.delete(`/gmail/disconnect/${acct.id}`)
                    .then(() => api.get('/gmail/status').then(r => setGmailStatus(r.data)))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          {/* Add another Gmail account */}
          <div className="flex items-center justify-between pt-2.5">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-red-500/10 rounded flex items-center justify-center text-xs text-gray-300">G</div>
              <p className="text-sm text-gray-400">
                {gmailStatus?.connected ? 'Add another Gmail account' : 'Connect Gmail to parse utility emails'}
              </p>
            </div>
            <button
              className="btn text-xs"
              onClick={() => getGmailConnectUrl().then(r => { window.location.href = r.url; })}
            >
              + Connect
            </button>
          </div>
        </div>

        <div className="card p-5 mb-4">
          <h2 className="text-sm font-semibold text-white mb-4">Google Drive</h2>
          {driveSuccessMsg && (
            <p className="text-xs text-green-400 mb-3">{driveSuccessMsg}</p>
          )}
          {(driveStatus?.accounts || []).map(acct => (
            <div key={acct.id} className="flex items-center justify-between py-2.5 border-b border-white/8 last:border-0">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 bg-blue-500/10 rounded flex items-center justify-center text-xs text-gray-300">D</div>
                <p className="text-sm text-gray-100">{acct.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="pill pill-green">&#x2713; Connected</span>
                <button
                  className="btn text-xs text-red-400 border-red-500/30 hover:bg-red-500/10"
                  onClick={() => api.delete(`/drive/disconnect/${acct.id}`)
                    .then(() => api.get('/drive/status').then(r => setDriveStatus(r.data)))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2.5">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-blue-500/10 rounded flex items-center justify-center text-xs text-gray-300">D</div>
              <p className="text-sm text-gray-400">
                {driveStatus?.connected ? 'Add another Drive account' : 'Connect Drive to bulk-import statements from a folder'}
              </p>
            </div>
            <button
              className="btn text-xs"
              onClick={() => getDriveConnectUrl().then(r => { window.location.href = r.url; })}
            >
              + Connect
            </button>
          </div>
        </div>

        <div className="card p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Account actions</h2>
          <div className="space-y-2">
            <button className="btn text-xs w-full justify-center text-gray-400">Export all data (CSV)</button>
            <button
              onClick={() => signOut()}
              className="btn text-xs w-full justify-center text-red-400 border-red-500/30 hover:bg-red-500/10"
            >
              Sign out
            </button>
          </div>
        </div>

      </div>
      )}
    </div>
  );
}

// ── Banking Tab ───────────────────────────────────────────────────────────────

const money = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  CHECKING: 'Checking', SAVINGS: 'Savings', CREDIT_CARD: 'Credit card', CASH_POOL: 'Cash',
};

function PlaidConnectButton({ onSuccess }: { onSuccess: () => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading]     = useState(false);

  // Detect OAuth return: Plaid redirects back with ?oauth_state_id=...
  const oauthRedirectUri = window.location.href.includes('oauth_state_id')
    ? window.location.href
    : undefined;

  useEffect(() => {
    createPlaidLinkToken().then(r => setLinkToken(r.link_token)).catch(() => {});
  }, []);

  const { open, ready } = usePlaidLink({
    token: linkToken ?? '',
    receivedRedirectUri: oauthRedirectUri,
    onSuccess: useCallback(async (public_token: string | null, metadata: any) => {
      if (!public_token) return;
      setLoading(true);
      try {
        await exchangePlaidToken(public_token, metadata);
        // Strip oauth_state_id from URL after success
        window.history.replaceState({}, '', '/settings?tab=banking');
        onSuccess();
      } catch (e: any) {
        alert(e?.response?.data?.error || 'Failed to connect account');
      } finally {
        setLoading(false);
      }
    }, [onSuccess]),
  });

  // Auto-open when returning from OAuth redirect
  useEffect(() => {
    if (oauthRedirectUri && ready) open();
  }, [oauthRedirectUri, ready, open]);

  return (
    <button
      onClick={() => open()}
      disabled={!ready || !linkToken || loading}
      className="btn btn-primary text-xs"
    >
      {loading ? 'Connecting…' : '+ Connect bank'}
    </button>
  );
}

function BankingTab() {
  const [items, setItems] = useState<PlaidItem[]>([]);
  const [loading, setLoading]   = useState(true);
  const [syncing, setSyncing]   = useState(false);
  const [syncMsg, setSyncMsg]   = useState('');

  const loadItems = useCallback(() =>
    getPlaidItems().then(setItems).catch(() => {}), []);

  useEffect(() => {
    loadItems().finally(() => setLoading(false));
  }, [loadItems]);

  async function handleSync() {
    setSyncing(true); setSyncMsg('');
    try {
      const { synced, failed } = await syncPlaidBalances();
      setSyncMsg(`Synced ${synced} connection${synced !== 1 ? 's' : ''}${failed ? ` · ${failed} failed` : ''}`);
      await loadItems();
    } finally { setSyncing(false); }
  }

  async function handleDisconnect(id: string, name: string) {
    if (!confirm(`Disconnect ${name}? Balance history will be kept.`)) return;
    await deletePlaidItem(id);
    setItems(prev => prev.filter(i => i.id !== id));
  }

  const allAccounts = items.flatMap(i => i.accounts);
  const totalCash = allAccounts
    .filter(a => a.accountType !== 'CREDIT_CARD' && a.isActive)
    .reduce((s, a) => s + Number(a.balances[0]?.available ?? a.balances[0]?.balance ?? 0), 0);

  return (
    <div className="px-6 py-5 max-w-2xl">
      {/* Summary */}
      {allAccounts.length > 0 && (
        <div className="card p-4 mb-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Total available cash</p>
            <p className="text-2xl font-semibold text-white">{money(totalCash)}</p>
            <p className="text-xs text-gray-500">Across {allAccounts.filter(a => a.accountType !== 'CREDIT_CARD').length} deposit accounts</p>
          </div>
          <div className="text-right">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="btn text-xs mb-1"
            >
              {syncing ? 'Syncing…' : '↻ Sync now'}
            </button>
            {syncMsg && <p className="text-xs text-emerald-400">{syncMsg}</p>}
          </div>
        </div>
      )}

      {/* Connected items */}
      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading…</div>
      ) : items.length === 0 ? (
        <div className="card p-8 text-center mb-4">
          <p className="text-sm font-medium text-gray-300 mb-1">No bank accounts connected</p>
          <p className="text-xs text-gray-500 mb-4">Connect your accounts to get automatic end-of-day balance snapshots. Works with Chase, Bank of America, Wells Fargo, and 12,000+ other institutions.</p>
        </div>
      ) : (
        <div className="space-y-3 mb-4">
          {items.map(item => (
            <div key={item.id} className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-semibold text-white">{item.institutionName}</p>
                  <p className="text-xs text-gray-500">
                    Last synced: {item.lastSyncedAt ? fmtDate(item.lastSyncedAt) : 'Never'}
                  </p>
                </div>
                <button
                  onClick={() => handleDisconnect(item.id, item.institutionName)}
                  className="text-xs text-red-400 hover:text-red-300 border border-red-500/20 hover:border-red-500/40 rounded-lg px-2.5 py-1.5 transition-colors"
                >
                  Disconnect
                </button>
              </div>
              <div className="space-y-2">
                {item.accounts.map(acct => {
                  const bal = acct.balances[0];
                  const displayBal = acct.accountType === 'CREDIT_CARD'
                    ? Number(bal?.balance ?? 0)
                    : Number(bal?.available ?? bal?.balance ?? 0);
                  return (
                    <div key={acct.id} className="flex items-center justify-between py-2 border-t border-white/5">
                      <div>
                        <p className="text-sm text-gray-100">
                          {acct.name}
                          {acct.last4 && <span className="text-gray-500 ml-1">···{acct.last4}</span>}
                        </p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-xs text-gray-500">{ACCOUNT_TYPE_LABELS[acct.accountType] ?? acct.accountType}</span>
                          {acct.ownerLabel && (
                            <span className="text-xs bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded">{acct.ownerLabel}</span>
                          )}
                          {bal?.source === 'plaid' && (
                            <span className="text-xs text-gray-600">· Auto-synced {fmtDate(bal.asOfDate)}</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-semibold ${acct.accountType === 'CREDIT_CARD' ? 'text-red-400' : 'text-white'}`}>
                          {acct.accountType === 'CREDIT_CARD' ? `(${money(displayBal)})` : money(displayBal)}
                        </p>
                        {bal?.available != null && acct.accountType !== 'CREDIT_CARD' && (
                          <p className="text-xs text-gray-500">{money(Number(bal.balance))} ledger</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <PlaidConnectButton onSuccess={() => loadItems()} />

      <div className="mt-4 rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <p className="text-xs text-gray-500">
          Bank connections are read-only. Sollux uses Plaid to securely fetch balances — your credentials are never stored. Balances snapshot automatically at 11:55 PM every night.
        </p>
      </div>
    </div>
  );
}
