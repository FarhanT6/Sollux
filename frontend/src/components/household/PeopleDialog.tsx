import { useEffect, useState } from 'react';
import {
  getHousehold, addHouseholdMember, renameHouseholdMember, removeHouseholdMember, assignToMember,
  getCreditCards, getLoans, getPersonalUtilities, type HouseholdMemberT,
} from '../../api/client';
import { describeApiError } from '../../lib/apiError';

type Item = { kind: 'card' | 'loan' | 'bill'; id: string; label: string; memberId: string | null };

/**
 * The people in the household and what is whose: add, rename or remove a
 * person, and set who each credit card, personal loan and personal bill
 * belongs to. Removing a person keeps their cards and loans; they go back
 * to the owner.
 */
export default function PeopleDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [members, setMembers] = useState<HouseholdMemberT[] | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const [h, cards, loans, bills] = await Promise.all([getHousehold(), getCreditCards(), getLoans({ isPersonal: true }), getPersonalUtilities().catch(() => [])]);
      setMembers(h.members);
      setItems([
        ...cards.cards.filter(c => c.status !== 'CLOSED').map(c => ({ kind: 'card' as const, id: c.id, label: `${c.name}${c.last4 ? ` ••${c.last4}` : ''}`, memberId: c.memberId ?? null })),
        ...loans.map((l: any) => ({ kind: 'loan' as const, id: l.id, label: `${l.lender}${l.loanType ? ` · ${String(l.loanType).replace('_', ' ').toLowerCase()}` : ''}`, memberId: l.memberId ?? null })),
        ...bills.map((b: any) => ({ kind: 'bill' as const, id: b.id, label: `${b.providerName}${b.accountNumber ? ` ··${String(b.accountNumber).slice(-4)}` : ''}`, memberId: b.memberId ?? null })),
      ]);
    } catch (e) { setErr(describeApiError(e, 'Could not load the household.')); }
  };
  useEffect(() => { void load(); }, []);

  async function run(fn: () => Promise<unknown>) {
    setErr('');
    try { await fn(); await load(); onChanged(); } catch (e) { setErr(describeApiError(e, 'That did not save.')); }
  }
  const assign = (it: Item, memberId: string | null) => {
    setItems(cur => cur?.map(x => (x.kind === it.kind && x.id === it.id ? { ...x, memberId } : x)) ?? null);
    void run(() => assignToMember(it.kind, it.id, memberId));
  };

  const section = (kind: Item['kind'], title: string) => {
    const rows = (items ?? []).filter(i => i.kind === kind);
    if (!rows.length) return null;
    return (
      <div>
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{title}</p>
        <div className="divide-y divide-white/5">
          {rows.map(it => (
            <div key={it.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="text-sm text-gray-200 truncate">{it.label}</span>
              <select value={it.memberId ?? ''} onChange={e => assign(it, e.target.value || null)} className="input-dark text-xs">
                <option value="">Me</option>
                {(members ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-xl" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <div className="p-5 pb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">People in your household</p>
            <p className="text-xs text-gray-500 mt-0.5">Each person gets their own overview of their cards, loans and bills, and Everyone shows them all together.</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">✕</button>
        </div>
        <div className="px-5 pb-5 overflow-y-auto space-y-5">
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between py-1"><span className="text-sm text-gray-200">Me</span><span className="text-xs text-gray-600">you — anything not given to someone else</span></div>
            {(members ?? []).map(m => (
              <div key={m.id} className="flex items-center justify-between gap-2 py-1">
                {editing?.id === m.id ? (
                  <form className="flex gap-2 flex-1" onSubmit={e => { e.preventDefault(); const n = editing.name.trim(); if (n) void run(() => renameHouseholdMember(m.id, n)); setEditing(null); }}>
                    <input autoFocus value={editing.name} onChange={e => setEditing({ id: m.id, name: e.target.value })} className="input-dark text-sm flex-1" />
                    <button className="btn text-xs">Save</button>
                  </form>
                ) : (
                  <>
                    <span className="text-sm text-gray-200">{m.name} <span className="text-xs text-gray-600">{[m.linked?.cards ? `${m.linked.cards} card${m.linked.cards === 1 ? '' : 's'}` : null, m.linked?.loans ? `${m.linked.loans} loan${m.linked.loans === 1 ? '' : 's'}` : null, m.linked?.bills ? `${m.linked.bills} bill${m.linked.bills === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}</span></span>
                    <span className="flex gap-2">
                      <button onClick={() => setEditing({ id: m.id, name: m.name })} className="text-xs text-gray-500 hover:text-gray-300">Rename</button>
                      <button onClick={() => { if (confirm(`Remove ${m.name}? Their cards, loans and bills stay, as yours.`)) void run(() => removeHouseholdMember(m.id)); }} className="text-xs text-gray-500 hover:text-red-400">Remove</button>
                    </span>
                  </>
                )}
              </div>
            ))}
            <form className="flex gap-2 pt-1" onSubmit={e => { e.preventDefault(); const n = name.trim(); if (!n) return; setName(''); void run(() => addHouseholdMember(n)); }}>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Add a person (e.g. Dad)" className="input-dark text-sm flex-1" />
              <button className="btn btn-primary text-xs px-3" disabled={!name.trim()}>Add</button>
            </form>
          </div>

          {(members?.length ?? 0) > 0 && (
            <div className="space-y-4">
              <p className="text-sm font-medium text-gray-200">Whose is what</p>
              {items == null ? <p className="text-xs text-gray-500">Loading…</p> : <>
                {section('card', 'Credit cards')}
                {section('loan', 'Personal loans')}
                {section('bill', 'Personal bills')}
                {items.length === 0 && <p className="text-xs text-gray-500">No cards, personal loans or personal bills yet.</p>}
              </>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
