import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, SignUp, SignIn } from '@clerk/clerk-react';
import Logo from '../../components/brand/Logo';
import { claimPortalInvite } from '../../api/client';

const KEY = 'sollux.portalInvite';

/**
 * Where a tenant's invite link lands. Not signed in: create a sign-in (or
 * sign in), and come back here. Signed in: the invite is claimed and the
 * portal opens.
 */
export default function PortalJoinPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'up' | 'in'>('up');
  const [error, setError] = useState<string | null>(null);

  // The token survives the trip through sign-up, which drops the query string.
  const fromLink = params.get('token');
  if (fromLink) { try { sessionStorage.setItem(KEY, fromLink); } catch { /* private mode */ } }
  const token = fromLink ?? (() => { try { return sessionStorage.getItem(KEY); } catch { return null; } })();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    if (!token) { navigate('/portal', { replace: true }); return; }
    claimPortalInvite(token)
      .then(() => { try { sessionStorage.removeItem(KEY); } catch { /* */ } navigate('/portal', { replace: true }); })
      .catch((e: any) => setError(e?.response?.data?.error ?? 'This invite could not be used. Ask your landlord for a new link.'));
  }, [isLoaded, isSignedIn, token]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10" style={{ background: '#161616', minHeight: '100dvh' }}>
      <div className="flex flex-col items-center gap-4 w-full max-w-sm">
        <Logo size={36} />
        {error ? (
          <div className="card p-5 text-sm text-gray-200 w-full">{error}</div>
        ) : isLoaded && isSignedIn ? (
          <p className="text-sm text-gray-400">Opening your portal…</p>
        ) : (
          <>
            <div className="text-center">
              <h1 className="text-lg font-semibold text-white">Your tenant portal</h1>
              <p className="text-sm text-gray-400 mt-1">Pay rent, set up autopay and send repair requests. {mode === 'up' ? 'Create a sign-in to start.' : 'Sign in to continue.'}</p>
            </div>
            {mode === 'up'
              ? <SignUp routing="virtual" forceRedirectUrl="/portal/join" signInUrl="/portal/join" />
              : <SignIn routing="virtual" forceRedirectUrl="/portal/join" signUpUrl="/portal/join" />}
            <button className="text-xs text-gray-400 underline" onClick={() => setMode(mode === 'up' ? 'in' : 'up')}>
              {mode === 'up' ? 'Already have a sign-in? Sign in' : 'New here? Create a sign-in'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
