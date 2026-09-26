/**
 * The leak and anomaly detective. For every metered account — water, sewer,
 * gas, electric — it compares the newest bill's usage per day with the
 * account's own baseline (the median of the bills before it, and the same
 * season last year when there is one) and asks what else is true:
 *
 *  - is the unit vacant? A vacant unit's usage should be near zero, so any
 *    real use is a leak, a running toilet, a squatter or a meter misread;
 *  - has it stayed high for two bills in a row? Leaks persist, one-offs don't;
 *  - is it seasonal? A winter gas spike that matches last winter is not news.
 *
 * The arithmetic is here; Claude only turns the findings into a likely cause
 * and what to check. Findings go through the bookkeeper (one per account,
 * refreshed nightly, cleared when usage comes back down).
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';
import { askClaude, jsonIn } from './models';
import type { Finding } from './bookkeeper';

const DAY = 86400000;
const METERED = ['WATER', 'SEWER', 'GAS', 'ELECTRIC'] as const;

export interface Reading { date: Date; perDay: number; unit: string; basis: 'usage' | 'dollars' }

export interface Assessment {
  ratio: number;              // newest ÷ baseline
  baseline: number;           // per day
  current: number;            // per day
  lastYear: number | null;    // same season last year, per day
  persistent: boolean;        // the bill before was high too
  seasonal: boolean;          // last year was about as high
  unit: string;
  basis: 'usage' | 'dollars';
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Readings newest first. Null when there is too little history or nothing unusual. */
export function assessUsage(readings: Reading[], vacant: boolean): Assessment | null {
  if (readings.length < (vacant ? 1 : 4)) return null;
  const [cur, prev, ...older] = readings;
  const history = [prev, ...older].filter(Boolean).slice(0, 6).map(r => r.perDay);
  const baseline = history.length ? median(history) : 0;
  // Same season last year: a reading 11–13 months back.
  const ly = readings.find(r => { const m = (cur.date.getTime() - r.date.getTime()) / (30.44 * DAY); return m >= 11 && m <= 13; });
  const lastYear = ly?.perDay ?? null;
  const ratio = baseline > 0 ? cur.perDay / baseline : cur.perDay > 0 ? Infinity : 1;
  const seasonal = lastYear != null && lastYear > 0 && cur.perDay / lastYear < 1.25;
  const persistent = !!prev && older.length > 0 && baseline > 0 && prev.perDay / median(older.slice(0, 6).map(r => r.perDay)) >= 1.4;
  // A vacant unit using anything like its occupied baseline is a finding on its own.
  // Only on metered usage: a vacant unit still pays its fixed service charge in dollars.
  const vacantUse = vacant && cur.basis === 'usage' && cur.perDay > 0 && (baseline === 0 || cur.perDay >= baseline * 0.5);
  if (!vacantUse && (ratio < 1.5 || seasonal)) return null;
  return { ratio, baseline, current: cur.perDay, lastYear, persistent, seasonal, unit: cur.unit, basis: cur.basis };
}

function readingsFrom(statements: { statementDate: Date; billingPeriodStart: Date | null; billingPeriodEnd: Date | null; usageValue: unknown; usageUnit: string | null; amountDue: unknown; rawDataJson: unknown }[]): Reading[] {
  // Usage when every recent bill has it; otherwise this period's charges in dollars.
  const withUsage = statements.filter(s => s.usageValue != null && Number(s.usageValue) > 0);
  const useUsage = withUsage.length >= Math.min(4, statements.length);
  const out: Reading[] = [];
  for (const s of statements) {
    const days = s.billingPeriodStart && s.billingPeriodEnd ? Math.max(1, Math.round((s.billingPeriodEnd.getTime() - s.billingPeriodStart.getTime()) / DAY) + 1) : 30;
    const raw = (s.rawDataJson ?? {}) as { currentCharges?: number | null };
    const value = useUsage ? (s.usageValue != null ? Number(s.usageValue) : null) : (raw.currentCharges ?? (s.amountDue != null ? Number(s.amountDue) : null));
    if (value == null || value < 0) continue;
    out.push({ date: s.billingPeriodEnd ?? s.statementDate, perDay: value / days, unit: useUsage ? (s.usageUnit ?? 'units') : 'dollars', basis: useUsage ? 'usage' : 'dollars' });
  }
  return out;
}

const WHAT_TO_CHECK: Record<string, string[]> = {
  WATER: ['Read the meter with every tap off; if the leak indicator turns, water is escaping', 'Toilets — a flapper that never seals is the usual cause', 'Irrigation timers and broken sprinkler heads', 'Water heater relief valve and hose bibs'],
  SEWER: ['Sewer follows water use — check the water account for the same spike'],
  GAS: ['Water heater and furnace pilot and thermostat settings', 'Smell for gas near appliances; if you do, call the gas company first'],
  ELECTRIC: ['Space heaters, pool or spa pumps, EV charging', 'A tenant\'s new appliance, or a neighbour tapping an outdoor outlet'],
};

export async function detectLeaks(userId: string): Promise<Finding[]> {
  const accounts = await db.utilityAccount.findMany({
    where: { isActive: true, category: { in: [...METERED] }, property: { userId } },
    select: {
      id: true, providerName: true, category: true, unitId: true, serviceLabel: true,
      property: { select: { id: true, address: true, nickname: true, units: { select: { id: true, leases: { where: { status: 'ACTIVE' }, select: { id: true } } } } } },
      statements: {
        where: { isScheduled: false }, orderBy: { statementDate: 'desc' }, take: 14,
        select: { id: true, statementDate: true, billingPeriodStart: true, billingPeriodEnd: true, usageValue: true, usageUnit: true, amountDue: true, rawDataJson: true },
      },
    },
  });
  const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  const out: Finding[] = [];

  for (const a of accounts) {
    const newest = a.statements[0];
    if (!newest || Date.now() - newest.statementDate.getTime() > 75 * DAY) continue;
    const units = a.property.units;
    const vacant = a.unitId
      ? !units.find(u => u.id === a.unitId)?.leases.length
      : units.length > 0 && units.every(u => u.leases.length === 0);
    const found = assessUsage(readingsFrom(a.statements), vacant);
    if (!found) continue;

    const place = `${a.providerName}${a.serviceLabel ? ` (${a.serviceLabel})` : ''} · ${a.property.nickname || a.property.address}`;
    const x = found.ratio === Infinity ? 'from nothing' : `${found.ratio.toFixed(1)}×`;
    const unitWord = found.basis === 'usage' ? `${found.unit}/day` : '$/day';
    const title = vacant && found.basis === 'usage' ? `${place}: ${found.current.toFixed(2)} ${unitWord} used on a vacant unit` : `${place}: ${x} its usual ${found.basis === 'usage' ? 'usage' : 'charges'}${found.persistent ? ', two bills running' : ''}`;
    let body = `Newest bill: ${found.current.toFixed(2)} ${unitWord} against a usual ${found.baseline.toFixed(2)}${found.lastYear != null ? ` (same season last year: ${found.lastYear.toFixed(2)})` : ''}.${vacant ? ' No active lease on this unit, so usage should be close to zero.' : ''}${found.persistent ? ' The bill before was high too — a leak stays until it is fixed.' : ''}`;
    let recommendation = (WHAT_TO_CHECK[a.category] ?? []).join('; ');

    if (client) {
      try {
        const { text } = await askClaude(client, {
          label: 'leak detective', maxTokens: 600, check: t => (jsonIn(t)?.likelyCause ? null : 'no cause'),
          messages: [{ role: 'user', content: `A rental property's ${a.category.toLowerCase()} account shows unusual use. Facts (computed, do not change the numbers): ${JSON.stringify({ category: a.category, provider: a.providerName, vacant, currentPerDay: found.current, usualPerDay: found.baseline, sameSeasonLastYearPerDay: found.lastYear, ratio: found.ratio === Infinity ? null : found.ratio, highTwoBillsRunning: found.persistent, measuredIn: unitWord })}\n\nReturn ONLY JSON: {"likelyCause": "one sentence, the most likely explanation", "check": ["up to 4 short things for the owner to check, most likely first"]}` }],
        });
        const d = jsonIn(text);
        if (d?.likelyCause) {
          body += ` Likely: ${String(d.likelyCause)}`;
          if (Array.isArray(d.check) && d.check.length) recommendation = d.check.slice(0, 4).map(String).join('; ');
        }
      } catch { /* the computed finding stands on its own */ }
    }
    out.push({
      key: `leak:${a.id}`, propertyId: a.property.id, utilityAccountId: a.id, type: 'ANOMALY',
      severity: vacant || found.persistent || found.ratio >= 2.5 ? 'ALERT' : 'WARNING',
      title, body, recommendation,
    });
  }
  return out;
}
