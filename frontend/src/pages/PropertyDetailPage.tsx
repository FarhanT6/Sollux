import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getProperty, getStatements, getPayments, getInsights, syncUtility, updateUtility, deleteUtility, updateProperty, deleteProperty, markInsightRead, dismissInsight, getStatementDownloadUrl, revealUtilityAccountNumber } from '../api/client';
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
  const navigate = useNavigate();
  const [syncing, setSyncing] = useState<string | null>(null);
  const [showAddUtility, setShowAddUtility] = useState(false);
  const [showEditProperty, setShowEditProperty] = useState(false);
  const [showDeleteProperty, setShowDeleteProperty] = useState(false);

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
    const stmt = a.statements?.[0];
    const raw = stmt?.rawDataJson as Record<string, unknown> | undefined;
    const bal = (raw?.accountBalance ?? raw?.totalDue ?? (stmt as any)?.balance ?? stmt?.amountDue) as number | undefined;
    return s + Number(bal ?? 0);
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
          <div className="flex items-center gap-2">
            <button onClick={() => setShowEditProperty(true)} className="btn text-xs">Edit property</button>
            <button
              onClick={() => setShowDeleteProperty(true)}
              className="btn text-xs text-red-400 border-red-500/30 hover:border-red-500/60"
            >
              Delete
            </button>
            <button
              onClick={() => accounts.forEach(a => handleSync(a.id))}
              className="btn btn-primary text-xs"
            >
              Sync all
            </button>
          </div>
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
                    payments={payments.filter(p => p.utilityAccountId === account.id)}
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
        {tab === 'documents' && (() => {
          // Group statements by utility account (already filtered to this property)
          const byAccount = accounts
            .map(acct => ({
              acct,
              stmts: statements.filter(s => s.utilityAccountId === acct.id),
            }))
            .filter(g => g.stmts.length > 0);

          // Statements for accounts not in the accounts list (shouldn't happen, but guard)
          const knownIds = new Set(accounts.map(a => a.id));
          const orphaned = statements.filter(s => !knownIds.has(s.utilityAccountId));

          const allGroups = [...byAccount, ...(orphaned.length > 0 ? [{ acct: null, stmts: orphaned }] : [])];

          return (
            <>
              {allGroups.length === 0 ? (
                <EmptyState icon="📄" title="No statements yet" body="Statements will appear here automatically once accounts are synced." />
              ) : (
                <div className="space-y-6 pb-8">
                  {allGroups.map(({ acct, stmts }) => (
                    <div key={acct?.id || 'orphaned'}>
                      <div className="flex items-center gap-2 mb-3">
                        <p className="section-label mb-0">{acct?.providerName || 'Unknown account'}</p>
                        <span className="text-xs text-gray-600">{stmts.length} statement{stmts.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        {stmts.map(stmt => (
                          <div
                            key={stmt.id}
                            className={`card p-3 transition-colors ${stmt.pdfS3Key ? 'hover:border-amber-500/40 cursor-pointer' : 'cursor-default'}`}
                            onClick={async () => {
                              if (!stmt.pdfS3Key) return;
                              try {
                                const res = await getStatementDownloadUrl(stmt.id);
                                window.open(res.url, '_blank', 'noopener,noreferrer');
                              } catch {
                                alert('Could not open PDF. Please try again.');
                              }
                            }}
                          >
                            <div className={`w-8 h-9 rounded flex items-center justify-center mb-2 ${stmt.pdfS3Key ? 'bg-red-500/10' : 'bg-white/4'}`}>
                              {stmt.pdfS3Key
                                ? <div className="w-3.5 h-4 bg-red-400 rounded-sm" />
                                : <span className="text-sm">📋</span>
                              }
                            </div>
                            <p className="text-xs font-medium text-gray-200 truncate">
                              {format(new Date(stmt.statementDate), 'MMM d, yyyy')}
                            </p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {stmt.amountDue ? `$${Number(stmt.amountDue).toFixed(2)}` : 'No amount'}
                              {stmt.dueDate ? ` · Due ${format(new Date(stmt.dueDate), 'MMM d')}` : ''}
                            </p>
                            <p className="text-xs mt-1" style={{ color: stmt.pdfS3Key ? '#ef4444' : '#6b7280' }}>
                              {stmt.pdfS3Key ? '📄 PDF' : 'No PDF'}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          );
        })()}

      </div>
      {showAddUtility && <AddUtilityModal propertyId={property.id} onClose={() => setShowAddUtility(false)} onSuccess={() => { getProperty(id!).then(setProperty); }} />}

      {showEditProperty && (
        <EditPropertyModal
          property={property}
          onClose={() => setShowEditProperty(false)}
          onSaved={updated => { setProperty(updated); setShowEditProperty(false); }}
        />
      )}

      {showDeleteProperty && (
        <DeletePropertyModal
          property={property}
          onClose={() => setShowDeleteProperty(false)}
          onDeleted={() => navigate('/properties')}
        />
      )}
    </div>
  );
}

const UTILITY_CATEGORIES = ['ELECTRIC','GAS','WATER','SEWER','TRASH','SOLAR','INTERNET','PHONE','INSURANCE','HOA','TAXES','OTHER'];

function EditUtilityModal({ account, onClose, onSaved }: { account: UtilityAccount; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    providerName:  account.providerName || '',
    category:      account.category     || 'OTHER',
    accountNumber: '',
    username:      '',
    password:      '',
    notes:         (account as any).notes || '',
    loginUrl:      account.loginUrl || '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fieldCls = 'w-full rounded-lg px-3 py-2 text-sm text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none';

  async function handleSave() {
    setLoading(true); setError('');
    try {
      const patch: Record<string, string> = {};
      if (form.providerName.trim()  !== account.providerName) patch.providerName = form.providerName.trim();
      if (form.category             !== account.category)     patch.category     = form.category;
      if (form.accountNumber.trim()) patch.accountNumber = form.accountNumber.trim();
      if (form.username.trim())      patch.username      = form.username.trim();
      if (form.password.trim())      patch.password      = form.password.trim();
      if (form.notes.trim()         !== ((account as any).notes || '')) patch.notes = form.notes.trim();
      if (form.loginUrl.trim()      !== (account.loginUrl || ''))       patch.loginUrl = form.loginUrl.trim();
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
          <h3 className="text-sm font-semibold text-white">Edit utility account</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Provider name</label>
              <input className={fieldCls} value={form.providerName} onChange={e => setForm(f => ({ ...f, providerName: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Category</label>
              <select className={fieldCls} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as any }))}>
                {UTILITY_CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">
              Account number
              {account.providerSlug === 'wm' && <span className="text-gray-600 ml-1">(e.g. 8-92846-35002)</span>}
            </label>
            <input className={fieldCls} placeholder={account.accountNumber || 'Full account number'} value={form.accountNumber} onChange={e => setForm(f => ({ ...f, accountNumber: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Username / Email</label>
              <input className={fieldCls} placeholder="New login" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Password</label>
              <input type="password" className={fieldCls} placeholder="New password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Pay/login link</label>
            <input className={fieldCls} placeholder="https://provider.com/login" value={form.loginUrl} onChange={e => setForm(f => ({ ...f, loginUrl: e.target.value }))} />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Notes (optional)</label>
            <input className={fieldCls} placeholder="Any notes about this account" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <p className="text-xs text-gray-600">Credential fields left blank keep their existing value.</p>

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

function DeleteUtilityModal({ account, onClose, onDeleted }: { account: UtilityAccount; onClose: () => void; onDeleted: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  async function handleDelete() {
    setLoading(true);
    try {
      await deleteUtility(account.id);
      onDeleted();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to delete');
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl p-6 space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-white">Delete {account.providerName}?</h3>
        <p className="text-xs text-gray-400">
          This will permanently delete the utility account and all its statements, payments, and history.
          This cannot be undone.
        </p>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button className="btn text-xs flex-1" onClick={onClose}>Cancel</button>
          <button
            className="flex-1 rounded-lg px-3 py-2 text-xs font-medium bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition-colors disabled:opacity-40"
            onClick={handleDelete}
            disabled={loading}
          >
            {loading ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditPropertyModal({ property, onClose, onSaved }: { property: Property; onClose: () => void; onSaved: (p: Property) => void }) {
  const [form, setForm] = useState({
    address:  property.address  || '',
    city:     property.city     || '',
    state:    property.state    || '',
    zip:      property.zip      || '',
    nickname: property.nickname || '',
    type:     property.type     || 'RENTAL',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const fieldCls = 'w-full rounded-lg px-3 py-2 text-sm text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none';

  async function handleSave() {
    setLoading(true); setError('');
    try {
      const updated = await updateProperty(property.id, form);
      onSaved(updated);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to update');
    } finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl p-6 space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Edit property</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Street address</label>
            <input className={fieldCls} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">City</label>
              <input className={fieldCls} value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">State</label>
              <input className={fieldCls} maxLength={2} value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value.toUpperCase().slice(0,2) }))} />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">ZIP</label>
              <input className={fieldCls} value={form.zip} onChange={e => setForm(f => ({ ...f, zip: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Nickname (optional)</label>
              <input className={fieldCls} placeholder="e.g. Beach House" value={form.nickname} onChange={e => setForm(f => ({ ...f, nickname: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Type</label>
              <select className={fieldCls} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as any }))}>
                {['PRIMARY','RENTAL','INVESTMENT','COMMERCIAL'].map(t => (
                  <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button className="btn text-xs flex-1" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary text-xs flex-1" onClick={handleSave} disabled={loading || !form.address || !form.city || !form.state}>
            {loading ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeletePropertyModal({ property, onClose, onDeleted }: { property: Property; onClose: () => void; onDeleted: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const accountCount = property.utilityAccounts?.length ?? 0;

  async function handleDelete() {
    setLoading(true);
    try {
      await deleteProperty(property.id);
      onDeleted();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to delete');
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl p-6 space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-white">Delete {property.nickname || property.address}?</h3>
        <div className="text-xs text-gray-400 space-y-1.5">
          <p>This will permanently delete:</p>
          <ul className="list-disc pl-4 space-y-0.5 text-gray-500">
            <li>The property record</li>
            <li>{accountCount} utility account{accountCount !== 1 ? 's' : ''}</li>
            <li>All statements, payments, and AI insights for this property</li>
          </ul>
          <p className="text-red-400 font-medium pt-1">This cannot be undone.</p>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button className="btn text-xs flex-1" onClick={onClose}>Cancel</button>
          <button
            className="flex-1 rounded-lg px-3 py-2 text-xs font-medium bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition-colors disabled:opacity-40"
            onClick={handleDelete}
            disabled={loading}
          >
            {loading ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}

function UtilityAccountCardWithHistory({
  account, payments, syncing, onSync, onRefresh, propertyId,
}: { account: UtilityAccount; payments: Payment[]; syncing: boolean; onSync: () => void; onRefresh: () => void; propertyId: string }) {
  const [editing,  setEditing]  = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();

  return (
    <div>
      {editing  && <EditUtilityModal   account={account} onClose={() => setEditing(false)}  onSaved={onRefresh} />}
      {deleting && <DeleteUtilityModal account={account} onClose={() => setDeleting(false)} onDeleted={onRefresh} />}
      <UtilityAccountCard account={account} payments={payments} syncing={syncing} onSync={onSync} onEdit={() => setEditing(true)} onDelete={() => setDeleting(true)} />
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
  account, payments, syncing, onSync, onEdit, onDelete
}: { account: UtilityAccount; payments: Payment[]; syncing: boolean; onSync: () => void; onEdit: () => void; onDelete: () => void }) {
  const [revealedAccountNumber, setRevealedAccountNumber] = useState<string | null>(null);
  const [revealingAccountNumber, setRevealingAccountNumber] = useState(false);

  async function toggleAccountNumber() {
    if (revealedAccountNumber != null) { setRevealedAccountNumber(null); return; }
    setRevealingAccountNumber(true);
    try {
      const { accountNumber } = await revealUtilityAccountNumber(account.id);
      setRevealedAccountNumber(accountNumber ?? '');
    } finally {
      setRevealingAccountNumber(false);
    }
  }

  const latest = account.statements?.[0];
  const dueDate = latest?.dueDate ? new Date(latest.dueDate) : null;
  const color = CATEGORY_COLORS[account.category] || '#888';

  // Reconcile balance against recent payments so a payment that hasn't yet posted
  // to the provider's API still shows up correctly. If the latest payment is after
  // the latest statement AND covers the open balance, treat the bill as paid.
  const raw = latest?.rawDataJson as Record<string, unknown> | undefined;
  const openBalance = (raw?.accountBalance ?? raw?.totalDue ?? (latest as any)?.balance ?? latest?.amountDue) as number | undefined;
  const stmtDate = latest?.statementDate ? new Date(latest.statementDate) : null;
  const recentPmt = payments
    .filter(p => stmtDate ? new Date(p.paymentDate) >= stmtDate : true)
    .sort((a, b) => new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime())[0];
  const recentPaidSum = payments
    .filter(p => stmtDate ? new Date(p.paymentDate) >= stmtDate : false)
    .reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const isPaidViaPayment = !!recentPmt && openBalance != null && recentPaidSum >= openBalance - 0.01;
  const isPaidViaStatement = (latest?.amountPaid != null && Number(latest.amountPaid) > 0) || raw?.isPaid === true;
  const isPaid = isPaidViaPayment || isPaidViaStatement;

  const now = new Date();
  const isPastDue = !isPaid && dueDate != null && dueDate < now;
  const isDueSoon = !isPaid && !isPastDue && dueDate != null && dueDate <= new Date(Date.now() + 7 * 86400000);

  // Status pill: paid > past due > due soon > sync status.
  // Bill state takes priority over sync state because the user cares about whether they owe money.
  const statusLabel = isPaid ? 'Paid'
    : isPastDue ? 'Past due'
    : isDueSoon ? 'Due soon'
    : account.lastSyncStatus === 'SUCCESS' ? 'Synced'
    : account.lastSyncStatus === 'FAILED' ? 'Sync failed'
    : account.lastSyncStatus === 'PENDING' ? 'Syncing…'
    : 'Not synced';

  const pillColor: any = isPaid ? 'green'
    : isPastDue ? 'red'
    : isDueSoon ? 'amber'
    : account.lastSyncStatus === 'SUCCESS' ? 'green'
    : account.lastSyncStatus === 'FAILED' ? 'red' : 'gray';

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
          <div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-sm font-semibold text-white">{account.providerName}</p>
              <button
                onClick={onEdit}
                title="Edit account"
                className="px-1.5 py-0.5 rounded text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-colors leading-none border border-white/10 hover:border-white/20"
              >
                Edit
              </button>
              <button
                onClick={onDelete}
                title="Delete account"
                className="px-1.5 py-0.5 rounded text-xs text-red-500/60 hover:text-red-400 hover:bg-red-500/10 transition-colors leading-none border border-red-500/20 hover:border-red-500/40"
              >
                Delete
              </button>
            </div>
            {account.accountNumber ? (
              <p className="text-xs font-mono text-gray-400 flex items-center gap-1">
                {revealedAccountNumber != null ? revealedAccountNumber : account.accountNumber}
                <button
                  onClick={toggleAccountNumber}
                  disabled={revealingAccountNumber}
                  title={revealedAccountNumber != null ? 'Hide account number' : 'Show full account number'}
                  className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40"
                >
                  {revealingAccountNumber ? '…' : revealedAccountNumber != null ? '🙈' : '👁'}
                </button>
              </p>
            ) : (
              <p className="text-xs font-mono text-gray-400">No account #</p>
            )}
          </div>
        </div>
        <Pill color={pillColor}>{statusLabel}</Pill>
      </div>

      <div className="flex items-end justify-between">
        <div className="flex-1 min-w-0">
          {(() => {
            const raw = latest?.rawDataJson as Record<string, unknown> | undefined;
            // accountBalance / totalDue = total amount owed (current + past due).
            // balance is the DB-level field; fall back to amountDue if nothing else is available.
            const accountBalance = (raw?.accountBalance ?? raw?.totalDue ?? (latest as any)?.balance) as number | undefined;
            const pastDue = raw?.pastDue as number | undefined;
            const fmt = (n: number) => `$${Number(n).toFixed(2)}`;

            // Total balance = full amount owed including any past due
            // Current charge = this billing period only (amountDue)
            // Past due = amount from prior unpaid periods (due immediately)
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

            // When the bill is paid (either via amountPaid in DB OR by a recent matching payment
            // that hasn't yet posted on the provider's side), show $0 as the topline and a small
            // "paid" sub-line instead of repeating the now-stale balance.
            const displayBalance = isPaid ? 0 : (totalBalance ?? 0);
            return (
              <>
                {/* Total balance — big topline number */}
                <p className="text-xl font-semibold text-white">
                  {totalBalance != null ? fmt(displayBalance) : '—'}
                </p>

                {/* Paid sub-line: reassures the user their payment is recognized even when
                    the provider's API hasn't reflected it yet. */}
                {isPaid && recentPmt && !isPaidViaStatement && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-xs text-emerald-400">
                      Paid {fmt(Number(recentPmt.amount))} on {format(new Date(recentPmt.paymentDate), 'MMM d')}
                    </span>
                  </div>
                )}

                {/* Past due row — red, due immediately */}
                {!isPaid && pastDueAmt != null && pastDueAmt > 0 && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-xs font-medium text-red-400">Past due: {fmt(pastDueAmt)}</span>
                    <span className="text-xs text-red-500/70">· due immediately</span>
                  </div>
                )}

                {/* Current charge row */}
                {!isPaid && currentCharge != null && (
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
        <div className="flex items-center gap-2 ml-3 flex-shrink-0">
          {account.loginUrl && (
            <a
              href={account.loginUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Pay on ${account.providerName}'s site`}
              className="btn text-xs"
            >
              Pay ↗
            </a>
          )}
          <button
            onClick={onSync}
            disabled={syncing}
            className="btn text-xs"
          >
            {syncing ? 'Syncing…' : 'Sync ↻'}
          </button>
        </div>
      </div>

      {/* No credentials banner */}
      {account.lastSyncStatus === 'FAILED' && account.lastSyncError?.startsWith('No credentials') && (
        <div className="mt-3 px-3 py-2 rounded-lg text-xs space-y-1"
          style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)' }}>
          <p className="font-medium text-indigo-400">Credentials required to sync</p>
          <p className="text-gray-400">
            Click <span className="text-gray-200">Edit</span> and add the username and password you use to log in to the{' '}
            <span className="text-gray-200">{account.providerName}</span> portal.
          </p>
        </div>
      )}

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
