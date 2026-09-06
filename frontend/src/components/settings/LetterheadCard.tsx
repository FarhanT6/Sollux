import { useEffect, useState } from 'react';
import { getLetterhead, saveLetterhead, type Letterhead } from '../../api/client';

/**
 * Who invoices come from and who tenants pay: the owner's entity — a trust,
 * an LLC, a name — with an address and contact line. Printed at the top of
 * every reimbursement invoice and on its "make payable to" line.
 */
export default function LetterheadCard() {
  const [form, setForm] = useState<Letterhead>({ name: '', address: '', phone: '', email: '' });
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLetterhead().then(l => { if (l) setForm({ name: l.name ?? '', address: l.address ?? '', phone: l.phone ?? '', email: l.email ?? '' }); }).catch(() => {});
  }, []);

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      await saveLetterhead({ name: form.name, address: form.address || null, phone: form.phone || null, email: form.email || null });
      setSaved(true);
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Could not save.');
    } finally { setBusy(false); }
  }

  const input = 'w-full text-sm px-3 py-1.5 rounded-lg text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none';

  return (
    <div className="card p-5 mb-4">
      <h2 className="text-sm font-semibold text-white mb-1">Letterhead</h2>
      <p className="text-xs text-gray-500 mb-4">Printed at the top of tenant invoices, and as who to make payments to.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="text-xs text-gray-400 block mb-1">Entity name</label>
          <input className={input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. The M.S. Talukder Family 2023 Trust" />
        </div>
        <div className="sm:col-span-2">
          <label className="text-xs text-gray-400 block mb-1">Mailing address</label>
          <input className={input} value={form.address ?? ''} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="Street, City, ST ZIP" />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Phone</label>
          <input className={input} value={form.phone ?? ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Email</label>
          <input className={input} value={form.email ?? ''} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
        </div>
      </div>
      <div className="flex items-center gap-3 mt-3">
        <button onClick={save} disabled={busy || !form.name.trim()} className="btn btn-primary text-xs disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        {saved && <span className="text-xs text-emerald-400">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
