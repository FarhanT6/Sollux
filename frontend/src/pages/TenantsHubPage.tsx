import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import RentCatchUp from '../components/tenant/RentCatchUp';
import { PageHeader } from '../components/ui';
import RentRollPage from './RentRollPage';
import RentPage from './RentPage';
import TenantsPage from './TenantsPage';
import NoticesPage from './NoticesPage';

type Tab = 'rent' | 'rent-roll' | 'tenants' | 'notices';

const TABS: { key: Tab; label: string }[] = [
  // Rent's one place: this month's collection and who is behind (once under Finances), then the leases.
  { key: 'rent', label: 'This month' },
  { key: 'rent-roll', label: 'Rent roll' },
  { key: 'tenants',   label: 'Tenants'   },
  { key: 'notices',   label: '3-day notices' },
];

export default function TenantsHubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const tab: Tab = TABS.some(t => t.key === raw) ? raw as Tab : 'rent';

  const [catchingUp, setCatchingUp] = useState(false);
  // Remount the open view after a catch-up so it shows the rent just logged.
  const [reload, setReload] = useState(0);
  function setTab(t: Tab) {
    setSearchParams({ tab: t }, { replace: true });
  }

  const subtitles: Record<Tab, string> = {
    'rent': 'Rent collected this month, reminders, and who is behind',
    'rent-roll': 'Active leases, rent amounts, and payment logging',
    'tenants':   'Tenant contact records and active leases',
    'notices':   'Generate and track 3-day pay-or-quit notices',
  };

  return (
    <div>
      <PageHeader title="Tenants & rent" subtitle={subtitles[tab]}
        action={<button onClick={() => setCatchingUp(true)} className="btn text-sm" title="Log every month with no payment on record as paid, from move-in, for tenants who owe nothing from earlier months">Mark rent paid to date</button>} />
      {catchingUp && <RentCatchUp onClose={() => setCatchingUp(false)} onDone={() => { setCatchingUp(false); setReload(n => n + 1); }} />}

      <div className="flex border-b px-6" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`text-sm py-3 px-4 border-b-2 transition-colors ${
              tab === t.key
                ? 'border-amber-400 text-amber-400 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="px-6 py-5" key={reload}>
        {tab === 'rent' && <RentPage embedded />}
        {tab === 'rent-roll' && <RentRollPage embedded />}
        {tab === 'tenants'   && <TenantsPage embedded />}
        {tab === 'notices'   && <NoticesPage embedded />}
      </div>
    </div>
  );
}
