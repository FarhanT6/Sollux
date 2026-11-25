/**
 * "Which month it pays", the same in every Log payment form (rent, loans): each month with what
 * it still owes, so the owner sees which month is open before picking, and the form fills the
 * amount from the month picked. Two months ahead to a year back, newest first.
 */
import { fmtMoney } from '../../lib/money';

export interface MonthFacts { due: number; owed: number }

export const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** Two months ahead of `center` to twelve back (YYYY-MM), newest first. */
export function monthsAround(center: string, ahead = 2, back = 12): string[] {
  const [y, m] = center.split('-').map(Number);
  const out: string[] = [];
  for (let i = ahead; i >= -back; i--) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** What a month says beside its name: paid, partly paid, owed, or nothing due. */
export function monthStatus(f: MonthFacts | null | undefined): string {
  if (!f) return '';
  if (f.due <= 0.005) return ' · nothing due';
  if (f.owed <= 0.005) return ' · paid';
  if (f.owed < f.due - 0.005) return ` · ${fmtMoney(f.owed)} of ${fmtMoney(f.due)} left`;
  return ` · ${fmtMoney(f.owed)} owed`;
}

export default function MonthPicker({ months, value, onChange, facts, thisMonth, disabled, className = 'input-dark text-sm w-full' }: {
  months: string[]; value: string; onChange: (m: string) => void;
  facts?: (m: string) => MonthFacts | null | undefined; thisMonth?: string; disabled?: boolean; className?: string;
}) {
  // A month opened on (an older payment being edited) stays listed.
  const list = months.includes(value) || !/^\d{4}-\d{2}$/.test(value) ? months : [...months, value].sort().reverse();
  return (
    <select className={className} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
      {list.map(m => (
        <option key={m} value={m}>{monthLabel(m)}{m === thisMonth ? ' (this month)' : ''}{monthStatus(facts?.(m))}</option>
      ))}
    </select>
  );
}
