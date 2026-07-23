import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getNotices, getLeases, createNotice, getNoticePreview } from '../api/client';
import type { RentNotice, Lease } from '../types';
import { format } from 'date-fns';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export default function NoticesPage() {
  const [notices, setNotices] = useState<RentNotice[]>([]);
  const [activeLeases, setActiveLeases] = useState<Lease[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [selectedLeaseId, setSelectedLeaseId] = useState('');
  const [signedBy, setSignedBy] = useState('');
  const [preview, setPreview] = useState<{ lineItems: { amount: number; dueDate: string }[]; totalDue: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([getNotices(), getLeases({ status: 'ACTIVE' })]).then(([n, l]) => {
      setNotices(n);
      setActiveLeases(l);
    }).finally(() => setLoading(false));
  }, []);

  async function handlePreview() {
    if (!selectedLeaseId) return;
    setPreviewing(true);
    try {
      const p = await getNoticePreview(selectedLeaseId);
      setPreview(p);
    } finally { setPreviewing(false); }
  }

  async function handleCreate() {
    if (!selectedLeaseId || !signedBy || !preview) return;
    setSaving(true);
    try {
      await createNotice({
        leaseId: selectedLeaseId,
        noticeDate: new Date().toISOString(),
        lineItems: preview.lineItems.map(i => ({ amount: i.amount, dueDate: new Date(i.dueDate).toISOString() })),
        totalDue: preview.totalDue,
        signedByName: signedBy,
      });
      const updated = await getNotices();
      setNotices(updated);
      setShowNewForm(false);
      setSelectedLeaseId('');
      setPreview(null);
      setSignedBy('');
    } finally { setSaving(false); }
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">3-Day Notices</h1>
          <p className="text-sm text-gray-400 mt-0.5">{notices.length} notices on file</p>
        </div>
        <button onClick={() => setShowNewForm(v => !v)} className="btn-primary text-sm">
          {showNewForm ? 'Cancel' : '+ New Notice'}
        </button>
      </div>

      {showNewForm && (
        <div className="rounded-xl p-5 mb-5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Lease</label>
              <select
                value={selectedLeaseId}
                onChange={e => { setSelectedLeaseId(e.target.value); setPreview(null); }}
                className="input-dark w-full"
              >
                <option value="">Select active lease…</option>
                {activeLeases.map(l => {
                  const prop = l.unit?.property;
                  const tenants = l.leaseTenants?.map(lt => lt.tenant.fullName).join(', ');
                  return (
                    <option key={l.id} value={l.id}>
                      {prop?.nickname || prop?.address} — {l.unit?.unitLabel} — {tenants}
                    </option>
                  );
                })}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Signed by</label>
              <input
                value={signedBy}
                onChange={e => setSignedBy(e.target.value)}
                placeholder="Your name"
                className="input-dark w-full"
              />
            </div>
          </div>

          <button onClick={handlePreview} disabled={!selectedLeaseId || previewing} className="text-sm text-amber-400 hover:text-amber-300 mr-4">
            {previewing ? 'Computing…' : 'Preview breakdown'}
          </button>

          {preview && (
            <div className="mt-4 mb-4 p-4 rounded-lg" style={{ background: 'rgba(0,0,0,0.3)' }}>
              <p className="text-xs text-gray-400 mb-2">Amounts due:</p>
              {preview.lineItems.map((item, i) => (
                <div key={i} className="flex justify-between text-sm text-white mb-1">
                  <span>{format(new Date(item.dueDate), 'MMMM yyyy')}</span>
                  <span>{money(item.amount)}</span>
                </div>
              ))}
              <div className="flex justify-between text-sm font-semibold text-amber-400 border-t border-white/10 mt-2 pt-2">
                <span>Total due</span>
                <span>{money(preview.totalDue)}</span>
              </div>
            </div>
          )}

          <button
            onClick={handleCreate}
            disabled={!selectedLeaseId || !signedBy || !preview || saving}
            className="btn-primary text-sm"
          >
            {saving ? 'Saving…' : 'Create & Save Notice'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : notices.length === 0 ? (
        <div className="text-center py-16 text-gray-500">No notices on file</div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
              <tr className="text-left text-gray-400 text-xs">
                <th className="px-4 py-3">Date served</th>
                <th className="px-4 py-3">Property</th>
                <th className="px-4 py-3">Tenant(s)</th>
                <th className="px-4 py-3 text-right">Total due</th>
                <th className="px-4 py-3">Signed by</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {notices.map(n => {
                const tenants = n.lease?.leaseTenants?.map(lt => lt.tenant.fullName).join(', ') || '—';
                const prop = n.lease?.unit?.property;
                return (
                  <tr key={n.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3 text-gray-400 text-xs">{format(new Date(n.noticeDate), 'MMM d, yyyy')}</td>
                    <td className="px-4 py-3 text-white text-xs">{prop?.nickname || prop?.address || '—'}</td>
                    <td className="px-4 py-3 text-gray-300 text-xs">{tenants}</td>
                    <td className="px-4 py-3 text-right font-medium text-red-400 text-xs">{money(Number(n.totalDue))}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{n.signedByName}</td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/notices/${n.id}`} className="text-xs text-amber-400 hover:text-amber-300">Print</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
