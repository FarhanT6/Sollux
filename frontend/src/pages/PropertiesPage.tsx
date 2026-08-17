import { useEffect, useMemo, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, rectSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getProperties, updateProperty, deleteProperty } from '../api/client';
import type { Property } from '../types';
import { PageHeader, StatCard, Skeleton, EmptyState } from '../components/ui';
import { PROPERTY_TYPE_LABELS } from '../types';
import AddPropertyModal from '../components/property/AddPropertyModal';

const TYPE_COLORS: Record<string, string> = {
  PRIMARY: 'bg-amber-500/10', RENTAL: 'bg-emerald-500/10',
  INVESTMENT: 'bg-purple-500/10', COMMERCIAL: 'bg-blue-500/10',
};

const FILTER_CHIPS = [
  { label: 'All', value: 'all' },
  { label: 'Primary', value: 'PRIMARY' },
  { label: 'Rental', value: 'RENTAL' },
  { label: 'Investment', value: 'INVESTMENT' },
  { label: 'Commercial', value: 'COMMERCIAL' },
];

export default function PropertiesPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [propOrder, setPropOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('sollux_prop_order') || '[]'); } catch { return []; }
  });
  const [filter, setFilter] = useState('all');
  const [cityFilter, setCityFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showAddProperty, setShowAddProperty] = useState(false);
  const [editingProperty, setEditingProperty]   = useState<Property | null>(null);
  const [deletingProperty, setDeletingProperty] = useState<Property | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function loadProperties() {
    return getProperties().then(setProperties);
  }

  useEffect(() => {
    loadProperties().finally(() => setLoading(false));
  }, []);

  // Sorted by user-defined drag order
  const orderedProperties = useMemo(() => {
    if (!propOrder.length) return properties;
    const idx = Object.fromEntries(propOrder.map((id, i) => [id, i]));
    return [...properties].sort((a, b) => (idx[a.id] ?? 999) - (idx[b.id] ?? 999));
  }, [properties, propOrder]);

  const cities  = useMemo(() => ['all', ...Array.from(new Set(properties.map(p => p.city).filter(Boolean))).sort()], [properties]);
  const states  = useMemo(() => ['all', ...Array.from(new Set(properties.map(p => p.state).filter(Boolean))).sort()], [properties]);

  const typeFiltered = filter === 'all' ? orderedProperties : orderedProperties.filter(p => p.type === filter);
  const cityFiltered = cityFilter === 'all' ? typeFiltered : typeFiltered.filter(p => p.city === cityFilter);
  const stateFiltered = stateFilter === 'all' ? cityFiltered : cityFiltered.filter(p => p.state === stateFilter);
  const searchLower = search.toLowerCase();
  const filtered = !searchLower ? stateFiltered : stateFiltered.filter(p =>
    (p.nickname || '').toLowerCase().includes(searchLower) ||
    (p.address || '').toLowerCase().includes(searchLower) ||
    (p.city || '').toLowerCase().includes(searchLower)
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // Operate on the full ordered list, not filtered
    const oldIdx = orderedProperties.findIndex(p => p.id === active.id);
    const newIdx = orderedProperties.findIndex(p => p.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const newOrder = arrayMove(orderedProperties, oldIdx, newIdx).map(p => p.id);
    setPropOrder(newOrder);
    localStorage.setItem('sollux_prop_order', JSON.stringify(newOrder));
  }

  const monthlyTotal = properties.reduce((sum, p) =>
    sum + (p.utilityAccounts || []).reduce((s, a) => {
      const stmt = a.statements?.[0];
      const raw = stmt?.rawDataJson as Record<string, unknown> | undefined;
      // accountBalance = total owed (set by scraper); totalDue = same field under alternate name;
      // balance = DB-level field populated by scrapeWorker; fall back to amountDue.
      const bal = (raw?.accountBalance ?? raw?.totalDue ?? stmt?.balance ?? stmt?.amountDue) as number | undefined;
      return s + Number(bal ?? 0);
    }, 0), 0);

  const totalAccounts = properties.reduce((s, p) => s + (p.utilityAccounts?.length ?? 0), 0);
  const alertCount = properties.reduce((s, p) => s + (p._count?.insights ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="All properties"
        subtitle={`${properties.length} properties · ${totalAccounts} utility accounts`}
        action={
          <button onClick={() => setShowAddProperty(true)} className="btn btn-primary text-xs">+ Add property</button>
        }
      />

      <div className="px-6 py-5">
        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <StatCard label="Total properties" value={properties.length} />
          <StatCard label="Utility accounts" value={totalAccounts} />
          <StatCard label="Monthly spend" value={`$${monthlyTotal.toLocaleString('en-US', { minimumFractionDigits: 0 })}`} />
          <StatCard label="Active alerts" value={alertCount} subColor={alertCount > 0 ? 'red' : 'neutral'} />
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by address, nickname, or city…"
            className="w-full max-w-sm pl-8 pr-3 py-1.5 text-sm rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-600 focus:border-amber-500/40 outline-none transition-colors"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs leading-none">×</button>
          )}
        </div>

        {/* Filter row */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {FILTER_CHIPS.map(chip => (
            <button
              key={chip.value}
              onClick={() => setFilter(chip.value)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                filter === chip.value
                  ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400 font-medium'
                  : 'bg-transparent border border-white/10 text-gray-400 hover:border-white/20 hover:text-gray-300'
              }`}
            >
              {chip.label}
              {chip.value !== 'all' && (
                <span className="ml-1 text-gray-500">({properties.filter(p => p.type === chip.value).length})</span>
              )}
            </button>
          ))}
        </div>

        {/* City + State dropdowns */}
        <div className="flex gap-2 mb-5 flex-wrap">
          {cities.length > 2 && (
            <select value={cityFilter} onChange={e => setCityFilter(e.target.value)}
              className="text-xs px-3 py-1.5 rounded-full border border-white/10 bg-transparent text-gray-400 focus:border-amber-500/30 focus:text-amber-400 outline-none transition-colors appearance-none pr-6"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center' }}>
              {cities.map(c => <option key={c} value={c} style={{ background: '#1a1a1a' }}>{c === 'all' ? 'All cities' : c}</option>)}
            </select>
          )}
          {states.length > 2 && (
            <select value={stateFilter} onChange={e => setStateFilter(e.target.value)}
              className="text-xs px-3 py-1.5 rounded-full border border-white/10 bg-transparent text-gray-400 focus:border-amber-500/30 focus:text-amber-400 outline-none transition-colors appearance-none pr-6"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center' }}>
              {states.map(s => <option key={s} value={s} style={{ background: '#1a1a1a' }}>{s === 'all' ? 'All states' : s}</option>)}
            </select>
          )}
          {(cityFilter !== 'all' || stateFilter !== 'all') && (
            <button onClick={() => { setCityFilter('all'); setStateFilter('all'); }}
              className="text-xs px-2.5 py-1.5 rounded-full border border-white/10 text-gray-500 hover:text-gray-300 transition-colors">
              Clear ×
            </button>
          )}
        </div>

        {/* Property grid (draggable) */}
        {loading ? (
          <div className="grid grid-cols-2 gap-4">
            {Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-56" />)}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon="🏠" title="No properties found" body="Add your first property to start tracking utility bills." />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={filtered.map(p => p.id)} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-2 gap-4">
                {filtered.map(property => (
                  <SortablePropertyCard
                    key={property.id}
                    property={property}
                    onEdit={() => setEditingProperty(property)}
                    onDelete={() => setDeletingProperty(property)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
      {showAddProperty   && <AddPropertyModal onClose={() => { setShowAddProperty(false); loadProperties(); }} />}
      {editingProperty   && (
        <EditPropertyModal
          property={editingProperty}
          onClose={() => setEditingProperty(null)}
          onSaved={() => { setEditingProperty(null); loadProperties(); }}
        />
      )}
      {deletingProperty  && (
        <DeletePropertyModal
          property={deletingProperty}
          onClose={() => setDeletingProperty(null)}
          onDeleted={() => { setDeletingProperty(null); loadProperties(); }}
        />
      )}
    </div>
  );
}

function SortablePropertyCard({ property, onEdit, onDelete }: { property: Property; onEdit: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: property.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined };
  return (
    <div ref={setNodeRef} style={style} className="relative group">
      <button
        className="absolute top-3 right-10 z-10 text-gray-700 hover:text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing touch-none"
        title="Drag to reorder"
        {...attributes} {...listeners}
      >
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
          <circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>
          <circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>
          <circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/>
        </svg>
      </button>
      <PropertyCard property={property} onEdit={onEdit} onDelete={onDelete} />
    </div>
  );
}

function PropertyCard({ property, onEdit, onDelete }: { property: Property; onEdit: () => void; onDelete: () => void }) {
  const accounts = (property.utilityAccounts || []).filter(a => a.isActive !== false);

  // Same reconciliation logic as the detail page: if recent payments cover the open
  // balance, treat the account as paid even if the provider's API hasn't reflected it.
  const isAccountPaid = (a: typeof accounts[number]): boolean => {
    const latest = a.statements?.[0];
    if (!latest) return false;
    const raw = latest.rawDataJson as Record<string, unknown> | undefined;
    if (Number(latest.amountPaid ?? 0) > 0 || raw?.isPaid === true) return true;
    const openBalance = (raw?.accountBalance ?? raw?.totalDue ?? (latest as any).balance ?? latest.amountDue) as number | undefined;
    if (openBalance == null || openBalance <= 0.01) return true;
    const stmtDate = latest.statementDate ? new Date(latest.statementDate) : null;
    const pmts = ((a as any).payments ?? []) as Array<{ paymentDate: string; amount: number }>;
    const sumSinceStmt = pmts
      .filter(p => stmtDate ? new Date(p.paymentDate) >= stmtDate : false)
      .reduce((s, p) => s + Number(p.amount ?? 0), 0);
    return sumSinceStmt >= openBalance - 0.01;
  };

  const monthlyTotal = accounts.reduce((s, a) => {
    if (isAccountPaid(a)) return s;
    return s + Number(a.statements?.[0]?.amountDue ?? 0);
  }, 0);
  // Sum past due across all unpaid accounts so the property-level footer can show
  // a rollup matching what each utility card shows individually.
  const totalPastDue = accounts.reduce((s, a) => {
    if (isAccountPaid(a)) return s;
    const latest = a.statements?.[0];
    const raw = latest?.rawDataJson as Record<string, unknown> | undefined;
    const pastDue = raw?.pastDue != null ? Number(raw.pastDue) : 0;
    return s + (pastDue > 0 ? pastDue : 0);
  }, 0);
  const hasAlert = (property._count?.insights ?? 0) > 0;
  const hasPastDue = totalPastDue > 0 || accounts.some(a => {
    if (isAccountPaid(a)) return false;
    const raw = a.statements?.[0]?.rawDataJson as Record<string, unknown> | undefined;
    return raw?.isPastDue === true;
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <Link to={`/properties/${property.id}`} className="p-4 border-b border-white/8 flex items-start gap-3 hover:bg-white/2 transition-colors block">
        <div className={`w-10 h-10 rounded-xl ${TYPE_COLORS[property.type] || 'bg-white/5'} flex items-center justify-center text-lg flex-shrink-0`}>
          {property.type === 'PRIMARY' ? '🏠' : property.type === 'RENTAL' ? '🏡' : property.type === 'COMMERCIAL' ? '🏢' : '🏘'}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">
            {property.nickname || property.address}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">{property.city}, {property.state}</p>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <span className="pill pill-gray">{PROPERTY_TYPE_LABELS[property.type]}</span>
            <span className="pill pill-blue">{accounts.length} accounts</span>
            {hasPastDue && <span className="pill pill-red">Past due</span>}
            {hasAlert && <span className="pill pill-red">Alert</span>}
          </div>
        </div>
        {/* Three-dot menu */}
        <div ref={menuRef} className="flex-shrink-0 relative" onClick={e => e.preventDefault()}>
          <button
            onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(v => !v); }}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-8 z-20 w-36 rounded-xl overflow-hidden shadow-xl" style={{ background: '#252525', border: '1px solid rgba(255,255,255,0.1)' }}>
              <button
                onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onEdit(); }}
                className="w-full text-left px-3 py-2.5 text-xs text-gray-300 hover:bg-white/8 transition-colors flex items-center gap-2"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                Edit property
              </button>
              <button
                onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onDelete(); }}
                className="w-full text-left px-3 py-2.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-2"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Delete property
              </button>
            </div>
          )}
        </div>
      </Link>

      {/* Bill grid */}
      <Link to={`/properties/${property.id}`} className="block p-4 hover:bg-white/2 transition-colors">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 mb-3">
          {accounts.slice(0, 6).map(account => {
            const latest = account.statements?.[0];
            const raw = latest?.rawDataJson as Record<string, unknown> | undefined;
            const dueDate = latest?.dueDate ? new Date(latest.dueDate) : null;
            const now = new Date();

            // Determine true status — uses the same recent-payment reconciliation as the
            // property header. isPaid wins over Past due / Due soon so a payment that's
            // still propagating on the provider side doesn't display as overdue.
            const isPaid = isAccountPaid(account);
            const isPastDue = !isPaid && (raw?.isPastDue === true || (dueDate && dueDate < now));
            const isDueSoon = !isPaid && !isPastDue && dueDate && dueDate <= new Date(now.getTime() + 7 * 86400000);
            const pastDueAmt = raw?.pastDue != null ? Number(raw.pastDue) : 0;
            const hasPastDueBalance = !isPaid && pastDueAmt > 0;

            // Display current charge only (amountDue); past due shown separately below.
            // When paid, show $0 so the tile matches the reconciled state.
            const displayAmt = isPaid ? 0
              : latest?.amountDue != null ? Number(latest.amountDue)
              : null;

            let statusLabel = '—';
            let statusColor = 'text-gray-500';
            if (!latest) { statusLabel = 'No data'; statusColor = 'text-gray-600'; }
            else if (isPaid) { statusLabel = 'Paid'; statusColor = 'text-emerald-500'; }
            else if (isPastDue) { statusLabel = 'Past due'; statusColor = 'text-red-400'; }
            else if (isDueSoon) { statusLabel = 'Due soon'; statusColor = 'text-amber-500'; }
            else if (dueDate) { statusLabel = `Due ${dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`; statusColor = 'text-blue-400'; }
            else { statusLabel = 'Unpaid'; statusColor = 'text-amber-400'; }

            return (
              <div key={account.id} className="bg-white/5 rounded-lg p-2">
                <p className="text-xs text-gray-400 truncate mb-0.5">{account.providerName}</p>
                <p className="text-xs font-semibold text-gray-100">
                  {displayAmt != null ? `$${Number(displayAmt).toFixed(0)}` : '—'}
                </p>
                {hasPastDueBalance && (
                  <p className="text-xs text-red-400">{`+$${pastDueAmt.toFixed(0)} past due`}</p>
                )}
                <p className={`text-xs mt-0.5 ${statusColor}`}>{statusLabel}</p>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400">Monthly total</p>
            <p className="text-base font-semibold text-white">${monthlyTotal.toFixed(0)}</p>
            {totalPastDue > 0 && (
              <p className="text-xs text-red-400 mt-0.5">{`+$${totalPastDue.toFixed(0)} past due`}</p>
            )}
          </div>
          <span className="text-xs text-gold-500">View detail →</span>
        </div>
      </Link>
    </div>
  );
}

// ── Edit property modal ────────────────────────────────────────────────────────

function EditPropertyModal({ property, onClose, onSaved }: { property: Property; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    address:  property.address  || '',
    city:     property.city     || '',
    state:    property.state    || '',
    zip:      property.zip      || '',
    nickname: property.nickname || '',
    type:     property.type     || 'RENTAL',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const fieldCls = 'w-full rounded-lg px-3 py-2 text-sm text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none';

  async function handleSave() {
    setLoading(true); setError('');
    try {
      await updateProperty(property.id, form);
      onSaved();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to update');
    } finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl p-6 space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Edit property</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Street address</label>
            <input className={fieldCls} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">City</label>
              <input className={fieldCls} value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">State</label>
              <input className={fieldCls} maxLength={2} value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value.toUpperCase().slice(0, 2) }))} />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">ZIP</label>
              <input className={fieldCls} value={form.zip} onChange={e => setForm(f => ({ ...f, zip: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Nickname (optional)</label>
              <input className={fieldCls} placeholder="e.g. Beach House" value={form.nickname} onChange={e => setForm(f => ({ ...f, nickname: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Type</label>
              <select className={fieldCls} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as any }))}>
                {['PRIMARY','RENTAL','INVESTMENT','COMMERCIAL'].map(t => (
                  <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button className="btn text-xs flex-1" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary text-xs flex-1" onClick={handleSave} disabled={loading || !form.address || !form.city || !form.state}>
            {loading ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Delete property modal ─────────────────────────────────────────────────────

function DeletePropertyModal({ property, onClose, onDeleted }: { property: Property; onClose: () => void; onDeleted: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const accountCount = property.utilityAccounts?.length ?? 0;

  async function handleDelete() {
    setLoading(true);
    try {
      await deleteProperty(property.id);
      onDeleted();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to delete');
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl p-6 space-y-4" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-white">Delete {property.nickname || property.address}?</h3>
        <div className="text-xs text-gray-400 space-y-1.5">
          <p>This will permanently delete:</p>
          <ul className="list-disc pl-4 space-y-0.5 text-gray-500">
            <li>The property record</li>
            <li>{accountCount} utility account{accountCount !== 1 ? 's' : ''}</li>
            <li>All statements, payments, and AI insights for this property</li>
          </ul>
          <p className="text-red-400 font-medium pt-1">This cannot be undone.</p>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button className="btn text-xs flex-1" onClick={onClose}>Cancel</button>
          <button
            className="flex-1 rounded-lg px-3 py-2 text-xs font-medium bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition-colors disabled:opacity-40"
            onClick={handleDelete}
            disabled={loading}
          >
            {loading ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
