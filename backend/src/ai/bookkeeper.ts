import Anthropic from '@anthropic-ai/sdk';
import { askClaude } from './models';
import { db } from '../config/db';
import { getPaymentPriorities } from '../services/paymentPriority';
import { watchDeadlines } from './deadlineWatcher';
import { payDayBrief } from './payDayBrief';

/**
 * The nightly bookkeeper.
 *
 * Goes over every account, bill, payment, policy and loan the owner holds
 * and raises what needs a hand: a bill overdue with no payment logged, one
 * due this week, a penalty about to land, an installment coming up, an
 * account whose bills have stopped arriving, a policy about to expire with
 * no renewal on file, a loan whose balance is only a projection, a late fee
 * the provider actually charged. Each finding is an insight with a stable
 * key, so the next run refreshes it rather than raising it twice, and clears
 * it once the condition has gone. A short plain-English digest sits on top.
 *
 * The checks are arithmetic, not a model's opinion: the figures come from
 * the same code the pages use. The model only writes the digest.
 */

const DAY = 86400000;
const money = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (d: Date | string) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const daysFromNow = (d: Date | string) => Math.round((new Date(d).getTime() - Date.now()) / DAY);

type Severity = 'INFO' | 'WARNING' | 'ALERT';
type Kind = 'ANOMALY' | 'SAVINGS' | 'REMINDER' | 'INFO' | 'OUTAGE';

export interface Finding {
  key: string;
  propertyId: string;
  utilityAccountId?: string | null;
  type: Kind;
  severity: Severity;
  title: string;
  body: string;
  recommendation?: string;
}

export async function runBookkeeperForUser(userId: string): Promise<{ raised: number; refreshed: number; cleared: number; findings: Finding[] }> {
  const findings: Finding[] = [];
  const now = new Date();

  // ── Bills: overdue, due this week, penalty imminent ─────────────────────
  const priorities = await getPaymentPriorities(userId);
  for (const p of priorities) {
    const owed = Number(p.balanceToCurrent ?? 0);
    if (owed <= 0.01) continue;
    const due = p.dueDate ? new Date(p.dueDate) : null;
    const label = `${p.providerName}${p.serviceLabel ? ` (${p.serviceLabel})` : ''} · ${p.propertyName}`;
    const fee = p.knownNextFee != null && p.knownNextFee > 0 ? ` A ${money(p.knownNextFee)} fee ${p.feeSource === 'stated_on_bill' ? 'is printed on the bill' : p.feeSource === 'your_rule' ? 'applies by your rule' : 'is what being late has cost here before'}.` : '';
    if (due && due < now) {
      const daysLate = Math.round((now.getTime() - due.getTime()) / DAY);
      findings.push({
        key: `overdue:${p.accountId}`, propertyId: p.propertyId, utilityAccountId: p.accountId,
        type: 'REMINDER', severity: 'ALERT',
        title: `${label}: ${money(owed)} overdue`,
        body: `Due ${fmt(due)}, ${daysLate} day${daysLate === 1 ? '' : 's'} ago, and no payment covering it is logged.${p.pastDue > 0 ? ` ${money(p.pastDue)} of it is carried from earlier bills.` : ''}${fee}`,
        recommendation: p.daysUntilShutoff != null && p.daysUntilShutoff <= 14 ? `Service is cut ${p.daysUntilShutoff} day${p.daysUntilShutoff === 1 ? '' : 's'} from now by your rule — pay this first.` : 'Pay it, or log the payment if it was already made.',
      });
    } else if (due && daysFromNow(due) <= 7) {
      findings.push({
        key: `due-soon:${p.accountId}`, propertyId: p.propertyId, utilityAccountId: p.accountId,
        type: 'REMINDER', severity: p.daysUntilPenalty != null && p.daysUntilPenalty <= 3 ? 'ALERT' : 'WARNING',
        title: `${label}: ${money(p.payThisMonth > 0 ? p.payThisMonth : owed)} due ${fmt(due)}`,
        body: `${daysFromNow(due)} day${daysFromNow(due) === 1 ? '' : 's'} away.${p.pastDue > 0 ? ` ${money(p.pastDue)} of the balance is carried from earlier bills.` : ''}${p.penaltyDate ? ` Penalty ${p.penaltyDateIsEstimate ? 'expected' : 'applies'} after ${fmt(p.penaltyDate)}.` : ''}${fee}`,
      });
    }
  }

  // ── Everything else, property by property ───────────────────────────────
  const properties = await db.property.findMany({
    where: { userId },
    select: {
      id: true, address: true, nickname: true,
      utilityAccounts: {
        where: { isActive: true },
        select: {
          id: true, providerName: true, serviceLabel: true, category: true, billingCadence: true, escrowLoanId: true, syncEnabled: true, createdAt: true,
          escrowLoan: { select: { lender: true } },
          statements: { orderBy: { statementDate: 'desc' }, take: 3, select: { id: true, statementDate: true, dueDate: true, amountDue: true, penaltiesFees: true, isScheduled: true, amountPaid: true, paidOverride: true } },
          payments: { where: { statementId: null, status: { in: ['PAID', 'PARTIAL'] } }, orderBy: { paymentDate: 'desc' }, take: 1, select: { paymentDate: true, amount: true } },
          insurancePolicy: { select: { id: true, policyNumber: true, expirationDate: true, effectiveDate: true, isActive: true } },
        },
      },
      loans: {
        where: { isActive: true },
        select: { id: true, lender: true, loanType: true, originalAmount: true, currentBalance: true, originationDate: true, monthlyPayment: true, interestRate: true, maturityDate: true, isPersonal: true },
      },
    },
  });

  for (const prop of properties) {
    const propName = prop.nickname || prop.address;
    for (const a of prop.utilityAccounts) {
      const label = `${a.providerName}${a.serviceLabel ? ` (${a.serviceLabel})` : ''} · ${propName}`;
      const issued = a.statements.filter(s => !(s.isScheduled && s.dueDate && s.dueDate > now));
      const latest = issued[0] ?? null;

      // A monthly account whose bills have stopped arriving.
      const monthly = a.billingCadence === 'MONTHLY' || a.billingCadence === 'BIMONTHLY';
      const staleAfter = a.billingCadence === 'BIMONTHLY' ? 75 : 45;
      if (monthly && !a.escrowLoanId && a.category !== 'INSURANCE') {
        const since = latest?.statementDate ?? a.createdAt;
        const age = Math.round((now.getTime() - new Date(since).getTime()) / DAY);
        if (age > staleAfter) {
          findings.push({
            key: `no-bill:${a.id}`, propertyId: prop.id, utilityAccountId: a.id,
            type: 'INFO', severity: 'WARNING',
            title: `${label}: no bill in ${age} days`,
            body: latest ? `The last statement on file is dated ${fmt(latest.statementDate)}. A monthly account should have had ${Math.floor(age / 30)} since.` : `No statement has ever been imported for this account.`,
            recommendation: a.syncEnabled ? 'Run Sync, or import the missing bills from the provider portal or your email.' : 'Sync is off for this account — import the bills, or turn sync back on.',
          });
        }
      }

      // A late fee the provider actually charged on the newest bill.
      if (latest && latest.penaltiesFees != null && Number(latest.penaltiesFees) > 0 && (now.getTime() - new Date(latest.statementDate).getTime()) / DAY <= 40) {
        findings.push({
          key: `late-fee:${latest.id}`, propertyId: prop.id, utilityAccountId: a.id,
          type: 'ANOMALY', severity: 'WARNING',
          title: `${label}: ${money(Number(latest.penaltiesFees))} in fees on the ${fmt(latest.statementDate)} bill`,
          body: 'The newest statement carries a penalty or late fee. Paying before the due date avoids the next one.',
        });
      }

      // A scheduled installment coming up this week.
      const upcoming = a.statements.find(s => s.isScheduled && s.dueDate && s.dueDate > now && daysFromNow(s.dueDate) <= 7 && s.paidOverride !== 'PAID' && Number(s.amountPaid ?? 0) < Number(s.amountDue ?? 0) - 0.01);
      if (upcoming && !a.escrowLoanId) {
        findings.push({
          key: `installment:${upcoming.id}`, propertyId: prop.id, utilityAccountId: a.id,
          type: 'REMINDER', severity: 'INFO',
          title: `${label}: ${money(Number(upcoming.amountDue ?? 0))} installment on ${fmt(upcoming.dueDate!)}`,
          body: 'From the policy\'s payment schedule. If it is on auto-pay nothing needs doing; the carrier\'s statement will replace this row when imported.',
        });
      }

      // A policy about to run out with no renewal on file.
      const pol = a.insurancePolicy;
      if (pol?.isActive && pol.expirationDate) {
        const left = daysFromNow(pol.expirationDate);
        if (left <= 30) {
          findings.push({
            key: `policy-expiring:${pol.id}`, propertyId: prop.id, utilityAccountId: a.id,
            type: 'REMINDER', severity: left < 0 ? 'ALERT' : 'WARNING',
            title: `${label}: policy ${pol.policyNumber ?? ''} ${left < 0 ? `expired ${fmt(pol.expirationDate)}` : `expires in ${left} day${left === 1 ? '' : 's'}`}`.replace(/\s+/g, ' '),
            body: left < 0 ? 'No renewal has been imported. If the policy renewed, import the renewal offer or declarations page so the new term is on file.' : 'Import the renewal offer or declarations page when it arrives so the new term, premium and payment schedule are on file.',
          });
        }
      }
    }

    // A loan whose balance is only a projection.
    for (const l of prop.loans) {
      const original = l.originalAmount != null ? Number(l.originalAmount) : null;
      const balance = l.currentBalance != null ? Number(l.currentBalance) : null;
      const months = l.originationDate ? (now.getTime() - new Date(l.originationDate).getTime()) / (30.44 * DAY) : 0;
      const untouched = balance != null && original != null && Math.abs(balance - original) < 0.01 && months > 1.5;
      if (balance == null || untouched) {
        findings.push({
          key: `loan-balance:${l.id}`, propertyId: prop.id,
          type: 'INFO', severity: 'INFO',
          title: `${l.lender} · ${propName}: balance ${balance == null ? 'not entered' : 'still equals the original amount'}`,
          body: balance == null ? 'The loans page projects a balance from the schedule until a real one is entered.' : `It reads ${money(balance)} of ${money(original!)} after ${Math.floor(months)} months of payments, which cannot be right; the loans page shows a projection instead.`,
          recommendation: 'Open the loan and set the current balance from the latest statement.',
        });
      }
    }
  }

  // ── Deadlines: balloons, rate resets, tax installments, citations, leases
  findings.push(...await watchDeadlines(userId, now));
  // ── This week's payments, and how to make each one
  findings.push(...await payDayBrief(userId).catch(() => []));

  // ── Write: refresh, raise, clear ─────────────────────────────────────────
  const propertyIds = properties.map(p => p.id);
  const open = await db.aIInsight.findMany({
    where: { propertyId: { in: propertyIds }, dedupeKey: { not: null }, isDismissed: false },
    select: { id: true, dedupeKey: true, severity: true, title: true, body: true },
  });
  const openByKey = new Map(open.map(i => [i.dedupeKey!, i]));
  let raised = 0, refreshed = 0, cleared = 0;
  for (const f of findings) {
    const existing = openByKey.get(f.key);
    if (existing) {
      const changed = existing.severity !== f.severity || existing.title !== f.title || existing.body !== f.body;
      await db.aIInsight.update({
        where: { id: existing.id },
        data: { severity: f.severity, title: f.title, body: f.body, recommendation: f.recommendation ?? null, ...(changed && existing.severity !== f.severity ? { isRead: false } : {}) },
      });
      refreshed++;
      openByKey.delete(f.key);
    } else {
      await db.aIInsight.create({
        data: { propertyId: f.propertyId, utilityAccountId: f.utilityAccountId ?? null, insightType: f.type, severity: f.severity, title: f.title, body: f.body, recommendation: f.recommendation ?? null, dedupeKey: f.key },
      });
      raised++;
    }
  }
  // Whatever the bookkeeper raised before and did not find tonight has been dealt with.
  for (const [key, stale] of openByKey) {
    if (key.startsWith('digest:')) continue;
    await db.aIInsight.update({ where: { id: stale.id }, data: { isDismissed: true } });
    cleared++;
  }

  await writeDigest(userId, propertyIds, findings);
  return { raised, refreshed, cleared, findings };
}

/** One short note on top: what tonight found, in plain English. */
async function writeDigest(userId: string, propertyIds: string[], findings: Finding[]): Promise<void> {
  if (propertyIds.length === 0) return;
  const key = `digest:${userId}`;
  const counts = { ALERT: 0, WARNING: 0, INFO: 0 } as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;
  const existing = await db.aIInsight.findFirst({ where: { dedupeKey: key, isDismissed: false }, select: { id: true } });

  if (findings.length === 0) {
    const body = 'Nothing needs a hand tonight: no bill overdue or due this week, no penalty coming, every monthly account has a recent bill, no policy expiring, no loan maturing.';
    await upsertDigest(existing?.id, propertyIds[0]!, key, 'Bookkeeper: all clear', body);
    return;
  }

  const fallback = [
    `${findings.length} item${findings.length === 1 ? '' : 's'}: ${counts.ALERT} urgent, ${counts.WARNING} to watch, ${counts.INFO} for the record.`,
    ...findings.filter(f => f.severity === 'ALERT').slice(0, 5).map(f => `• ${f.title}`),
  ].join('\n');
  let body = fallback;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const { text: digest } = await askClaude(anthropic, {
        label: 'bookkeeper digest', maxTokens: 400,
        messages: [{
          role: 'user',
          content: `You are the nightly bookkeeper for a small real-estate portfolio. Write a short digest (4–8 sentences, plain prose, no headers or bullet points, no preamble) of what needs the owner's attention, most urgent first, in dollars and dates. Do not invent anything not in the list. Findings:\n${findings.map(f => `- [${f.severity}] ${f.title}. ${f.body}`).join('\n')}`,
        }],
      });
      if (digest) body = digest;
    } catch (err) {
      console.warn('[Bookkeeper] digest fell back to the plain summary:', err instanceof Error ? err.message : err);
    }
  }
  await upsertDigest(existing?.id, propertyIds[0]!, key, `Bookkeeper: ${counts.ALERT} urgent, ${counts.WARNING} to watch`, body);
}

async function upsertDigest(id: string | undefined, propertyId: string, key: string, title: string, body: string) {
  if (id) {
    await db.aIInsight.update({ where: { id }, data: { title, body, severity: 'INFO', isRead: false } });
  } else {
    await db.aIInsight.create({ data: { propertyId, insightType: 'INFO', severity: 'INFO', title, body, dedupeKey: key } });
  }
}

/** Every owner, for the nightly run. */
export async function runBookkeeperForEveryone(): Promise<void> {
  const users = await db.user.findMany({ select: { id: true } });
  for (const u of users) {
    try {
      const r = await runBookkeeperForUser(u.id);
      console.log(`[Bookkeeper] user ${u.id}: ${r.raised} raised, ${r.refreshed} refreshed, ${r.cleared} cleared`);
    } catch (err) {
      console.error(`[Bookkeeper] user ${u.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
