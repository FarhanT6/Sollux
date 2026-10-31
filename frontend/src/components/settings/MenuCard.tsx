import { useState } from 'react';
import { useModules, saveHidden, type ModuleKey } from '../../lib/modules';
import { NAV } from '../layout/AppLayout';
import { toast } from '../../lib/toast';

/**
 * Which pages are in the menu. A page taken out is only out of the menu:
 * its records stay, it still opens from a link, and ticking it brings it
 * back. For the pages not in use yet — set aside, not deleted.
 */
export default function MenuCard() {
  const { hidden, has, isOwner, loaded } = useModules();
  const [busy, setBusy] = useState(false);
  if (!loaded) return null;
  const pages = NAV.filter(n => has((n as { module?: ModuleKey }).module) && !(n as { phoneOnly?: boolean }).phoneOnly);
  const toggle = async (to: string) => {
    const next = new Set(hidden);
    if (next.has(to)) next.delete(to); else next.add(to);
    setBusy(true);
    try { await saveHidden([...next]); toast(next.has(to) ? 'Taken out of the menu — nothing was deleted.' : 'Back in the menu.'); }
    catch { toast('Could not change the menu.', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="card p-5 mb-4">
      <p className="text-sm text-white font-medium">Menu</p>
      <p className="text-xs text-gray-500 mt-1 mb-4">Untick a page you are not using yet. It leaves the menu, keeps everything in it, and comes back when you tick it again.</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
        {pages.map(n => (
          <label key={n.to} className="flex items-center gap-2 cursor-pointer text-sm text-gray-200">
            <input type="checkbox" className="accent-amber-500" checked={!hidden.has(n.to)} disabled={!isOwner || busy} onChange={() => void toggle(n.to)} />
            {n.label}
          </label>
        ))}
      </div>
      {!isOwner && <p className="text-xs text-gray-500 mt-3">Only the account owner can change the menu.</p>}
    </div>
  );
}
