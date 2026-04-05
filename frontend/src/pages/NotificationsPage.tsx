import { PageHeader } from '../components/ui';

export default function NotificationsPage() {
  return (
    <div>
      <PageHeader title="Notification settings" subtitle="Configure how and when Sollux alerts you" />
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
    </div>
  );
}
