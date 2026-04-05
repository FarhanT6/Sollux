import { useUser, useClerk } from '@clerk/clerk-react';
import { useEffect, useState } from 'react';
import { PageHeader } from '../components/ui';
import api, { getGmailConnectUrl } from '../api/client';

export default function SettingsPage() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [gmailStatus, setGmailStatus] = useState<{ connected: boolean; accounts: { id: string; email: string; label?: string }[] } | null>(null);
  const [gmailSuccessMsg, setGmailSuccessMsg] = useState('');

  useEffect(() => {
    api.get('/gmail/status').then(r => setGmailStatus(r.data)).catch(() => {});

    if (window.location.search.includes('gmail=connected')) {
      setGmailSuccessMsg('Gmail connected successfully!');
      setTimeout(() => setGmailSuccessMsg(''), 4000);
    }
  }, []);

  return (
    <div>
      <PageHeader title="Settings" subtitle="Manage your account and subscription" />
      <div className="px-6 py-5 max-w-2xl">

        <div className="card p-5 mb-4">
          <h2 className="text-sm font-semibold text-white mb-4">Profile</h2>
          <div className="space-y-3">
            <div>
              <p className="text-xs text-gray-400 mb-1">Full name</p>
              <p className="text-sm text-gray-100">{user?.fullName || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Email</p>
              <p className="text-sm text-gray-100">{user?.primaryEmailAddress?.emailAddress || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Member since</p>
              <p className="text-sm text-gray-100">{user?.createdAt ? new Date(user.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—'}</p>
            </div>
          </div>
        </div>

        <div className="card p-5 mb-4">
          <h2 className="text-sm font-semibold text-white mb-4">Subscription</h2>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-300">Pro plan</p>
              <p className="text-xs text-amber-400">Up to 10 properties · Full AI engine · Email + SMS</p>
            </div>
            <span className="pill pill-amber">Active</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button className="btn text-xs justify-center">Manage billing</button>
            <button className="btn text-xs justify-center">Upgrade to Business</button>
          </div>
        </div>

        <div className="card p-5 mb-4">
          <h2 className="text-sm font-semibold text-white mb-4">Connected accounts</h2>
          {gmailSuccessMsg && (
            <p className="text-xs text-green-400 mb-3">{gmailSuccessMsg}</p>
          )}
          {/* List all connected Gmail accounts */}
          {(gmailStatus?.accounts || []).map(acct => (
            <div key={acct.id} className="flex items-center justify-between py-2.5 border-b border-white/8 last:border-0">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 bg-red-500/10 rounded flex items-center justify-center text-xs text-gray-300">G</div>
                <div>
                  <p className="text-sm text-gray-100">{acct.email}</p>
                  {acct.label && <p className="text-xs text-gray-400">{acct.label}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="pill pill-green">&#x2713; Connected</span>
                <button
                  className="btn text-xs text-red-400 border-red-500/30 hover:bg-red-500/10"
                  onClick={() => api.delete(`/gmail/disconnect/${acct.id}`)
                    .then(() => api.get('/gmail/status').then(r => setGmailStatus(r.data)))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          {/* Add another Gmail account */}
          <div className="flex items-center justify-between pt-2.5">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-red-500/10 rounded flex items-center justify-center text-xs text-gray-300">G</div>
              <p className="text-sm text-gray-400">
                {gmailStatus?.connected ? 'Add another Gmail account' : 'Connect Gmail to parse utility emails'}
              </p>
            </div>
            <button
              className="btn text-xs"
              onClick={() => getGmailConnectUrl().then(r => { window.location.href = r.url; })}
            >
              + Connect
            </button>
          </div>
        </div>

        <div className="card p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Account actions</h2>
          <div className="space-y-2">
            <button className="btn text-xs w-full justify-center text-gray-400">Export all data (CSV)</button>
            <button
              onClick={() => signOut()}
              className="btn text-xs w-full justify-center text-red-400 border-red-500/30 hover:bg-red-500/10"
            >
              Sign out
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
