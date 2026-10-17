import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useUser, useClerk } from '@clerk/clerk-react';
import { useEffect, useMemo, useState } from 'react';
import { PhoneChromeContext, NavBar, phoneRoute, rememberEntry } from '../../ios';
import Logo from '../brand/Logo';
import PlanBanner from '../PlanBanner';
import { getDashboardSummary } from '../../api/client';
import type { DashboardSummary } from '../../types';
import { tap } from '../../lib/native';
import { useThemeChoice, type ThemeChoice } from '../../lib/theme';

function Ico({ d, children, size = 16 }: { d?: string; children?: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d ? <path d={d} /> : children}
    </svg>
  );
}

export const NAV = [
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
    to: '/personal', label: 'Personal',
    icon: (z: number) => <Ico size={z}><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/></Ico>,
  },
  {
    to: '/vault', label: 'Vault',
    icon: (z: number) => <Ico size={z}><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.5"/></Ico>,
  },
  {
    to: '/taxes', label: 'Taxes',
    icon: (z: number) => <Ico size={z}><path d="M3 21h18"/><path d="M4 10h16"/><path d="M12 3l9 5H3l9-5z"/><path d="M6 10v8M10 10v8M14 10v8M18 10v8"/></Ico>,
  },
  {
    to: '/compliance', label: 'Compliance',
    icon: (z: number) => <Ico size={z}><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z"/><path d="M9 12l2 2 4-4"/></Ico>,
  },
  {
    to: '/projects', label: 'Projects',
    icon: (z: number) => <Ico size={z}><path d="M4 21V5h7v16"/><path d="M11 9h9v12"/><path d="M7 9h1M7 13h1M7 17h1M14 13h2M14 17h2"/><path d="M2 21h20"/></Ico>,
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
export const TAB_BAR = ['/dashboard', '/properties', '/scan', '/finances', '/payments'];

/**
 * One layout, two shapes. Wide screens get the sidebar they always had. On a
 * phone — the iOS app, or Safari — it is an iOS app: five tabs and More at
 * the bottom inside the home-indicator safe area, and a navigation bar at the
 * top with the screen's title and Back (src/ios/routes.ts). Screens built on
 * the iOS layer draw their own bar; the shell draws it for the rest.
 */
export default function AppLayout() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const location = useLocation();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [themeChoice, setThemeChoice] = useThemeChoice();
  // A phone screen built on the iOS layer draws its own navigation bar.
  const [ownHeader, setOwnHeader] = useState(false);
  const chrome = useMemo(() => ({ setOwnHeader }), []);

  useEffect(() => {
    getDashboardSummary().then(setSummary).catch(() => {});
  }, []);

  // Remember which screen each history entry was, so Back can name it.
  useEffect(() => { rememberEntry(location.pathname + location.search); }, [location.key, location.pathname, location.search]);

  const section = '/' + location.pathname.split('/')[1];
  const moreActive = !TAB_BAR.includes(section);
  const summaryBadge = (to: string) => {
    const b = badge(to);
    return b ? b.n : null;
  };

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

  const themeSwitch = (
    <div className="mb-2 flex items-center gap-0.5 rounded-lg p-0.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }} role="radiogroup" aria-label="Theme">
      {(['light', 'dark', 'system'] as ThemeChoice[]).map(c => (
        <button key={c} role="radio" aria-checked={themeChoice === c} onClick={() => setThemeChoice(c)}
          className={`flex-1 text-[11px] py-1 rounded-md transition-colors ${themeChoice === c ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
          style={themeChoice === c ? { background: 'rgba(255,255,255,0.08)' } : undefined}>
          {c === 'light' ? 'Light' : c === 'dark' ? 'Dark' : 'Auto'}
        </button>
      ))}
    </div>
  );

  const account = (
    <div className="px-3 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
      {themeSwitch}
      <NavLink to="/settings" className="flex items-center gap-2 rounded-lg px-1 py-1 transition-colors hover:bg-white/5 cursor-pointer">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0"
          style={{ background: 'rgba(245,166,35,0.2)', color: '#F5A623' }}>
          {user?.firstName?.[0]}{user?.lastName?.[0]}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-white truncate">{user?.fullName || user?.emailAddresses[0]?.emailAddress}</p>
          <p className="text-xs text-gray-500 truncate">{summary ? `${summary.totalProperties} properties` : ''}</p>
        </div>
      </NavLink>
      <button onClick={() => signOut()} className="mt-1 w-full text-left text-xs text-gray-500 hover:text-gray-300 px-1 py-0.5 transition-colors" title="Sign out">Sign out</button>
    </div>
  );

  const logo = <Logo size={28} />;

  return (
    <PhoneChromeContext.Provider value={chrome}>
    <div className="app-canvas flex h-screen overflow-hidden" style={{ background: '#1e1e1e', height: '100dvh' }}>
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
        className={`app-chrome hidden md:flex flex-shrink-0 flex-col overflow-hidden transition-all duration-200 ${sidebarOpen ? 'w-52' : 'w-0'}`}
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

      {/* ── Phone: navigation bar + tab bar ─────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Pages not built on the iOS layer still get the iOS bar: title and Back from the route table. */}
        {!ownHeader && (
          <div className="ios-shellbar md:hidden flex-shrink-0">
            <NavBar title={phoneRoute(location.pathname).title} back={{}} />
          </div>
        )}

        <main data-scroll-root className={`${ownHeader ? '' : 'app-canvas'} flex-1 overflow-y-auto ${!sidebarOpen ? 'md:pt-12' : ''}`}
          style={{ background: ownHeader ? 'var(--ios-bg)' : '#1e1e1e', WebkitOverflowScrolling: 'touch', overscrollBehaviorY: 'contain' }}>
          <PlanBanner />
          <Outlet />
          {/* Keep the last row clear of the tab bar on pages not yet on the iOS layer. */}
          {!ownHeader && <div className="md:hidden h-20" />}
        </main>

        {/* The iOS tab bar: five destinations and More, translucent over the content. */}
        <nav className="ios-tabbar md:hidden" aria-label="Tabs">
          {TAB_BAR.map(to => {
            const n = NAV.find(x => x.to === to)!;
            const b = summaryBadge(to);
            return (
              <NavLink key={to} to={to} onClick={() => tap()} className={({ isActive }) => `ios-tab ${isActive ? 'active' : ''}`}>
                <span style={{ position: 'relative' }}>
                  {n.icon(24)}
                  {b != null && <span className="ios-tab-badge">{b}</span>}
                </span>
                <span>{n.label}</span>
              </NavLink>
            );
          })}
          <NavLink to="/more" onClick={() => tap()} className={`ios-tab ${moreActive ? 'active' : ''}`}>
            <span style={{ position: 'relative' }}>
              <Ico size={24}><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></Ico>
              {(summary?.unreadInsights ?? 0) > 0 && <span className="ios-tab-badge">{summary!.unreadInsights}</span>}
            </span>
            <span>More</span>
          </NavLink>
        </nav>
      </div>
    </div>
    </PhoneChromeContext.Provider>
  );
}
