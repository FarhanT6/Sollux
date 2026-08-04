import { useEffect, useMemo, useState } from 'react';
import {
  getReconciliationProfiles, createReconciliationProfile, deleteReconciliationProfile,
  getReconciliationStatements, createReconciliationStatement, applyReconciliationStatement,
  deleteReconciliationStatement, uploadReconciliationDocument,
  getProperties, getLeases, getLoans,
} from '../api/client';
import type {
  ReconciliationProfile, ReconciliationStatement, ReconciliationLineItem,
  Property, Lease, Loan, ExpenseCategory,
} from '../types';
import { EXPENSE_CATEGORY_LABELS } from '../types';
import { format } from 'date-fns';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ReconciliationPage({ embedded }: { embedded?: boolean } = {}) {
  const [profiles, setProfiles] = useState<ReconciliationProfile[]>([]);
  const [statements, setStatements] = useState<ReconciliationStatement[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [showNewStatement, setShowNewStatement] = useState(false);

  const load = async () => {
    const [p, s, props, l] = await Promise.all([
      getReconciliationProfiles(), getReconciliationStatements(), getProperties(), getLoans(),
    ]);
    setProfiles(p);
    setStatements(s);
    setProperties(props);
    setLoans(l);
    if (!selectedProfileId && p.length > 0) setSelectedProfileId(p[0].id);
  };

  useEffect(() => { load().finally(() => setLoading(false)); }, []);

  const selectedProfile = profiles.find(p => p.id === selectedProfileId) ?? null;
  const profileStatements = statements.filter(s => s.profileId === selectedProfileId);

  if (loading) return <div className="p-6 text-gray-500 text-sm">Loading…</div>;

  return (
    <div className={embedded ? '' : 'p-6 max-w-6xl mx-auto'}>
      {!embedded && (
        <div className="mb-4">
          <h1 className="text-xl font-semibold text-white">Reconciliation</h1>
          <p className="text-sm text-gray-400 mt-0.5">Monthly statements from a manager/collector who nets rent, fees, and loan payments together</p>
        </div>
      )}

      <div className="flex gap-6">
        {/* Profile sidebar */}
        <div className="w-56 flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Profiles</p>
            <button onClick={() => setShowNewProfile(true)} className="text-xs text-amber-400 hover:text-amber-300">+ New</button>
          </div>
          <div className="space-y-1">
            {profiles.map(p => (
              <button key={p.id} onClick={() => setSelectedProfileId(p.id)}
                className={`w-full text-left text-sm px-3 py-2 rounded-lg transition-colors ${
                  selectedProfileId === p.id ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5'
                }`}>
                {p.name}
              </button>
            ))}
            {profiles.length === 0 && <p className="text-xs text-gray-600">No profiles yet — create one to get started.</p>}
          </div>
        </div>

        {/* Statements for selected profile */}
        <div className="flex-1 min-w-0">
          {!selectedProfile ? (
            <p className="text-sm text-gray-500">Select or create a profile to see its statements.</p>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-semibold text-white">{selectedProfile.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {selectedProfile.property && `Rent: ${selectedProfile.property.nickname || selectedProfile.property.address}`}
                    {selectedProfile.loanIds.length > 0 && ` · ${selectedProfile.loanIds.length} loan${selectedProfile.loanIds.length > 1 ? 's' : ''}`}
                    {selectedProfile.managementFeeCategory && ` · mgmt fee: ${EXPENSE_CATEGORY_LABELS[selectedProfile.managementFeeCategory as ExpenseCategory] ?? selectedProfile.managementFeeCategory}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={async () => { if (confirm(`Delete profile "${selectedProfile.name}"? Applied statements are kept regardless.`)) { await deleteReconciliationProfile(selectedProfile.id); setSelectedProfileId(null); load(); } }}
                    className="text-xs text-red-500 hover:text-red-400">Delete profile</button>
                  <button onClick={() => setShowNewStatement(true)} className="btn-primary text-xs px-3 py-1.5">+ New statement</button>
                </div>
              </div>

              {profileStatements.length === 0 ? (
                <p className="text-sm text-gray-500 py-8 text-center">No statements logged for this profile yet.</p>
              ) : (
                <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
                  <table className="w-full text-sm">
                    <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
                      <tr className="text-left text-gray-400 text-xs">
                        <th className="px-4 py-3">Date</th>
                        <th className="px-4 py-3">Line items</th>
                        <th className="px-4 py-3 text-right">Net</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {profileStatements.map(s => (
                        <tr key={s.id}>
                          <td className="px-4 py-3 text-gray-300 text-xs whitespace-nowrap">{format(new Date(s.statementDate), 'MMM yyyy')}</td>
                          <td className="px-4 py-3 text-gray-500 text-xs">{s.lineItems.length} item{s.lineItems.length !== 1 ? 's' : ''}</td>
                          <td className={`px-4 py-3 text-right font-medium ${s.netAmount >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{money(s.netAmount)}</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${s.status === 'APPLIED' ? 'bg-emerald-900/40 text-emerald-500' : 'bg-amber-900/40 text-amber-400'}`}>
                              {s.status === 'APPLIED' ? 'Applied' : 'Draft'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            {s.status === 'DRAFT' ? (
                              <>
                                <button onClick={async () => { if (confirm('Apply this statement? This creates the real rent, loan, and expense records.')) { await applyReconciliationStatement(s.id); load(); } }}
                                  className="text-xs text-amber-400 hover:text-amber-300 mr-3">Apply</button>
                                <button onClick={async () => { if (confirm('Delete this draft?')) { await deleteReconciliationStatement(s.id); load(); } }}
                                  className="text-xs text-red-500 hover:text-red-400">Delete</button>
                              </>
                            ) : (
                              <span className="text-xs text-gray-600">{s.appliedAt && format(new Date(s.appliedAt), 'MMM d, yyyy')}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showNewProfile && (
        <NewProfileModal
          properties={properties}
          loans={loans}
          onClose={() => setShowNewProfile(false)}
          onCreated={async (p) => { setShowNewProfile(false); await load(); setSelectedProfileId(p.id); }}
        />
      )}

      {showNewStatement && selectedProfile && (
        <NewStatementModal
          profile={selectedProfile}
          loans={loans}
          onClose={() => setShowNewStatement(false)}
          onCreated={async () => { setShowNewStatement(false); await load(); }}
        />
      )}
    </div>
  );
}

// ─── New Profile Modal ──────────────────────────────────────

function NewProfileModal({ properties, loans, onClose, onCreated }: {
  properties: Property[]; loans: Loan[];
  onClose: () => void; onCreated: (p: ReconciliationProfile) => void;
}) {
  const [name, setName] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [leaseId, setLeaseId] = useState('');
  const [leases, setLeases] = useState<Lease[]>([]);
  const [managementFeeCategory, setManagementFeeCategory] = useState('PROPERTY_MANAGEMENT');
  const [collectsRent, setCollectsRent] = useState(true);
  const [collectsFee, setCollectsFee] = useState(true);
  const [loanIds, setLoanIds] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!propertyId) { setLeases([]); return; }
    getLeases({ propertyId, status: 'ACTIVE' }).then(setLeases);
  }, [propertyId]);

  function toggleLoan(id: string) {
    setLoanIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function handleSave() {
    if (!name) return;
    setSaving(true);
    try {
      const created = await createReconciliationProfile({
        name,
        propertyId: propertyId || null,
        leaseId: collectsRent ? (leaseId || null) : null,
        managementFeeCategory: collectsFee ? managementFeeCategory : null,
        loanIds,
        notes: notes || null,
      });
      onCreated(created);
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-2xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: '#1a1a1a', border: '1px solid rgba(255,255,255,0.1)' }}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-white">New reconciliation profile</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        <label className="field-label">Name *</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Monty James" className="field-input mb-3 w-full" />

        <label className="flex items-center gap-2 text-sm text-gray-300 mb-2 cursor-pointer">
          <input type="checkbox" checked={collectsRent} onChange={e => setCollectsRent(e.target.checked)} />
          Collects rent for a property
        </label>
        {collectsRent && (
          <div className="grid grid-cols-2 gap-3 mb-3 pl-6">
            <div>
              <label className="field-label">Property</label>
              <select value={propertyId} onChange={e => { setPropertyId(e.target.value); setLeaseId(''); }} className="field-input w-full">
                <option value="">— Select —</option>
                {properties.map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">Lease / unit</label>
              <select value={leaseId} onChange={e => setLeaseId(e.target.value)} className="field-input w-full" disabled={!propertyId}>
                <option value="">— Select —</option>
                {leases.map(l => <option key={l.id} value={l.id}>{l.unit?.unitLabel ?? l.id} — {money(Number(l.rentAmount))}/mo</option>)}
              </select>
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-gray-300 mb-2 cursor-pointer">
          <input type="checkbox" checked={collectsFee} onChange={e => setCollectsFee(e.target.checked)} />
          Deducts a management fee
        </label>
        {collectsFee && (
          <div className="mb-3 pl-6">
            <label className="field-label">Expense category</label>
            <select value={managementFeeCategory} onChange={e => setManagementFeeCategory(e.target.value)} className="field-input w-full">
              {Object.entries(EXPENSE_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        )}

        <label className="field-label">Also collects payments on these loans</label>
        <div className="mb-3 max-h-40 overflow-y-auto rounded-lg border border-white/10 p-2 space-y-1">
          {loans.map(l => (
            <label key={l.id} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer px-1 py-1 hover:bg-white/5 rounded">
              <input type="checkbox" checked={loanIds.includes(l.id)} onChange={() => toggleLoan(l.id)} />
              {l.lender} {l.property && <span className="text-gray-500">— {l.property.nickname || l.property.address}</span>}
            </label>
          ))}
          {loans.length === 0 && <p className="text-xs text-gray-600 px-1">No loans on file.</p>}
        </div>

        <label className="field-label">Notes</label>
        <input value={notes} onChange={e => setNotes(e.target.value)} className="field-input mb-4 w-full" />

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">Cancel</button>
          <button disabled={!name || saving} onClick={handleSave} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {saving ? 'Saving…' : 'Create profile'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── New Statement Modal ────────────────────────────────────

function NewStatementModal({ profile, loans, onClose, onCreated }: {
  profile: ReconciliationProfile; loans: Loan[];
  onClose: () => void; onCreated: () => void;
}) {
  const profileLoans = useMemo(() => loans.filter(l => profile.loanIds.includes(l.id)), [loans, profile]);

  const [statementDate, setStatementDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [items, setItems] = useState<ReconciliationLineItem[]>(() => {
    const initial: ReconciliationLineItem[] = [];
    if (profile.leaseId) {
      initial.push({ type: 'RENT', targetId: profile.leaseId, targetLabel: 'Rent collected', description: 'Rent collected', amount: 0, direction: 'CREDIT' });
    }
    if (profile.managementFeeCategory) {
      initial.push({ type: 'EXPENSE', targetId: null, targetLabel: 'Management fee', description: 'Management fee', amount: 0, direction: 'DEBIT' });
    }
    for (const l of profileLoans) {
      initial.push({ type: 'LOAN_PAYMENT', targetId: l.id, targetLabel: l.lender, description: `${l.lender} loan payment`, amount: 0, direction: 'DEBIT' });
    }
    return initial;
  });
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const netAmount = items.reduce((s, it) => s + (it.direction === 'CREDIT' ? it.amount : -it.amount), 0);

  function updateItem(i: number, patch: Partial<ReconciliationLineItem>) {
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  }
  function addOtherItem() {
    setItems(prev => [...prev, { type: 'OTHER', targetId: null, targetLabel: null, description: '', amount: 0, direction: 'DEBIT' }]);
  }
  function removeItem(i: number) {
    setItems(prev => prev.filter((_, idx) => idx !== i));
  }

  async function handleSave() {
    setError(null);
    const valid = items.filter(it => it.amount > 0);
    if (valid.length === 0) { setError('Enter at least one non-zero amount.'); return; }
    setSaving(true);
    try {
      const statement = await createReconciliationStatement({
        profileId: profile.id,
        statementDate,
        lineItems: valid,
        notes: notes || undefined,
      });
      if (file) {
        const base64 = await readFileAsBase64(file);
        await uploadReconciliationDocument(statement.id, base64, file.name);
      }
      onCreated();
    } catch {
      setError('Failed to save statement. Please try again.');
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl rounded-2xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: '#1a1a1a', border: '1px solid rgba(255,255,255,0.1)' }}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-white">New statement — {profile.name}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">{error}</div>}

        <label className="field-label">Statement date</label>
        <input type="date" value={statementDate} onChange={e => setStatementDate(e.target.value)} className="field-input mb-4 w-full" />

        <p className="text-xs text-gray-500 mb-2 uppercase tracking-wide">Line items</p>
        <div className="space-y-2 mb-3">
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => updateItem(i, { direction: it.direction === 'CREDIT' ? 'DEBIT' : 'CREDIT' })}
                title="Click to flip"
                className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 w-24 text-center cursor-pointer transition-colors ${it.direction === 'CREDIT' ? 'bg-emerald-900/40 text-emerald-400 hover:bg-emerald-900/60' : 'bg-red-900/40 text-red-400 hover:bg-red-900/60'}`}
              >
                {it.direction === 'CREDIT' ? 'Owed to you' : 'Deducted'}
              </button>
              <input value={it.description ?? ''} onChange={e => updateItem(i, { description: e.target.value })}
                placeholder="Description" className="field-input text-sm flex-1" />
              <input type="number" value={it.amount || ''} onChange={e => updateItem(i, { amount: parseFloat(e.target.value) || 0 })}
                placeholder="0.00" className="field-input text-sm w-28" />
              {it.type === 'OTHER' && (
                <button onClick={() => removeItem(i)} className="text-gray-600 hover:text-red-400 text-sm px-1">✕</button>
              )}
            </div>
          ))}
        </div>
        <button onClick={addOtherItem} className="text-xs text-amber-400 hover:text-amber-300 mb-4">+ Add line item</button>

        <div className="rounded-lg px-3 py-2.5 mb-4" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <p className="text-xs text-gray-500">Net {netAmount >= 0 ? 'owed to you' : 'you owe'}</p>
          <p className={`text-lg font-semibold ${netAmount >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{money(Math.abs(netAmount))}</p>
        </div>

        <label className="field-label">Statement document (optional)</label>
        <input type="file" accept="application/pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} className="field-input mb-3 w-full text-sm" />

        <label className="field-label">Notes</label>
        <input value={notes} onChange={e => setNotes(e.target.value)} className="field-input mb-4 w-full" />

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">Cancel</button>
          <button disabled={saving} onClick={handleSave} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {saving ? 'Saving…' : 'Save as draft'}
          </button>
        </div>
      </div>
    </div>
  );
}
