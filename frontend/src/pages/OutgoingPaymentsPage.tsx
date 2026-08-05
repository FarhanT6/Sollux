import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import {
  getOutgoingTransactions, syncOutgoingTransactions, matchOutgoingTransaction,
  applyOutgoingTransaction, ignoreOutgoingTransaction, getProperties, getUtilityCandidates,
} from '../api/client';
import type { OutgoingTransaction, IncomingTransactionStatus, Property, ExpenseCategory, UtilityCandidate } from '../types';
import { EXPENSE_CATEGORY_LABELS } from '../types';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const MATCH_TYPE_LABELS: Record<string, string> = { HARDWARE: 'Hardware store', UTILITY: 'Utility payment' };

const FILTERS: { key: IncomingTransactionStatus | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'SUGGESTED', label: 'Suggested' },
  { key: 'UNMATCHED', label: 'Unmatched' },
  { key: 'APPLIED', label: 'Applied' },
  { key: 'IGNORED', label: 'Ignored' },
];

export default function OutgoingPaymentsPage({ embedded }: { embedded?: boolean } = {}) {
  const [transactions, setTransactions] = useState<OutgoingTransaction[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [filter, setFilter] = useState<IncomingTransactionStatus | 'ALL'>('SUGGESTED');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = async () => {
    const [tx, props] = await Promise.all([
      getOutgoingTransactions(filter === 'ALL' ? undefined : filter),
      getProperties(),
    ]);
    setTransactions(tx);
    setProperties(props);
  };

  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [filter]);

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const result = await syncOutgoingTransactions();
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

  async function handleProperty(id: string, propertyId: string) {
    await matchOutgoingTransaction(id, { propertyId: propertyId || null, utilityAccountId: null, statementId: null });
    load();
  }
  async function handleCandidate(id: string, candidate: UtilityCandidate | null) {
    await matchOutgoingTransaction(id, candidate
      ? { propertyId: candidate.propertyId, utilityAccountId: candidate.utilityAccountId, statementId: candidate.statementId }
      : { propertyId: null, utilityAccountId: null, statementId: null });
    load();
  }
  async function handleCategory(id: string, category: string) {
    await matchOutgoingTransaction(id, { category });
    load();
  }
  async function handleApply(id: string) {
    await applyOutgoingTransaction(id);
    load();
  }
  async function handleIgnore(id: string) {
    await ignoreOutgoingTransaction(id);
    load();
  }

  return (
    <div className={embedded ? '' : 'p-6 max-w-4xl mx-auto'}>
      {!embedded && (
        <div className="mb-4">
          <h1 className="text-xl font-semibold text-white">Expense Payments</h1>
          <p className="text-sm text-gray-400 mt-0.5">Hardware-store purchases and utility bill payments from your watched bank accounts</p>
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
          No {filter === 'ALL' ? '' : filter.toLowerCase()} transactions. Turn on "Watch for expenses" on a bank account under Settings → Banking, then Sync.
        </p>
      ) : (
        <div className="space-y-2">
          {transactions.map(tx => (
            <div key={tx.id} className="rounded-xl p-3" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-white/10 text-gray-300">{MATCH_TYPE_LABELS[tx.matchType ?? ''] ?? 'Other'}</span>
                  <span className="text-xs text-gray-500">{format(new Date(tx.date), 'MMM d, yyyy')}</span>
                  <span className="text-xs text-gray-600">· {tx.bankAccount?.name}</span>
                  {tx.utilityAccount && <span className="text-xs text-gray-600">· {tx.utilityAccount.providerName}</span>}
                </div>
                <p className="text-sm font-semibold text-red-400">{money(tx.amount)}</p>
              </div>
              <p className="text-xs text-gray-500 mb-2 truncate">{tx.name}</p>

              <div className="flex items-center gap-2">
                {tx.status === 'APPLIED' ? (
                  <p className="text-xs text-emerald-500">
                    {tx.appliedType === 'STATEMENT' ? 'Marked matching utility statement paid' : 'Logged as an expense'} — {tx.property?.nickname || tx.property?.address}
                  </p>
                ) : tx.status === 'IGNORED' ? (
                  <p className="text-xs text-gray-600">Ignored</p>
                ) : tx.matchType === 'UTILITY' ? (
                  <UtilityMatchRow tx={tx} onCandidate={handleCandidate} onApply={handleApply} onIgnore={handleIgnore} />
                ) : (
                  <>
                    <select
                      value={tx.propertyId ?? ''}
                      onChange={e => handleProperty(tx.id, e.target.value)}
                      className="field-input text-xs flex-1"
                    >
                      <option value="">— No property matched —</option>
                      {properties.map(p => (
                        <option key={p.id} value={p.id}>{p.nickname || p.address}</option>
                      ))}
                    </select>
                    <select
                      value={tx.category ?? 'REPAIRS_MAINTENANCE'}
                      onChange={e => handleCategory(tx.id, e.target.value)}
                      className="field-input text-xs flex-shrink-0 w-40"
                    >
                      {Object.entries(EXPENSE_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k as ExpenseCategory}>{v}</option>)}
                    </select>
                    <button
                      disabled={!tx.propertyId}
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

// ─── Utility payment row: candidate statement picker ─────────────────────────
// Cross-references the payment amount against every unpaid statement on any
// provider-matched utility account (across all properties), within a $20
// tolerance. When exactly one property has a plausible statement it's
// pre-selected; ambiguous cases (or none close enough) are left for the user
// to pick here.

function UtilityMatchRow({ tx, onCandidate, onApply, onIgnore }: {
  tx: OutgoingTransaction;
  onCandidate: (id: string, candidate: UtilityCandidate | null) => void;
  onApply: (id: string) => void;
  onIgnore: (id: string) => void;
}) {
  const [candidates, setCandidates] = useState<UtilityCandidate[] | null>(null);

  useEffect(() => {
    getUtilityCandidates(tx.id).then(setCandidates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.id]);

  const selectedKey = tx.statementId ?? '';

  function handleChange(value: string) {
    if (!value) { onCandidate(tx.id, null); return; }
    const candidate = candidates?.find(c => c.statementId === value) ?? null;
    onCandidate(tx.id, candidate);
  }

  return (
    <>
      <select
        value={selectedKey}
        onChange={e => handleChange(e.target.value)}
        className="field-input text-xs flex-1"
      >
        <option value="">— No statement matched —</option>
        {candidates?.map(c => (
          <option key={c.statementId} value={c.statementId}>
            {c.propertyLabel} — {format(new Date(c.statementDate), 'MMM yyyy')} — {money(c.amountDue)}
            {c.withinTolerance ? '' : ` (off by ${money(c.diff)})`}
          </option>
        ))}
      </select>
      <button
        disabled={!tx.propertyId}
        onClick={() => onApply(tx.id)}
        className="text-xs text-amber-400 hover:text-amber-300 disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
      >Apply</button>
      <button onClick={() => onIgnore(tx.id)} className="text-xs text-red-500 hover:text-red-400 flex-shrink-0">Ignore</button>
    </>
  );
}
