import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useUser, useClerk } from '@clerk/clerk-react';
import { useEffect, useState } from 'react';
import { getDashboardSummary } from '../../api/client';
import type { DashboardSummary } from '../../types';

const NAV = [
  { to: '/dashboard',     label: 'Dashboard',       color: '#F5A623' },
  { to: '/properties',    label: 'Properties',       color: '#F0997B' },
  { to: '/insights',      label: 'AI insights',      color: '#5DCAA5' },
  { to: '/payments',      label: 'Payments',         color: '#7F77DD' },
  { to: '/documents',     label: 'Document vault',   color: '#D4537E' },
];

const NAV_ACCOUNT = [
  { to: '/notifications', label: 'Notifications',    color: '#378ADD' },
  { to: '/settings',      label: 'Settings',         color: '#888780' },
];

export default function AppLayout() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);

  useEffect(() => {
    getDashboardSummary().then(setSummary).catch(() => {});
  }, []);

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#1e1e1e' }}>
      {/* Sidebar */}
      <aside className="w-52 flex-shrink-0 flex flex-col" style={{ background: '#161616', borderRight: '1px solid rgba(255,255,255,0.07)' }}>
        {/* Logo */}
        <div className="px-4 py-4 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="w-7 h-7 rounded-lg bg-gold-500 flex items-center justify-center">
            <div className="w-3 h-3 rounded-full bg-white" />
          </div>
          <span className="text-base font-semibold tracking-tight text-white">
            Sol<span className="text-gold-500">lux</span>
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 overflow-y-auto">
          <p className="section-label px-2 mt-1 mb-1">Overview</p>
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) =>
              `sidebar-link ${isActive ? 'active' : ''}`
            }>
              <span className="w-3.5 h-3.5 rounded flex-shrink-0" style={{ background: n.color }} />
              <span>{n.label}</span>
              {n.to === '/insights' && summary?.unreadInsights ? (
                <span className="ml-auto pill pill-red text-xs px-1.5 py-0">{summary.unreadInsights}</span>
              ) : null}
              {n.to === '/payments' && summary?.billsDueSoon ? (
                <span className="ml-auto pill pill-amber text-xs px-1.5 py-0">{summary.billsDueSoon}</span>
              ) : null}
            </NavLink>
          ))}

          <p className="section-label px-2 mt-4 mb-1">Account</p>
          {NAV_ACCOUNT.map(n => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) =>
              `sidebar-link ${isActive ? 'active' : ''}`
            }>
              <span className="w-3.5 h-3.5 rounded flex-shrink-0" style={{ background: n.color }} />
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div className="px-3 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0"
              style={{ background: 'rgba(245,166,35,0.2)', color: '#F5A623' }}>
              {user?.firstName?.[0]}{user?.lastName?.[0]}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-white truncate">{user?.fullName || user?.emailAddresses[0]?.emailAddress}</p>
              <p className="text-xs text-gray-500 truncate">
                {summary ? `${summary.totalProperties} properties` : 'Pro plan'}
              </p>
            </div>
            <button
              onClick={() => signOut()}
              className="text-xs text-gray-500 hover:text-gray-300 flex-shrink-0"
              title="Sign out"
            >
              ↩
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto" style={{ background: '#1e1e1e' }}>
        <Outlet />
      </main>
    </div>
  );
}
