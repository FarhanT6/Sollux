import { useState } from 'react';
import { createUtility } from '../../api/client';
import { Modal, Field, Input, Select } from '../ui';
import type { UtilityCategory } from '../../types';
import { CATEGORY_LABELS } from '../../types';

const PROVIDER_SLUGS: Record<string, string> = {
  'SDGE': 'sdge',
  'SoCal Gas': 'socal-gas',
  'IID': 'iid',
  'WM': 'wm',
  'Republic Services': 'republic-services',
  'Cox': 'cox',
  'FPL': 'fpl',
  'Spectrum': 'spectrum',
  'T-Mobile': 'tmobile',
  'AT&T': 'att',
  'Brevard County Water': 'brevard-water',
  'Vista Irrigation District': 'vid',
  'City of Oceanside': 'city-oceanside',
  'City of Imperial': 'city-imperial',
  'City of El Centro': 'city-el-centro',
  'City of Brawley': 'city-brawley',
  'Service Finance (Solar)': 'service-finance',
  'Bamboo Insurance': 'bamboo-insurance',
  'Safeco Insurance': 'safeco',
  'Other': 'gmail-fallback',
};

// Providers with a live scraper (vs gmail-fallback only)
const SCRAPER_SUPPORTED = new Set(['sdge', 'socal-gas', 'iid', 'wm', 'republic-services', 'cox', 'fpl', 'city-brawley']);

interface Props {
  propertyId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export default function AddUtilityModal({ propertyId, onClose, onSuccess }: Props) {
  const [step, setStep] = useState<'provider' | 'credentials'>('provider');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    providerName: '',
    providerSlug: '',
    category: 'ELECTRIC' as UtilityCategory,
    accountNumber: '',
    username: '',
    password: '',
    loginUrl: '',
    notes: '',
    useGmail: false,
  });

  function set(key: string, value: string | boolean) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function selectProvider(name: string) {
    set('providerName', name);
    set('providerSlug', PROVIDER_SLUGS[name] || 'gmail-fallback');
  }

  async function handleSubmit() {
    if (!form.providerName) { setError('Please select a provider'); return; }
    if (!form.useGmail && !form.accountNumber.trim()) { setError('Account number is required'); return; }
    setLoading(true);
    setError('');
    try {
      await createUtility({
        propertyId,
        providerName: form.providerName,
        providerSlug: form.useGmail ? 'gmail-fallback' : form.providerSlug,
        category: form.category,
        accountNumber: form.accountNumber || undefined,
        username: form.useGmail ? undefined : form.username,
        password: form.useGmail ? undefined : form.password,
        loginUrl: form.loginUrl || undefined,
        notes: form.notes || undefined,
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to add utility account');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title="Add utility account"
      onClose={onClose}
      footer={
        <>
          <button className="btn text-xs" onClick={onClose}>Cancel</button>
          {step === 'provider'
            ? <button className="btn btn-primary text-xs" onClick={() => setStep('credentials')} disabled={!form.providerName}>
                Next →
              </button>
            : <button className="btn btn-primary text-xs" onClick={handleSubmit} disabled={loading}>
                {loading ? 'Connecting…' : 'Connect account'}
              </button>
          }
        </>
      }
    >
      {step === 'provider' ? (
        <div>
          <Field label="Category" htmlFor="category" required>
            <Select
              id="category"
              value={form.category}
              onChange={e => set('category', e.target.value)}
            >
              {(Object.keys(CATEGORY_LABELS) as UtilityCategory[]).map(c => (
                <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
              ))}
            </Select>
          </Field>

          <Field label="Provider" required>
            <div className="grid grid-cols-3 gap-1.5 max-h-52 overflow-y-auto pr-1">
              {Object.keys(PROVIDER_SLUGS).map(name => {
                const slug = PROVIDER_SLUGS[name];
                const hasLiveScraper = SCRAPER_SUPPORTED.has(slug);
                return (
                  <button
                    key={name}
                    onClick={() => selectProvider(name)}
                    className={`text-xs px-2 py-2 rounded-lg border text-left transition-colors relative ${
                      form.providerName === name
                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 font-medium'
                        : 'bg-white/5 border-white/10 text-gray-300 hover:border-white/20'
                    }`}
                  >
                    {name}
                    {hasLiveScraper && (
                      <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-500" title="Auto-sync supported" />
                    )}
                  </button>
                );
              })}
            </div>
          </Field>

          {form.providerName && (
            <p className="text-xs text-gray-400 mt-1">
              Selected: <span className="font-medium text-gray-700">{form.providerName}</span>
            </p>
          )}
        </div>
      ) : (
        <div>
          <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <p className="text-xs font-medium text-amber-300">{form.providerName}</p>
            <p className="text-xs text-amber-400">Your credentials are encrypted with AES-256 before storage and never logged.</p>
          </div>

          {/* Gmail option */}
          <div className="mb-4 p-3 bg-white/5 rounded-lg flex items-start gap-2">
            <input
              type="checkbox"
              id="use-gmail"
              checked={form.useGmail}
              onChange={e => set('useGmail', e.target.checked)}
              className="mt-0.5"
            />
            <label htmlFor="use-gmail" className="text-xs text-gray-300 cursor-pointer">
              <span className="font-medium">Use Gmail instead</span> — Parse bills from your email automatically (no password needed)
            </label>
          </div>

          {!form.useGmail && (
            <>
              <Field label="Username / Email" htmlFor="username" required>
                <Input
                  id="username"
                  type="text"
                  autoComplete="off"
                  value={form.username}
                  onChange={e => set('username', e.target.value)}
                  placeholder="Your login email or username"
                />
              </Field>
              <Field label="Password" htmlFor="password" required>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={e => set('password', e.target.value)}
                  placeholder="Your account password"
                />
              </Field>
            </>
          )}

          <Field
            label="Account number"
            htmlFor="acct"
            required
            hint={
              form.providerSlug === 'wm'
                ? 'Enter full WM account number, e.g. 8-92846-35002 — used to match this property when one login has multiple service addresses'
                : 'Found on your bill or provider portal — used to match this property when one login covers multiple accounts'
            }
          >
            <Input
              id="acct"
              value={form.accountNumber}
              onChange={e => set('accountNumber', e.target.value)}
              placeholder={form.providerSlug === 'wm' ? 'e.g. 8-92846-35002' : 'Full account number from your bill'}
            />
          </Field>

          <Field label="Notes (optional)" htmlFor="notes">
            <Input
              id="notes"
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="e.g. 1017 Trash, Laundry Room meter"
            />
          </Field>

          {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
