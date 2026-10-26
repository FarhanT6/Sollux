/**
 * A stand-in for @clerk/clerk-react, used only by `vite --mode mock` (see
 * vite.config.ts) so screens can be opened and screenshot-tested without a
 * Clerk instance. Never part of a production build.
 */
import type { ReactNode } from 'react';

const user = {
  id: 'user_mock', firstName: 'Alex', lastName: 'Morgan', fullName: 'Alex Morgan',
  primaryEmailAddress: { emailAddress: 'owner@example.com' },
  emailAddresses: [{ emailAddress: 'owner@example.com' }],
  createdAt: new Date('2026-04-01'), passwordEnabled: true,
};
// localStorage sollux.mockUser = "tenant" signs in as the seeded tenant instead
// (the dev API's Clerk stub reads the token).
const tenant = typeof window !== 'undefined' && (() => { try { return localStorage.getItem('sollux.mockUser') === 'tenant'; } catch { return false; } })();
const token = tenant ? 'mock-tenant' : 'mock-token';
if (tenant) Object.assign(user, { id: 'user_tenant_mock', firstName: 'Tina', lastName: 'Tenant', fullName: 'Tina Tenant', primaryEmailAddress: { emailAddress: 'tenant@example.com' }, emailAddresses: [{ emailAddress: 'tenant@example.com' }] });
const clerk = {
  loaded: true, signOut: async () => {}, openUserProfile: () => {}, openSignIn: () => {},
  session: { getToken: async () => token },
};
if (typeof window !== 'undefined') (window as any).Clerk = clerk;

export function ClerkProvider({ children }: { children: ReactNode; publishableKey?: string }) { return <>{children}</>; }
export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: user.id, getToken: async () => token, signOut: clerk.signOut });
export const useUser = () => ({ isLoaded: true, isSignedIn: true, user });
export const useClerk = () => clerk;
export const SignedIn = ({ children }: { children: ReactNode }) => <>{children}</>;
export const SignedOut = (_: { children: ReactNode }) => null;
export const SignIn = (_: any) => <div style={{ color: '#888', padding: 24 }}>[Clerk sign-in]</div>;
export const SignUp = (_: any) => <div style={{ color: '#888', padding: 24 }}>[Clerk sign-up]</div>;
export const UserButton = () => null;
