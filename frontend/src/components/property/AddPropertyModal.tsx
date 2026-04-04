import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createProperty } from '../../api/client';
import { Modal, Field, Input, Select } from '../ui';
import type { PropertyType } from '../../types';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

interface Props {
  onClose: () => void;
}

export default function AddPropertyModal({ onClose }: Props) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    nickname: '',
    address: '',
    city: '',
    state: 'CA',
    zip: '',
    type: 'RENTAL' as PropertyType,
  });

  function set(key: string, value: string) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  async function handleSubmit() {
    if (!form.address || !form.city || !form.zip) {
      setError('Address, city, and ZIP are required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const property = await createProperty(form);
      onClose();
      navigate(`/properties/${property.id}`);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to create property');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title="Add property"
      onClose={onClose}
      footer={
        <>
          <button className="btn text-xs" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary text-xs" onClick={handleSubmit} disabled={loading}>
            {loading ? 'Creating…' : 'Create property'}
          </button>
        </>
      }
    >
      <Field label="Nickname (optional)" htmlFor="nickname" hint="E.g. 'Vista Verde Home', 'Hunsaker Rentals'">
        <Input
          id="nickname"
          value={form.nickname}
          onChange={e => set('nickname', e.target.value)}
          placeholder="Optional short name"
        />
      </Field>

      <Field label="Property type" htmlFor="type" required>
        <Select id="type" value={form.type} onChange={e => set('type', e.target.value)}>
          <option value="PRIMARY">Primary home</option>
          <option value="RENTAL">Rental</option>
          <option value="INVESTMENT">Investment</option>
          <option value="COMMERCIAL">Commercial</option>
        </Select>
      </Field>

      <Field label="Street address" htmlFor="address" required>
        <Input
          id="address"
          value={form.address}
          onChange={e => set('address', e.target.value)}
          placeholder="4349 Vista Verde Way"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="City" htmlFor="city" required>
          <Input
            id="city"
            value={form.city}
            onChange={e => set('city', e.target.value)}
            placeholder="Oceanside"
          />
        </Field>
        <Field label="State" htmlFor="state" required>
          <Select id="state" value={form.state} onChange={e => set('state', e.target.value)}>
            {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
      </div>

      <Field label="ZIP code" htmlFor="zip" required>
        <Input
          id="zip"
          value={form.zip}
          onChange={e => set('zip', e.target.value)}
          placeholder="92056"
          maxLength={10}
        />
      </Field>

      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </Modal>
  );
}
