import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getProperties } from '../api/client';
import type { Property } from '../types';
import { PageHeader, StatCard, Skeleton, EmptyState, Pill } from '../components/ui';
import { PROPERTY_TYPE_LABELS, CATEGORY_COLORS } from '../types';
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
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [showAddProperty, setShowAddProperty] = useState(false);

  function loadProperties() {
    return getProperties().then(setProperties);
  }

  useEffect(() => {
    loadProperties().finally(() => setLoading(false));
  }, []);

  const filtered = filter === 'all' ? properties : properties.filter(p => p.type === filter);

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
      {showAddProperty && <AddPropertyModal onClose={() => { setShowAddProperty(false); loadProperties(); }} />}
    </div>
  );
}

function PropertyCard({ property }: { property: Property }) {
  const accounts = property.utilityAccounts || [];
  const monthlyTotal = accounts.reduce((s, a) => {
    return s + Number(a.statements?.[0]?.amountDue ?? 0);
  }, 0);
  const hasAlert = (property._count?.insights ?? 0) > 0;
  const hasPastDue = accounts.some(a => {
    const raw = a.statements?.[0]?.rawDataJson as Record<string, unknown> | undefined;
    const isPaid = Number(a.statements?.[0]?.amountPaid ?? 0) > 0 || raw?.isPaid === true;
    if (isPaid) return false;
    const pastDue = raw?.pastDue != null ? Number(raw.pastDue) : 0;
    return pastDue > 0 || raw?.isPastDue === true;
  });
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
            {hasPastDue && <span className="pill pill-red">Past due</span>}
            {hasAlert && <span className="pill pill-red">Alert</span>}
          </div>
        </div>
      </div>

      {/* Bill grid */}
      <div className="p-4">
        <div className="grid grid-cols-3 gap-1.5 mb-3">
          {accounts.slice(0, 6).map(account => {
            const latest = account.statements?.[0];
            const raw = latest?.rawDataJson as Record<string, unknown> | undefined;
            const dueDate = latest?.dueDate ? new Date(latest.dueDate) : null;
            const now = new Date();

            // Determine true status
            const isPaid = Number(latest?.amountPaid ?? 0) > 0 || raw?.isPaid === true;
            const isPastDue = !isPaid && (raw?.isPastDue === true || (dueDate && dueDate < now));
            const isDueSoon = !isPaid && !isPastDue && dueDate && dueDate <= new Date(now.getTime() + 7 * 86400000);
            const pastDueAmt = raw?.pastDue != null ? Number(raw.pastDue) : 0;
            const hasPastDueBalance = !isPaid && pastDueAmt > 0;

            // Display current charge only (amountDue); past due shown separately below
            const displayAmt = latest?.amountDue != null ? Number(latest.amountDue) : null;

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
          </div>
          <span className="text-xs text-gold-500">View detail →</span>
        </div>
      </div>
    </Link>
  );
}
