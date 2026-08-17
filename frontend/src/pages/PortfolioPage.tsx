import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { getProperties, getLeases, getLoans } from '../api/client';
import type { Property, Lease, Loan } from '../types';
import { PROPERTY_TYPE_LABELS } from '../types';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export default function PortfolioPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [leases, setLeases]         = useState<Lease[]>([]);
  const [loans, setLoans]           = useState<Loan[]>([]);
  const [loading, setLoading]       = useState(true);

  const [search, setSearch]           = useState('');
  const [filterState, setFilterState] = useState('');
  const [filterType, setFilterType]   = useState('');
  const [filterStatus, setFilterStatus] = useState('ACTIVE');
  const [sortBy, setSortBy]           = useState<'name' | 'rent' | 'arrears' | 'equity'>('name');

  useEffect(() => {
    Promise.all([
      getProperties(),
      getLeases({ status: 'ACTIVE' }),
      getLoans({ isPersonal: false }),
    ]).then(([props, lses, lns]) => {
      setProperties(props);
      setLeases(lses);
      setLoans(lns);
    }).finally(() => setLoading(false));
  }, []);

  const stats = useMemo(() => {
    const map: Record<string, { rent: number; arrears: number; occupied: number; debt: number; debtService: number; net: number }> = {};
    for (const p of properties) {
      const pl = leases.filter(l => l.unit?.property?.id === p.id);
      const ll = loans.filter(l => l.propertyId === p.id && l.isActive);
      const rent = pl.reduce((s, l) => s + Number(l.rentAmount), 0);
      // Monthly debt service = principal+interest plus escrow on active loans.
      const debtService = ll.reduce((s, l) => s + Number(l.monthlyPayment ?? 0) + Number(l.escrowAmount ?? 0), 0);
      map[p.id] = {
        rent,
        arrears:  pl.reduce((s, l) => s + Number(l.arrearsBalance), 0),
        occupied: new Set(pl.map(l => l.unitId)).size,
        debt:     ll.reduce((s, l) => s + Number(l.currentBalance ?? 0), 0),
        debtService,
        net:      rent - debtService,
      };
    }
    return map;
  }, [properties, leases, loans]);

  const states = useMemo(() => [...new Set(properties.map(p => p.state))].sort(), [properties]);
  const types  = useMemo(() => [...new Set(properties.map(p => p.type))].sort(), [properties]);

  const filtered = useMemo(() => {
    let list = properties;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        p.address.toLowerCase().includes(q) ||
        (p.nickname ?? '').toLowerCase().includes(q) ||
        p.city.toLowerCase().includes(q)
      );
    }
    if (filterState)  list = list.filter(p => p.state === filterState);
    if (filterType)   list = list.filter(p => p.type === filterType);
    if (filterStatus) list = list.filter(p => p.status === filterStatus);

    return [...list].sort((a, b) => {
      const sa = stats[a.id] ?? {};
      const sb = stats[b.id] ?? {};
      if (sortBy === 'rent')    return (sb.rent ?? 0) - (sa.rent ?? 0);
      if (sortBy === 'arrears') return (sb.arrears ?? 0) - (sa.arrears ?? 0);
      if (sortBy === 'equity') {
        const eq = (p: Property) => Number(p.estimatedValue ?? 0) - (stats[p.id]?.debt ?? 0);
        return eq(b) - eq(a);
      }
      return (a.nickname ?? a.address).localeCompare(b.nickname ?? b.address);
    });
  }, [properties, search, filterState, filterType, filterStatus, sortBy, stats]);

  const totals = useMemo(() => ({
    rent:    filtered.reduce((s, p) => s + (stats[p.id]?.rent   ?? 0), 0),
    net:     filtered.reduce((s, p) => s + (stats[p.id]?.net    ?? 0), 0),
    arrears: filtered.reduce((s, p) => s + (stats[p.id]?.arrears ?? 0), 0),
    equity:  filtered.reduce((s, p) => {
      const eq = Number(p.estimatedValue ?? 0) - (stats[p.id]?.debt ?? 0);
      return s + (eq > 0 ? eq : 0);
    }, 0),
  }), [filtered, stats]);

  // Cluster properties that share a parcel group so adjacent/combined
  // parcels (e.g. 1536/1538/1518 Hunsaker St) show together, not scattered.
  const { groups, ungrouped } = useMemo(() => {
    const g: Record<string, Property[]> = {};
    const u: Property[] = [];
    for (const p of filtered) {
      if (p.parcelGroupName) (g[p.parcelGroupName] ??= []).push(p);
      else u.push(p);
    }
    return { groups: g, ungrouped: u };
  }, [filtered]);

  return (
    <div>
      <div className="px-6 py-4 flex items-center justify-between sticky top-0 z-10"
        style={{ background: '#1e1e1e', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div>
          <h1 className="text-base font-semibold text-white">Portfolio</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {filtered.length} properties · {money(totals.rent)}/mo · {totals.arrears > 0 ? `${money(totals.arrears)} arrears` : 'No arrears'}
          </p>
        </div>
      </div>

      <div className="px-6 py-5">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
          {[
            { label: 'Monthly rent roll', value: money(totals.rent), color: 'text-white' },
            { label: 'Monthly net', value: `${totals.net >= 0 ? '' : '-'}${money(Math.abs(totals.net))}`, color: totals.net >= 0 ? 'text-emerald-400' : 'text-red-400' },
            { label: 'Total arrears',     value: money(totals.arrears), color: totals.arrears > 0 ? 'text-red-400' : 'text-gray-500' },
            { label: 'Portfolio equity',  value: money(totals.equity), color: 'text-emerald-400' },
            { label: 'Properties shown', value: String(filtered.length), color: 'text-white' },
          ].map(c => (
            <div key={c.label} className="card p-3.5">
              <p className="text-xs text-gray-500 mb-0.5">{c.label}</p>
              <p className={`text-xl font-semibold ${c.color}`}>{c.value}</p>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex gap-2 mb-5 flex-wrap">
          <div className="relative flex-1 min-w-52">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search address, nickname, city…"
              className="input-dark w-full pl-8 text-sm" />
          </div>
          <select value={filterState}  onChange={e => setFilterState(e.target.value)}  className="input-dark text-sm">
            <option value="">All states</option>
            {states.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filterType}   onChange={e => setFilterType(e.target.value)}   className="input-dark text-sm">
            <option value="">All types</option>
            {types.map(t => <option key={t} value={t}>{PROPERTY_TYPE_LABELS[t] ?? t}</option>)}
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="input-dark text-sm">
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="SOLD">Sold</option>
            <option value="INACTIVE">Inactive</option>
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} className="input-dark text-sm">
            <option value="name">Sort: Name</option>
            <option value="rent">Sort: Highest rent</option>
            <option value="arrears">Sort: Most arrears</option>
            <option value="equity">Sort: Most equity</option>
          </select>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {Array(6).fill(0).map((_, i) => (
              <div key={i} className="card h-36 animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-500 text-sm">No properties match your filters</div>
        ) : (
          <div className="space-y-4">
            {Object.entries(groups).map(([groupName, groupProps]) => {
              const groupRent = groupProps.reduce((s, p) => s + (stats[p.id]?.rent ?? 0), 0);
              const groupArrears = groupProps.reduce((s, p) => s + (stats[p.id]?.arrears ?? 0), 0);
              const groupEquity = groupProps.reduce((s, p) => s + Math.max(0, Number(p.estimatedValue ?? 0) - (stats[p.id]?.debt ?? 0)), 0);
              const groupNet = groupProps.reduce((s, p) => s + (stats[p.id]?.net ?? 0), 0);
              return (
                <div key={groupName} className="rounded-xl p-3" style={{ border: '1px solid rgba(245,166,35,0.2)', background: 'rgba(245,166,35,0.03)' }}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1 pb-2 mb-1">
                    <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide">{groupName} · {groupProps.length} parcels</p>
                    <p className="text-xs text-gray-400">
                      <span className={groupNet >= 0 ? 'text-emerald-400' : 'text-red-400'} title="Rent minus monthly debt service (P&I + escrow)">
                        {groupNet >= 0 ? '+' : ''}{money(groupNet)}/mo net
                      </span>
                      {' · '}{money(groupRent)}/mo · {groupArrears > 0 ? <span className="text-red-400">{money(groupArrears)} arrears</span> : 'no arrears'} · {money(groupEquity)} equity
                    </p>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    {groupProps.map(p => <PropertyCard key={p.id} p={p} stat={stats[p.id]} />)}
                  </div>
                </div>
              );
            })}
            {ungrouped.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {ungrouped.map(p => <PropertyCard key={p.id} p={p} stat={stats[p.id]} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PropertyCard({ p, stat }: { p: Property; stat?: { rent: number; arrears: number; occupied: number; debt: number; debtService: number; net: number } }) {
  const s = stat ?? { rent: 0, arrears: 0, occupied: 0, debt: 0, debtService: 0, net: 0 };
  const totalUnits = p.units?.length ?? 0;
  const occ = totalUnits > 0 ? Math.round(s.occupied / totalUnits * 100) : null;
  const equity = Number(p.estimatedValue ?? 0) - s.debt;
  return (
    <Link to={`/portfolio/${p.id}`} className="card p-4 hover:border-amber-500/30 transition-colors block group">
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white truncate group-hover:text-amber-400 transition-colors">
            {p.nickname || p.address}
          </p>
          {p.nickname && <p className="text-xs text-gray-500 truncate">{p.address}</p>}
          <p className="text-xs text-gray-500">{p.city}, {p.state}</p>
        </div>
        <div className="flex gap-1.5 flex-shrink-0 ml-2 flex-wrap justify-end">
          <span className="pill pill-gray">{PROPERTY_TYPE_LABELS[p.type] ?? p.type}</span>
          {occ !== null && (
            <span className={`pill ${occ === 100 ? 'pill-green' : occ >= 75 ? 'pill-amber' : 'pill-red'}`}>
              {occ}% occ
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Net/mo</p>
          <p className={`text-sm font-semibold ${s.net > 0 ? 'text-emerald-400' : s.net < 0 ? 'text-red-400' : 'text-gray-600'}`}
             title="Rent minus monthly debt service (P&I + escrow)">
            {s.rent || s.debtService ? `${s.net >= 0 ? '' : '-'}${money(Math.abs(s.net))}` : '—'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Rent/mo</p>
          <p className="text-sm font-semibold text-white">{s.rent ? money(s.rent) : '—'}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Arrears</p>
          <p className={`text-sm font-semibold ${s.arrears > 0 ? 'text-red-400' : 'text-gray-600'}`}>
            {s.arrears > 0 ? money(s.arrears) : '—'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Equity</p>
          <p className="text-sm font-semibold text-emerald-400">{equity > 0 ? money(equity) : '—'}</p>
        </div>
      </div>
    </Link>
  );
}
