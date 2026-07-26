import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import RentRollPage from './RentRollPage';
import TenantsPage from './TenantsPage';
import NoticesPage from './NoticesPage';

type Tab = 'rent-roll' | 'tenants' | 'notices';

const TABS: { key: Tab; label: string }[] = [
  { key: 'rent-roll', label: 'Rent roll' },
  { key: 'tenants',   label: 'Tenants'   },
  { key: 'notices',   label: '3-day notices' },
];

export default function TenantsHubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') as Tab) || 'rent-roll';

  function setTab(t: Tab) {
    setSearchParams({ tab: t }, { replace: true });
  }

  const subtitles: Record<Tab, string> = {
    'rent-roll': 'Active leases, rent amounts, and payment logging',
    'tenants':   'Tenant contact records and active leases',
    'notices':   'Generate and track 3-day pay-or-quit notices',
  };

  return (
    <div>
      <PageHeader title="Tenants" subtitle={subtitles[tab]} />

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

      <div className="px-6 py-5">
        {tab === 'rent-roll' && <RentRollPage embedded />}
        {tab === 'tenants'   && <TenantsPage embedded />}
        {tab === 'notices'   && <NoticesPage embedded />}
      </div>
    </div>
  );
}
