import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getReimbursement, saveReimbursement, previewReimbursementInvoice, createReimbursementInvoice,
  recordReimbursementPayment, deleteReimbursementInvoice,
  type ReimbursementRule, type ReimbursementConfig, type ReimbursementInvoiceSummary, type ReimbursementDraft,
} from '../../api/client';
import { fmtDate } from '../../lib/date';

/**
 * The tenant's utility reimbursement for one lease: which utilities they
 * repay and how, invoices generated from the property's real statements, and
 * what they paid against each.
 *
 * Not every lease has this. The panel is off until the owner turns it on, so
 * a tenant who does not reimburse utilities never sees an invoice generated.
 */

const CATEGORIES = ['WATER', 'ELECTRIC', 'GAS', 'SEWER', 'TRASH', 'INTERNET', 'OTHER'];
const CAT_LABEL: Record<string, string> = { WATER: 'Water', ELECTRIC: 'Electricity', GAS: 'Gas', SEWER: 'Sewer', TRASH: 'Trash', INTERNET: 'Internet', OTHER: 'Other' };
const money = (v: number | string | null | undefined) => `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: unknown) => Number(v ?? 0) || 0;

const DEFAULT_RULES: ReimbursementRule[] = [
  { category: 'WATER', mode: 'PERCENT', value: 60 },
  { category: 'ELECTRIC', mode: 'PERCENT', value: 60 },
  { category: 'TRASH', mode: 'FLAT_MONTHLY', value: 63.84 },
];

export default function UtilityReimbursementPanel({ leaseId }: { leaseId: string }) {
  const [config, setConfig] = useState<ReimbursementConfig | null>(null);
  const [invoices, setInvoices] = useState<ReimbursementInvoiceSummary[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; providerName: string; serviceLabel: string | null; category: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [rules, setRules] = useState<ReimbursementRule[]>(DEFAULT_RULES);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Generation
  const [range, setRange] = useState({ from: '', to: '' });
  const [draft, setDraft] = useState<ReimbursementDraft | null>(null);
  // Lines struck out of the draft — already billed on a hand-made invoice,
  // or settled some other way. Re-previewed without them so the totals are true.
  const [excluded, setExcluded] = useState<string[]>([]);

  // Payment recording
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payForm, setPayForm] = useState({ amount: '', paidAt: new Date().toISOString().slice(0, 10) });

  async function load() {
    setLoading(true);
    try {
      const r = await getReimbursement(leaseId);
      setConfig(r.config);
      setInvoices(r.invoices);
      setAccounts(r.accounts);
      if (r.config) { setRules(r.config.rulesJson); setEnabled(r.config.enabled); }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Could not load reimbursement settings.');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [leaseId]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setBusy('save'); setError(null);
    try {
      await saveReimbursement(leaseId, { enabled, rules: rules.filter(r => r.category) });
      setEditing(false);
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Could not save.');
    } finally { setBusy(null); }
  }

  async function preview(nextExcluded: string[] = excluded) {
    if (!range.from || !range.to) return;
    setBusy('preview'); setError(null);
    try { setDraft(await previewReimbursementInvoice(leaseId, range.from, range.to, nextExcluded)); }
    catch (err: any) { setError(err?.response?.data?.error ?? 'Could not build a preview.'); }
    finally { setBusy(null); }
  }

  async function generate() {
    setBusy('generate'); setError(null);
    try {
      const inv = await createReimbursementInvoice(leaseId, range.from, range.to, excluded);
      setDraft(null); setExcluded([]);
      await load();
      window.open(`/reimbursements/${inv.id}`, '_blank');
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Could not create the invoice.');
    } finally { setBusy(null); }
  }

  async function pay(id: string) {
    const amount = parseFloat(payForm.amount);
    if (!(amount > 0)) return;
    setBusy(id); setError(null);
    try {
      await recordReimbursementPayment(id, amount, payForm.paidAt);
      setPayingId(null);
      setPayForm({ amount: '', paidAt: new Date().toISOString().slice(0, 10) });
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Could not record the payment.');
    } finally { setBusy(null); }
  }

  async function remove(inv: ReimbursementInvoiceSummary) {
    if (!confirm(`Delete the invoice for ${fmtDate(inv.periodStart, 'MMM d')} – ${fmtDate(inv.periodEnd, 'MMM d, yyyy')}?\n\nIts statements can be billed again, and any credit it used goes back to the tenant's balance.`)) return;
    setBusy(inv.id);
    try { await deleteReimbursementInvoice(inv.id); await load(); }
    catch (err: any) { setError(err?.response?.data?.error ?? 'Could not delete.'); }
    finally { setBusy(null); }
  }

  const sel = 'input-dark text-xs';
  const credit = num(config?.creditBalance);

  if (loading) return <div className="mt-4 text-xs text-gray-500">Loading utility reimbursement…</div>;

  // ── Not set up ────────────────────────────────────────────────────────────
  if (!config && !editing) {
    return (
      <div className="mt-4 rounded-lg px-4 py-3 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.12)' }}>
        <div>
          <p className="text-sm text-gray-300">Utility reimbursement</p>
          <p className="text-xs text-gray-500">This tenant doesn't repay utilities. Turn it on if the lease has them cover a share.</p>
        </div>
        <button onClick={() => { setRules(DEFAULT_RULES); setEnabled(true); setEditing(true); }} className="btn text-xs">Set up</button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg p-4 space-y-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white">Utility reimbursement</p>
          <p className="text-xs text-gray-500">
            {config?.enabled === false ? 'Off' : (config?.rulesJson ?? []).map(r =>
              `${r.label || CAT_LABEL[r.category] || r.category} ${r.mode === 'PERCENT' ? `${r.value}%` : r.mode === 'FULL' ? '100%' : `${money(r.value)}/mo`}`
            ).join(' · ')}
            {credit > 0 && <span className="text-emerald-400"> · {money(credit)} credit on account</span>}
          </p>
        </div>
        <button onClick={() => setEditing(e => !e)} className="text-xs text-amber-400 hover:text-amber-300">{editing ? 'Cancel' : 'Edit rules'}</button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* ── Rules editor ── */}
      {editing && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="accent-amber-500" />
            Tenant reimburses utilities
          </label>
          {rules.map((r, i) => (
            <div key={i} className="flex items-center gap-2 flex-wrap">
              <select className={sel} value={r.category} onChange={e => setRules(rs => rs.map((x, j) => j === i ? { ...x, category: e.target.value } : x))}>
                {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
              </select>
              <select className={sel} value={r.mode} onChange={e => setRules(rs => rs.map((x, j) => j === i ? { ...x, mode: e.target.value as ReimbursementRule['mode'] } : x))}>
                <option value="PERCENT">% of each bill</option>
                <option value="FULL">Full bill</option>
                <option value="FLAT_MONTHLY">Flat per month</option>
              </select>
              {r.mode !== 'FULL' && (
                <input type="number" step="0.01" className={`${sel} w-24`} value={r.value}
                  onChange={e => setRules(rs => rs.map((x, j) => j === i ? { ...x, value: parseFloat(e.target.value) || 0 } : x))}
                  placeholder={r.mode === 'PERCENT' ? '%' : '$/month'} />
              )}
              <span className="text-xs text-gray-500">{r.mode === 'PERCENT' ? '%' : r.mode === 'FLAT_MONTHLY' ? '$/month' : ''}</span>
              <button onClick={() => setRules(rs => rs.filter((_, j) => j !== i))} className="text-xs text-gray-500 hover:text-red-400">remove</button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button onClick={() => setRules(rs => [...rs, { category: 'OTHER', mode: 'PERCENT', value: 50 }])} className="text-xs text-gray-400 hover:text-white">+ rule</button>
            <div className="flex-1" />
            <button onClick={save} disabled={busy === 'save'} className="btn btn-primary text-xs disabled:opacity-50">{busy === 'save' ? 'Saving…' : 'Save'}</button>
          </div>
          {accounts.length > 0 && (
            <p className="text-xs text-gray-600">
              Bills come from this property's accounts: {accounts.map(a => a.serviceLabel ? `${a.providerName} (${a.serviceLabel})` : a.providerName).join(', ')}. Meters assigned to another unit are excluded automatically.
            </p>
          )}
        </div>
      )}

      {/* ── Generate ── */}
      {config?.enabled && !editing && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-400">Bill the tenant for</span>
            <input type="date" className={sel} value={range.from} onChange={e => { setExcluded([]); setDraft(null); setRange(r => ({ ...r, from: e.target.value })); }} />
            <span className="text-xs text-gray-500">to</span>
            <input type="date" className={sel} value={range.to} onChange={e => { setExcluded([]); setDraft(null); setRange(r => ({ ...r, to: e.target.value })); }} />
            <button onClick={() => preview()} disabled={!range.from || !range.to || busy === 'preview'} className="btn text-xs disabled:opacity-50">{busy === 'preview' ? 'Building…' : 'Preview'}</button>
          </div>

          {draft && (
            <div className="rounded-lg p-3 space-y-2" style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.08)' }}>
              {draft.lines.length === 0 ? (
                <p className="text-xs text-gray-500">Nothing to bill in that range.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead><tr className="text-gray-500"><th></th><th className="text-left py-1">Utility</th><th className="text-left">Period</th><th className="text-right">Bill</th><th className="text-right">Share</th><th className="text-right">Tenant owes</th></tr></thead>
                  <tbody>
                    {draft.lines.map((l, i) => (
                      <tr key={i} className="border-t border-white/5 text-gray-300">
                        <td className="py-1 pr-2">
                          <button
                            title="Leave this line off — already billed or paid another way"
                            onClick={() => { const next = [...excluded, l.key!]; setExcluded(next); preview(next); }}
                            className="text-gray-600 hover:text-red-400"
                          >✕</button>
                        </td>
                        <td className="py-1">{l.label}</td>
                        <td className="text-gray-500">{l.periodStart && l.periodEnd ? `${fmtDate(l.periodStart, 'M/d/yy')} – ${fmtDate(l.periodEnd, 'M/d/yy')}` : '—'}</td>
                        <td className="text-right">{money(l.baseAmount)}</td>
                        <td className="text-right text-gray-500">{l.sharePercent != null ? `${l.sharePercent}%` : 'flat'}</td>
                        <td className="text-right text-white">{money(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="text-xs text-right space-y-0.5">
                <p className="text-gray-400">Subtotal <span className="text-white ml-2">{money(draft.subtotal)}</span></p>
                {draft.creditApplied > 0 && <p className="text-emerald-400">Credit applied <span className="ml-2">−{money(draft.creditApplied)}</span></p>}
                <p className="text-gray-200 font-semibold">Total due <span className="text-white ml-2">{money(draft.total)}</span></p>
              </div>
              {excluded.length > 0 && (
                <p className="text-xs text-gray-500">
                  {excluded.length} line{excluded.length === 1 ? '' : 's'} left off.{' '}
                  <button onClick={() => { setExcluded([]); preview([]); }} className="text-amber-400 hover:text-amber-300">Restore all</button>
                </p>
              )}
              {draft.alreadyBilled.length > 0 && (
                <p className="text-xs text-amber-400">
                  {draft.alreadyBilled.length} bill{draft.alreadyBilled.length === 1 ? ' is' : 's are'} already on an earlier invoice and won't be billed again: {draft.alreadyBilled.map(b => `${b.label} ${b.period}`).join('; ')}.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button onClick={() => setDraft(null)} className="btn text-xs">Discard</button>
                <button onClick={generate} disabled={draft.lines.length === 0 || busy === 'generate'} className="btn btn-primary text-xs disabled:opacity-50">{busy === 'generate' ? 'Creating…' : 'Create invoice'}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Invoices ── */}
      {invoices.length > 0 && (
        <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
          {invoices.map(inv => {
            const total = num(inv.total), paid = num(inv.paidAmount);
            const balance = total - paid;
            return (
              <div key={inv.id} className="py-2">
                <div className="flex items-center gap-3 text-xs">
                  <Link to={`/reimbursements/${inv.id}`} className="text-gray-100 hover:text-amber-400 font-medium">
                    {fmtDate(inv.periodStart, 'MMM d')} – {fmtDate(inv.periodEnd, 'MMM d, yyyy')}
                  </Link>
                  <span className="text-gray-500">{inv._count.lines} line{inv._count.lines === 1 ? '' : 's'}</span>
                  <div className="flex-1" />
                  <span className="text-white">{money(total)}</span>
                  <span className={`pill text-[10px] ${inv.status === 'PAID' ? 'pill-green' : inv.status === 'PARTIAL' ? 'pill-amber' : 'pill-gray'}`}>
                    {inv.status === 'PAID' ? (paid > total + 0.01 ? `Paid · ${money(paid - total)} over` : 'Paid') : inv.status === 'PARTIAL' ? `${money(balance)} left` : inv.status}
                  </span>
                  {inv.status !== 'PAID' && (
                    <button onClick={() => { setPayingId(payingId === inv.id ? null : inv.id); setPayForm(f => ({ ...f, amount: String(balance.toFixed(2)) })); }} className="text-amber-400 hover:text-amber-300">Record payment</button>
                  )}
                  <Link to={`/reimbursements/${inv.id}`} className="text-gray-500 hover:text-white">View / print</Link>
                  {paid === 0 && <button onClick={() => remove(inv)} disabled={busy === inv.id} className="text-gray-600 hover:text-red-400">delete</button>}
                </div>
                {payingId === inv.id && (
                  <div className="flex items-center gap-2 mt-2">
                    <input type="number" step="0.01" className={`${sel} w-28`} value={payForm.amount} onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))} placeholder="Amount" />
                    <input type="date" className={sel} value={payForm.paidAt} onChange={e => setPayForm(f => ({ ...f, paidAt: e.target.value }))} />
                    <button onClick={() => pay(inv.id)} disabled={busy === inv.id} className="btn btn-primary text-xs disabled:opacity-50">Save</button>
                    <button onClick={() => setPayingId(null)} className="btn text-xs">Cancel</button>
                    <span className="text-xs text-gray-600">Paying more than the total banks the difference as credit for the next invoice.</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
