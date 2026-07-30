import { Outlet, NavLink } from 'react-router-dom';
import { useUser, useClerk } from '@clerk/clerk-react';
import { useEffect, useState } from 'react';
import { getDashboardSummary } from '../../api/client';
import type { DashboardSummary } from '../../types';

function Ico({ d, children }: { d?: string; children?: React.ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d ? <path d={d} /> : children}
    </svg>
  );
}

const NAV = [
  {
    to: '/dashboard', label: 'Overview',
    icon: <Ico><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Ico>,
  },
  {
    to: '/properties', label: 'Properties',
    icon: <Ico><path d="M3 21h18"/><path d="M6 21V7l6-4 6 4v14"/><path d="M9 21v-9h6v9"/></Ico>,
  },
  {
    to: '/import', label: 'Import',
    icon: <Ico><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></Ico>,
  },
  {
    to: '/finances', label: 'Finances',
    icon: <Ico><rect x="3" y="13" width="4" height="8" rx="0.5"/><rect x="10" y="7" width="4" height="14" rx="0.5"/><rect x="17" y="3" width="4" height="18" rx="0.5"/></Ico>,
  },
  {
    to: '/portfolio', label: 'Portfolio',
    icon: <Ico><path d="M3 21h18"/><path d="M9 21V7H5l7-5 7 5v14"/><rect x="9" y="13" width="2" height="4"/><rect x="13" y="13" width="2" height="4"/></Ico>,
  },
  {
    to: '/insights', label: 'Insights',
    icon: <Ico d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" />,
  },
];

export default function AppLayout() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    getDashboardSummary().then(setSummary).catch(() => {});
  }, []);

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#1e1e1e' }}>
      {!sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="fixed top-4 left-4 z-50 w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 hover:text-white transition-colors"
          style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)' }}
          title="Show sidebar"
        >
          <Ico d="M3 6h18M3 12h18M3 18h18" />
        </button>
      )}
      <aside
        className={`flex-shrink-0 flex flex-col overflow-hidden transition-all duration-200 ${sidebarOpen ? 'w-52' : 'w-0'}`}
        style={{ background: '#161616', borderRight: sidebarOpen ? '1px solid rgba(255,255,255,0.07)' : 'none' }}
      >
        <div className="px-4 py-4 flex items-center justify-between gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-gold-500 flex items-center justify-center flex-shrink-0">
              <div className="w-3 h-3 rounded-full bg-white" />
            </div>
            <span className="text-base font-semibold tracking-tight text-white whitespace-nowrap">
              Sol<span className="text-gold-500">lux</span>
            </span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-lg text-gray-500 hover:text-white hover:bg-white/5 transition-colors"
            title="Hide sidebar"
          >
            <Ico d="M3 6h18M3 12h18M3 18h18" />
          </button>
        </div>

        <nav className="flex-1 px-2 py-3 overflow-y-auto">
          {NAV.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            >
              <span className="flex-shrink-0" style={{ opacity: 0.65 }}>{n.icon}</span>
              <span>{n.label}</span>
              {n.to === '/insights' && summary?.unreadInsights ? (
                <span className="ml-auto pill pill-red text-xs px-1.5 py-0">{summary.unreadInsights}</span>
              ) : n.to === '/properties' && summary?.billsDueSoon ? (
                <span className="ml-auto pill pill-amber text-xs px-1.5 py-0">{summary.billsDueSoon}</span>
              ) : null}
            </NavLink>
          ))}
        </nav>

        <div className="px-3 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <NavLink to="/settings" className="flex items-center gap-2 rounded-lg px-1 py-1 transition-colors hover:bg-white/5 cursor-pointer">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0"
              style={{ background: 'rgba(245,166,35,0.2)', color: '#F5A623' }}
            >
              {user?.firstName?.[0]}{user?.lastName?.[0]}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-white truncate">{user?.fullName || user?.emailAddresses[0]?.emailAddress}</p>
              <p className="text-xs text-gray-500 truncate">
                {summary ? `${summary.totalProperties} properties` : 'Pro plan'}
              </p>
            </div>
          </NavLink>
          <button onClick={() => signOut()} className="mt-1 w-full text-left text-xs text-gray-500 hover:text-gray-300 px-1 py-0.5 transition-colors" title="Sign out">Sign out</button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto" style={{ background: '#1e1e1e' }}>
        <Outlet />
      </main>
    </div>
  );
}
