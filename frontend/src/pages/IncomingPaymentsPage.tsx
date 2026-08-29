import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import {
  getIncomingTransactions, syncIncomingTransactions, matchIncomingTransaction,
  applyIncomingTransaction, ignoreIncomingTransaction, getLeases,
} from '../api/client';
import type { IncomingTransaction, IncomingTransactionStatus, Lease } from '../types';
import { fmtDate } from '../lib/date';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const CHANNEL_LABELS: Record<string, string> = {
  ZELLE: 'Zelle', VENMO: 'Venmo', PAYPAL: 'PayPal', CASH_APP: 'Cash App', APPLE_CASH: 'Apple Cash',
  CHECK: 'Check', ACH: 'ACH', DEPOSIT: 'Deposit', OTHER: 'Other',
};

const FILTERS: { key: IncomingTransactionStatus | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'SUGGESTED', label: 'Suggested' },
  { key: 'UNMATCHED', label: 'Unmatched' },
  { key: 'APPLIED', label: 'Applied' },
  { key: 'IGNORED', label: 'Ignored' },
];

export default function IncomingPaymentsPage({ embedded }: { embedded?: boolean } = {}) {
  const [transactions, setTransactions] = useState<IncomingTransaction[]>([]);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [filter, setFilter] = useState<IncomingTransactionStatus | 'ALL'>('SUGGESTED');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = async () => {
    const [tx, l] = await Promise.all([
      getIncomingTransactions(filter === 'ALL' ? undefined : filter),
      getLeases({ status: 'ACTIVE' }),
    ]);
    setTransactions(tx);
    setLeases(l);
  };

  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [filter]);

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const result = await syncIncomingTransactions();
      setSyncMsg(
        result.errors.length > 0
          ? `Synced ${result.itemsSynced} account(s), ${result.added} new — ${result.errors.join('; ')}`
          : `Synced ${result.itemsSynced} account(s), ${result.added} new transaction(s) found.`
      );
      await load();
    } finally {
      setSyncing(false);
    }
  }

  async function handleMatch(id: string, leaseId: string) {
    await matchIncomingTransaction(id, leaseId || null);
    load();
  }
  async function handleApply(id: string) {
    await applyIncomingTransaction(id);
    load();
  }
  async function handleIgnore(id: string) {
    await ignoreIncomingTransaction(id);
    load();
  }

  return (
    <div className={embedded ? '' : 'p-6 max-w-4xl mx-auto'}>
      {!embedded && (
        <div className="mb-4">
          <h1 className="text-xl font-semibold text-white">Incoming Payments</h1>
          <p className="text-sm text-gray-400 mt-0.5">Transfers, checks and deposits into your watched bank accounts, matched to tenants</p>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1">
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                filter === f.key ? 'bg-amber-500/20 text-amber-400' : 'text-gray-500 hover:text-gray-300'
              }`}>
              {f.label}
            </button>
          ))}
        </div>
        <button onClick={handleSync} disabled={syncing} className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50">
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {syncMsg && <p className="text-xs text-gray-500 mb-3">{syncMsg}</p>}

      {loading ? (
        <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>
      ) : transactions.length === 0 ? (
        <p className="text-sm text-gray-500 py-8 text-center">
          No {filter === 'ALL' ? '' : filter.toLowerCase()} transactions. Turn on "Watch for rent payments" on a bank account under Settings → Banking, then Sync.
        </p>
      ) : (
        <div className="space-y-2">
          {transactions.map(tx => (
            <div key={tx.id} className="rounded-xl p-3" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-white/10 text-gray-300">{CHANNEL_LABELS[tx.channel ?? 'OTHER']}</span>
                  <span className="text-xs text-gray-500">{fmtDate(tx.date, 'MMM d, yyyy')}</span>
                  <span className="text-xs text-gray-600">· {tx.bankAccount?.name}</span>
                </div>
                <p className="text-sm font-semibold text-emerald-500">{money(tx.amount)}</p>
              </div>
              <p className="text-xs text-gray-500 mb-2 truncate">{tx.name}</p>

              <div className="flex items-center gap-2">
                {tx.status === 'APPLIED' ? (
                  <p className="text-xs text-emerald-500">
                    Applied to {tx.matchedLease?.leaseTenants.map(lt => lt.tenant.fullName).join(', ')} ({tx.matchedLease?.unit.property.nickname || tx.matchedLease?.unit.property.address})
                  </p>
                ) : tx.status === 'IGNORED' ? (
                  <p className="text-xs text-gray-600">Ignored</p>
                ) : (
                  <>
                    <select
                      value={tx.matchedLeaseId ?? ''}
                      onChange={e => handleMatch(tx.id, e.target.value)}
                      className="field-input text-xs flex-1"
                    >
                      <option value="">— No tenant matched —</option>
                      {leases.map(l => (
                        <option key={l.id} value={l.id}>
                          {l.leaseTenants?.map(lt => lt.tenant.fullName).join(', ') || l.unit?.unitLabel} — {l.unit?.property?.nickname || l.unit?.property?.address}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={!tx.matchedLeaseId}
                      onClick={() => handleApply(tx.id)}
                      className="text-xs text-amber-400 hover:text-amber-300 disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                    >Apply</button>
                    <button onClick={() => handleIgnore(tx.id)} className="text-xs text-red-500 hover:text-red-400 flex-shrink-0">Ignore</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
