import { Fragment, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getReimbursementInvoice, setReimbursementInvoiceStatus } from '../api/client';
import { fmtDate } from '../lib/date';

/**
 * The invoice a tenant receives, laid out the way it was always sent by
 * hand: month by month, each utility's bill with its statement period, the
 * tenant's share, a total per utility, a total per month, a grand total,
 * then what was paid and what is owed. Printable as-is; Print → Save as PDF
 * is the send.
 */

const money = (v: number | string | null | undefined) => `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: unknown) => Number(v ?? 0) || 0;
const monthOf = (iso: string) => iso.slice(0, 7);
const monthName = (ym: string) => new Date(`${ym}-15T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export default function ReimbursementInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const [inv, setInv] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getReimbursementInvoice(id).then(setInv).catch(err => setError(err?.response?.data?.error ?? 'Invoice not found.'));
  }, [id]);

  const months = useMemo(() => {
    if (!inv) return [];
    const map = new Map<string, any[]>();
    for (const l of inv.lines) {
      const m = monthOf(l.sortKey);
      if (!map.has(m)) map.set(m, []);
      map.get(m)!.push(l);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [inv]);

  if (error) return <div className="p-6 text-sm text-red-400">{error}</div>;
  if (!inv) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  const lease = inv.reimbursement.lease;
  const property = lease.unit.property;
  const tenants = (lease.leaseTenants ?? []).map((lt: any) => lt.tenant.fullName).join(', ');
  const total = num(inv.total), paid = num(inv.paidAmount), balance = total - paid;

  async function markSent() {
    await setReimbursementInvoiceStatus(inv.id, 'SENT');
    setInv({ ...inv, status: 'SENT' });
  }

  return (
    <div className="min-h-screen" style={{ background: '#fff', color: '#111' }}>
      <style>{`
        @media print { .no-print { display: none !important; } body { background: #fff; } }
        .inv table { border-collapse: collapse; width: 100%; }
        .inv th, .inv td { border: 1px solid #d0d0d0; padding: 6px 10px; font-size: 13px; }
        .inv th { background: #7fe9e9; font-weight: 700; text-align: center; }
        .inv td.num { text-align: right; font-variant-numeric: tabular-nums; }
        .inv tr.sub td { background: #fff36b; font-weight: 700; }
        .inv tr.month td { background: #7ee36b; font-weight: 700; }
        .inv tr.grand td { background: #c9b8ea; font-weight: 700; font-size: 14px; }
      `}</style>

      <div className="no-print px-6 py-3 flex items-center gap-3" style={{ borderBottom: '1px solid #e5e5e5', background: '#f7f7f7' }}>
        <Link to={`/tenants`} className="text-xs" style={{ color: '#555' }}>← Back</Link>
        <div className="flex-1" />
        <span className="text-xs" style={{ color: '#777' }}>Status: {inv.status}</span>
        {inv.status === 'DRAFT' && <button onClick={markSent} className="text-xs px-3 py-1 rounded" style={{ border: '1px solid #bbb' }}>Mark as sent</button>}
        <button onClick={() => window.print()} className="text-xs px-3 py-1 rounded" style={{ background: '#F5A623', color: '#000', fontWeight: 600 }}>Print / Save PDF</button>
      </div>

      <div className="inv mx-auto px-8 py-8" style={{ maxWidth: 820 }}>
        {inv.letterhead?.name && (
          <div style={{ borderBottom: '2px solid #111', paddingBottom: 10, marginBottom: 18, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontSize: 22, fontWeight: 700, letterSpacing: 0.3, fontFamily: 'Georgia, "Times New Roman", serif' }}>{inv.letterhead.name}</p>
              {inv.letterhead.address && <p style={{ fontSize: 12, color: '#444' }}>{inv.letterhead.address}</p>}
            </div>
            <div style={{ textAlign: 'right', fontSize: 12, color: '#444' }}>
              {inv.letterhead.phone && <p>{inv.letterhead.phone}</p>}
              {inv.letterhead.email && <p>{inv.letterhead.email}</p>}
            </div>
          </div>
        )}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700 }}>Utility Reimbursement</h1>
            <p style={{ fontSize: 13, color: '#444' }}>{property.nickname || property.address}{lease.unit?.unitLabel ? ` · Unit ${lease.unit.unitLabel}` : ''}</p>
            <p style={{ fontSize: 13, color: '#444' }}>{property.address}, {property.city} {property.state} {property.zip ?? ''}</p>
          </div>
          <div style={{ textAlign: 'right', fontSize: 13, color: '#444' }}>
            <p><strong>Tenant:</strong> {tenants || '—'}</p>
            <p><strong>Period:</strong> {fmtDate(inv.periodStart, 'M/d/yy')} – {fmtDate(inv.periodEnd, 'M/d/yy')}</p>
            <p><strong>Invoice date:</strong> {fmtDate(inv.createdAt, 'M/d/yy')}</p>
          </div>
        </div>

        {months.map(([ym, lines]) => {
          const statementLines = lines.filter((l: any) => l.kind === 'STATEMENT');
          const flatLines = lines.filter((l: any) => l.kind === 'FLAT');
          const byLabel = new Map<string, any[]>();
          for (const l of statementLines) { if (!byLabel.has(l.label)) byLabel.set(l.label, []); byLabel.get(l.label)!.push(l); }
          const monthTotal = lines.reduce((t: number, l: any) => t + num(l.amount), 0);
          return (
            <div key={ym} style={{ marginBottom: 22 }}>
              <table>
                <thead>
                  <tr><th style={{ width: '22%' }}>Utility</th><th style={{ width: '30%' }}>Statement Period</th><th style={{ width: '18%' }}>Amount</th><th style={{ width: '30%' }}>Tenant Share</th></tr>
                </thead>
                <tbody>
                  {[...byLabel.entries()].map(([label, ls]) => (
                    <Fragment key={label}>
                      {ls.map((l: any) => (
                        <tr key={l.id}>
                          <td style={{ textAlign: 'center' }}>{label}</td>
                          <td style={{ textAlign: 'center' }}>{l.periodStart && l.periodEnd ? `${fmtDate(l.periodStart, 'M/d/yy')} – ${fmtDate(l.periodEnd, 'M/d/yy')}` : '—'}</td>
                          <td className="num">{money(l.baseAmount)}</td>
                          <td className="num">{money(l.amount)}{l.sharePercent != null && l.sharePercent !== 100 ? <span style={{ color: '#777', fontSize: 11 }}> ({l.sharePercent}%)</span> : null}</td>
                        </tr>
                      ))}
                      <tr className="sub">
                        <td></td><td></td>
                        <td style={{ textAlign: 'center' }}>{label} Total</td>
                        <td className="num">{money(ls.reduce((t: number, l: any) => t + num(l.amount), 0))}</td>
                      </tr>
                    </Fragment>
                  ))}
                  {flatLines.map((l: any) => (
                    <tr className="sub" key={l.id}>
                      <td style={{ textAlign: 'center', background: '#fff', fontWeight: 400 }}>{l.label}</td>
                      <td style={{ textAlign: 'center', background: '#fff', fontWeight: 400 }}>1 month · {money(l.baseAmount)}/month</td>
                      <td style={{ textAlign: 'center' }}>{l.label.replace(/\s*\(.*\)$/, '')} Total</td>
                      <td className="num">{money(l.amount)}</td>
                    </tr>
                  ))}
                  <tr className="month">
                    <td></td><td></td>
                    <td style={{ textAlign: 'center' }}>{monthName(ym)} Total</td>
                    <td className="num">{money(monthTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          );
        })}

        <table style={{ maxWidth: 420, marginLeft: 'auto' }}>
          <tbody>
            <tr className="grand"><td>Total</td><td className="num">{money(inv.subtotal)}</td></tr>
            {num(inv.creditApplied) > 0 && <tr><td>Credit from previous overpayment</td><td className="num">−{money(inv.creditApplied)}</td></tr>}
            {num(inv.creditApplied) > 0 && <tr className="grand"><td>Amount due</td><td className="num">{money(total)}</td></tr>}
            {paid > 0 && <tr><td>Paid{inv.paidAt ? ` on ${fmtDate(inv.paidAt, 'M/d/yy')}` : ''}</td><td className="num">{money(paid)}</td></tr>}
            {paid > 0 && balance > 0.01 && <tr><td>Balance owed</td><td className="num">{money(balance)}</td></tr>}
            {paid > 0 && balance < -0.01 && <tr><td>Paid over — credited to next invoice</td><td className="num">{money(-balance)}</td></tr>}
          </tbody>
        </table>

        {inv.letterhead?.name && (
          <p style={{ marginTop: 18, fontSize: 12, color: '#333' }}>
            Please make payments payable to <strong>{inv.letterhead.name}</strong>{inv.letterhead.address ? ` · ${inv.letterhead.address}` : ''}.
          </p>
        )}
        {inv.notes && <p style={{ marginTop: 16, fontSize: 12, color: '#555' }}>{inv.notes}</p>}
      </div>
    </div>
  );
}
