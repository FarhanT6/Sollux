import { useEffect, useState } from 'react';
import { getCardDuplicates, mergeCardGroup, type CardDuplicateGroup } from '../../api/client';
import { describeApiError } from '../../lib/apiError';

/**
 * "These cards look like one account": cards filed more than once (a statement
 * with no card number made a new card each time), merged in one click into the
 * card with the newest statement. Shown on Personal's Overview and Credit cards.
 */
export default function DuplicateCards({ cardIds, onMerged }: { /** The cards on screen: only groups touching them are shown. */ cardIds: string[]; onMerged: () => void }) {
  const [groups, setGroups] = useState<CardDuplicateGroup[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const key = cardIds.join(',');
  useEffect(() => { void getCardDuplicates().then(setGroups).catch(() => {}); }, [key]);
  const shown = groups.filter(g => g.cardIds.some(id => cardIds.includes(id)));
  if (!shown.length) return null;
  return (
    <div className="card p-4 mb-5 space-y-3" style={{ borderColor: 'rgba(245,166,35,0.35)' }}>
      {shown.map(g => {
        const keep = g.names[0];
        return (
          <div key={g.keepId} className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[260px]">
              <p className="text-sm text-white">{g.cardIds.length} cards look like one account: <span className="font-medium">{[...new Set(g.names)].join(' / ')}</span></p>
              <p className="text-xs text-gray-500">They have {g.reason}. Merging keeps “{keep}” (it has the newest statement) and moves every statement, transaction and payment onto it; a statement on two of them is kept once.{g.differentOwners ? ' They are set to different people — check Belongs to on the card afterwards.' : ''}</p>
            </div>
            <button disabled={busy === g.keepId} className="btn btn-primary text-xs disabled:opacity-50" onClick={async () => {
              setBusy(g.keepId); setErr('');
              try { await mergeCardGroup(g.keepId, g.cardIds); setGroups(gs => gs.filter(x => x.keepId !== g.keepId)); onMerged(); }
              catch (e) { setErr(describeApiError(e, 'Could not merge them.')); }
              finally { setBusy(null); }
            }}>{busy === g.keepId ? 'Merging…' : `Merge into one`}</button>
          </div>
        );
      })}
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
