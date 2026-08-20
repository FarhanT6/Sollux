import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getUnits, createUnit, updateUnit, deleteUnit } from '../api/client';
import type { Unit, Lease } from '../types';
import { fmtDate } from '../lib/date';

const money = (n?: number | string | null) =>
  n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const MS_PER_DAY = 86_400_000;

// A tenancy is current when its lease is ACTIVE. A month-to-month lease past
// its end date is still a tenancy — holdover, not vacancy.
const isCurrent = (l: Lease) => l.status === 'ACTIVE';

const tenantNames = (l: Lease) =>
  (l.leaseTenants ?? []).map(lt => lt.tenant.fullName).join(', ') || 'Unnamed tenant';

function monthsBetween(startIso: string, endIso?: string | null): number | null {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const months = (end - start) / MS_PER_DAY / 30.44;
  return months >= 0 ? Math.round(months * 10) / 10 : null;
}

const EMPTY_UNIT = { unitLabel: '', bedrooms: '', bathrooms: '', sqft: '', notes: '' };

/**
 * Units of a property, and everyone who has lived in each one.
 *
 * The Tenants tab is lease-first — it answers "who is renting from me". This is
 * unit-first: pick a door and see its whole occupancy history, since tenants
 * come and go but the unit stays. Both read the same Unit → Lease → Tenant
 * chain; only the entry point differs.
 */
export default function UnitsTab({ propertyId }: { propertyId: string }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);  // unit id, or 'new'
  const [form, setForm] = useState(EMPTY_UNIT);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setUnits(await getUnits({ propertyId, history: 'true' }));
  }

  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [propertyId]);

  const stats = useMemo(() => {
    const occupied = units.filter(u => (u.leases ?? []).some(isCurrent)).length;
    const currentRent = units.reduce((s, u) => {
      const active = (u.leases ?? []).find(isCurrent);
      return s + (active ? Number(active.rentAmount) : 0);
    }, 0);
    return { total: units.length, occupied, vacant: units.length - occupied, currentRent };
  }, [units]);

  function openNew() { setForm(EMPTY_UNIT); setEditing('new'); }

  function openEdit(u: Unit) {
    setForm({
      unitLabel: u.unitLabel,
      bedrooms: u.bedrooms != null ? String(u.bedrooms) : '',
      bathrooms: u.bathrooms != null ? String(u.bathrooms) : '',
      sqft: u.sqft != null ? String(u.sqft) : '',
      notes: u.notes ?? '',
    });
    setEditing(u.id);
  }

  async function save() {
    if (!form.unitLabel.trim()) return;
    const num = (v: string) => (v === '' ? undefined : Number(v));
    const payload = {
      unitLabel: form.unitLabel.trim(),
      bedrooms: num(form.bedrooms),
      bathrooms: num(form.bathrooms),
      sqft: num(form.sqft),
      notes: form.notes.trim() || undefined,
    };
    setSaving(true);
    try {
      if (editing === 'new') await createUnit({ propertyId, ...payload });
      else if (editing) await updateUnit(editing, payload);
      setEditing(null);
      await load();
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Could not save that unit.');
    } finally { setSaving(false); }
  }

  async function remove(u: Unit) {
    const leaseCount = (u.leases ?? []).length;
    // Leases cascade from Unit, taking their payments and history with them —
    // that is a much bigger deletion than "remove a label".
    const warning = leaseCount > 0
      ? `\n\nThis unit has ${leaseCount} lease${leaseCount === 1 ? '' : 's'} on it. Deleting it deletes ${leaseCount === 1 ? 'that lease' : 'those leases'} too, along with their rent payments, notices and rent history.`
      : '';
    if (!confirm(`Delete unit "${u.unitLabel}"?${warning}\n\nThis cannot be undone.`)) return;
    setBusy(u.id);
    try {
      await deleteUnit(u.id);
      await load();
    } catch (err: any) {
      alert(err?.response?.data?.error ?? 'Could not delete that unit.');
    } finally { setBusy(null); }
  }

  if (loading) return <div className="text-center py-12 text-sm text-gray-500">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500">
          {stats.total} unit{stats.total === 1 ? '' : 's'}
          {stats.total > 0 && (
            <>
              {' · '}<span className="text-emerald-400">{stats.occupied} occupied</span>
              {stats.vacant > 0 && <>{' · '}<span className="text-amber-400">{stats.vacant} vacant</span></>}
              {' · '}{money(stats.currentRent)}/mo
            </>
          )}
        </p>
        <button onClick={openNew} className="btn btn-primary text-xs">+ Add unit</button>
      </div>

      {editing === 'new' && (
        <UnitForm form={form} setForm={setForm} saving={saving} isNew
          onSave={save} onCancel={() => setEditing(null)} />
      )}

      {units.length === 0 ? (
        <div className="text-center py-12 text-sm text-gray-500">
          No units yet. Add one, then create a lease against it.
        </div>
      ) : (
        <div className="space-y-2">
          {units.map(u => {
            const leases = u.leases ?? [];
            const current = leases.filter(isCurrent);
            const past = leases.filter(l => !isCurrent(l));
            const open = expanded === u.id;
            return (
              <div key={u.id} className="card overflow-hidden">
                <div className="px-4 py-3">
                  <div className="flex items-start gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <button onClick={() => setExpanded(open ? null : u.id)}
                          className="text-sm font-semibold text-white hover:text-amber-400 text-left">
                          Unit {u.unitLabel}
                        </button>
                        <span className={`pill text-xs ${current.length > 0 ? 'pill-green' : 'pill-amber'}`}>
                          {current.length > 0 ? 'Occupied' : 'Vacant'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500">
                        {[
                          u.bedrooms ? `${u.bedrooms}bd` : null,
                          u.bathrooms ? `${u.bathrooms}ba` : null,
                          u.sqft ? `${u.sqft} sqft` : null,
                        ].filter(Boolean).join(' · ') || 'No details'}
                        {' · '}{leases.length} tenanc{leases.length === 1 ? 'y' : 'ies'} on record
                      </p>
                      {current.length > 0 ? (
                        <p className="text-xs text-gray-400 mt-0.5">
                          {current.map(l => tenantNames(l)).join('; ')}
                          <span className="text-gray-600"> · since {fmtDate(current[0].startDate)}</span>
                        </p>
                      ) : past.length > 0 ? (
                        <p className="text-xs text-gray-600 mt-0.5">
                          Last tenant {tenantNames(past[0])}
                          {past[0].endDate && ` · left ${fmtDate(past[0].endDate)}`}
                        </p>
                      ) : (
                        <p className="text-xs text-gray-600 mt-0.5">Never tenanted</p>
                      )}
                    </div>

                    <div className="text-right flex-shrink-0">
                      {current.length > 0 && (
                        <p className="text-sm font-semibold text-white">
                          {money(current.reduce((s, l) => s + Number(l.rentAmount), 0))}/mo
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-3 mt-2 text-xs">
                    <button onClick={() => setExpanded(open ? null : u.id)} className="text-amber-400 hover:text-amber-300">
                      {open ? 'Hide history' : 'Occupancy history'}
                    </button>
                    <button onClick={() => openEdit(u)} className="text-gray-500 hover:text-gray-300">Edit</button>
                    <button onClick={() => remove(u)} disabled={busy === u.id}
                      className="text-gray-600 hover:text-red-400 disabled:opacity-40">
                      {busy === u.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>

                {editing === u.id && (
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <UnitForm form={form} setForm={setForm} saving={saving}
                      onSave={save} onCancel={() => setEditing(null)} />
                  </div>
                )}

                {open && editing !== u.id && (
                  <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
                    {leases.length === 0 ? (
                      <p className="text-xs text-gray-600">No one has been recorded in this unit yet.</p>
                    ) : (
                      <div className="space-y-0">
                        {leases.map((l, i) => {
                          const months = monthsBetween(l.startDate, isCurrent(l) ? null : l.endDate);
                          // The gap before this tenancy: how long the unit sat
                          // empty between the previous tenant leaving and this
                          // one moving in. leases are newest-first.
                          const previous = leases[i + 1];
                          const gapDays = previous?.endDate
                            ? Math.max(0, Math.round((new Date(l.startDate).getTime() - new Date(previous.endDate).getTime()) / MS_PER_DAY))
                            : null;
                          return (
                            <div key={l.id}>
                              <div className="flex items-start gap-2 py-2">
                                <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${isCurrent(l) ? 'bg-emerald-400' : 'bg-gray-600'}`} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs text-white">
                                    {(l.leaseTenants ?? []).length === 0 ? 'Unnamed tenant' : (l.leaseTenants ?? []).map((lt, j) => (
                                      <span key={lt.tenant.id}>
                                        {j > 0 && ', '}
                                        <Link to={`/tenants/${lt.tenant.id}`} className="hover:text-amber-400">
                                          {lt.tenant.fullName}
                                        </Link>
                                      </span>
                                    ))}
                                    {l.businessName && <span className="text-gray-500"> · {l.businessName}</span>}
                                    {isCurrent(l) && <span className="pill pill-green text-xs ml-1.5">Current</span>}
                                  </p>
                                  <p className="text-xs text-gray-500">
                                    {fmtDate(l.startDate)} – {isCurrent(l) ? 'present' : (l.endDate ? fmtDate(l.endDate) : 'no end date')}
                                    {months != null && ` · ${months} mo`}
                                    {!isCurrent(l) && ` · ${l.status.toLowerCase()}`}
                                  </p>
                                </div>
                                <p className="text-xs text-gray-300 flex-shrink-0">{money(l.rentAmount)}/mo</p>
                              </div>
                              {gapDays != null && (
                                <div className="ml-[0.6rem] pl-4 py-1 text-xs" style={{ borderLeft: '2px dashed rgba(255,255,255,0.12)' }}>
                                  {gapDays > 0
                                    ? <span className="text-amber-400">Vacant {gapDays} day{gapDays === 1 ? '' : 's'}</span>
                                    : <span className="text-emerald-400">Re-let immediately</span>}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
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

function UnitForm({ form, setForm, saving, isNew, onSave, onCancel }: {
  form: typeof EMPTY_UNIT;
  setForm: (f: typeof EMPTY_UNIT | ((f: typeof EMPTY_UNIT) => typeof EMPTY_UNIT)) => void;
  saving: boolean; isNew?: boolean; onSave: () => void; onCancel: () => void;
}) {
  const set = (k: keyof typeof EMPTY_UNIT) => (e: { target: { value: string } }) =>
    setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <div className="px-4 py-3 space-y-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <input value={form.unitLabel} onChange={set('unitLabel')}
          placeholder="Unit label * (e.g. 2B, Main House)" className="input-dark text-xs" />
        <input type="number" step="0.5" value={form.bedrooms} onChange={set('bedrooms')} placeholder="Bedrooms" className="input-dark text-xs" />
        <input type="number" step="0.5" value={form.bathrooms} onChange={set('bathrooms')} placeholder="Bathrooms" className="input-dark text-xs" />
        <input type="number" value={form.sqft} onChange={set('sqft')} placeholder="Sq ft" className="input-dark text-xs" />
      </div>
      <input value={form.notes} onChange={set('notes')} placeholder="Notes" className="input-dark text-xs w-full" />
      <div className="flex justify-end gap-3">
        <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
        <button onClick={onSave} disabled={saving || !form.unitLabel.trim()}
          className="btn btn-primary text-xs disabled:opacity-40">
          {saving ? '…' : isNew ? 'Add unit' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
