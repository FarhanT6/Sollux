import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import BackLink from '../components/ui/BackLink';
import { getReimbursementInvoice, setReimbursementInvoiceStatus, updateReimbursementInvoiceTerms } from '../api/client';
import { fmtDate } from '../lib/date';

/**
 * The invoice a tenant receives. One sheet: who it is from, who it is to,
 * the invoice number and dates, then each utility's bill with its statement
 * period, what the bill was, what share the tenant carries, and what that
 * comes to — grouped by month when the invoice spans more than one — a
 * Total Due box, payment instructions, and the owner's details in the
 * footer. Printable as-is; Print → Save as PDF is the send.
 */

const money = (v: number | string | null | undefined) => `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: unknown) => Number(v ?? 0) || 0;
const monthOf = (iso: string) => iso.slice(0, 7);
const monthName = (ym: string) => new Date(`${ym}-15T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const INK = '#1c2230';
const MUTED = '#6b7280';
const ACCENT = '#b8674a';
const PAPER = '#f8f6f3';
const TINT = '#efe9e4';
const RULE = '#e6e0da';

const ICONS: Record<string, JSX.Element> = {
  WATER: <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
  SEWER: <><circle cx="12" cy="12" r="9" /><path d="M12 3v18M3 12h18M6 6l12 12M18 6L6 18" /></>,
  TRASH: <><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  GAS: <path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z" />,
  ELECTRIC: <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />,
  INTERNET: <><path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0" /><circle cx="12" cy="19.5" r="1" fill={ACCENT} /></>,
};
function Icon({ category }: { category: string }) {
  const d = ICONS[category] ?? <><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2" /></>;
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d}
    </svg>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="inv-meta" style={{ display: 'grid', gridTemplateColumns: '150px 1fr', alignItems: 'baseline', marginBottom: 10 }}>
      <span style={{ fontSize: 11, letterSpacing: 1.6, textTransform: 'uppercase', color: MUTED }}>{k}</span>
      <span style={{ fontSize: 14, color: INK }}>{v}</span>
    </div>
  );
}

export default function ReimbursementInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const [inv, setInv] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingTerms, setEditingTerms] = useState(false);
  const [savingTerms, setSavingTerms] = useState(false);
  const [termsForm, setTermsForm] = useState({ dueDate: '', payableTo: '', paymentInstructions: '' });

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
  const issued = new Date(inv.createdAt);
  // A due date is printed only when the owner set one, and the payment
  // details block goes with it: no date, no block.
  const due = inv.dueDate ? new Date(inv.dueDate) : null;
  const lh = inv.letterhead ?? {};
  const fromName = lh.name || 'Sollux';
  const payableTo = inv.payableTo || fromName;
  const multiMonth = months.length > 1;

  async function markSent() {
    await setReimbursementInvoiceStatus(inv.id, 'SENT');
    setInv({ ...inv, status: 'SENT' });
  }

  function openTerms() {
    setTermsForm({
      dueDate: inv.dueDate ? String(inv.dueDate).slice(0, 10) : '',
      payableTo: inv.payableTo ?? '',
      paymentInstructions: inv.paymentInstructions ?? '',
    });
    setEditingTerms(true);
  }

  async function saveTerms() {
    setSavingTerms(true);
    try {
      const updated = await updateReimbursementInvoiceTerms(inv.id, {
        dueDate: termsForm.dueDate || null, payableTo: termsForm.payableTo || null, paymentInstructions: termsForm.paymentInstructions || null,
      });
      setInv({ ...inv, dueDate: updated.dueDate, payableTo: updated.payableTo, paymentInstructions: updated.paymentInstructions });
      setEditingTerms(false);
    } finally { setSavingTerms(false); }
  }

  const th: React.CSSProperties = { fontSize: 11, letterSpacing: 1.6, textTransform: 'uppercase', color: MUTED, fontWeight: 600, padding: '12px 16px', textAlign: 'left', background: TINT };
  const td: React.CSSProperties = { padding: '16px 16px', fontSize: 14, color: INK, borderTop: `1px solid ${RULE}`, verticalAlign: 'middle' };
  const right: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  return (
    <div className="min-h-screen" style={{ background: PAPER, color: INK, fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif' }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff; }
          @page { margin: 10mm 12mm; }
          /* One sheet at 100%: the screen layout is roomy, the paper one is
             not. Scaling the print instead thins the ink; the sizes below
             keep the type full-strength and simply tighter. */
          .sheet { padding: 0 !important; max-width: none !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .inv-masthead { margin-bottom: 18px !important; }
          .inv-title { margin-bottom: 14px !important; gap: 20px !important; }
          .inv-h1 { font-size: 26px !important; }
          .inv-sub { font-size: 12px !important; margin-top: 6px !important; }
          .inv-meta { margin-bottom: 4px !important; }
          .inv-meta span { font-size: 11px !important; }
          .inv-billto { padding: 10px 14px !important; margin-bottom: 12px !important; }
          .inv-billto div { font-size: 12px !important; margin-bottom: 2px !important; }
          .inv-month { margin-bottom: 10px !important; break-inside: avoid; page-break-inside: avoid; }
          .inv-th { padding: 6px 12px !important; font-size: 9px !important; }
          .inv-td { padding: 7px 12px !important; font-size: 11.5px !important; }
          .inv-totals { margin-bottom: 12px !important; break-inside: avoid; page-break-inside: avoid; }
          .inv-totalbox { padding: 12px 20px !important; }
          .inv-total-label { font-size: 18px !important; }
          .inv-total-amt { font-size: 22px !important; }
          .inv-thanks { font-size: 12px !important; }
          .inv-rule { margin-bottom: 14px !important; }
          .inv-pay { padding: 12px 16px !important; margin-bottom: 12px !important; break-inside: avoid; page-break-inside: avoid; }
          .inv-pay p { font-size: 11px !important; line-height: 1.5 !important; }
          .inv-footer { padding-top: 10px !important; font-size: 10px !important; }
          /* Light grey reads as faded on paper; print it a shade darker. */
          .sheet [style*="rgb(107, 114, 128)"] { color: #4b5563 !important; }
          .sheet [style*="rgb(63, 69, 82)"] { color: #2b3140 !important; }
        }
      `}</style>

      <div className="no-print px-6 py-3 flex items-center gap-3" style={{ borderBottom: `1px solid ${RULE}`, background: '#fff' }}>
        <BackLink fallback="/tenants" className="text-xs" style={{ color: MUTED }}>← Back</BackLink>
        <div className="flex-1" />
        <span className="text-xs" style={{ color: MUTED }}>Status: {inv.status}</span>
        <button onClick={openTerms} className="text-xs px-3 py-1 rounded" style={{ border: `1px solid ${RULE}`, color: INK }}>Payment terms</button>
        {inv.status === 'DRAFT' && <button onClick={markSent} className="text-xs px-3 py-1 rounded" style={{ border: `1px solid ${RULE}`, color: INK }}>Mark as sent</button>}
        <button onClick={() => window.print()} className="text-xs px-3 py-1 rounded" style={{ background: ACCENT, color: '#fff', fontWeight: 600 }}>Print / Save PDF</button>
      </div>

      {editingTerms && (
        <div className="no-print px-6 py-4" style={{ borderBottom: `1px solid ${RULE}`, background: TINT }}>
          <div className="mx-auto grid gap-3" style={{ maxWidth: 860, gridTemplateColumns: '1fr 2fr' }}>
            <label className="text-xs" style={{ color: MUTED }}>
              <span className="block mb-1">Due date (blank prints none, and no payment details)</span>
              <input type="date" className="w-full text-sm px-2 py-1 rounded" style={{ border: `1px solid ${RULE}`, color: INK, background: '#fff' }} value={termsForm.dueDate} onChange={e => setTermsForm(f => ({ ...f, dueDate: e.target.value }))} />
            </label>
            <label className="text-xs" style={{ color: MUTED }}>
              <span className="block mb-1">Payable to</span>
              <input className="w-full text-sm px-2 py-1 rounded" style={{ border: `1px solid ${RULE}`, color: INK, background: '#fff' }} value={termsForm.payableTo} onChange={e => setTermsForm(f => ({ ...f, payableTo: e.target.value }))} placeholder={fromName} />
            </label>
            <label className="text-xs" style={{ color: MUTED, gridColumn: '1 / -1' }}>
              <span className="block mb-1">Payment instructions</span>
              <textarea rows={3} className="w-full text-sm px-2 py-1 rounded" style={{ border: `1px solid ${RULE}`, color: INK, background: '#fff' }} value={termsForm.paymentInstructions} onChange={e => setTermsForm(f => ({ ...f, paymentInstructions: e.target.value }))} placeholder="Check to the address above, Zelle to …, or pay the way you pay rent." />
            </label>
            <div className="flex gap-2 justify-end" style={{ gridColumn: '1 / -1' }}>
              <button onClick={() => setEditingTerms(false)} className="text-xs px-3 py-1 rounded" style={{ border: `1px solid ${RULE}`, color: INK }}>Cancel</button>
              <button onClick={saveTerms} disabled={savingTerms} className="text-xs px-3 py-1 rounded" style={{ background: ACCENT, color: '#fff', fontWeight: 600 }}>{savingTerms ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="sheet mx-auto" style={{ maxWidth: 860, padding: '40px 48px 32px' }}>
        {/* Masthead */}
        <div className="inv-masthead" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 44 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 20V10l8-6 8 6v10" /><path d="M9 20v-6h6v6" />
            </svg>
            <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: 5, color: INK }}>SOLLUX</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 13, letterSpacing: 2.4, textTransform: 'uppercase', color: INK, fontWeight: 600 }}>Utility Invoice</div>
            <div style={{ height: 2, width: 90, background: ACCENT, marginLeft: 'auto', marginTop: 8 }} />
          </div>
        </div>

        {/* Title + meta */}
        <div className="inv-title" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 32 }}>
          <div>
            <h1 className="inv-h1" style={{ fontSize: 38, fontWeight: 700, lineHeight: 1.1, margin: 0, letterSpacing: -0.5 }}>Utility Statement</h1>
            <p className="inv-sub" style={{ fontSize: 15, color: MUTED, marginTop: 12 }}>Your share of the utility charges for the property.</p>
          </div>
          <div style={{ borderLeft: `1px solid ${RULE}`, paddingLeft: 28, paddingTop: 4 }}>
            <Meta k="Invoice #" v={inv.number ?? '—'} />
            <Meta k="Issue date" v={fmtDate(issued, 'MMM d, yyyy')} />
            {due && <Meta k="Due date" v={fmtDate(due, 'MMM d, yyyy')} />}
            <Meta k="Billing period" v={`${fmtDate(inv.periodStart, 'MMM d, yyyy')} – ${fmtDate(inv.periodEnd, 'MMM d, yyyy')}`} />
          </div>
        </div>

        {/* Bill to */}
        <div className="inv-billto" style={{ background: TINT, borderRadius: 8, padding: '20px 24px', marginBottom: 28, display: 'flex', gap: 16 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
          </svg>
          <div>
            <div style={{ fontSize: 11, letterSpacing: 1.6, textTransform: 'uppercase', color: MUTED, fontWeight: 600, marginBottom: 8 }}>Bill to</div>
            <div style={{ fontSize: 15, color: INK, marginBottom: 3 }}>{tenants || '—'}</div>
            <div style={{ fontSize: 15, color: MUTED, marginBottom: 3 }}>{property.address}, {property.city} {property.state} {property.zip ?? ''}</div>
            {lease.unit?.unitLabel && <div style={{ fontSize: 15, color: MUTED }}>Unit {lease.unit.unitLabel}</div>}
          </div>
        </div>

        {/* Lines */}
        {months.map(([ym, lines]) => {
          const monthTotal = lines.reduce((t: number, l: any) => t + num(l.amount), 0);
          return (
            <div key={ym} className="inv-month" style={{ marginBottom: 22, border: `1px solid ${RULE}`, borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th className="inv-th" style={{ ...th, width: '26%' }}>{multiMonth ? monthName(ym) : 'Utility'}</th>
                    <th className="inv-th" style={{ ...th, width: '30%' }}>Billing period</th>
                    <th className="inv-th" style={{ ...th, ...right, width: '16%' }}>Bill</th>
                    <th className="inv-th" style={{ ...th, ...right, width: '12%' }}>Share</th>
                    <th className="inv-th" style={{ ...th, ...right, width: '16%' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l: any) => (
                    <tr key={l.id}>
                      <td className="inv-td" style={td}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, fontWeight: 600 }}>
                          <Icon category={l.category} />{l.label.replace(/\s*\(.*\)$/, '')}
                        </span>
                      </td>
                      <td className="inv-td" style={{ ...td, color: '#3f4552' }}>
                        {l.kind === 'FLAT' ? monthName(monthOf(l.sortKey)) : l.periodStart && l.periodEnd ? `${fmtDate(l.periodStart, 'MMM d')} – ${fmtDate(l.periodEnd, 'MMM d, yyyy')}` : '—'}
                      </td>
                      <td className="inv-td" style={{ ...td, ...right, color: '#3f4552' }}>{l.kind === 'FLAT' ? `${money(l.baseAmount)} / mo` : money(l.baseAmount)}</td>
                      <td className="inv-td" style={{ ...td, ...right, color: '#3f4552' }}>{l.kind === 'FLAT' ? 'flat' : l.sharePercent != null ? `${l.sharePercent}%` : '100%'}</td>
                      <td className="inv-td" style={{ ...td, ...right, fontWeight: 600 }}>{money(l.amount)}</td>
                    </tr>
                  ))}
                  {multiMonth && (
                    <tr>
                      <td className="inv-td" style={{ ...td, background: PAPER }} colSpan={4}><span style={{ fontSize: 11, letterSpacing: 1.6, textTransform: 'uppercase', color: MUTED, fontWeight: 600 }}>{monthName(ym)} total</span></td>
                      <td className="inv-td" style={{ ...td, ...right, background: PAPER, fontWeight: 700 }}>{money(monthTotal)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          );
        })}

        {/* Totals */}
        <div className="inv-totals" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 28 }}>
          <div style={{ minWidth: 400 }}>
            {(num(inv.creditApplied) > 0 || paid > 0) && (
              <div style={{ padding: '4px 24px 12px', fontSize: 14, color: '#3f4552' }}>
                {num(inv.creditApplied) > 0 && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span>Subtotal</span><span style={right}>{money(inv.subtotal)}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span>Credit from previous overpayment</span><span style={right}>−{money(inv.creditApplied)}</span></div>
                  </>
                )}
                {paid > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span>Paid{inv.paidAt ? ` on ${fmtDate(inv.paidAt, 'MMM d, yyyy')}` : ''}</span><span style={right}>−{money(paid)}</span></div>}
                {paid > 0 && balance < -0.01 && <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span>Overpaid — credited to your next invoice</span><span style={right}>{money(-balance)}</span></div>}
              </div>
            )}
            <div className="inv-totalbox" style={{ background: '#f3e4de', borderRadius: 8, padding: '22px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
              <span className="inv-total-label" style={{ fontSize: 26, fontWeight: 700 }}>{paid > 0 ? (balance > 0.01 ? 'Balance Due' : 'Paid in Full') : 'Total Due'}</span>
              <span style={{ width: 1, height: 34, background: ACCENT, opacity: 0.5 }} />
              <span className="inv-total-amt" style={{ fontSize: 30, fontWeight: 700, ...right }}>{money(paid > 0 ? Math.max(balance, 0) : total)}</span>
            </div>
          </div>
        </div>

        {inv.notes && <p style={{ fontSize: 13, color: '#3f4552', marginBottom: 20 }}>{inv.notes}</p>}

        <p className="inv-thanks" style={{ fontSize: 15, color: INK, margin: 0 }}>Thank you for your prompt payment.</p>
        <div className="inv-rule" style={{ height: 2, width: 64, background: ACCENT, marginTop: 8, marginBottom: 36 }} />

        {/* Payment details — only with a due date, and at the foot of the page. */}
        {due && (
          <div className="inv-pay" style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: '22px 26px', background: '#fff', marginBottom: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.8" strokeLinecap="round" aria-hidden><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h3" /></svg>
              <span style={{ fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: INK, fontWeight: 600 }}>Payment details</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase', color: MUTED, fontWeight: 600, marginBottom: 8 }}>Payment instructions</div>
                <p style={{ fontSize: 13, color: '#3f4552', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-line' }}>
                  {inv.paymentInstructions
                    ? inv.paymentInstructions
                    : <>Please make payment payable to <strong style={{ color: INK }}>{payableTo}</strong>{lh.address ? `, ${lh.address}` : ''}.</>}
                  {' '}Reference invoice {inv.number ?? ''} with your payment.
                </p>
              </div>
              <div style={{ borderLeft: `1px solid ${RULE}`, paddingLeft: 28 }}>
                <div style={{ fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase', color: MUTED, fontWeight: 600, marginBottom: 8 }}>Important</div>
                <p style={{ fontSize: 13, color: '#3f4552', lineHeight: 1.6, margin: 0 }}>
                  Payment is due by {fmtDate(due, 'MMMM d, yyyy')}. Copies of the underlying utility statements are available on request.
                  Late payments may be subject to additional fees per your lease agreement.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="inv-footer" style={{ borderTop: `1px solid ${RULE}`, paddingTop: 16, display: 'flex', alignItems: 'center', gap: 28, fontSize: 12, color: MUTED, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, color: INK }}>{fromName}</span>
          {lh.email && <span>✉ {lh.email}</span>}
          {lh.phone && <span>☏ {lh.phone}</span>}
          {lh.address && <span>{lh.address}</span>}
          <span style={{ marginLeft: 'auto' }}>Page 1 of 1</span>
        </div>
      </div>
    </div>
  );
}
