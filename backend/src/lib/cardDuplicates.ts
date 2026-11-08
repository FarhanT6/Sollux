/**
 * Cards that are one account filed more than once. A statement that prints no
 * card number (PayPal Credit, Apple Card) used to make a new card each time it
 * came in, and the same card can be added by hand and from a statement.
 *
 * Grouped when they share a last four, or when none of them has one and their
 * names are the same card (cardNameKey: "PayPal Credit (Synchrony Bank)" and
 * "PayPal Credit" are one). Two cards with different last fours are never one,
 * whatever their names. The card kept is the one with the newest statement.
 * Pure; exported for tests.
 */
import { cardNameKey } from '../services/cardIntake';

export interface DupCard {
  id: string; name: string; last4: string | null; status: string; memberId: string | null; createdAt: Date | string;
  statements: { closingDate: Date | string; newBalance: unknown; fromEmail?: boolean }[];
}
export interface DupGroup { keepId: string; cardIds: string[]; reason: string; differentOwners: boolean }

const day = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const sameName = (a: string, b: string) => { const x = cardNameKey(a), y = cardNameKey(b); return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x)); };

export function duplicateGroups(cards: DupCard[]): DupGroup[] {
  const open = cards.filter(c => c.status !== 'CLOSED');
  const groups: DupCard[][] = [];
  const used = new Set<string>();
  for (const c of open) {
    if (used.has(c.id)) continue;
    const g = open.filter(o => !used.has(o.id) && (o.id === c.id || (c.last4 ? o.last4 === c.last4 : !o.last4 && sameName(o.name, c.name))));
    if (g.length > 1) { g.forEach(x => used.add(x.id)); groups.push(g); }
  }
  return groups.map(g => {
    const newest = (c: DupCard) => Math.max(0, ...c.statements.filter(s => !s.fromEmail).map(s => Date.parse(day(s.closingDate))));
    const keep = [...g].sort((a, b) => newest(b) - newest(a) || Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt)))[0];
    // Evidence: the same statement on two of them.
    const keys = g.map(c => new Set(c.statements.map(s => `${day(s.closingDate)}|${Number(s.newBalance).toFixed(2)}`)));
    const shared = g.length > 1 ? [...keys[0]].find(k => keys.slice(1).some(s => s.has(k))) : undefined;
    const reason = g[0].last4 ? `the same card number ••${g[0].last4}`
      : shared ? `the same name and the same statement (${shared.split('|')[0]}, $${shared.split('|')[1]})`
      : 'the same name, and their statements print no card number';
    return { keepId: keep.id, cardIds: [keep.id, ...g.filter(c => c.id !== keep.id).map(c => c.id)], reason, differentOwners: new Set(g.map(c => c.memberId ?? 'me')).size > 1 };
  });
}
