/**
 * The account's optional modules (backend lib/modules.ts): bills and
 * expenses are always on; tenants & operations, books & reporting and
 * personal & vault are turned on in Settings. Read once per page load and
 * shared, so the sidebar, the phone's More screen and Settings agree.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';

export type ModuleKey = 'operations' | 'books' | 'personal';
export const MODULE_INFO: { key: ModuleKey; title: string; body: string }[] = [
  { key: 'operations', title: 'Tenants & operations', body: 'Leases and rent roll, rent collection and the tenant portal, repairs, notices, legal, compliance and projects.' },
  { key: 'books', title: 'Books & reporting', body: 'P&L, cash flow, budget, bank reconciliation, loans, expenses and taxes.' },
  { key: 'personal', title: 'Personal & vault', body: 'Personal finances, credit cards and the encrypted vault.' },
];

interface State { modules: Set<ModuleKey>; isAdmin: boolean; isOwner: boolean; loaded: boolean }
// Until it loads, everything shows: nothing a user relies on flickers away.
let state: State = { modules: new Set(['operations', 'books', 'personal']), isAdmin: false, isOwner: false, loaded: false };
const listeners = new Set<(s: State) => void>();
let loading: Promise<void> | null = null;
const publish = (s: State) => { state = s; listeners.forEach(l => l(s)); };

function load(): Promise<void> {
  loading ??= api.get<{ modules: ModuleKey[]; isAdmin: boolean; isOwner: boolean }>('/account/modules')
    .then(r => publish({ modules: new Set(r.data.modules), isAdmin: r.data.isAdmin, isOwner: r.data.isOwner, loaded: true }))
    .catch(() => publish({ ...state, loaded: true }));
  return loading;
}

export function useModules(): State & { has: (m?: ModuleKey) => boolean } {
  const [s, setS] = useState(state);
  useEffect(() => { listeners.add(setS); void load(); return () => { listeners.delete(setS); }; }, []);
  return { ...s, has: (m?: ModuleKey) => !m || s.modules.has(m) };
}

export async function saveModules(modules: ModuleKey[]): Promise<void> {
  const r = await api.put<{ modules: ModuleKey[] }>('/account/modules', { modules });
  publish({ ...state, modules: new Set(r.data.modules) });
}
