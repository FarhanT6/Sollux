import { useEffect, useState } from 'react';
import api from '../../api/client';
import { fmtDate } from '../../lib/date';

interface AuditRequest {
  id: string; name: string; email: string; phone: string | null; properties: number | null;
  currentTools: string | null; notes: string | null; status: string; createdAt: string;
  files: { name: string; url: string }[];
}
const STATUSES = ['new', 'contacted', 'audited', 'converted', 'declined'] as const;

/** Free portfolio audit requests from the landing page (admin only): who asked, their bills, and where each stands. */
export default function AuditRequestsPanel() {
  const [rows, setRows] = useState<AuditRequest[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get<AuditRequest[]>('/admin/audit-requests').then(r => setRows(r.data)).catch(e => setError(e?.response?.data?.error ?? 'Could not load requests.')); }, []);
  const setStatus = (id: string, status: string) =>
    api.patch(`/admin/audit-requests/${id}`, { status }).then(() => setRows(rs => rs?.map(r => r.id === id ? { ...r, status } : r) ?? null));

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!rows) return <p className="text-sm text-gray-500">Loading…</p>;
  if (!rows.length) return <p className="text-sm text-gray-500">No audit requests yet. They arrive from the landing page’s “Get a free portfolio audit” form.</p>;
  return (
    <div className="space-y-3">
      {rows.map(r => (
        <div key={r.id} className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-white">{r.name} <span className="text-gray-500 font-normal">· {fmtDate(r.createdAt, 'MMM d, h:mm a')}</span></p>
              <p className="text-xs text-gray-400 mt-0.5">
                <a className="hover:text-amber-400" href={`mailto:${r.email}`}>{r.email}</a>{r.phone ? ` · ${r.phone}` : ''}
                {r.properties != null ? ` · ${r.properties} properties` : ''}{r.currentTools ? ` · uses ${r.currentTools}` : ''}
              </p>
            </div>
            <select className="input-dark text-xs" value={r.status} onChange={e => void setStatus(r.id, e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
            </select>
          </div>
          {r.notes && <p className="text-xs text-gray-300 mt-2 whitespace-pre-wrap">{r.notes}</p>}
          {r.files.length > 0 && (
            <p className="text-xs mt-2 flex flex-wrap gap-3">
              {r.files.map(f => <a key={f.url} href={f.url} target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:text-amber-300">{f.name} ↗</a>)}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
