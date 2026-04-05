import { useEffect, useState } from 'react';
import { getStatements } from '../api/client';
import type { Statement } from '../types';
import { PageHeader, EmptyState, Skeleton } from '../components/ui';
import { format } from 'date-fns';

export default function DocumentsPage() {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getStatements({}).then(data => setStatements(data.filter(s => s.pdfS3Key))).finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <PageHeader title="Document vault" subtitle={`${statements.length} statements auto-saved`} />
      <div className="px-6 py-5">
        {loading ? <div className="grid grid-cols-3 gap-3">{Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-28" />)}</div> :
          statements.length === 0 ? <EmptyState icon="📄" title="No documents yet" body="PDFs will be saved here automatically as statements are scraped." /> : (
            <div className="grid grid-cols-3 gap-3">
              {statements.map(stmt => (
                <div key={stmt.id} className="card p-3 hover:border-gold-300 transition-colors cursor-pointer">
                  <div className="w-8 h-9 bg-red-500/10 rounded flex items-center justify-center mb-2">
                    <div className="w-3.5 h-4 bg-red-400 rounded-sm" />
                  </div>
                  <p className="text-xs font-medium text-gray-100 truncate">
                    {stmt.utilityAccount?.providerName}_{format(new Date(stmt.statementDate), 'MMMyyyy')}.pdf
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {stmt.utilityAccount?.property?.nickname || stmt.utilityAccount?.property?.address}
                  </p>
                  <p className="text-xs text-gray-400">
                    {stmt.amountDue ? `$${Number(stmt.amountDue).toFixed(2)} · ` : ''}{format(new Date(stmt.statementDate), 'MMM d, yyyy')}
                  </p>
                </div>
              ))}
            </div>
          )
        }
      </div>
    </div>
  );
}
