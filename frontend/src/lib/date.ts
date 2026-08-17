import { format } from 'date-fns';

// Format a DATE-ONLY value (lease dates, due dates, statement/effective dates)
// by its calendar date, NOT the viewer's local timezone.
//
// The backend stores these as midnight UTC (e.g. "2025-05-01T00:00:00Z").
// Formatting that instant with the local timezone shifts it a day backward
// for anyone west of UTC (May 1 → Apr 30 in US timezones). We take just the
// YYYY-MM-DD portion and rebuild a local Date from those parts, so the
// calendar date the user entered is what shows — no shift.
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
