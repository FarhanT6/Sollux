import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getProperties } from '../api/client';
import type { Property } from '../types';
import { PageHeader, StatCard, Skeleton, EmptyState, Pill } from '../components/ui';
import { PROPERTY_TYPE_LABELS, CATEGORY_COLORS } from '../types';

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
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProperties().then(setProperties).finally(() => setLoading(false));
  }, []);

  const filtered = filter === 'all' ? properties : properties.filter(p => p.type === filter);

  const monthlyTotal = properties.reduce((sum, p) =>
    sum + (p.utilityAccounts || []).reduce((s, a) =>
      s + Number(a.statements?.[0]?.amountDue ?? 0), 0), 0);

  const totalAccounts = properties.reduce((s, p) => s + (p.utilityAccounts?.length ?? 0), 0);
  const alertCount = properties.reduce((s, p) => s + (p._count?.insights ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="All properties"
        subtitle={`${properties.length} properties · ${totalAccounts} utility accounts`}
        action={
          <Link to="/properties/new" className="btn btn-primary text-xs">+ Add property</Link>
        }
      />

      <div className="px-6 py-5">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          <StatCard label="Total properties" value={properties.length} />
          <StatCard label="Utility accounts" value={totalAccounts} />
          <StatCard label="Monthly spend" value={`$${monthlyTotal.toLocaleString('en-US', { minimumFractionDigits: 0 })}`} />
          <StatCard label="Active alerts" value={alertCount} subColor={alertCount > 0 ? 'red' : 'neutral'} />
        </div>

        {/* Filter chips */}
        <div className="flex gap-2 mb-5 flex-wrap">
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
                <span className="ml-1 text-gray-500">
                  ({properties.filter(p => p.type === chip.value).length})
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Property grid */}
        {loading ? (
          <div className="grid grid-cols-2 gap-4">
            {Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-56" />)}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon="🏠" title="No properties found" body="Add your first property to start tracking utility bills." />
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {filtered.map(property => (
              <PropertyCard key={property.id} property={property} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PropertyCard({ property }: { property: Property }) {
  const accounts = property.utilityAccounts || [];
  const monthlyTotal = accounts.reduce((s, a) => s + Number(a.statements?.[0]?.amountDue ?? 0), 0);
  const hasAlert = (property._count?.insights ?? 0) > 0;
  const syncStatus = accounts.some(a => a.lastSyncStatus === 'FAILED') ? 'error'
    : accounts.some(a => a.lastSyncStatus === 'PENDING') ? 'warning'
    : 'success';

  return (
    <Link to={`/properties/${property.id}`} className="card hover:border-gold-300 transition-colors block overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-white/8 flex items-start gap-3">
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
            {hasAlert && <span className="pill pill-red">Alert</span>}
          </div>
        </div>
      </div>

      {/* Bill grid */}
      <div className="p-4">
        <div className="grid grid-cols-3 gap-1.5 mb-3">
          {accounts.slice(0, 6).map(account => {
            const latest = account.statements?.[0];
            const dueDate = latest?.dueDate;
            const isDue = dueDate && new Date(dueDate) <= new Date(Date.now() + 7 * 86400000);
            return (
              <div key={account.id} className="bg-white/5 rounded-lg p-2">
                <p className="text-xs text-gray-400 truncate mb-0.5">{account.providerName}</p>
                <p className="text-xs font-semibold text-gray-100">
                  {latest?.amountDue ? `$${Number(latest.amountDue).toFixed(0)}` : '—'}
                </p>
                <p className={`text-xs mt-0.5 ${isDue ? 'text-amber-500' : 'text-emerald-500'}`}>
                  {dueDate ? (isDue ? 'Due soon' : 'Paid') : '—'}
                </p>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400">Monthly total</p>
            <p className="text-base font-semibold text-white">${monthlyTotal.toFixed(0)}</p>
          </div>
          <span className="text-xs text-gold-500">View detail →</span>
        </div>
      </div>
    </Link>
  );
}
