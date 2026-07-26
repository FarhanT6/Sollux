import { useUser, useClerk } from '@clerk/clerk-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import api, { getGmailConnectUrl, getDriveConnectUrl } from '../api/client';

type SettingsTab = 'account' | 'notifications';

export default function SettingsPage() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') as SettingsTab) || 'account';
  const [gmailStatus, setGmailStatus] = useState<{ connected: boolean; accounts: { id: string; email: string; label?: string }[] } | null>(null);
  const [gmailSuccessMsg, setGmailSuccessMsg] = useState('');
  const [driveStatus, setDriveStatus] = useState<{ connected: boolean; accounts: { id: string; email: string }[] } | null>(null);
  const [driveSuccessMsg, setDriveSuccessMsg] = useState('');

  useEffect(() => {
    api.get('/gmail/status').then(r => setGmailStatus(r.data)).catch(() => {});
    api.get('/drive/status').then(r => setDriveStatus(r.data)).catch(() => {});

    if (window.location.search.includes('gmail=connected')) {
      setGmailSuccessMsg('Gmail connected successfully!');
      setTimeout(() => setGmailSuccessMsg(''), 4000);
    }
    if (window.location.search.includes('drive=connected')) {
      setDriveSuccessMsg('Google Drive connected successfully!');
      setTimeout(() => setDriveSuccessMsg(''), 4000);
    }
  }, []);

  return (
    <div>
      <PageHeader title="Settings" subtitle={tab === 'notifications' ? 'Configure how and when Sollux alerts you' : 'Manage your account and subscription'} />

      <div className="flex border-b px-6" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        {(['account', 'notifications'] as SettingsTab[]).map(t => (
          <button
            key={t}
            onClick={() => setSearchParams({ tab: t }, { replace: true })}
            className={`text-sm py-3 px-4 border-b-2 transition-colors capitalize ${
              tab === t
                ? 'border-amber-400 text-amber-400 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'notifications' ? (
        <div className="px-6 py-5 max-w-2xl">
          <div className="card p-5 mb-4">
            <h2 className="text-sm font-semibold text-white mb-4">Alert channels</h2>
            {[
              { label: 'Email notifications', desc: 'Receive alerts and reminders to your email', id: 'email' },
              { label: 'SMS notifications', desc: 'Receive alerts via text message (Pro plan)', id: 'sms' },
              { label: 'Browser push', desc: 'Receive in-browser push notifications', id: 'push' },
            ].map(item => (
              <div key={item.id} className="flex items-center justify-between py-3 border-b border-white/8 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-100">{item.label}</p>
                  <p className="text-xs text-gray-400">{item.desc}</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" defaultChecked={item.id === 'email'} className="sr-only peer" />
                  <div className="w-9 h-5 bg-white/10 peer-checked:bg-gold-500 rounded-full transition-colors" />
                  <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
                </label>
              </div>
            ))}
          </div>

          <div className="card p-5 mb-4">
            <h2 className="text-sm font-semibold text-white mb-4">Alert types</h2>
            {[
              { label: 'Bill due reminders', desc: 'Alert when a bill is due within N days', id: 'due' },
              { label: 'Anomaly detection', desc: 'Alert when a bill is significantly above average', id: 'anomaly' },
              { label: 'Payment confirmations', desc: 'Alert when a payment is recorded', id: 'payment' },
              { label: 'Sync failures', desc: 'Alert when an account fails to sync', id: 'sync' },
            ].map(item => (
              <div key={item.id} className="flex items-center justify-between py-3 border-b border-white/8 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-100">{item.label}</p>
                  <p className="text-xs text-gray-400">{item.desc}</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" defaultChecked className="sr-only peer" />
                  <div className="w-9 h-5 bg-white/10 peer-checked:bg-gold-500 rounded-full transition-colors" />
                  <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
                </label>
              </div>
            ))}
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold text-white mb-4">Reminder timing</h2>
            <div className="flex items-center gap-3">
              <p className="text-sm text-gray-400">Send reminders</p>
              <select className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200">
                <option value="3">3 days before due</option>
                <option value="5">5 days before due</option>
                <option value="7">7 days before due</option>
              </select>
            </div>
          </div>
        </div>
      ) : (
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

        <div className="card p-5 mb-4">
          <h2 className="text-sm font-semibold text-white mb-4">Google Drive</h2>
          {driveSuccessMsg && (
            <p className="text-xs text-green-400 mb-3">{driveSuccessMsg}</p>
          )}
          {(driveStatus?.accounts || []).map(acct => (
            <div key={acct.id} className="flex items-center justify-between py-2.5 border-b border-white/8 last:border-0">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 bg-blue-500/10 rounded flex items-center justify-center text-xs text-gray-300">D</div>
                <p className="text-sm text-gray-100">{acct.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="pill pill-green">&#x2713; Connected</span>
                <button
                  className="btn text-xs text-red-400 border-red-500/30 hover:bg-red-500/10"
                  onClick={() => api.delete(`/drive/disconnect/${acct.id}`)
                    .then(() => api.get('/drive/status').then(r => setDriveStatus(r.data)))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2.5">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-blue-500/10 rounded flex items-center justify-center text-xs text-gray-300">D</div>
              <p className="text-sm text-gray-400">
                {driveStatus?.connected ? 'Add another Drive account' : 'Connect Drive to bulk-import statements from a folder'}
              </p>
            </div>
            <button
              className="btn text-xs"
              onClick={() => getDriveConnectUrl().then(r => { window.location.href = r.url; })}
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
      )}
    </div>
  );
}
