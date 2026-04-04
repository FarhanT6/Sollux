import { useUser, useClerk } from '@clerk/clerk-react';
import { PageHeader } from '../components/ui';

export default function SettingsPage() {
  const { user } = useUser();
  const { signOut } = useClerk();

  return (
    <div>
      <PageHeader title="Settings" subtitle="Manage your account and subscription" />
      <div className="px-6 py-5 max-w-2xl">

        <div className="card p-5 mb-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Profile</h2>
          <div className="space-y-3">
            <div>
              <p className="text-xs text-gray-400 mb-1">Full name</p>
              <p className="text-sm text-gray-900">{user?.fullName || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Email</p>
              <p className="text-sm text-gray-900">{user?.primaryEmailAddress?.emailAddress || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Member since</p>
              <p className="text-sm text-gray-900">{user?.createdAt ? new Date(user.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—'}</p>
            </div>
          </div>
        </div>

        <div className="card p-5 mb-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Subscription</h2>
          <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-900">Pro plan</p>
              <p className="text-xs text-amber-700">Up to 10 properties · Full AI engine · Email + SMS</p>
            </div>
            <span className="pill pill-amber">Active</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button className="btn text-xs justify-center">Manage billing</button>
            <button className="btn text-xs justify-center">Upgrade to Business</button>
          </div>
        </div>

        <div className="card p-5 mb-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Connected accounts</h2>
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-red-50 rounded flex items-center justify-center text-xs">G</div>
              <div>
                <p className="text-sm text-gray-900">Gmail</p>
                <p className="text-xs text-gray-400">Parse utility emails automatically</p>
              </div>
            </div>
            <button className="btn text-xs">Connect</button>
          </div>
        </div>

        <div className="card p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Account actions</h2>
          <div className="space-y-2">
            <button className="btn text-xs w-full justify-center text-gray-600">Export all data (CSV)</button>
            <button
              onClick={() => signOut()}
              className="btn text-xs w-full justify-center text-red-500 border-red-200 hover:bg-red-50"
            >
              Sign out
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
