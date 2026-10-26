import { useState } from 'react';
import { useModules, saveModules, MODULE_INFO, type ModuleKey } from '../../lib/modules';
import { toast } from '../../lib/toast';

/**
 * Which parts of Sollux this account uses. Bills and expenses are always on;
 * each module adds its pages to the menu. Turning one off hides its pages —
 * nothing is deleted, and turning it back on brings everything back.
 */
export default function ModulesCard() {
  const { modules, isOwner, loaded } = useModules();
  const [busy, setBusy] = useState<ModuleKey | null>(null);
  if (!loaded) return null;
  const toggle = async (key: ModuleKey) => {
    const next = new Set(modules);
    if (next.has(key)) next.delete(key); else next.add(key);
    setBusy(key);
    try { await saveModules([...next]); toast(next.has(key) ? 'Turned on.' : 'Turned off — nothing was deleted.'); }
    catch { toast('Could not change modules.', 'error'); }
    finally { setBusy(null); }
  };
  return (
    <div className="card p-5 mb-4">
      <p className="text-sm text-white font-medium">Modules</p>
      <p className="text-xs text-gray-500 mt-1 mb-4">Bills and expenses are always on. Turn on what else you want Sollux to run; turning a module off only hides it.</p>
      <div className="space-y-3">
        {MODULE_INFO.map(m => {
          const on = modules.has(m.key);
          return (
            <label key={m.key} className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" className="mt-1 accent-amber-500" checked={on} disabled={!isOwner || busy != null} onChange={() => void toggle(m.key)} />
              <span>
                <span className="text-sm text-gray-200">{m.title}</span>
                <span className="block text-xs text-gray-500">{m.body}</span>
              </span>
            </label>
          );
        })}
      </div>
      {!isOwner && <p className="text-xs text-gray-500 mt-3">Only the account owner can change modules.</p>}
    </div>
  );
}
