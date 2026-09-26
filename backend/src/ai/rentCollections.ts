/**
 * The rent collections assistant. Each night it finds every active lease
 * whose rent for this month is late past its grace days and drafts a
 * reminder for the owner to send — a short text and an email:
 *
 *  - a few days late: a friendly reminder of the amount and how to pay;
 *  - more than a week late: firmer, naming any late fee in the lease and
 *    that a 3-day notice to pay rent or quit comes next.
 *
 * Claude writes the wording from the facts (never inventing amounts); a
 * plain template stands in if it cannot. Nothing is sent — the owner copies
 * it or opens it in their own email or messages app and marks it sent. One
 * draft per lease, month and stage, so a night's rerun never duplicates.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';
import { askClaude, jsonIn } from './models';

const DAY = 86400000;
const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface LateLease {
  leaseId: string; tenant: string; firstName: string; email: string | null; phone: string | null; unit: string; property: string;
  rent: number; paid: number; owed: number; arrears: number; dueDate: Date; daysLate: number; lateFee: number | null;
}

/** Leases whose rent this month is late past grace. `now` is injectable for tests. */
export async function lateLeases(userId: string, now = new Date()): Promise<LateLease[]> {
  const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
  const leases = await db.lease.findMany({
    where: { status: 'ACTIVE', unit: { property: { userId } } },
    include: {
      leaseTenants: { where: { isPrimary: true }, include: { tenant: true }, take: 1 },
      unit: { select: { unitLabel: true, property: { select: { address: true, nickname: true } } } },
      rentPayments: { where: { periodDate: { gte: monthStart, lt: monthEnd } }, select: { amount: true } },
    },
  });
  const out: LateLease[] = [];
  for (const l of leases) {
    const rent = Number(l.rentAmount) - Number(l.section8Amount ?? 0);
    if (rent <= 0) continue;
    const paid = l.rentPayments.reduce((s, p) => s + Number(p.amount), 0);
    const owed = Math.round((rent - paid) * 100) / 100;
    if (owed <= 1) continue;
    const dueDay = l.rentDueDay ?? 1;
    const dueDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), Math.min(dueDay, 28)));
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const daysLate = Math.floor((today - dueDate.getTime()) / DAY);
    if (daysLate <= (l.lateFeeGraceDays ?? 3)) continue;
    const t = l.leaseTenants[0]?.tenant;
    const fee = l.lateFeeAmount != null ? Number(l.lateFeeAmount) : l.lateFeePercent != null ? Math.round(rent * l.lateFeePercent) / 100 : null;
    out.push({
      leaseId: l.id, tenant: t?.fullName ?? 'Tenant', firstName: (t?.fullName ?? 'there').split(/\s+/)[0], email: t?.email ?? null, phone: t?.phone ?? null,
      unit: l.unit.unitLabel, property: l.unit.property.nickname || l.unit.property.address,
      rent, paid, owed, arrears: Number(l.arrearsBalance ?? 0), dueDate, daysLate, lateFee: fee,
    });
  }
  return out;
}

function template(l: LateLease, firm: boolean, pay: string, from: string) {
  const due = l.dueDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const sms = firm
    ? `Hi ${l.firstName}, rent of ${money(l.owed)} for ${l.unit} was due ${due} and is now ${l.daysLate} days late.${l.lateFee ? ` A ${money(l.lateFee)} late fee applies under the lease.` : ''} Please pay today${pay ? ` (${pay})` : ''}; if it isn't received I'll need to serve a 3-day notice. — ${from}`
    : `Hi ${l.firstName}, a reminder that rent of ${money(l.owed)} for ${l.unit} was due ${due}.${pay ? ` You can pay by ${pay}.` : ''} Let me know if anything's come up. — ${from}`;
  return {
    subject: firm ? `Rent past due — ${l.unit}` : `Rent reminder — ${l.unit}`,
    body: `Hi ${l.firstName},\n\n${firm
      ? `Rent of ${money(l.owed)} for ${l.unit} at ${l.property} was due on ${due} and is now ${l.daysLate} days late.${l.lateFee ? ` Under the lease a late fee of ${money(l.lateFee)} applies.` : ''} Please pay the full amount today. If it has not been received, the next step is a 3-day notice to pay rent or quit.`
      : `This is a friendly reminder that rent of ${money(l.owed)} for ${l.unit} at ${l.property} was due on ${due}. If you've already sent it, thank you — please disregard this.`}${pay ? `\n\nHow to pay: ${pay}` : ''}\n\nIf something has come up, please reply and let me know.\n\nThank you,\n${from}`,
    sms,
  };
}

export async function draftRentReminders(userId: string, now = new Date()): Promise<{ drafted: number; late: number }> {
  const late = await lateLeases(userId, now);
  if (!late.length) return { drafted: 0, late: 0 };
  const recipient = await db.paymentRecipient.findUnique({ where: { userId } });
  const from = recipient?.name ?? 'Management';
  const pay = [recipient?.name ? `Zelle or check payable to ${recipient.name}` : null, recipient?.phone ? `Zelle ${recipient.phone}` : recipient?.email ? `Zelle ${recipient.email}` : null, recipient?.address ? `mail to ${recipient.address}` : null].filter(Boolean).join('; ');
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  let drafted = 0;

  for (const l of late) {
    const firm = l.daysLate > 7;
    const kind = firm ? 'FIRM' : 'REMINDER';
    const dedupeKey = `rent:${l.leaseId}:${month}:${kind}`;
    if (await db.messageDraft.findUnique({ where: { dedupeKey }, select: { id: true } })) continue;

    let msg = template(l, firm, pay, from);
    if (client) {
      try {
        const facts = {
          tenantFirstName: l.firstName, unit: l.unit, property: l.property, amountOwedThisMonth: l.owed, monthlyRent: l.rent, paidSoFar: l.paid,
          dueDate: l.dueDate.toISOString().slice(0, 10), daysLate: l.daysLate, lateFeeInLease: l.lateFee, earlierArrears: l.arrears > 0 ? l.arrears : null,
          howToPay: pay || null, signOff: from, stage: firm ? 'firm: past grace, mention the late fee if any and that a 3-day notice to pay rent or quit is the next step' : 'friendly first reminder; allow that it may already be on its way',
        };
        const { text } = await askClaude(client, {
          label: 'rent reminder', maxTokens: 900, check: t => (jsonIn(t)?.body ? null : 'no draft'),
          messages: [{ role: 'user', content: `Draft a rent reminder from a small landlord to a tenant, in plain, warm, direct first-person language. Use only these facts; never invent an amount, date, fee or threat not listed. No legal advice.\n\nFacts: ${JSON.stringify(facts)}\n\nReturn ONLY JSON: {"subject": "email subject", "body": "the email, with line breaks", "sms": "a text message under 320 characters"}` }],
        });
        const d = jsonIn(text);
        if (d?.body) msg = { subject: String(d.subject || msg.subject), body: String(d.body), sms: d.sms ? String(d.sms) : msg.sms };
      } catch (err) {
        console.warn('[RentCollections] template used:', err instanceof Error ? err.message : err);
      }
    }
    await db.messageDraft.create({
      data: { userId, leaseId: l.leaseId, kind, toName: l.tenant, toEmail: l.email, toPhone: l.phone, subject: msg.subject, body: msg.body, sms: msg.sms, amountDue: l.owed, dedupeKey },
    });
    // A firm reminder supersedes this month's friendly one if it was never sent.
    if (firm) await db.messageDraft.updateMany({ where: { dedupeKey: `rent:${l.leaseId}:${month}:REMINDER`, status: 'DRAFT' }, data: { status: 'DISMISSED' } });
    drafted++;
  }
  return { drafted, late: late.length };
}
