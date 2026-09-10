import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useUser, useClerk } from '@clerk/clerk-react';
import { useEffect, useState } from 'react';
import { getDashboardSummary } from '../../api/client';
import type { DashboardSummary } from '../../types';
import { tap } from '../../lib/native';

function Ico({ d, children, size = 16 }: { d?: string; children?: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d ? <path d={d} /> : children}
    </svg>
  );
}

const NAV = [
  {
    to: '/dashboard', label: 'Overview',
    icon: (z: number) => <Ico size={z}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Ico>,
  },
  {
    to: '/properties', label: 'Utilities',
    icon: (z: number) => <Ico size={z}><path d="M3 21h18"/><path d="M6 21V7l6-4 6 4v14"/><path d="M9 21v-9h6v9"/></Ico>,
  },
  {
    to: '/import', label: 'Import',
    icon: (z: number) => <Ico size={z}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></Ico>,
  },
  {
    to: '/scan', label: 'Scan',
    icon: (z: number) => <Ico size={z}><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18"/><path d="M4 12h4"/></Ico>,
  },
  {
    to: '/finances', label: 'Finances',
    icon: (z: number) => <Ico size={z}><rect x="3" y="13" width="4" height="8" rx="0.5"/><rect x="10" y="7" width="4" height="14" rx="0.5"/><rect x="17" y="3" width="4" height="18" rx="0.5"/></Ico>,
  },
  {
    to: '/portfolio', label: 'Portfolio',
    icon: (z: number) => <Ico size={z}><path d="M3 21h18"/><path d="M9 21V7H5l7-5 7 5v14"/><rect x="9" y="13" width="2" height="4"/><rect x="13" y="13" width="2" height="4"/></Ico>,
  },
  {
    to: '/payments', label: 'Payments',
    icon: (z: number) => <Ico size={z}><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></Ico>,
  },
  {
    to: '/operations', label: 'Operations',
    icon: (z: number) => <Ico size={z}><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></Ico>,
  },
  {
    to: '/legal', label: 'Legal',
    icon: (z: number) => <Ico size={z}><path d="M12 3v18"/><path d="M5 7h14"/><path d="M6 7l-3 6h6z"/><path d="M18 7l-3 6h6z"/></Ico>,
  },
  {
    to: '/insights', label: 'Insights',
    icon: (z: number) => <Ico size={z} d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" />,
  },
];

/** The five that fit a thumb; everything else lives behind "More". */
const TAB_BAR = ['/dashboard', '/properties', '/scan', '/finances', '/payments'];

/**
 * One layout, two shapes. Wide screens get the sidebar they always had. On a
 * phone — the iOS app, or Safari — the sidebar becomes a drawer, the five
 * most-used destinations sit in a bottom tab bar inside the home-indicator
 * safe area, and the top of the page keeps clear of the notch. Nothing
 * inside the pages changes; they already reflow.
 */
export default function AppLayout() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const location = useLocation();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    getDashboardSummary().then(setSummary).catch(() => {});
  }, []);

  // A navigation closes the drawer; a phone never shows two screens.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  const section = '/' + location.pathname.split('/')[1];
  const moreActive = !TAB_BAR.includes(section);

  const badge = (to: string) =>
    to === '/insights' && summary?.unreadInsights ? { n: summary.unreadInsights, color: 'pill-red' }
    : to === '/properties' && summary?.billsDueSoon ? { n: summary.billsDueSoon, color: 'pill-amber' }
    : null;

  const navList = (
    <nav className="flex-1 px-2 py-3 overflow-y-auto">
      {NAV.map(n => {
        const b = badge(n.to);
        return (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="flex-shrink-0" style={{ opacity: 0.65 }}>{n.icon(16)}</span>
            <span>{n.label}</span>
            {b && <span className={`ml-auto pill ${b.color} text-xs px-1.5 py-0`}>{b.n}</span>}
          </NavLink>
        );
      })}
    </nav>
  );

  const account = (
    <div className="px-3 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
      <NavLink to="/settings" className="flex items-center gap-2 rounded-lg px-1 py-1 transition-colors hover:bg-white/5 cursor-pointer">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0"
          style={{ background: 'rgba(245,166,35,0.2)', color: '#F5A623' }}>
          {user?.firstName?.[0]}{user?.lastName?.[0]}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-white truncate">{user?.fullName || user?.emailAddresses[0]?.emailAddress}</p>
          <p className="text-xs text-gray-500 truncate">{summary ? `${summary.totalProperties} properties` : 'Pro plan'}</p>
        </div>
      </NavLink>
      <button onClick={() => signOut()} className="mt-1 w-full text-left text-xs text-gray-500 hover:text-gray-300 px-1 py-0.5 transition-colors" title="Sign out">Sign out</button>
    </div>
  );

  const logo = (
    <div className="flex items-center gap-2 min-w-0">
      <div className="w-7 h-7 rounded-lg bg-gold-500 flex items-center justify-center flex-shrink-0">
        <div className="w-3 h-3 rounded-full bg-white" />
      </div>
      <span className="text-base font-semibold tracking-tight text-white whitespace-nowrap">
        Sol<span className="text-gold-500">lux</span>
      </span>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#1e1e1e', height: '100dvh' }}>
      {/* ── Desktop sidebar ─────────────────────────────────────── */}
      {!sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="hidden md:flex fixed top-4 left-4 z-50 w-9 h-9 items-center justify-center rounded-lg text-gray-400 hover:text-white transition-colors"
          style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)' }}
          title="Show sidebar"
        >
          <Ico d="M3 6h18M3 12h18M3 18h18" />
        </button>
      )}
      <aside
        className={`hidden md:flex flex-shrink-0 flex-col overflow-hidden transition-all duration-200 ${sidebarOpen ? 'w-52' : 'w-0'}`}
        style={{ background: '#161616', borderRight: sidebarOpen ? '1px solid rgba(255,255,255,0.07)' : 'none' }}
      >
        <div className="px-4 py-4 flex items-center justify-between gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          {logo}
          <button onClick={() => setSidebarOpen(false)}
            className="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-lg text-gray-500 hover:text-white hover:bg-white/5 transition-colors" title="Hide sidebar">
            <Ico d="M3 6h18M3 12h18M3 18h18" />
          </button>
        </div>
        {navList}
        {account}
      </aside>

      {/* ── Phone: top bar + drawer + tab bar ───────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden pt-safe flex-shrink-0" style={{ background: '#161616', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="h-11 px-3 flex items-center justify-between">
            {logo}
            <button onClick={() => { tap(); setDrawerOpen(true); }}
              className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 active:text-white" aria-label="Menu">
              <Ico d="M3 6h18M3 12h18M3 18h18" size={18} />
            </button>
          </div>
        </header>

        {drawerOpen && (
          <div className="md:hidden fixed inset-0 z-50 flex">
            <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => setDrawerOpen(false)} />
            <aside className="relative w-72 max-w-[85vw] h-full flex flex-col pt-safe pb-safe" style={{ background: '#161616', borderRight: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="px-4 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {logo}
                <button onClick={() => setDrawerOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500" aria-label="Close">✕</button>
              </div>
              {navList}
              {account}
            </aside>
          </div>
        )}

        <main className={`flex-1 overflow-y-auto ${!sidebarOpen ? 'md:pt-12' : ''}`} style={{ background: '#1e1e1e', WebkitOverflowScrolling: 'touch' }}>
          <Outlet />
          {/* Keep the last row above the tab bar on phones. */}
          <div className="md:hidden h-20" />
        </main>

        <nav className="md:hidden pb-safe flex-shrink-0 flex items-stretch" style={{ background: '#161616', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          {TAB_BAR.map(to => {
            const n = NAV.find(x => x.to === to)!;
            const b = badge(to);
            return (
              <NavLink key={to} to={to} onClick={() => tap()} className={({ isActive }) => `tabbar-link ${isActive ? 'active' : ''}`}>
                <span className="relative">
                  {n.icon(20)}
                  {b && <span className={`absolute -top-1 -right-2 pill ${b.color} text-[9px] px-1 py-0 leading-4`}>{b.n}</span>}
                </span>
                <span>{n.label}</span>
              </NavLink>
            );
          })}
          <button onClick={() => { tap(); setDrawerOpen(true); }} className={`tabbar-link ${moreActive ? 'active' : ''}`}>
            <Ico size={20}><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></Ico>
            <span>More</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
