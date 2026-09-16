import { format } from 'date-fns';

// Format a DATE-ONLY value (lease dates, due dates, statement/effective dates)
// by its calendar date, NOT the viewer's local timezone.
//
// The backend stores these as midnight UTC (e.g. "2025-05-01T00:00:00Z").
// Formatting that instant with the local timezone shifts it a day backward
// for anyone west of UTC (May 1 → Apr 30 in US timezones). We take just the
// YYYY-MM-DD portion and rebuild a local Date from those parts, so the
// calendar date the user entered is what shows — no shift.
/**
 * The month a bill is filed under: the later of the month it was issued and
 * the month it covers. A bill sent after its service month (CR&R's Sep 1
 * bill for August) files under the issue month; one sent ahead of it
 * (Blueshield's Aug 17 bill for Sep 1–30) files under the month it covers.
 * Either way a bill sits in the latest month it touches.
 */
export function billMonthLabel(s: { statementDate?: string | null; billingPeriodEnd?: string | null } | null | undefined): string {
  if (!s) return '—';
  const key = (d?: string | null) => (d ? d.slice(0, 7) : '');
  const issued = key(s.statementDate);
  const covers = key(s.billingPeriodEnd);
  const pick = issued && covers ? (covers > issued ? s.billingPeriodEnd : s.statementDate) : (s.statementDate || s.billingPeriodEnd);
  return fmtDate(pick, 'MMM yyyy');
}

export function fmtDate(d?: string | Date | null, fmtStr = 'MMM d, yyyy'): string {
  if (!d) return '—';
  const iso = typeof d === 'string' ? d : d.toISOString();
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, day] = m;
    return format(new Date(Number(y), Number(mo) - 1, Number(day)), fmtStr);
  }
  // Fallback for non-ISO inputs
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? '—' : format(parsed, fmtStr);
}

// "2026-08" for a DATE-ONLY value, for grouping or comparing by month.
// Same hazard as fmtDate: reading a midnight-UTC value with local getMonth()
// lands in the *previous* month for anyone west of UTC whenever the value is
// the 1st, which is exactly how rent period dates are stored.
export function monthKey(d?: string | Date | null): string | null {
  if (!d) return null;
  const iso = typeof d === 'string' ? d : d.toISOString();
  const m = iso.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

// Calendar year of a DATE-ONLY value. Same hazard as monthKey: a statement
// dated Jan 1 read with local getFullYear() lands in the previous year for
// anyone west of UTC, dropping it out of year filters and YTD totals.
export function yearOf(d?: string | Date | null): number | null {
  if (!d) return null;
  const iso = typeof d === 'string' ? d : d.toISOString();
  const m = iso.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

// "2026-08" for a local Date — the counterpart to monthKey for "right now".
export function localMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Today, in Pacific time. `new Date().toISOString()` is UTC, which after
 * 5pm on the West Coast is already tomorrow — so every "paid date" and "as
 * of" field defaulted to a day that had not happened yet. The portfolio is
 * run from California, so dates a person is about to confirm are pinned
 * to Pacific time whatever device or timezone they happen to be on.
 */
export const HOME_TIME_ZONE = 'America/Los_Angeles';

export function todayISO(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: HOME_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** This month in Pacific time, as YYYY-MM. */
export function thisMonthISO(): string {
  return todayISO().slice(0, 7);
}
