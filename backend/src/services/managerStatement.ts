/**
 * Reading a property manager's monthly statement — the one that nets rent
 * collected against the management fee, repairs, and sometimes a loan
 * payment, and sends the owner what is left. The owner uploads the PDF (or
 * a photo); the lines are read, each is matched to a property, a lease, a
 * loan (lib/managerStatementMatch.ts), and rent already on record for that
 * lease and month is flagged so it is not counted twice. Nothing is saved
 * here: the owner reviews the draft and applies it (routes/reconciliation).
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';
import { askClaude, jsonIn, needsJson } from '../ai/models';
import { fileBlockForClaude } from './pdfImportService';
import { best, categoryFor, leaseScore, lenderScore, propertyScore, words, type LineKind } from '../lib/managerStatementMatch';

const PROMPT = `This is a property manager's statement to an owner (an owner statement): rent the manager collected, minus what the manager paid or deducted, and what was sent to the owner.

Return ONLY a JSON object, no commentary:
{
  "manager": string or null — the management company or person issuing it,
  "periodStart": "YYYY-MM-DD" or null, "periodEnd": "YYYY-MM-DD" or null, "statementDate": "YYYY-MM-DD" or null,
  "beginningBalance": number or null, "endingBalance": number or null,
  "lines": [{
    "date": "YYYY-MM-DD" or null,
    "property": string or null — the property the line belongs to, as printed (street address or name),
    "payee": string or null — the tenant (for rent), vendor (for a repair), lender (for a loan payment), as printed,
    "unit": string or null,
    "description": string — as printed,
    "kind": "RENT" | "MANAGEMENT_FEE" | "REPAIR" | "UTILITY" | "LOAN_PAYMENT" | "OTHER_EXPENSE" | "OWNER_DRAW" | "OTHER",
    "amount": number — positive,
    "direction": "IN" (money collected for the owner) | "OUT" (money paid out or deducted, including what was sent to the owner)
  }]
}

Rules:
- One line per transaction as printed; do not merge or invent lines, and leave out subtotals and running balances.
- RENT is rent (and late fees or other charges) collected from a tenant. MANAGEMENT_FEE is the manager's own fee or commission. REPAIR is maintenance, repairs, cleaning, landscaping, a handyman. UTILITY is a utility bill the manager paid. LOAN_PAYMENT is a mortgage or loan payment made from the owner's money. OWNER_DRAW is money sent to the owner (owner distribution, owner payment, draw). OTHER_EXPENSE is any other cost; OTHER anything else (a deposit held, a reserve).
- A statement covering several properties names each line's property; carry the section's property onto its lines.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Reading statements needs the AI key (ANTHROPIC_API_KEY).'), { status: 503 });
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface DraftLine {
  date: string | null; description: string; kind: LineKind; amount: number; direction: 'IN' | 'OUT';
  propertyHint: string | null; payee: string | null; unit: string | null;
  /** Matched records; null when the owner has to choose. */
  propertyId: string | null; leaseId: string | null; loanId: string | null;
  /** The expense category a cost line is filed under. */
  category: string | null;
  /** Rent already recorded for this lease in this month, close to this amount: left out unless the owner says otherwise. */
  alreadyRecorded: boolean;
  include: boolean;
}

export interface StatementDraft {
  manager: string | null; periodStart: string | null; periodEnd: string | null; statementDate: string | null;
  beginningBalance: number | null; endingBalance: number | null;
  profileId: string | null; lines: DraftLine[];
  totals: { in: number; out: number; toOwner: number };
}

const iso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const KINDS: LineKind[] = ['RENT', 'MANAGEMENT_FEE', 'REPAIR', 'UTILITY', 'LOAN_PAYMENT', 'OTHER_EXPENSE', 'OWNER_DRAW', 'OTHER'];

export async function readManagerStatement(userId: string, file: Buffer, name: string): Promise<StatementDraft> {
  const { text } = await askClaude(anthropic(), {
    label: name, feature: 'manager-statement', maxTokens: 8000, check: needsJson,
    messages: [{ role: 'user', content: [await fileBlockForClaude(file, name), { type: 'text', text: PROMPT }] }],
  });
  const raw = jsonIn(text);
  if (!raw || !Array.isArray(raw.lines)) throw Object.assign(new Error(`Could not read a statement from ${name}.`), { status: 422 });

  const [properties, leases, loans, profiles] = await Promise.all([
    db.property.findMany({ where: { userId }, select: { id: true, address: true, nickname: true } }),
    db.lease.findMany({
      where: { unit: { property: { userId } } },
      select: { id: true, status: true, startDate: true, unit: { select: { unitLabel: true, propertyId: true } }, leaseTenants: { select: { tenant: { select: { fullName: true } } } } },
    }),
    db.loan.findMany({ where: { userId, isActive: true }, select: { id: true, lender: true, propertyId: true } }),
    db.reconciliationProfile.findMany({ where: { userId }, select: { id: true, name: true, propertyId: true, loanIds: true } }),
  ]);
  const manager = typeof raw.manager === 'string' ? raw.manager.trim() : null;
  const profile = manager ? best(profiles, p => (words(p.name).length && words(p.name).every(w => words(manager).includes(w)) ? 2 : 0)) : null;

  const lines: DraftLine[] = [];
  for (const l of raw.lines as any[]) {
    const amount = Math.abs(Number(l?.amount));
    if (!(amount > 0)) continue;
    const kind: LineKind = KINDS.includes(l?.kind) ? l.kind : 'OTHER';
    const propertyHint = typeof l?.property === 'string' ? l.property : null;
    const payee = typeof l?.payee === 'string' ? l.payee : null;
    const unit = typeof l?.unit === 'string' ? l.unit : null;
    // The property: as printed, else the manager's own property, else the only one a lease or loan points at.
    let property = propertyHint ? best(properties, p => propertyScore(propertyHint, p)) : null;
    if (!property && profile?.propertyId) property = properties.find(p => p.id === profile.propertyId) ?? null;

    let leaseId: string | null = null, loanId: string | null = null;
    if (kind === 'RENT') {
      const pool = leases.filter(x => !property || x.unit.propertyId === property.id)
        .map(x => ({ id: x.id, propertyId: x.unit.propertyId, active: x.status === 'ACTIVE', unitLabel: x.unit.unitLabel, tenantNames: x.leaseTenants.map(t => t.tenant.fullName) }));
      const hint = [payee, unit].filter(Boolean).join(' ');
      // An active lease before an ended one with the same tenant.
      const m = best(pool, x => leaseScore(hint, x) * 2 + (x.active ? 1 : 0))
        ?? (property && pool.filter(x => x.active).length === 1 ? pool.find(x => x.active)! : null);
      if (m) { leaseId = m.id; if (!property) property = properties.find(p => p.id === m.propertyId) ?? null; }
    }
    if (kind === 'LOAN_PAYMENT') {
      const mine = profile ? (profile.loanIds as string[] | null) ?? [] : [];
      const pool = loans.filter(x => !property || x.propertyId === property.id);
      const m = best(pool, x => lenderScore([payee, l?.description].filter(Boolean).join(' '), x.lender) * 2 + (mine.includes(x.id) ? 1 : 0))
        ?? (pool.length === 1 ? pool[0] : null);
      if (m) { loanId = m.id; if (!property && m.propertyId) property = properties.find(p => p.id === m.propertyId) ?? null; }
    }
    lines.push({
      date: iso(l?.date), description: String(l?.description ?? '').slice(0, 300), kind, amount,
      direction: l?.direction === 'IN' ? 'IN' : 'OUT', propertyHint, payee, unit,
      propertyId: property?.id ?? null, leaseId, loanId, category: categoryFor(kind),
      alreadyRecorded: false, include: kind !== 'OWNER_DRAW' && kind !== 'OTHER',
    });
  }

  // Rent already on record for the lease that month (a tenant portal payment, a deposit matched earlier).
  const rentLines = lines.filter(x => x.kind === 'RENT' && x.leaseId);
  if (rentLines.length) {
    const fallback = iso(raw.periodEnd) ?? iso(raw.statementDate);
    const recorded = await db.rentPayment.findMany({
      where: { leaseId: { in: rentLines.map(x => x.leaseId!) } },
      select: { leaseId: true, amount: true, periodDate: true, paidDate: true },
    });
    for (const x of rentLines) {
      const month = (x.date ?? fallback)?.slice(0, 7);
      if (!month) continue;
      x.alreadyRecorded = recorded.some(r => r.leaseId === x.leaseId
        && (r.periodDate.toISOString().slice(0, 7) === month || r.paidDate.toISOString().slice(0, 7) === month)
        && Math.abs(Number(r.amount) - x.amount) <= Math.max(1, x.amount * 0.02));
      if (x.alreadyRecorded) x.include = false;
    }
  }

  const sum = (f: (x: DraftLine) => boolean) => Math.round(lines.filter(f).reduce((t, x) => t + x.amount, 0) * 100) / 100;
  return {
    manager, periodStart: iso(raw.periodStart), periodEnd: iso(raw.periodEnd), statementDate: iso(raw.statementDate),
    beginningBalance: Number.isFinite(Number(raw.beginningBalance)) && raw.beginningBalance != null ? Number(raw.beginningBalance) : null,
    endingBalance: Number.isFinite(Number(raw.endingBalance)) && raw.endingBalance != null ? Number(raw.endingBalance) : null,
    profileId: profile?.id ?? null, lines,
    totals: { in: sum(x => x.direction === 'IN'), out: sum(x => x.direction === 'OUT' && x.kind !== 'OWNER_DRAW'), toOwner: sum(x => x.kind === 'OWNER_DRAW') },
  };
}
