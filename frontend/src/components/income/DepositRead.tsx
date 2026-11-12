import { useEffect, useMemo, useState } from 'react';
import { readDeposit, recordDeposit, undoDeposit, getBankAccounts, getLeases, type DepositDraft, type DepositDraftCheck } from '../../api/client';
import type { Lease } from '../../types';
import { fmtMoney } from '../../lib/money';
import { fmtDate, fmtMoment } from '../../lib/date';
import { describeApiError } from '../../lib/apiError';

const r2 = (n: number) => Math.round(n * 100) / 100;
const toBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(f);
});

type Row = DepositDraftCheck & { key: number };

/**
 * A bank deposit of several checks, read from the bank's "Deposit details"
 * page: the screenshots (or a PDF) in, each check matched to a tenant by the
 * name on it and split into the month's rent and their utilities, reviewed,
 * recorded — and undone, if need be. The bank connection only sees the total.
 */
export default function DepositRead({ onClose, onRecorded }: { onClose: () => void; onRecorded?: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [reading, setReading] = useState(false);
  const [draft, setDraft] = useState<DepositDraft | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [account, setAccount] = useState('');
  const [accounts, setAccounts] = useState<{ id: string; label: string }[]>([]);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ key: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getBankAccounts().then(list => setAccounts((list as any[]).filter(a => a.accountType !== 'CREDIT_CARD').map(a => {
      const name = a.nickname || a.name;
      return { id: a.id, label: `${name}${a.last4 && !String(name).includes(a.last4) ? ` ··${a.last4}` : ''}` };
    }))).catch(() => setAccounts([]));
    getLeases({ status: 'ACTIVE', view: 'rent' }).then(setLeases).catch(() => setLeases([]));
  }, []);
  const leaseLabel = (l: Lease) => `${(l.leaseTenants ?? []).map((t: any) => t.tenant?.fullName).filter(Boolean).join(', ') || 'No tenant'} — ${l.unit?.property?.nickname || l.unit?.property?.address || ''}${l.unit?.unitLabel ? ` · ${l.unit.unitLabel}` : ''}`;

  async function read() {
    if (!files.length) { setErr('Add the screenshots or PDF of the deposit first.'); return; }
    setReading(true); setErr(null);
    try {
      const d = await readDeposit(await Promise.all(files.map(async f => ({ fileData: await toBase64(f), filename: f.name }))));
      setDraft(d);
      setRows(d.checks.map((c, i) => ({ ...c, key: i })));
      setAccount(d.bankAccountId ?? '');
    } catch (e) { setErr(describeApiError(e, 'Could not read the deposit.')); }
    finally { setReading(false); }
  }

  const set = (key: number, patch: Partial<Row>) => setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)));
  const chosen = rows.filter(r => r.include && r.leaseId);
  const bad = chosen.filter(r => Math.abs(r.rent + r.utilities - r.amount) > 0.01 || !r.month);
  const totals = useMemo(() => ({ rent: r2(chosen.reduce((s, r) => s + r.rent, 0)), utilities: r2(chosen.reduce((s, r) => s + r.utilities, 0)) }), [chosen]);

  async function record() {
    if (!draft) return;
    if (!account) { setErr('Pick the bank account the deposit went into.'); return; }
    if (bad.length) { setErr('Each check\'s rent and utilities must add up to the check, with a month for the rent.'); return; }
    setSaving(true); setErr(null);
    try {
      const r = await recordDeposit({
        bankAccountId: account, postDate: draft.postDate!, total: draft.total ?? draft.checksSum,
        checks: chosen.map(c => ({ leaseId: c.leaseId!, amount: c.amount, month: c.month!, rent: c.rent, utilities: c.utilities, payer: c.payer, checkNumber: c.checkNumber, memo: c.memo })),
      });
      setDone({ key: r.key, text: `Recorded ${r.checks} check${r.checks === 1 ? '' : 's'}: ${fmtMoney(r.rent)} rent and ${fmtMoney(r.utilities)} utilities, deposited ${fmtDate(draft.postDate)}.` });
      onRecorded?.();
    } catch (e) { setErr(describeApiError(e, 'Not recorded.')); }
    finally { setSaving(false); }
  }
  async function undo(key: string) {
    setSaving(true); setErr(null);
    try { await undoDeposit(key); setDone(null); setDraft(d => (d ? { ...d, recorded: null } : d)); onRecorded?.(); }
    catch (e) { setErr(describeApiError(e, 'Could not undo it.')); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="card p-5 w-full max-w-4xl max-h-[92vh] overflow-y-auto space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">Read a bank deposit</p>
            <p className="text-xs text-gray-500">The bank connection only sees a deposit&rsquo;s total. From the bank&rsquo;s deposit details, each check is matched to the tenant whose name is on it and split into rent and their utilities.</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300" aria-label="Close">✕</button>
        </div>

        {!draft && (
          <div className="space-y-2">
            <p className="text-xs text-gray-400">On your bank&rsquo;s website, open the deposit and expand each check so its picture shows (the name on it is how Sollux knows whose it is). Take screenshots — as many as it takes — or print the page to PDF, and add them here. The pictures are read, not kept.</p>
            <label className="block rounded-lg border border-dashed border-white/15 px-4 py-6 text-center text-xs text-gray-400 cursor-pointer hover:border-amber-500/50"
              onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); setFiles(f => [...f, ...Array.from(e.dataTransfer.files)]); }}>
              <input type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={e => setFiles(f => [...f, ...Array.from(e.target.files ?? [])])} />
              {files.length ? `${files.length} file${files.length === 1 ? '' : 's'}: ${files.map(f => f.name).join(', ')}` : 'Drop screenshots or a PDF here, or click to choose'}
            </label>
            <div className="flex gap-2 justify-end">
              {files.length > 0 && <button className="btn text-xs" onClick={() => setFiles([])} disabled={reading}>Clear</button>}
              <button className="btn btn-primary text-xs disabled:opacity-50" disabled={reading || !files.length} onClick={() => void read()}>{reading ? 'Reading the checks…' : 'Read the deposit'}</button>
            </div>
          </div>
        )}

        {draft && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <span className="text-white text-sm font-semibold">{fmtMoney(draft.total ?? draft.checksSum)}</span>
              <span className="text-gray-400">{draft.postDate ? `posted ${fmtDate(draft.postDate)}` : 'no post date read'} · {draft.checks.length} check{draft.checks.length === 1 ? '' : 's'}{draft.bank ? ` · ${draft.bank}` : ''}</span>
              <span className="flex items-center gap-1.5 ml-auto">
                <span className="text-gray-500">Into</span>
                <select className="input-dark text-xs" value={account} onChange={e => setAccount(e.target.value)}>
                  <option value="">Pick the account…</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </span>
            </div>
            {draft.problems.map(p => <p key={p} className="text-xs text-amber-400">{p}</p>)}
            {draft.recorded && !done && (
              <p className="text-xs text-amber-400">This deposit was recorded {fmtMoment(draft.recorded.at)}. <button className="underline" onClick={() => void undo(draft.recorded!.key)} disabled={saving}>Undo it</button> to record it again.</p>
            )}

            <div className="space-y-2">
              {rows.map(r => {
                const off = Math.abs(r.rent + r.utilities - r.amount) > 0.01;
                return (
                  <div key={r.key} className="rounded-lg px-3 py-2.5 text-xs" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <input type="checkbox" checked={r.include} onChange={e => set(r.key, { include: e.target.checked })} aria-label="Record this check" />
                      <span className="text-gray-500">#{r.index}</span>
                      <span className="text-white font-semibold">{fmtMoney(r.amount)}</span>
                      <span className="text-gray-400 min-w-0 flex-1 truncate">{[r.payer ? `from ${r.payer}` : 'no name read', r.checkNumber ? `check ${r.checkNumber}` : null, r.memo ? `"${r.memo}"` : null].filter(Boolean).join(' · ')}</span>
                      {r.matchedBy === 'amount' && <span className="text-amber-400/80">matched by amount — check the tenant</span>}
                    </div>
                    <div className="mt-2 grid grid-cols-2 sm:grid-cols-[minmax(0,2fr)_auto_auto_auto] gap-2 items-end">
                      <label className="col-span-2 sm:col-span-1"><span className="block text-[11px] text-gray-500 mb-0.5">Tenant</span>
                        <select className="input-dark text-xs w-full" value={r.leaseId ?? ''} onChange={e => {
                          const l = leases.find(x => x.id === e.target.value);
                          const rent = l ? r2(Math.min(r.amount, Number(l.rentAmount))) : 0;
                          set(r.key, { leaseId: e.target.value || null, include: !!e.target.value, month: r.month ?? (draft.postDate ?? '').slice(0, 7), rent, utilities: r2(r.amount - rent), rentDue: 0, utilitiesOwed: 0 });
                        }}>
                          <option value="">Not rent — leave it out</option>
                          {leases.map(l => <option key={l.id} value={l.id}>{leaseLabel(l)}</option>)}
                        </select></label>
                      <label><span className="block text-[11px] text-gray-500 mb-0.5">Rent for</span>
                        <input type="month" className="input-dark text-xs w-36" value={r.month ?? ''} onChange={e => set(r.key, { month: e.target.value })} disabled={!r.leaseId} /></label>
                      <label><span className="block text-[11px] text-gray-500 mb-0.5">Rent</span>
                        <input type="number" step="0.01" className="input-dark text-xs w-28" value={r.rent} disabled={!r.leaseId}
                          onChange={e => { const rent = r2(Math.max(0, Math.min(r.amount, Number(e.target.value) || 0))); set(r.key, { rent, utilities: r2(r.amount - rent) }); }} /></label>
                      <label><span className="block text-[11px] text-gray-500 mb-0.5">Utilities</span>
                        <input type="number" step="0.01" className="input-dark text-xs w-28" value={r.utilities} disabled={!r.leaseId}
                          onChange={e => { const utilities = r2(Math.max(0, Math.min(r.amount, Number(e.target.value) || 0))); set(r.key, { utilities, rent: r2(r.amount - utilities) }); }} /></label>
                    </div>
                    {r.leaseId && (r.rentDue > 0 || r.utilitiesOwed > 0) && (
                      <p className="text-gray-500 mt-1">Owes {fmtMoney(r.rentDue)} rent for {r.month ? fmtDate(`${r.month}-01`, 'MMMM') : 'the month'}{r.utilitiesOwed > 0 ? ` and ${fmtMoney(r.utilitiesOwed)} in open utility invoices (paid oldest first)` : ''}.</p>
                    )}
                    {r.alreadyLogged && <p className="text-amber-400/90 mt-1">{r.alreadyLogged} — left out so it isn&rsquo;t counted twice. Tick it if this is a different check.</p>}
                    {off && <p className="text-red-400 mt-1">Rent and utilities add up to {fmtMoney(r.rent + r.utilities)}, not the check&rsquo;s {fmtMoney(r.amount)}.</p>}
                  </div>
                );
              })}
            </div>

            {err && <p className="text-xs text-red-400">{err}</p>}
            {done ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-emerald-400">{done.text}</p>
                <div className="flex gap-2 shrink-0">
                  <button className="btn text-xs" disabled={saving} onClick={() => void undo(done.key)}>Undo</button>
                  <button className="btn btn-primary text-xs" onClick={onClose}>Done</button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-3">
                <span className="text-xs text-gray-400">{chosen.length} check{chosen.length === 1 ? '' : 's'} · {fmtMoney(totals.rent)} rent · {fmtMoney(totals.utilities)} utilities</span>
                <button className="btn text-xs" onClick={() => { setDraft(null); setRows([]); }}>Start over</button>
                <button className="btn btn-primary text-xs disabled:opacity-50" disabled={saving || !chosen.length || !!draft.recorded} onClick={() => void record()}>{saving ? 'Recording…' : `Record ${chosen.length} check${chosen.length === 1 ? '' : 's'}`}</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
