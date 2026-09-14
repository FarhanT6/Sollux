import { useEffect, useState } from 'react';
import { deleteProperty, getProperties, mergeProperty } from '../api/client';
import type { Property } from '../types';

/**
 * Delete a property — or, when it is a duplicate, fold it into the real one
 * first. Merging re-points every utility account, statement, unit, lease,
 * expense, loan, policy, tax record, document and insight at the property
 * chosen here, then removes the now-empty duplicate. Plain delete drops all
 * of that with the property.
 */
export default function DeletePropertyModal({ property, onClose, onDeleted }: {
  property: Property; onClose: () => void; onDeleted: (mergedIntoId?: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [mode, setMode]       = useState<'delete' | 'merge'>('delete');
  const [others, setOthers]   = useState<Property[]>([]);
  const [targetId, setTargetId] = useState('');
  const accountCount = property.utilityAccounts?.length ?? 0;

  useEffect(() => {
    getProperties().then(list => {
      const rest = list.filter(p => p.id !== property.id);
      setOthers(rest);
      // A duplicate is usually the same street address: offer that one first.
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const twin = rest.find(p => norm(p.address) === norm(property.address) && p.city === property.city);
      if (twin) { setTargetId(twin.id); setMode('merge'); }
    }).catch(() => {});
  }, [property.id, property.address, property.city]);

  async function handle() {
    setLoading(true);
    setError('');
    try {
      if (mode === 'merge') {
        if (!targetId) { setError('Choose the property to keep.'); setLoading(false); return; }
        await mergeProperty(property.id, targetId);
        onDeleted(targetId);
      } else {
        await deleteProperty(property.id);
        onDeleted();
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || (mode === 'merge' ? 'Failed to merge' : 'Failed to delete'));
      setLoading(false);
    }
  }

  const label = (p: Property) => `${p.nickname ? `${p.nickname} — ` : ''}${p.address}, ${p.city}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl p-6 space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-white">Remove {property.nickname || property.address}?</h3>

        <div className="flex rounded-lg overflow-hidden text-xs" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
          <button onClick={() => setMode('merge')} disabled={others.length === 0}
            className={`flex-1 px-3 py-2 transition-colors disabled:opacity-40 ${mode === 'merge' ? 'bg-amber-500/15 text-amber-400' : 'text-gray-400 hover:text-white'}`}>
            Move everything to another property
          </button>
          <button onClick={() => setMode('delete')}
            className={`flex-1 px-3 py-2 transition-colors ${mode === 'delete' ? 'bg-red-500/15 text-red-400' : 'text-gray-400 hover:text-white'}`}>
            Delete everything
          </button>
        </div>

        {mode === 'merge' ? (
          <div className="text-xs text-gray-400 space-y-2">
            <p>Use this for a duplicate. Its utility accounts, statements, expenses, loans, tenants, documents and history move to the property you keep, then the duplicate is removed.</p>
            <select value={targetId} onChange={e => setTargetId(e.target.value)} className="input-dark w-full text-sm">
              <option value="">— Keep which property? —</option>
              {others.map(p => <option key={p.id} value={p.id}>{label(p)}</option>)}
            </select>
            <p className="text-gray-500">Nothing is deleted except the empty duplicate record. The kept property's own name, address and value are untouched.</p>
          </div>
        ) : (
          <div className="text-xs text-gray-400 space-y-1.5">
            <p>This will permanently delete:</p>
            <ul className="list-disc pl-4 space-y-0.5 text-gray-500">
              <li>The property record</li>
              <li>{accountCount} utility account{accountCount !== 1 ? 's' : ''}</li>
              <li>All statements, payments, expenses, loans, leases, documents and AI insights for this property</li>
            </ul>
            <p className="text-red-400 font-medium pt-1">This cannot be undone.</p>
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button className="btn text-xs flex-1" onClick={onClose}>Cancel</button>
          <button
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium border transition-colors disabled:opacity-40 ${
              mode === 'merge'
                ? 'bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/25'
                : 'bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25'}`}
            onClick={handle}
            disabled={loading || (mode === 'merge' && !targetId)}
          >
            {loading ? (mode === 'merge' ? 'Moving…' : 'Deleting…') : (mode === 'merge' ? 'Move and remove duplicate' : 'Delete permanently')}
          </button>
        </div>
      </div>
    </div>
  );
}
