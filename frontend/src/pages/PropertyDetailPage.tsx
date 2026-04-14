import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getProperty, getStatements, getPayments, getInsights, syncUtility, updateUtility, markInsightRead, dismissInsight, getStatementDownloadUrl } from '../api/client';
import type { Property, Statement, Payment, AIInsight, UtilityAccount } from '../types';
import { CATEGORY_LABELS, CATEGORY_COLORS } from '../types';
import { PageHeader, StatCard, InsightCard, Skeleton, EmptyState, Pill } from '../components/ui';
import { format } from 'date-fns';
import AddUtilityModal from '../components/utility/AddUtilityModal';

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
  const [showAddUtility, setShowAddUtility] = useState(false);

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
  const monthlyTotal = accounts.reduce((s, a) => {
    const raw = a.statements?.[0]?.rawDataJson as Record<string, unknown> | undefined;
    const bal = raw?.accountBalance as number | undefined;
    return s + Number(bal ?? a.statements?.[0]?.amountDue ?? 0);
  }, 0);
  const lastSynced = accounts.map(a => a.lastSyncedAt).filter(Boolean).sort().pop();

  async function handleSync(accountId: string) {
    setSyncing(accountId);
    try {
      await syncUtility(accountId);
      // Poll until the worker finishes (status leaves PENDING)
      const poll = async () => {
        const updated = await getProperty(id!);
        setProperty(updated);
        const acct = updated.utilityAccounts?.find((a: UtilityAccount) => a.id === accountId);
        if (acct?.lastSyncStatus === 'PENDING' || acct?.lastSyncStatus === null) {
          setTimeout(poll, 2000);
        } else {
          setSyncing(null);
        }
      };
      setTimeout(poll, 2000);
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
      <div className="px-6 py-4 border-b border-white/8">
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Monthly total" value={`$${monthlyTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} />
          <StatCard label="Last synced" value={lastSynced ? format(new Date(lastSynced), 'h:mm a') : 'Never'} sub={lastSynced ? format(new Date(lastSynced), 'MMM d') : ''} />
          <StatCard label="Utility accounts" value={accounts.length} sub="All connected" subColor="green" />
          <StatCard label="AI insights" value={insights.filter(i => !i.isRead).length} sub={insights.filter(i => !i.isRead).length > 0 ? 'Unread' : 'All clear'} subColor={insights.filter(i => !i.isRead).length > 0 ? 'red' : 'neutral'} />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-white/8 px-6 bg-transparent">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`text-sm py-3 px-4 border-b-2 transition-colors ${
              tab === t.key
                ? 'border-amber-400 text-amber-400 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-300'
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
            <div className="flex items-center justify-between mb-3">
              <p className="section-label">Active utility accounts</p>
              <button onClick={() => setShowAddUtility(true)} className="btn btn-primary text-xs">+ Add utility</button>
            </div>
            {accounts.length === 0 ? (
              <EmptyState icon="⚡" title="No utility accounts" body="Add a utility account to start tracking bills for this property." />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {accounts.map(account => (
                  <UtilityAccountCardWithHistory
                    key={account.id}
                    account={account}
                    propertyId={id!}
                    syncing={syncing === account.id}
                    onSync={() => handleSync(account.id)}
                    onRefresh={() => getProperty(id!).then(setProperty)}
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
            <div className="mb-4 flex items-center gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
              <div className="w-10 h-10 rounded-full bg-gold-500 flex items-center justify-center flex-shrink-0">
                <div className="w-5 h-5 rounded-full bg-white" />
              </div>
              <div>
                <p className="text-sm font-medium text-amber-300">Sollux AI is monitoring {accounts.length} utility accounts</p>
                <p className="text-xs text-amber-400">Last synced {lastSynced ? format(new Date(lastSynced), 'MMM d \'at\' h:mm a') : 'never'} · {insights.length} total insights</p>
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
                  <div
                    key={stmt.id}
                    className="card p-3 hover:border-gold-300 transition-colors cursor-pointer"
                    onClick={async () => {
                      try {
                        const res = await getStatementDownloadUrl(stmt.id);
                        window.open(res.url, '_blank', 'noopener,noreferrer');
                      } catch {
                        alert('Could not open PDF. Please try again.');
                      }
                    }}
                  >
                    <div className="w-8 h-9 bg-red-500/10 rounded flex items-center justify-center mb-2">
                      <div className="w-3.5 h-4 bg-red-400 rounded-sm" />
                    </div>
                    <p className="text-xs font-medium text-gray-100 truncate">
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
      {showAddUtility && <AddUtilityModal propertyId={property.id} onClose={() => setShowAddUtility(false)} onSuccess={() => { getProperty(id!).then(setProperty); }} />}
    </div>
  );
}

function EditUtilityModal({ account, onClose, onSaved }: { account: UtilityAccount; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ accountNumber: '', username: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    setLoading(true); setError('');
    try {
      const patch: Record<string, string> = {};
      if (form.accountNumber.trim()) patch.accountNumber = form.accountNumber.trim();
      if (form.username.trim()) patch.username = form.username.trim();
      if (form.password.trim()) patch.password = form.password.trim();
      if (Object.keys(patch).length === 0) { onClose(); return; }
      await updateUtility(account.id, patch);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to update');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl p-6 space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Edit {account.providerName}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
        </div>
        <p className="text-xs text-gray-500">Leave a field blank to keep the existing value.</p>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">
              Account number
              {account.providerSlug === 'wm' && <span className="text-gray-600 ml-1">(e.g. 8-92846-35002)</span>}
            </label>
            <input
              className="w-full rounded-lg px-3 py-2 text-sm text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none"
              placeholder={account.accountNumber || 'Full account number from your bill'}
              value={form.accountNumber}
              onChange={e => setForm(f => ({ ...f, accountNumber: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Username / Email</label>
            <input
              className="w-full rounded-lg px-3 py-2 text-sm text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none"
              placeholder="New username or email"
              value={form.username}
              onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Password</label>
            <input
              type="password"
              className="w-full rounded-lg px-3 py-2 text-sm text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none"
              placeholder="New password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            />
          </div>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button className="btn text-xs flex-1" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary text-xs flex-1" onClick={handleSave} disabled={loading}>
            {loading ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function UtilityAccountCardWithHistory({
  account, syncing, onSync, onRefresh, propertyId,
}: { account: UtilityAccount; syncing: boolean; onSync: () => void; onRefresh: () => void; propertyId: string }) {
  const [editing, setEditing] = useState(false);
  const navigate = useNavigate();

  return (
    <div>
      {editing && <EditUtilityModal account={account} onClose={() => setEditing(false)} onSaved={onRefresh} />}
      <UtilityAccountCard account={account} syncing={syncing} onSync={onSync} onEdit={() => setEditing(true)} />
      <button
        onClick={() => navigate(`/properties/${propertyId}/utilities/${account.id}`)}
        className="mt-1.5 ml-1 text-xs text-gray-500 hover:text-[#F5A623] transition-colors flex items-center gap-1"
      >
        <span>›</span>
        View statements &amp; payments
      </button>
    </div>
  );
}

function UtilityAccountCard({
  account, syncing, onSync, onEdit
}: { account: UtilityAccount; syncing: boolean; onSync: () => void; onEdit: () => void }) {
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
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-semibold text-white">{account.providerName}</p>
              <button
                onClick={onEdit}
                title="Edit account"
                className="px-1.5 py-0.5 rounded text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-colors leading-none border border-white/10 hover:border-white/20"
              >
                Edit
              </button>
            </div>
            <p className="text-xs font-mono text-gray-400">{account.accountNumber || 'No account #'}</p>
          </div>
        </div>
        <Pill color={isDueSoon ? 'amber' : pillColor}>
          {isDueSoon ? 'Due soon' : statusLabel}
        </Pill>
      </div>

      <div className="flex items-end justify-between">
        <div className="flex-1 min-w-0">
          {(() => {
            const raw = latest?.rawDataJson as Record<string, unknown> | undefined;
            const accountBalance = raw?.accountBalance as number | undefined;
            const pastDue = raw?.pastDue as number | undefined;
            const fmt = (n: number) => `$${Number(n).toFixed(2)}`;

            // Total balance = accountBalance (full amount owed including any past due)
            // Current charge = amountDue on the latest statement (this billing period only)
            // Past due = what's owed from prior periods (due immediately)
            const totalBalance = accountBalance ?? latest?.amountDue;
            const currentCharge = latest?.amountDue;
            const pastDueAmt = pastDue && pastDue > 0 ? pastDue
              : (totalBalance != null && currentCharge != null && totalBalance - currentCharge > 0.01)
                ? Math.round((totalBalance - currentCharge) * 100) / 100
                : undefined;

            if (!latest) {
              return (
                <p className="text-sm text-gray-500">No statement yet</p>
              );
            }

            return (
              <>
                {/* Total balance — big topline number */}
                <p className="text-xl font-semibold text-white">
                  {totalBalance != null ? fmt(totalBalance) : '—'}
                </p>

                {/* Past due row — red, due immediately */}
                {pastDueAmt != null && pastDueAmt > 0 && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-xs font-medium text-red-400">Past due: {fmt(pastDueAmt)}</span>
                    <span className="text-xs text-red-500/70">· due immediately</span>
                  </div>
                )}

                {/* Current charge row */}
                {currentCharge != null && (
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="text-xs text-gray-400">
                      Current: {fmt(currentCharge)}
                    </span>
                    {dueDate && (
                      <span className="text-xs text-gray-500">· due {format(dueDate, 'MMM d')}</span>
                    )}
                  </div>
                )}

                {latest.usageValue && (
                  <p className="text-xs text-gray-500 mt-0.5">{latest.usageValue} {latest.usageUnit}</p>
                )}
              </>
            );
          })()}
        </div>
        <button
          onClick={onSync}
          disabled={syncing}
          className="btn text-xs ml-3 flex-shrink-0"
        >
          {syncing ? 'Syncing…' : 'Sync ↻'}
        </button>
      </div>

      {/* MFA required banner */}
      {account.lastSyncStatus === 'FAILED' && account.lastSyncError?.startsWith('MFA_REQUIRED') && (
        <div className="mt-3 px-3 py-2 rounded-lg text-xs space-y-1"
          style={{ background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.25)' }}>
          <p className="font-medium text-amber-400">Phone verification required</p>
          <p className="text-gray-400">
            Log in to <span className="text-gray-200">{account.providerName}</span> manually in your browser,
            complete the verification code step, then click Sync — Sollux will reuse the trusted session automatically.
          </p>
        </div>
      )}

      {account.lastSyncedAt && account.lastSyncStatus !== 'FAILED' && (
        <p className="text-xs text-gray-300 mt-2">
          Last synced {format(new Date(account.lastSyncedAt), 'MMM d \'at\' h:mm a')}
        </p>
      )}
    </div>
  );
}
