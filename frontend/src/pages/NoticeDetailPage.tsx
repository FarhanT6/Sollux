import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getNotice, deleteNotice, getRentPayableTo, saveRentPayableTo, type RentPayableTo } from '../api/client';
import type { RentNotice } from '../types';
import { fmtDate as fmtDateSafe } from '../lib/date';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const fmtDate = (d: string | Date) => fmtDateSafe(d, 'MMMM d, yyyy');

function U({ children }: { children: React.ReactNode }) {
  return <span style={{ textDecoration: 'underline' }}>{children}</span>;
}
function BU({ children }: { children: React.ReactNode }) {
  return <span style={{ fontWeight: 'bold', textDecoration: 'underline' }}>{children}</span>;
}

const EMPTY_PAYABLE: RentPayableTo = { name: '', phone: '', email: '', address: '' };

/** Who the rent is payable to, as the account saved it (set here once, used on every notice). */
function PayableToForm({ value, onSaved, onCancel }: { value: RentPayableTo | null; onSaved: (p: RentPayableTo) => void; onCancel?: () => void }) {
  const [f, setF] = useState<RentPayableTo>(value ?? EMPTY_PAYABLE);
  const [busy, setBusy] = useState(false);
  const field = (k: keyof RentPayableTo, label: string, ph: string) => (
    <label className="block"><span className="text-xs text-gray-400">{label}</span>
      <input className="input-dark w-full text-sm mt-1" placeholder={ph} value={f[k]} onChange={e => setF(x => ({ ...x, [k]: e.target.value }))} /></label>
  );
  return (
    <div className="card p-5 mb-6 print:hidden max-w-3xl mx-auto">
      <p className="text-sm text-white font-medium">Who is the rent payable to?</p>
      <p className="text-xs text-gray-500 mt-1 mb-4">Printed on every 3-day notice from this account: where and how the tenant pays. Saved once, used on every notice.</p>
      <div className="grid sm:grid-cols-2 gap-3">
        {field('name', 'Name', 'Who the rent is paid to')}
        {field('phone', 'Phone', '(555) 123-4567')}
        {field('email', 'Email (for Zelle)', 'name@example.com')}
        {field('address', 'Address (in person and by mail)', 'Street, city, state ZIP')}
      </div>
      <div className="flex gap-2 mt-4">
        <button className="btn-primary text-sm disabled:opacity-40" disabled={busy || !f.name.trim() || !f.address.trim()}
          onClick={() => { setBusy(true); saveRentPayableTo(f).then(onSaved).catch(() => alert('Could not save these details.')).finally(() => setBusy(false)); }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {onCancel && <button className="btn text-sm" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

export default function NoticeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [notice, setNotice] = useState<RentNotice | null>(null);
  const [loading, setLoading] = useState(true);
  // The account's payable-to details; undefined while loading, null when never set.
  const [payable, setPayable] = useState<RentPayableTo | null | undefined>(undefined);
  const [editingPayable, setEditingPayable] = useState(false);
  useEffect(() => { getRentPayableTo().then(setPayable).catch(() => setPayable(null)); }, []);

  useEffect(() => {
    if (!id) return;
    getNotice(id).then(setNotice).finally(() => setLoading(false));
  }, [id]);

  async function handleDelete() {
    if (!confirm('Delete this notice record? This cannot be undone.')) return;
    await deleteNotice(id!);
    navigate('/tenants?tab=notices');
  }

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>;
  if (!notice) return <div className="p-6 text-gray-500">Notice not found</div>;

  const { lease } = notice;
  const property = lease?.unit?.property;
  const unitLabel = lease?.unit?.unitLabel;
  const tenantNames = lease?.leaseTenants?.map(lt => lt.tenant.fullName).join(', ') || 'Occupant';
  const propertyAddress = [
    `${property?.address ?? ''}${unitLabel ? ` ${unitLabel}` : ''}`,
    property?.city,
    property?.state && property?.zip ? `${property.state} ${property.zip}` : property?.state,
    property?.county ? `${property.county} County` : null,
  ].filter(Boolean).join(', ');

  const lineItems = notice.lineItems as { amount: number; dueDate: string }[];
  // Blank lines until the account's payable-to details are saved.
  const P = payable ?? EMPTY_PAYABLE;

  return (
    <div className="p-6">
      {/* Controls — hidden on print */}
      <div className="flex items-center justify-between mb-6 print:hidden">
        <div>
          <h1 className="text-xl font-semibold text-white">3-Day Notice</h1>
          <p className="text-sm text-gray-400">{property?.nickname || property?.address} — {tenantNames} · served {fmtDate(notice.noticeDate)}</p>
        </div>
        <div className="flex gap-3">
          {payable && <button onClick={() => setEditingPayable(true)} className="btn text-sm">Payable-to details</button>}
          <button onClick={() => window.print()} disabled={!payable} title={payable ? undefined : 'Add who the rent is payable to first'} className="btn-primary text-sm disabled:opacity-40">Print</button>
          <button onClick={handleDelete} className="text-sm text-red-500 hover:text-red-400 border border-red-900/50 px-3 py-1.5 rounded-lg">Delete</button>
        </div>
      </div>

      {(payable === null || editingPayable) && (
        <PayableToForm value={payable ?? null} onSaved={p => { setPayable(p); setEditingPayable(false); }} onCancel={payable ? () => setEditingPayable(false) : undefined} />
      )}

      {/* Notice body — renders in serif for print readability */}
      <div className="mx-auto max-w-3xl bg-white px-12 py-10 text-black text-sm leading-relaxed" style={{ fontFamily: 'Georgia, serif' }}>
        <h2 style={{ textAlign: 'center', fontWeight: 'bold', textDecoration: 'underline', marginBottom: '1.5rem' }}>
          THREE-DAY NOTICE TO PAY RENT OR VACATE PREMISES
        </h2>

        <p style={{ marginBottom: 0 }}>
          TO <U>&nbsp;&nbsp;{tenantNames}&nbsp;&nbsp;</U>,{' '}
          <U>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</U>
        </p>
        <p style={{ marginBottom: '1rem' }}>AND ALL OTHER OCCUPANT(S) IN POSSESSION:</p>

        <p style={{ marginBottom: '1rem' }}>
          <strong>YOU ARE HEREBY NOTIFIED</strong> that pursuant to the agreement under which you hold the possession
          of the premises at <U>&nbsp;&nbsp;{propertyAddress}&nbsp;&nbsp;</U>, there is now due, unpaid, and delinquent rent of:
        </p>

        <div className="overflow-x-auto">
          <table style={{ marginBottom: '1rem' }}>
            <tbody>
              {lineItems.map((item, i) => (
                <tr key={i}>
                  <td style={{ paddingRight: '4px', textAlign: 'right' }}>$</td>
                  <td style={{ paddingRight: '4px' }}><U>&nbsp;&nbsp;{money(item.amount).replace('$', '').trim()}&nbsp;&nbsp;</U></td>
                  <td style={{ paddingRight: '4px' }}>Due</td>
                  <td><U>&nbsp;&nbsp;{fmtDate(item.dueDate)}&nbsp;&nbsp;</U></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p style={{ marginBottom: '1rem' }}>
          TOTAL AMOUNT DUE: <U>&nbsp;&nbsp;{money(Number(notice.totalDue))}&nbsp;&nbsp;</U>
        </p>

        <p style={{ marginBottom: '1rem' }}>
          <strong>YOU ARE FURTHER NOTIFIED THAT</strong> within three (3) days, excluding Saturdays and Sundays and
          other judicial holidays, after service of this notice on you, you must pay the amount of rent stated in this
          notice in full or quit the premises and deliver up possession of the premises to the undersigned, who is
          authorized to receive possession of the premises, or the undersigned will institute legal proceedings for
          unlawful detainer against you to recover possession of the premises and to recover all rents and damages due.
        </p>

        <p style={{ marginBottom: '1.5rem' }}>
          <strong>YOU ARE FURTHER NOTIFIED</strong> that by this notice the undersigned elects to and does declare a
          forfeiture of the lease or agreement if the rent stated in this notice is not paid in full within the three (3)
          days, excluding Saturdays and Sundays and other judicial holidays.
        </p>

        <p style={{ marginBottom: '0.25rem' }}>Dated: <U>&nbsp;&nbsp;{fmtDate(notice.noticeDate)}&nbsp;&nbsp;</U></p>
        <div style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
          <p style={{ borderBottom: '1px solid black', display: 'inline-block', minWidth: '250px' }}>{notice.signedByName}</p>
          <p style={{ fontSize: '0.75rem', marginTop: '2px' }}>PERSON AUTHORIZED TO GIVE NOTICE</p>
        </div>

        <h3 style={{ textAlign: 'center', fontWeight: 'bold', marginBottom: '0.5rem' }}>THE RENT IS PAYABLE TO:</h3>
        <p>Make Payable To: <BU>{P.name}</BU>&nbsp;&nbsp;&nbsp;&nbsp;Phone Number: <U>&nbsp;&nbsp;{P.phone}&nbsp;&nbsp;</U></p>
        <p style={{ marginBottom: '1rem' }}>Address: <U>&nbsp;&nbsp;{P.address}&nbsp;&nbsp;</U></p>

        <h3 style={{ textAlign: 'center', fontWeight: 'bold', marginBottom: '0.25rem' }}>HOW TO DELIVER THE RENT:</h3>
        <p style={{ textAlign: 'center', fontWeight: 'bold', marginBottom: '0.25rem' }}>IN PERSON:</p>
        <p>Deliver Payment To (Name(s) of Person(s)): <BU>{P.name}</BU></p>
        <p>Phone Number: <BU>{P.phone}</BU></p>
        <p>Personally Pay Here: <BU>{P.address}</BU></p>
        <p style={{ marginBottom: '1rem' }}>Personally Pay During Days and Hours: <BU>Monday through Sunday from 12:00 AM - 11:59 PM</BU></p>

        <p style={{ textAlign: 'center', fontWeight: 'bold', marginBottom: '0.25rem' }}>BY ELECTRONIC FUNDS TRANSFER:</p>
        <p>Pay by Electronic Funds Transfer Procedure:</p>
        <p style={{ marginBottom: '1rem' }}>
          Zelle to {P.name} at{' '}
          <a href={`mailto:${P.email}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>{P.email}</a>
        </p>

        <p style={{ textAlign: 'center', fontWeight: 'bold', marginBottom: '0.25rem' }}>BY MAIL:</p>
        <p style={{ marginBottom: '0.25rem' }}>Mail Check/Money Order To This Address: <BU>{P.address}</BU></p>
        <p style={{ fontWeight: 'bold', marginBottom: '1.5rem' }}>
          It shall be conclusively presumed that upon the mailing of any rent or notice to the owner by the
          tenant to the name and address provided, the notice or rent is deemed received by the owner on the
          date posted, if the tenant can show proof of mailing to the name and address provided by the owner.
        </p>

        <p style={{ textAlign: 'center', fontSize: '0.75rem' }}>Page <strong>1</strong> of <strong>1</strong></p>
      </div>
    </div>
  );
}
