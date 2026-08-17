import { useEffect, useState, useMemo } from 'react';
import { getStatements, getStatementDownloadUrl } from '../api/client';
import type { Statement } from '../types';
import { PageHeader, EmptyState, Skeleton } from '../components/ui';
import { format } from 'date-fns';
import { fmtDate } from '../lib/date';

const inputClass = 'rounded-lg px-3 py-1.5 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-amber-500/50 bg-white/6 border border-white/8';

export default function DocumentsPage() {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [propertyFilter, setPropertyFilter] = useState('all');

  useEffect(() => {
    getStatements({}).then(data => setStatements(data)).finally(() => setLoading(false));
  }, []);

  const properties = useMemo(() => {
    const seen = new Set<string>();
    statements.forEach(s => {
      const p = s.utilityAccount?.property?.nickname || s.utilityAccount?.property?.address || '';
      if (p) seen.add(p);
    });
    return Array.from(seen).sort();
  }, [statements]);

  const filtered = useMemo(() => {
    let result = statements;
    if (propertyFilter !== 'all') {
      result = result.filter(s =>
        (s.utilityAccount?.property?.nickname || s.utilityAccount?.property?.address) === propertyFilter
      );
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(s =>
        (s.utilityAccount?.providerName || '').toLowerCase().includes(q) ||
        (s.utilityAccount?.property?.nickname || s.utilityAccount?.property?.address || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [statements, propertyFilter, search]);

  const byProperty = useMemo(() => {
    const groups = new Map<string, Statement[]>();
    filtered.forEach(s => {
      const key = s.utilityAccount?.property?.nickname || s.utilityAccount?.property?.address || 'Unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    });
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const handleClick = async (stmt: Statement) => {
    if (!stmt.pdfS3Key) return;
    try {
      const res = await getStatementDownloadUrl(stmt.id);
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch { alert('Could not open PDF. Please try again.'); }
  };

  const pdfCount = statements.filter(s => s.pdfS3Key).length;

  return (
    <div>
      <PageHeader
        title="Document vault"
        subtitle={`${statements.length} statements · ${pdfCount} with PDF · ${properties.length} properties`}
      />
      <div className="px-6 py-5">
        {/* Filter bar */}
        <div className="flex gap-3 mb-6">
          <input
            type="text"
            placeholder="Search provider or property..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={`${inputClass} flex-1`}
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
          />
          <select
            value={propertyFilter}
            onChange={e => setPropertyFilter(e.target.value)}
            className={inputClass}
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', minWidth: 180 }}
          >
            <option value="all">All properties</option>
            {properties.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        {loading ? (
          <div className="grid grid-cols-3 gap-3">
            {Array(9).fill(0).map((_, i) => <Skeleton key={i} className="h-28" />)}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon="📄" title="No statements" body={search || propertyFilter !== 'all' ? 'No statements match your filters.' : 'Statements will appear here automatically once accounts are synced.'} />
        ) : (
          <div className="space-y-8">
            {byProperty.map(([propName, stmts]) => (
              <div key={propName}>
                <div className="flex items-center gap-3 mb-3">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{propName}</p>
                  <span className="text-xs text-gray-600">{stmts.length} statement{stmts.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {stmts.map(stmt => (
                    <div
                      key={stmt.id}
                      onClick={() => handleClick(stmt)}
                      className={`card p-3 transition-colors ${stmt.pdfS3Key ? 'hover:border-amber-500/40 cursor-pointer' : 'cursor-default'}`}
                    >
                      <div className={`w-8 h-9 rounded flex items-center justify-center mb-2 ${stmt.pdfS3Key ? 'bg-red-500/10' : 'bg-white/4'}`}>
                        {stmt.pdfS3Key
                          ? <div className="w-3.5 h-4 bg-red-400 rounded-sm" />
                          : <span className="text-sm">📋</span>
                        }
                      </div>
                      <p className="text-xs font-medium text-gray-200 truncate">
                        {stmt.utilityAccount?.providerName}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {fmtDate(stmt.statementDate, 'MMM d, yyyy')}
                        {stmt.amountDue ? ` · $${Number(stmt.amountDue).toFixed(2)}` : ''}
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
      </div>
    </div>
  );
}
