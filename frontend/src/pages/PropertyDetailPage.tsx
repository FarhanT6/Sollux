import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getProperty, getStatements, getPayments, getInsights, syncUtility, markInsightRead, dismissInsight } from '../api/client';
import type { Property, Statement, Payment, AIInsight, UtilityAccount } from '../types';
import { CATEGORY_LABELS, CATEGORY_COLORS } from '../types';
import { PageHeader, StatCard, InsightCard, Skeleton, EmptyState, Pill } from '../components/ui';
import { format } from 'date-fns';

type Tab = 'utilities' | 'payments' | 'insights' | 'documents';

export default function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [property, setProperty] = useState<Property | null>(null);
  const [statements, setStatements] = useState<Statement[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [tab, setTab] = useState<Tab>('utilities');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      getProperty(id),
      getStatements({ propertyId: id }),
      getPayments({ propertyId: id }),
      getInsights({ propertyId: id }),
    ]).then(([p, s, pmt, ins]) => {
      setProperty(p);
      setStatements(s);
      setPayments(pmt);
      setInsights(ins.filter(i => !i.isDismissed));
    }).finally(() => setLoading(false));
  }, [id]);

  const accounts = property?.utilityAccounts || [];
  const monthlyTotal = accounts.reduce((s, a) => s + Number(a.statements?.[0]?.amountDue ?? 0), 0);
  const lastSynced = accounts.map(a => a.lastSyncedAt).filter(Boolean).sort().pop();

  async function handleSync(accountId: string) {
    setSyncing(accountId);
    try {
      await syncUtility(accountId);
      setTimeout(() => setSyncing(null), 2000);
    } catch { setSyncing(null); }
  }

  async function handleReadInsight(insightId: string) {
    await markInsightRead(insightId);
    setInsights(prev => prev.map(i => i.id === insightId ? { ...i, isRead: true } : i));
  }

  async function handleDismissInsight(insightId: string) {
    await dismissInsight(insightId);
    setInsights(prev => prev.filter(i => i.id !== insightId));
  }

  if (loading) return <div className="p-6"><Skeleton className="h-40 mb-4" /><Skeleton className="h-64" /></div>;
  if (!property) return <div className="p-6 text-gray-400">Property not found</div>;

  const TABS: { key: Tab; label: string }[] = [
    { key: 'utilities', label: 'Utilities' },
    { key: 'payments', label: 'Payment history' },
    { key: 'insights', label: `AI insights${insights.filter(i => !i.isRead).length > 0 ? ` (${insights.filter(i => !i.isRead).length})` : ''}` },
    { key: 'documents', label: 'Documents' },
  ];

  return (
    <div>
      <PageHeader
        title={property.nickname || property.address}
        subtitle={`${property.city}, ${property.state} · ${property.type.charAt(0) + property.type.slice(1).toLowerCase()}`}
        breadcrumb={[
          { label: 'All properties', href: '/properties' },
          { label: property.nickname || property.address },
        ]}
        action={
          <button
            onClick={() => accounts.forEach(a => handleSync(a.id))}
            className="btn btn-primary text-xs"
          >
            Sync all
          </button>
        }
      />

      {/* Property hero stats */}
      <div className="px-6 py-4 border-b border-gray-100">
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Monthly total" value={`$${monthlyTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} />
          <StatCard label="Last synced" value={lastSynced ? format(new Date(lastSynced), 'h:mm a') : 'Never'} sub={lastSynced ? format(new Date(lastSynced), 'MMM d') : ''} />
          <StatCard label="Utility accounts" value={accounts.length} sub="All connected" subColor="green" />
          <StatCard label="AI insights" value={insights.filter(i => !i.isRead).length} sub={insights.filter(i => !i.isRead).length > 0 ? 'Unread' : 'All clear'} subColor={insights.filter(i => !i.isRead).length > 0 ? 'red' : 'neutral'} />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-100 px-6 bg-white">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`text-sm py-3 px-4 border-b-2 transition-colors ${
              tab === t.key
                ? 'border-gold-500 text-gold-600 font-medium'
                : 'border-transparent text-gray-400 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="px-6 py-5">

        {/* ── Utilities tab ─────────────────────────────── */}
        {tab === 'utilities' && (
          <>
            <p className="section-label mb-3">Active utility accounts</p>
            {accounts.length === 0 ? (
              <EmptyState icon="⚡" title="No utility accounts" body="Add a utility account to start tracking bills for this property." />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {accounts.map(account => (
                  <UtilityAccountCard
                    key={account.id}
                    account={account}
                    syncing={syncing === account.id}
                    onSync={() => handleSync(account.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Payments tab ──────────────────────────────── */}
        {tab === 'payments' && (
          <>
            <p className="section-label mb-3">Payment history</p>
            {payments.length === 0 ? (
              <EmptyState icon="💳" title="No payments yet" body="Payment history will appear here once accounts are synced." />
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Utility</th>
                    <th>Amount</th>
                    <th>Date</th>
                    <th>Confirmation #</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id}>
                      <td className="font-medium">{p.utilityAccount?.providerName}</td>
                      <td className="font-semibold">${Number(p.amount).toFixed(2)}</td>
                      <td className="text-gray-500">{format(new Date(p.paymentDate), 'MMM d, yyyy')}</td>
                      <td><span className="font-mono text-xs text-gray-400">{p.confirmationNumber || '—'}</span></td>
                      <td><Pill color="green">Paid</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {/* ── Insights tab ──────────────────────────────── */}
        {tab === 'insights' && (
          <>
            <div className="mb-4 flex items-center gap-3 bg-amber-50 border border-amber-100 rounded-xl p-4">
              <div className="w-10 h-10 rounded-full bg-gold-500 flex items-center justify-center flex-shrink-0">
                <div className="w-5 h-5 rounded-full bg-white" />
              </div>
              <div>
                <p className="text-sm font-medium text-amber-900">Sollux AI is monitoring {accounts.length} utility accounts</p>
                <p className="text-xs text-amber-700">Last synced {lastSynced ? format(new Date(lastSynced), 'MMM d \'at\' h:mm a') : 'never'} · {insights.length} total insights</p>
              </div>
            </div>
            {insights.length === 0 ? (
              <EmptyState icon="✨" title="No active insights" body="Sollux will surface anomalies and savings tips here once enough data is collected." />
            ) : (
              insights.map(insight => (
                <InsightCard
                  key={insight.id}
                  insight={insight}
                  onRead={handleReadInsight}
                  onDismiss={handleDismissInsight}
                />
              ))
            )}
          </>
        )}

        {/* ── Documents tab ─────────────────────────────── */}
        {tab === 'documents' && (
          <>
            <p className="section-label mb-3">Statements auto-saved</p>
            {statements.filter(s => s.pdfS3Key).length === 0 ? (
              <EmptyState icon="📄" title="No documents yet" body="PDF statements will appear here automatically once accounts are synced." />
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {statements.filter(s => s.pdfS3Key).map(stmt => (
                  <div key={stmt.id} className="card p-3 hover:border-gold-300 transition-colors cursor-pointer">
                    <div className="w-8 h-9 bg-red-50 rounded flex items-center justify-center mb-2">
                      <div className="w-3.5 h-4 bg-red-400 rounded-sm" />
                    </div>
                    <p className="text-xs font-medium text-gray-900 truncate">
                      {stmt.utilityAccount?.providerName}_{format(new Date(stmt.statementDate), 'MMMyyyy')}.pdf
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {stmt.amountDue ? `$${Number(stmt.amountDue).toFixed(2)} · ` : ''}{format(new Date(stmt.statementDate), 'MMM d, yyyy')}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}

function UtilityAccountCard({
  account, syncing, onSync
}: { account: UtilityAccount; syncing: boolean; onSync: () => void }) {
  const latest = account.statements?.[0];
  const dueDate = latest?.dueDate ? new Date(latest.dueDate) : null;
  const isDueSoon = dueDate && dueDate <= new Date(Date.now() + 7 * 86400000);
  const color = CATEGORY_COLORS[account.category] || '#888';

  const statusLabel = account.lastSyncStatus === 'SUCCESS' ? 'Synced'
    : account.lastSyncStatus === 'FAILED' ? 'Sync failed'
    : account.lastSyncStatus === 'PENDING' ? 'Syncing…'
    : 'Not synced';

  const pillColor: any = account.lastSyncStatus === 'SUCCESS' ? 'green'
    : account.lastSyncStatus === 'FAILED' ? 'red' : 'gray';

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
          <div>
            <p className="text-sm font-semibold text-gray-900">{account.providerName}</p>
            <p className="text-xs font-mono text-gray-400">{account.accountNumber || 'No account #'}</p>
          </div>
        </div>
        <Pill color={isDueSoon ? 'amber' : pillColor}>
          {isDueSoon ? 'Due soon' : statusLabel}
        </Pill>
      </div>

      <div className="flex items-end justify-between">
        <div>
          <p className="text-xl font-semibold text-gray-900">
            {latest?.amountDue ? `$${Number(latest.amountDue).toFixed(2)}` : '—'}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {dueDate ? `Due ${format(dueDate, 'MMM d')}` : 'No statement yet'}
          </p>
          {latest?.usageValue && (
            <p className="text-xs text-gray-400">
              {latest.usageValue} {latest.usageUnit}
            </p>
          )}
        </div>
        <button
          onClick={onSync}
          disabled={syncing}
          className="btn text-xs"
        >
          {syncing ? 'Syncing…' : 'Sync ↻'}
        </button>
      </div>

      {account.lastSyncedAt && (
        <p className="text-xs text-gray-300 mt-2">
          Last synced {format(new Date(account.lastSyncedAt), 'MMM d \'at\' h:mm a')}
        </p>
      )}
    </div>
  );
}
