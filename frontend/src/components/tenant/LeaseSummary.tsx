import { useState } from 'react';
import type { LeaseDetails } from '../../api/client';
import { summaryRows } from '../../lib/leaseTerms';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/** What was read from the lease agreement, beyond the lease's own fields. */
export default function LeaseSummary({ details, defaultOpen = false }: { details: LeaseDetails | null | undefined; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const rows = summaryRows(details, money);
  if (rows.length === 0) return null;
  return (
    <div className="mt-2">
      <button className="text-xs text-gray-500 hover:text-gray-300" onClick={() => setOpen(o => !o)}>
        {open ? '▾' : '▸'} Lease summary{details?.source ? <span className="text-gray-600"> · from {details.source}</span> : null}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1">
          {rows.map(([label, value], i) => (
            <div key={i} className="grid grid-cols-[130px_1fr] gap-3 text-xs">
              <span className="text-gray-500">{label}</span>
              <span className="text-gray-300">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
