/**
 * A stand-in for @clerk/clerk-react, used only by `vite --mode mock` (see
 * vite.config.ts) so screens can be opened and screenshot-tested without a
 * Clerk instance. Never part of a production build.
 */
import type { ReactNode } from 'react';

const user = {
  id: 'user_mock', firstName: 'Farhan', lastName: 'Talukder', fullName: 'Farhan Talukder',
  primaryEmailAddress: { emailAddress: 'owner@example.com' },
  emailAddresses: [{ emailAddress: 'owner@example.com' }],
  createdAt: new Date('2026-04-01'), passwordEnabled: true,
};
const clerk = {
  signOut: async () => {}, openUserProfile: () => {}, openSignIn: () => {},
  session: { getToken: async () => 'mock-token' },
};
if (typeof window !== 'undefined') (window as any).Clerk = clerk;

export function ClerkProvider({ children }: { children: ReactNode; publishableKey?: string }) { return <>{children}</>; }
export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: user.id, getToken: async () => 'mock-token', signOut: clerk.signOut });
export const useUser = () => ({ isLoaded: true, isSignedIn: true, user });
export const useClerk = () => clerk;
export const SignedIn = ({ children }: { children: ReactNode }) => <>{children}</>;
export const SignedOut = (_: { children: ReactNode }) => null;
export const SignIn = (_: any) => <div style={{ color: '#888', padding: 24 }}>[Clerk sign-in]</div>;
export const SignUp = (_: any) => <div style={{ color: '#888', padding: 24 }}>[Clerk sign-up]</div>;
export const UserButton = () => null;
