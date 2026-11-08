import { useEffect, useState } from 'react';
import { getHousehold, assignToMember, type HouseholdMemberT } from '../../api/client';

let cached: Promise<HouseholdMemberT[]> | null = null;
/** The household, fetched once per page load. */
export const householdMembers = () => (cached ??= getHousehold().then(h => h.members).catch(() => { cached = null; return []; }));
export const forgetHousehold = () => { cached = null; };

/**
 * "Belongs to" on a card, personal loan or personal bill: whose it is in the
 * household. Shown only once there are people besides the owner.
 */
export default function BelongsTo({ kind, id, memberId, onChanged, className }: {
  kind: 'card' | 'loan' | 'expense' | 'bill'; id: string; memberId?: string | null; onChanged?: () => void; className?: string;
}) {
  const [members, setMembers] = useState<HouseholdMemberT[]>([]);
  const [value, setValue] = useState(memberId ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { void householdMembers().then(setMembers); }, []);
  useEffect(() => { setValue(memberId ?? ''); }, [memberId]);
  if (!members.length) return null;
  return (
    <label className={`inline-flex items-center gap-1.5 text-xs text-gray-500 ${className ?? ''}`}>
      Belongs to
      <select value={value} disabled={saving} className="input-dark text-xs py-0.5"
        onChange={async e => {
          const v = e.target.value; setValue(v); setSaving(true);
          try { await assignToMember(kind, id, v || null); onChanged?.(); } finally { setSaving(false); }
        }}>
        <option value="">Me</option>
        {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </label>
  );
}
