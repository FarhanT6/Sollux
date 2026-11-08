import { useEffect, useState } from 'react';
import { getHousehold, assignToMember, type HouseholdMemberT, type HouseholdT } from '../../api/client';

let cached: Promise<HouseholdT | null> | null = null;
/** The household, fetched once per page load. */
export const household = () => (cached ??= getHousehold().catch(() => { cached = null; return null; }));
export const householdMembers = () => household().then(h => h?.members ?? []);
export const forgetHousehold = () => { cached = null; };

/**
 * The name to show for whose something is: "Me" is whoever is signed in. For
 * the owner that is anything with no person; for a person with their own
 * login it is theirs, and the owner's things show under the owner's first name.
 */
export function whoLabel(h: Pick<HouseholdT, 'members' | 'ownerName' | 'viewerMemberId'> | null | undefined, memberId: string | null | undefined): string {
  if (!memberId) return h?.viewerMemberId ? (h.ownerName.split(/\s+/)[0] || 'Owner') : 'Me';
  if (h?.viewerMemberId === memberId) return 'Me';
  return h?.members.find(m => m.id === memberId)?.name ?? '?';
}

/**
 * "Belongs to" on a card, personal loan or personal bill: whose it is in the
 * household. Shown only once there are people besides the owner.
 */
export default function BelongsTo({ kind, id, memberId, onChanged, className }: {
  kind: 'card' | 'loan' | 'expense' | 'bill'; id: string; memberId?: string | null; onChanged?: () => void; className?: string;
}) {
  const [h, setH] = useState<HouseholdT | null>(null);
  const members: HouseholdMemberT[] = h?.members ?? [];
  const [value, setValue] = useState(memberId ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { void household().then(setH); }, []);
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
        <option value="">{whoLabel(h, null)}</option>
        {members.map(m => <option key={m.id} value={m.id}>{whoLabel(h, m.id)}</option>)}
      </select>
    </label>
  );
}
