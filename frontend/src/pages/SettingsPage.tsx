import { useUser, useClerk } from '@clerk/clerk-react';
import ClickUpCard from '../components/settings/ClickUpCard';
import LetterheadCard from '../components/settings/LetterheadCard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePlaidLink } from 'react-plaid-link';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { PageHeader } from '../components/ui';
import api, {
  getGmailConnectUrl,
  getDriveConnectUrl,
  createPlaidLinkToken,
  exchangePlaidToken,
  getPlaidItems,
  deletePlaidItem,
  syncPlaidBalances,
  getBankAccounts,
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
  recordBankBalance,
  getIndexRates,
  createIndexRate,
  deleteIndexRate,
} from '../api/client';
import type { PlaidItem } from '../api/client';
import type { BankAccount, IndexRate } from '../types';
import { format } from 'date-fns';
import { fmtDate as fmtDateSafe } from '../lib/date';
import { getAccount, inviteAccountMember, cancelAccountInvite, removeAccountMember,
  getNotificationPreferences, updateNotificationPreferences } from '../api/client';
import type { AccountInfo } from '../api/client';

type SettingsTab = 'account' | 'notifications' | 'banking' | 'rates';

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
          : tab === 'rates'       ? 'Reference rate history for variable-rate loans (e.g. WSJ Prime Rate)'
          : 'Manage your account and subscription'
        }
      />

      <div className="flex border-b px-6" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        {(['account', 'notifications', 'banking', 'rates'] as SettingsTab[]).map(t => (
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
        <NotificationsTab />
      ) : tab === 'rates' ? (
        <RatesTab />
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

        <SharedAccessCard />

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

        <LetterheadCard />
        <ClickUpCard />

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

// ── Rates Tab ────────────────────────────────────────────────────────────────

function RatesTab() {
  const [rates, setRates]     = useState<IndexRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [rate, setRate]       = useState('');
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes]     = useState('');
  const [saving, setSaving]   = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getIndexRates('PRIME').then(setRates).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAdd() {
    if (!rate || !effectiveDate) return;
    setSaving(true);
    try {
      await createIndexRate({ indexName: 'PRIME', rate: parseFloat(rate), effectiveDate, notes: notes || undefined });
      setRate(''); setNotes('');
      load();
    } finally { setSaving(false); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this rate entry?')) return;
    await deleteIndexRate(id);
    setRates(prev => prev.filter(r => r.id !== id));
  }

  const current = rates[0];

  return (
    <div className="px-6 py-5 max-w-2xl">
      <div className="card p-5 mb-4">
        <h2 className="text-sm font-semibold text-white mb-1">WSJ Prime Rate</h2>
        <p className="text-xs text-gray-500 mb-4">
          Sollux has no live market data feed — log Prime rate changes here as they happen (or whenever you notice one),
          and every variable-rate loan indexed to Prime recalculates its interest rate automatically on its own reset anniversary.
        </p>
        {current && (
          <div className="rounded-lg px-3 py-2.5 mb-4" style={{ background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.2)' }}>
            <p className="text-xs text-gray-400">Current Prime</p>
            <p className="text-lg font-semibold text-amber-400">{current.rate}%</p>
            <p className="text-xs text-gray-500">as of {fmtDateSafe(current.effectiveDate, 'MMM d, yyyy')}</p>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">New rate (%)</label>
            <input type="number" step="0.001" value={rate} onChange={e => setRate(e.target.value)} className="input-dark w-full text-sm" placeholder="8.50" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Effective date</label>
            <input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} className="input-dark w-full text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Notes (optional)</label>
            <input value={notes} onChange={e => setNotes(e.target.value)} className="input-dark w-full text-sm" placeholder="Fed cut" />
          </div>
        </div>
        <button onClick={handleAdd} disabled={saving || !rate || !effectiveDate} className="btn-primary text-sm px-4 py-2 disabled:opacity-50">
          {saving ? 'Saving…' : '+ Log rate change'}
        </button>
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold text-white mb-3">History</h2>
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : rates.length === 0 ? (
          <p className="text-sm text-gray-500">No Prime rate logged yet — add one above to activate any variable-rate loans.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-white/5">
                  <th className="text-left pb-2">Effective</th>
                  <th className="text-right pb-2">Rate</th>
                  <th className="text-left pb-2 pl-3">Notes</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {rates.map(r => (
                  <tr key={r.id} className="border-b border-white/5">
                    <td className="py-2 text-gray-300">{fmtDateSafe(r.effectiveDate, 'MMM d, yyyy')}</td>
                    <td className="py-2 text-right text-white font-medium">{r.rate}%</td>
                    <td className="py-2 pl-3 text-gray-500">{r.notes || '—'}</td>
                    <td className="py-2 text-right">
                      <button onClick={() => handleDelete(r.id)} className="text-xs text-red-500 hover:text-red-400">Del</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Banking Tab ───────────────────────────────────────────────────────────────

const money = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const fmtDate = (d: string | null | undefined) => fmtDateSafe(d);

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  CHECKING: 'Checking', SAVINGS: 'Savings', CREDIT_CARD: 'Credit card', CASH_POOL: 'Cash / Wallet',
};

const MANUAL_PRESETS = [
  { name: 'Venmo',        bank: 'Venmo',    accountType: 'CASH_POOL' as const },
  { name: 'Apple Cash',   bank: 'Apple',    accountType: 'CASH_POOL' as const },
  { name: 'Cash App',     bank: 'Cash App', accountType: 'CASH_POOL' as const },
  { name: 'PayPal',       bank: 'PayPal',   accountType: 'CASH_POOL' as const },
  { name: 'Cash on Hand', bank: '',         accountType: 'CASH_POOL' as const },
];

// ── Sortable Plaid institution card ──────────────────────────────────────────
function SortablePlaidCard({
  item, balVisible, disp, onDisconnect, onToggleWatch,
}: {
  item: PlaidItem;
  balVisible: boolean;
  disp: (n: number | null | undefined) => string;
  onDisconnect: (id: string, name: string) => void;
  onToggleWatch: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };

  const accounts = item.accounts.filter((acct, idx, arr) =>
    arr.findIndex(a => a.name === acct.name && a.last4 === acct.last4) === idx
  );

  return (
    <div ref={setNodeRef} style={style} className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <button
            className="text-gray-600 hover:text-gray-400 cursor-grab active:cursor-grabbing touch-none select-none px-1"
            title="Drag to reorder"
            {...attributes} {...listeners}
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
              <circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>
              <circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>
              <circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/>
            </svg>
          </button>
          <div>
            <p className="text-sm font-semibold text-white">{item.institutionName}</p>
            <p className="text-xs text-gray-500">Last synced: {item.lastSyncedAt ? fmtDate(item.lastSyncedAt) : 'Never'}</p>
          </div>
        </div>
        <button
          onClick={() => onDisconnect(item.id, item.institutionName)}
          className="text-xs text-red-400 hover:text-red-300 border border-red-500/20 hover:border-red-500/40 rounded-lg px-2.5 py-1.5 transition-colors"
        >Disconnect</button>
      </div>
      <div className="space-y-2">
        {accounts.map(acct => {
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
                {acct.accountType !== 'CREDIT_CARD' && (
                  <div className="mt-1.5 space-y-1">
                    <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!acct.watchForRentPayments}
                        onChange={async e => { await updateBankAccount(acct.id, { watchForRentPayments: e.target.checked }); onToggleWatch(); }}
                      />
                      Watch for rent payments (Zelle/Venmo/PayPal/Cash App)
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!acct.watchForExpenses}
                        onChange={async e => { await updateBankAccount(acct.id, { watchForExpenses: e.target.checked }); onToggleWatch(); }}
                      />
                      Watch for expenses (hardware stores, utility payments)
                    </label>
                  </div>
                )}
              </div>
              <div className="text-right">
                <p className={`text-sm font-semibold ${acct.accountType === 'CREDIT_CARD' ? 'text-red-400' : 'text-white'}`}>
                  {balVisible
                    ? (acct.accountType === 'CREDIT_CARD' ? `(${disp(displayBal)})` : disp(displayBal))
                    : '••••'}
                </p>
                {bal?.available != null && acct.accountType !== 'CREDIT_CARD' && balVisible && (
                  <p className="text-xs text-gray-500">{money(Number(bal.balance))} ledger</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Add manual account modal ──────────────────────────────────────────────────
function AddManualAccountModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [bank, setBank] = useState('');
  const [accountType, setAccountType] = useState<'CHECKING' | 'SAVINGS' | 'CREDIT_CARD' | 'CASH_POOL'>('CASH_POOL');
  const [balance, setBalance] = useState('');
  const [saving, setSaving] = useState(false);

  function applyPreset(p: typeof MANUAL_PRESETS[number]) {
    setName(p.name); setBank(p.bank); setAccountType(p.accountType);
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const acct = await createBankAccount({ name: name.trim(), bank: bank.trim() || undefined, accountType });
      if (balance && !isNaN(parseFloat(balance))) {
        await recordBankBalance(acct.id, { balance: parseFloat(balance) });
      }
      onSaved();
    } catch { } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }} onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl p-6" style={{ background: '#1a1a1a', border: '1px solid rgba(255,255,255,0.1)' }} onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-white mb-4">Add account</h2>

        {/* Quick presets */}
        <p className="text-xs text-gray-500 mb-2">Quick add</p>
        <div className="flex flex-wrap gap-1.5 mb-4">
          {MANUAL_PRESETS.map(p => (
            <button key={p.name} onClick={() => applyPreset(p)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${name === p.name ? 'bg-amber-500/15 border-amber-500/40 text-amber-400' : 'border-white/10 text-gray-400 hover:border-white/20'}`}>
              {p.name}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Account name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. My Venmo"
              className="w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-600 focus:border-amber-500/40 outline-none" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Institution (optional)</label>
            <input value={bank} onChange={e => setBank(e.target.value)} placeholder="e.g. Chase"
              className="w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-600 focus:border-amber-500/40 outline-none" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Type</label>
            <select value={accountType} onChange={e => setAccountType(e.target.value as any)}
              className="w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-white focus:border-amber-500/40 outline-none">
              <option value="CHECKING">Checking</option>
              <option value="SAVINGS">Savings</option>
              <option value="CREDIT_CARD">Credit card</option>
              <option value="CASH_POOL">Cash / Digital wallet</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Current balance ($)</label>
            <input value={balance} onChange={e => setBalance(e.target.value)} placeholder="0.00" type="number" step="0.01"
              className="w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-600 focus:border-amber-500/40 outline-none" />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="btn text-xs">Cancel</button>
          <button onClick={handleSave} disabled={!name.trim() || saving} className="btn btn-primary text-xs">
            {saving ? 'Saving…' : 'Add account'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main BankingTab ───────────────────────────────────────────────────────────
function BankingTab() {
  // balance visibility — hidden by default each session
  const [balVisible, setBalVisible] = useState(() => sessionStorage.getItem('sollux_bal_vis') === '1');
  const toggleBal = () => setBalVisible(v => {
    const next = !v;
    sessionStorage.setItem('sollux_bal_vis', next ? '1' : '0');
    return next;
  });
  const disp = (n: number | null | undefined) => balVisible ? money(n) : '——';

  const [items, setItems] = useState<PlaidItem[]>([]);
  const [itemIds, setItemIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('sollux_plaid_order') || '[]'); } catch { return []; }
  });
  const [manualAccounts, setManualAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading]     = useState(true);
  const [syncing, setSyncing]     = useState(false);
  const [syncMsg, setSyncMsg]     = useState('');
  const [showAddManual, setShowAddManual] = useState(false);
  const [editingBal, setEditingBal] = useState<string | null>(null);
  const [editingBalVal, setEditingBalVal] = useState('');
  const [savingBal, setSavingBal] = useState(false);

  const sortedItems = useMemo(() => {
    if (!itemIds.length) return items;
    const idx = Object.fromEntries(itemIds.map((id, i) => [id, i]));
    return [...items].sort((a, b) => (idx[a.id] ?? 999) - (idx[b.id] ?? 999));
  }, [items, itemIds]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const loadAll = useCallback(async () => {
    const [plaidItems, allAccounts] = await Promise.all([getPlaidItems(), getBankAccounts()]);
    setItems(plaidItems);
    // accounts with a plaidAccountId are Plaid-managed; everything else is manual
    setManualAccounts((allAccounts as any[]).filter((a: any) => !a.plaidAccountId));
  }, []);

  useEffect(() => { loadAll().finally(() => setLoading(false)); }, [loadAll]);

  async function handleSync() {
    setSyncing(true); setSyncMsg('');
    try {
      const { synced, failed } = await syncPlaidBalances();
      setSyncMsg(`Synced ${synced} connection${synced !== 1 ? 's' : ''}${failed ? ` · ${failed} failed` : ''}`);
      await loadAll();
    } finally { setSyncing(false); }
  }

  async function handleDisconnect(id: string, name: string) {
    if (!confirm(`Disconnect ${name}? Balance history will be kept.`)) return;
    await deletePlaidItem(id);
    setItems(prev => prev.filter(i => i.id !== id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = sortedItems.findIndex(i => i.id === active.id);
    const newIdx = sortedItems.findIndex(i => i.id === over.id);
    const newOrder = arrayMove(sortedItems, oldIdx, newIdx).map(i => i.id);
    setItemIds(newOrder);
    localStorage.setItem('sollux_plaid_order', JSON.stringify(newOrder));
  }

  async function handleDeleteManual(id: string) {
    if (!confirm('Remove this account?')) return;
    await deleteBankAccount(id);
    setManualAccounts(prev => prev.filter(a => a.id !== id));
  }

  async function handleSaveBalance(accountId: string) {
    const val = parseFloat(editingBalVal);
    if (isNaN(val)) return;
    setSavingBal(true);
    try {
      await recordBankBalance(accountId, { balance: val });
      await loadAll();
      setEditingBal(null);
    } catch { } finally { setSavingBal(false); }
  }

  const THIRD_PARTY_KW = ['venmo', 'apple', 'cash app', 'paypal'];
  const isTP = (a: any) => {
    const t = ((a.name || '') + ' ' + (a.bank || '')).toLowerCase();
    return THIRD_PARTY_KW.some(k => t.includes(k));
  };

  const allPlaidAccounts  = items.flatMap(i => i.accounts);
  const plaidDeposit      = allPlaidAccounts.filter(a => a.accountType !== 'CREDIT_CARD' && a.isActive);
  const plaidCredit       = allPlaidAccounts.filter(a => a.accountType === 'CREDIT_CARD' && a.isActive);
  const thirdPartyAccts   = manualAccounts.filter(a => a.isActive && isTP(a));
  const cashAccts         = manualAccounts.filter(a => a.isActive && !isTP(a) && a.accountType !== 'CREDIT_CARD');

  const bankTotal       = plaidDeposit.reduce((s, a) => s + Number(a.balances[0]?.available ?? a.balances[0]?.balance ?? 0), 0);
  const thirdPartyTotal = thirdPartyAccts.reduce((s, a) => s + Number((a as any).balances?.[0]?.balance ?? 0), 0);
  const cashOnHandTotal = cashAccts.reduce((s, a) => s + Number((a as any).balances?.[0]?.balance ?? 0), 0);
  const grandTotal      = bankTotal + thirdPartyTotal + cashOnHandTotal;

  const buckets = [
    { label: 'Banks', total: bankTotal, count: plaidDeposit.length, sub: 'connected accounts' },
    { label: '3rd party', total: thirdPartyTotal, count: thirdPartyAccts.length, sub: 'payment services' },
    { label: 'Cash', total: cashOnHandTotal, count: cashAccts.length, sub: 'on hand' },
  ].filter(b => b.count > 0);

  const EyeBtn = () => (
    <button onClick={toggleBal} title={balVisible ? 'Hide balances' : 'Show balances'}
      className="text-xs px-2.5 py-1.5 rounded-lg transition-colors text-gray-400 hover:text-white"
      style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)' }}>
      {balVisible ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
        </svg>
      )}
    </button>
  );

  return (
    <div className="px-6 py-5 max-w-2xl">
      {/* Summary */}
      {(allPlaidAccounts.length > 0 || manualAccounts.length > 0) && (
        <div className="mb-4">
          {/* Grand total */}
          <div className="card p-4 mb-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Total available</p>
              <p className="text-2xl font-semibold text-white">{balVisible ? money(grandTotal) : '••••••'}</p>
              {plaidCredit.length > 0 && (
                <p className="text-xs text-gray-500 mt-0.5">
                  {balVisible ? money(plaidCredit.reduce((s, a) => s + Number(a.balances[0]?.balance ?? 0), 0)) : '••••'} credit outstanding
                </p>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="flex gap-2">
                <EyeBtn />
                <button onClick={handleSync} disabled={syncing} className="btn text-xs">{syncing ? 'Syncing…' : '↻ Sync now'}</button>
              </div>
              {syncMsg && <p className="text-xs text-emerald-400">{syncMsg}</p>}
            </div>
          </div>

          {/* 3 buckets */}
          {buckets.length > 0 && (
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
              {buckets.map(b => (
                <div key={b.label} className="card p-3">
                  <p className="text-xs text-gray-500 mb-1">{b.label}</p>
                  <p className="text-base font-semibold text-white">{balVisible ? money(b.total) : '••••'}</p>
                  <p className="text-xs text-gray-600 mt-0.5">{b.count} {b.sub}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Plaid institution cards (draggable) */}
      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading…</div>
      ) : sortedItems.length === 0 && manualAccounts.length === 0 ? (
        <div className="card p-8 text-center mb-4">
          <p className="text-sm font-medium text-gray-300 mb-1">No bank accounts connected</p>
          <p className="text-xs text-gray-500 mb-4">Connect your accounts to get automatic end-of-day balance snapshots.</p>
        </div>
      ) : (
        <>
          {sortedItems.length > 0 && (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={sortedItems.map(i => i.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-3 mb-4">
                  {sortedItems.map(item => (
                    <SortablePlaidCard key={item.id} item={item} balVisible={balVisible} disp={disp} onDisconnect={handleDisconnect} onToggleWatch={loadAll} />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}

          {/* Manual / cash accounts */}
          {manualAccounts.length > 0 && (
            <div className="card p-4 mb-4">
              <p className="text-xs font-medium text-gray-400 mb-3">Cash &amp; digital wallets</p>
              <div className="space-y-2">
                {manualAccounts.map(acct => (
                  <div key={acct.id} className="flex items-center justify-between py-2 border-t border-white/5">
                    <div>
                      <p className="text-sm text-gray-100">{acct.name}</p>
                      <span className="text-xs text-gray-500">{ACCOUNT_TYPE_LABELS[acct.accountType] ?? acct.accountType}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {editingBal === acct.id ? (
                        <>
                          <input
                            autoFocus
                            type="number" step="0.01"
                            value={editingBalVal}
                            onChange={e => setEditingBalVal(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleSaveBalance(acct.id); if (e.key === 'Escape') setEditingBal(null); }}
                            className="w-24 px-2 py-1 text-sm rounded-lg bg-white/5 border border-white/15 text-white outline-none focus:border-amber-500/40"
                          />
                          <button onClick={() => handleSaveBalance(acct.id)} disabled={savingBal} className="text-xs text-emerald-400 hover:text-emerald-300">✓</button>
                          <button onClick={() => setEditingBal(null)} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => { setEditingBal(acct.id); setEditingBalVal(String((acct as any).balances?.[0]?.balance ?? '')); }}
                            className="text-sm font-semibold text-white hover:text-amber-400 transition-colors">
                            {balVisible ? money((acct as any).balances?.[0]?.balance ?? null) : '••••'}
                          </button>
                          <button onClick={() => handleDeleteManual(acct.id)} className="text-xs text-gray-600 hover:text-red-400 transition-colors ml-1">✕</button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="flex gap-2 mb-4">
        <PlaidConnectButton onSuccess={() => loadAll()} />
        <button onClick={() => setShowAddManual(true)} className="btn text-xs">+ Add cash / wallet</button>
      </div>

      <div className="mt-2 rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <p className="text-xs text-gray-500">
          Bank connections are read-only. Sollux uses Plaid to securely fetch balances — your credentials are never stored. Balances snapshot automatically at 11:55 PM every night.
        </p>
      </div>

      {showAddManual && (
        <AddManualAccountModal
          onClose={() => setShowAddManual(false)}
          onSaved={() => { setShowAddManual(false); loadAll(); }}
        />
      )}
    </div>
  );
}

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

// ─── Shared ("family") account access ────────────────────────────────────────
// Members sign in with their own credentials but see and edit the owner's
// data — every API route resolves to the owner's account for them.
function SharedAccessCard() {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => getAccount().then(setInfo).catch(() => {});
  useEffect(() => { load(); }, []);

  async function add() {
    if (!email.trim() && !phone.trim()) return;
    setBusy(true); setErr('');
    try {
      await inviteAccountMember({ email: email.trim() || undefined, phone: phone.trim() || undefined });
      setEmail(''); setPhone('');
      await load();
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not add that person.');
    } finally { setBusy(false); }
  }

  if (!info) return null;

  return (
    <div className="card p-5 mb-4">
      <h2 className="text-sm font-semibold text-white mb-1">Shared access</h2>
      <p className="text-xs text-gray-400 mb-4">
        {info.isOwner
          ? 'People you add sign in with their own login but see and edit this same account — all properties, tenants, and finances.'
          : `You have shared access to ${info.owner?.fullName || info.owner?.email || 'another'}'s account. Only the owner can manage members.`}
      </p>

      <div className="space-y-2 mb-4">
        <div className="flex items-center justify-between py-2 border-b border-white/8">
          <div>
            <p className="text-sm text-gray-100">{info.owner?.fullName || info.owner?.email}</p>
            <p className="text-xs text-gray-500">{info.owner?.email}</p>
          </div>
          <span className="pill pill-amber">Owner</span>
        </div>
        {info.members.map(m => (
          <div key={m.id} className="flex items-center justify-between py-2 border-b border-white/8 last:border-0">
            <div>
              <p className="text-sm text-gray-100">{m.fullName || m.email}</p>
              <p className="text-xs text-gray-500">{m.email}{m.phone ? ` · ${m.phone}` : ''}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="pill pill-green">Full access</span>
              {info.isOwner && (
                <button onClick={async () => { if (confirm(`Remove ${m.fullName || m.email}'s access?`)) { await removeAccountMember(m.id); load(); } }}
                  className="text-xs text-red-400 hover:text-red-300">Remove</button>
              )}
            </div>
          </div>
        ))}
        {info.pendingInvites.map(inv => (
          <div key={inv.id} className="flex items-center justify-between py-2 border-b border-white/8 last:border-0">
            <div>
              <p className="text-sm text-gray-300">{inv.email || inv.phone}</p>
              <p className="text-xs text-gray-500">Access starts when they sign up with this {inv.email ? 'email' : 'phone number'}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="pill pill-gray">Pending</span>
              {info.isOwner && (
                <button onClick={async () => { await cancelAccountInvite(inv.id); load(); }}
                  className="text-xs text-red-400 hover:text-red-300">Cancel</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {info.isOwner && (
        <>
          <div className="flex gap-2 flex-wrap items-center">
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="their@email.com"
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 flex-1 min-w-48" />
            <span className="text-xs text-gray-600">or</span>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="760-672-7717"
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 w-40" />
            <button onClick={add} disabled={busy || (!email.trim() && !phone.trim())}
              className="btn btn-primary text-xs disabled:opacity-40">{busy ? 'Adding…' : 'Add person'}</button>
          </div>
          {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
          <p className="text-xs text-gray-600 mt-2">
            They sign up at Sollux with that email or phone — access links automatically on their first sign-in.
          </p>
        </>
      )}
    </div>
  );
}

// Notification preferences. Every control here used to be a `defaultChecked`
// toggle with no handler — the page looked configurable but saved nothing,
// even though /api/notifications/preferences was fully implemented. Each
// channel × event pair is one NotificationPreference row.
const NOTIF_CHANNELS = [
  { id: 'EMAIL', label: 'Email notifications', desc: 'Receive alerts and reminders to your email' },
  { id: 'SMS',   label: 'SMS notifications',   desc: 'Receive alerts via text message (Pro plan)' },
  { id: 'PUSH',  label: 'Browser push',        desc: 'Receive in-browser push notifications' },
] as const;

const NOTIF_EVENTS = [
  { id: 'BILL_DUE',       label: 'Bill due reminders',    desc: 'Alert when a bill is due within N days' },
  { id: 'ANOMALY',        label: 'Anomaly detection',     desc: 'Alert when a bill is significantly above average' },
  { id: 'PAYMENT',        label: 'Payment confirmations', desc: 'Alert when a payment is recorded' },
  { id: 'SYNC_FAILURE',   label: 'Sync failures',         desc: 'Alert when an account fails to sync' },
] as const;

interface NotifPref { channel: string; eventType: string; isEnabled: boolean; thresholdDays: number }

function NotificationsTab() {
  const [prefs, setPrefs] = useState<NotifPref[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    getNotificationPreferences().then(setPrefs).finally(() => setLoading(false));
  }, []);

  const find = (channel: string, eventType: string) =>
    prefs.find(p => p.channel === channel && p.eventType === eventType);

  // A channel is on when any event is enabled for it; toggling it sets every
  // event at once, which is what the single row implies.
  const channelOn = (channel: string) => NOTIF_EVENTS.some(e => find(channel, e.id)?.isEnabled);
  // An event row reflects email, the channel that always exists.
  const eventOn = (eventType: string) => find('EMAIL', eventType)?.isEnabled ?? false;
  const thresholdDays = find('EMAIL', 'BILL_DUE')?.thresholdDays ?? 5;

  async function save(channel: string, eventType: string, patch: { isEnabled?: boolean; thresholdDays?: number }) {
    const current = find(channel, eventType);
    const body = {
      channel, eventType,
      isEnabled: patch.isEnabled ?? current?.isEnabled ?? false,
      thresholdDays: patch.thresholdDays ?? current?.thresholdDays ?? 5,
    };
    // Optimistic — a toggle that waits on a round trip feels broken.
    setPrefs(prev => {
      const rest = prev.filter(p => !(p.channel === channel && p.eventType === eventType));
      return [...rest, body];
    });
    setSaving(`${channel}:${eventType}`);
    try {
      await updateNotificationPreferences(body);
    } catch {
      setPrefs(await getNotificationPreferences());
      alert('Could not save that preference.');
    } finally {
      setSaving(null);
    }
  }

  const toggleChannel = (channel: string, on: boolean) =>
    Promise.all(NOTIF_EVENTS.map(e => save(channel, e.id, { isEnabled: on })));

  const toggleEvent = (eventType: string, on: boolean) => save('EMAIL', eventType, { isEnabled: on });

  if (loading) return <div className="px-6 py-5 text-sm text-gray-500">Loading…</div>;

  return (
    <div className="px-6 py-5 max-w-2xl">
      <div className="card p-5 mb-4">
        <h2 className="text-sm font-semibold text-white mb-4">Alert channels</h2>
        {NOTIF_CHANNELS.map(item => (
          <Toggle key={item.id} label={item.label} desc={item.desc}
            checked={channelOn(item.id)} busy={saving?.startsWith(item.id + ':')}
            onChange={on => toggleChannel(item.id, on)} />
        ))}
      </div>

      <div className="card p-5 mb-4">
        <h2 className="text-sm font-semibold text-white mb-4">Alert types</h2>
        {NOTIF_EVENTS.map(item => (
          <Toggle key={item.id} label={item.label} desc={item.desc}
            checked={eventOn(item.id)} busy={saving === `EMAIL:${item.id}`}
            onChange={on => toggleEvent(item.id, on)} />
        ))}
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold text-white mb-4">Reminder timing</h2>
        <div className="flex items-center gap-3">
          <p className="text-sm text-gray-400">Send reminders</p>
          <select value={String(thresholdDays)}
            onChange={e => save('EMAIL', 'BILL_DUE', { thresholdDays: Number(e.target.value) })}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200">
            <option value="3">3 days before due</option>
            <option value="5">5 days before due</option>
            <option value="7">7 days before due</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, desc, checked, busy, onChange }: {
  label: string; desc: string; checked: boolean; busy?: boolean; onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-white/8 last:border-0">
      <div>
        <p className="text-sm font-medium text-gray-100">{label}</p>
        <p className="text-xs text-gray-400">{desc}</p>
      </div>
      <label className={`relative inline-flex items-center cursor-pointer ${busy ? 'opacity-60' : ''}`}>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="sr-only peer" />
        <div className="w-9 h-5 bg-white/10 peer-checked:bg-gold-500 rounded-full transition-colors" />
        <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
      </label>
    </div>
  );
}
