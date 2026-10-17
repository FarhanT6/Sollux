import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useClerk } from '@clerk/clerk-react';
import Logo from '../../components/brand/Logo';
import { getPortalMe, type PortalMe } from '../../api/client';

/**
 * The tenant portal's frame: the tenant's own pages (home, repairs,
 * payments) and nothing of the owner's app. Phone-first — most tenants open
 * it from the invite on their phone.
 */
const PortalCtx = createContext<{ me: PortalMe | null; reload: () => Promise<void> }>({ me: null, reload: async () => {} });
export const usePortal = () => useContext(PortalCtx);

export default function PortalLayout() {
  const { signOut } = useClerk();
  const location = useLocation();
  const [me, setMe] = useState<PortalMe | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const reload = useCallback(() => getPortalMe().then(m => { setMe(m); setProblem(null); }).catch((e: any) => {
    setProblem(e?.response?.data?.error ?? "Your portal didn't load. Try again in a moment.");
  }), []);
  useEffect(() => { void reload(); }, [reload]);

  const tab = (to: string, label: string) => (
    <NavLink to={to} end className={({ isActive }) => `flex-1 text-center py-2.5 text-sm ${isActive ? 'text-amber-400 font-medium' : 'text-gray-400'}`}>{label}</NavLink>
  );

  return (
    <PortalCtx.Provider value={{ me, reload }}>
      <div className="min-h-screen" style={{ background: '#161616', minHeight: '100dvh' }}>
        <header className="sticky top-0 z-10" style={{ background: 'rgba(22,22,22,0.92)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,0.07)', paddingTop: 'env(safe-area-inset-top)' }}>
          <div className="max-w-xl mx-auto px-4 h-14 flex items-center justify-between">
            <Logo size={24} />
            <button onClick={() => void signOut({ redirectUrl: '/sign-in' })} className="text-xs text-gray-400 hover:text-gray-200">Sign out</button>
          </div>
          {me && (
            <nav className="max-w-xl mx-auto px-2 flex" aria-label="Portal">
              {tab('/portal', 'Home')}
              {tab('/portal/repairs', 'Repairs')}
              {tab('/portal/payments', 'Payments')}
            </nav>
          )}
        </header>
        <main className="max-w-xl mx-auto px-4 py-5" style={{ paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
          {problem ? (
            <div className="card p-5 text-sm text-gray-300">
              <p>{problem}</p>
              {!location.pathname.startsWith('/portal/join') && <p className="text-xs text-gray-500 mt-2">If you were sent an invite link, open it again on this device.</p>}
            </div>
          ) : !me ? <p className="text-sm text-gray-500">Loading…</p> : <Outlet />}
        </main>
      </div>
    </PortalCtx.Provider>
  );
}
