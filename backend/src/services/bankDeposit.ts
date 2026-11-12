/**
 * A bank deposit of several checks, read from the bank's "Deposit details"
 * page (screenshots or a PDF, with the checks opened so their images show).
 *
 * The bank connection only sees the deposit's total ("DEPOSIT $5,631.97"),
 * which matches no one's rent, so it was left out; the checks in it were never
 * recorded. Here each check is read — amount, the name printed on it, number,
 * memo — matched to a tenant by that name (or their payer names), and split:
 * the month's rent first, then the tenant's open utility invoices (oldest
 * first), then anything left as a utility payment — tenants pay utility
 * reimbursements on the same check as rent, so amounts alone never line up.
 * The owner reviews the split and records it (POST /api/deposits/record);
 * a recorded deposit can be undone in one stroke. The check images are not
 * kept: they carry account numbers.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../config/db';
import { askClaude, jsonIn, needsJson } from '../ai/models';
import { fileBlockForClaude } from './pdfImportService';
import { matchPayer } from './transactionMatchService';
import { rentMonthFor } from './p2pPaymentEmails';
import { planPayment, memoSaysUtilities } from './incomingRent';
import { recordRentPayment } from './rentPaymentService';
import { reimbursableItems, payInvoice, recordReimbursementPayment, deleteReimbursementPayment } from './reimbursement';
import { checkPendingWithBank } from './pendingMoney';

const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const iso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };

const PROMPT = `These are pages from a bank's website showing the details of ONE deposit of one or more checks
(screenshots or a PDF; the same deposit may span several screenshots). Return JSON only, no prose:
{
  "bank": string | null,
  "accountLast4": string | null,      // last 4 digits of the account the deposit went into, if shown; never more digits
  "postDate": "YYYY-MM-DD" | null,    // the deposit's post date
  "total": number | null,             // the deposit total
  "checkCount": number | null,        // how many checks the page says were deposited
  "checks": [{
    "index": number,                  // its number on the page ("Check 3 of 7" → 3)
    "amount": number,                 // the check amount
    "payer": string | null,           // the name printed on the check as who wrote it (top left of the check image: the account holder). Not the bank, not the payee. null when no image shows it.
    "payTo": string | null,           // the "Pay to the order of" name, if legible
    "checkNumber": string | null,     // the check's own number (top right), if legible
    "memo": string | null,            // the memo line, if any
    "checkDate": "YYYY-MM-DD" | null  // the date written on the check, if legible
  }]
}
Rules: one entry per check, listed once even if it appears in two screenshots; amounts as plain numbers;
never guess a name or number that is not legible — use null.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Reading a deposit needs the AI key (ANTHROPIC_API_KEY).'), { status: 503 });
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface ReadCheck { index: number; amount: number; payer: string | null; payTo: string | null; checkNumber: string | null; memo: string | null; checkDate: string | null }
export interface DepositRead { bank: string | null; accountLast4: string | null; postDate: string | null; total: number | null; checkCount: number | null; checks: ReadCheck[] }

/** The deposit as the model read it, cleaned: one entry per check, numbers as numbers, last 4 digits only. */
export function cleanRead(raw: any): DepositRead {
  const seen = new Set<number>();
  const checks: ReadCheck[] = [];
  for (const [i, c] of (Array.isArray(raw?.checks) ? raw.checks : []).entries()) {
    const amount = num(c?.amount);
    if (amount == null || amount <= 0) continue;
    const index = Number.isInteger(c?.index) ? c.index : i + 1;
    if (seen.has(index)) continue;
    seen.add(index);
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
    checks.push({ index, amount: r2(amount), payer: s(c.payer), payTo: s(c.payTo), checkNumber: s(c.checkNumber)?.replace(/[^\dA-Za-z-]/g, '') || null, memo: s(c.memo), checkDate: iso(c.checkDate) });
  }
  checks.sort((a, b) => a.index - b.index);
  const last4 = typeof raw?.accountLast4 === 'string' ? raw.accountLast4.replace(/\D/g, '').slice(-4) : null;
  return {
    bank: typeof raw?.bank === 'string' ? raw.bank.slice(0, 80) : null,
    accountLast4: last4 && last4.length === 4 ? last4 : null,
    postDate: iso(raw?.postDate), total: num(raw?.total), checkCount: Number.isInteger(raw?.checkCount) ? raw.checkCount : null, checks,
  };
}

/** Read the deposit from its pages (one model call for all of them). */
export async function readDepositPages(files: { buf: Buffer; name: string }[]): Promise<DepositRead> {
  const blocks = await Promise.all(files.map(f => fileBlockForClaude(f.buf, f.name)));
  const { text } = await askClaude(anthropic(), {
    label: files.map(f => f.name).join(', ').slice(0, 80), feature: 'deposit-read', maxTokens: 4000, check: needsJson,
    messages: [{ role: 'user', content: [...blocks, { type: 'text', text: PROMPT }] }],
  });
  const raw = jsonIn(text);
  if (!raw) throw Object.assign(new Error('Could not read a deposit from those pages.'), { status: 422 });
  return cleanRead(raw);
}

/** How a check splits between the month's rent and utilities: rent first, then utilities; a utilities memo the other way. */
export function splitCheck(amount: number, rentDue: number, utilitiesOwed: number, memo: string | null): { rent: number; utilities: number } {
  if (memoSaysUtilities(memo) && amount <= utilitiesOwed + 0.5) return { rent: 0, utilities: r2(amount) };
  const rent = r2(Math.min(amount, Math.max(0, rentDue)));
  return { rent, utilities: r2(amount - rent) };
}

export interface DraftCheck extends ReadCheck {
  leaseId: string | null; tenant: string | null; place: string | null; matchedBy: 'name' | 'amount' | null;
  month: string | null; rentDue: number; utilitiesOwed: number; rent: number; utilities: number;
  /** A rent payment already on record that looks like this check (left out unless the owner ticks it). */
  alreadyLogged: string | null;
  include: boolean;
}
export interface DepositDraft extends DepositRead {
  bankAccountId: string | null; checksSum: number; problems: string[];
  /** Recorded before: when, and the key to undo it. */
  recorded: { at: string; key: string } | null;
  checks: DraftCheck[];
}

const recordKey = (userId: string, bankAccountId: string, postDate: string, total: number) => `deposit-read:${userId}:${bankAccountId}:${postDate}:${Math.round(total * 100)}`;

async function owedOn(leaseId: string, userId: string, period: Date) {
  const plan = await planPayment(leaseId, userId, 0, period);
  let invoices: { id: string; outstanding: number; periodStart: string }[] = [];
  try { invoices = (await reimbursableItems(leaseId, userId)).invoices.filter(i => i.outstanding > 0.005).sort((a, b) => a.periodStart.localeCompare(b.periodStart)); } catch { /* no utility billing */ }
  return { rentDue: plan.due, invoices, utilitiesOwed: r2(invoices.reduce((s, i) => s + i.outstanding, 0)) };
}

/** The deposit matched to the owner's tenants, each check split, ready to review. */
export async function draftDeposit(userId: string, read: DepositRead): Promise<DepositDraft> {
  const banks = read.accountLast4
    ? await db.bankAccount.findMany({ where: { userId, last4: read.accountLast4, accountType: { not: 'CREDIT_CARD' }, isActive: true }, select: { id: true } })
    : [];
  const bankAccountId = banks.length === 1 ? banks[0].id : null;
  const postDate = read.postDate ?? new Date().toISOString().slice(0, 10);
  const leases = await db.lease.findMany({
    where: { status: 'ACTIVE', unit: { property: { userId } } },
    select: { id: true, rentAmount: true, unit: { select: { unitLabel: true, property: { select: { address: true, nickname: true } } } }, leaseTenants: { select: { tenant: { select: { fullName: true } } } } },
  });
  const label = (id: string) => {
    const l = leases.find(x => x.id === id);
    if (!l) return { tenant: null, place: null };
    return { tenant: l.leaseTenants.map(t => t.tenant.fullName).join(', ') || null, place: `${l.unit.property.nickname || l.unit.property.address}${l.unit.unitLabel ? ` · ${l.unit.unitLabel}` : ''}` };
  };
  // What each lease owes for a month, worked out once however many checks ask.
  const owedMemo = new Map<string, ReturnType<typeof owedOn>>();
  const owed = (leaseId: string, period: Date) => {
    const k = `${leaseId}:${period.toISOString().slice(0, 7)}`;
    if (!owedMemo.has(k)) owedMemo.set(k, owedOn(leaseId, userId, period));
    return owedMemo.get(k)!;
  };
  const checks: DraftCheck[] = [];
  for (const c of read.checks) {
    const when = new Date(`${c.checkDate ?? postDate}T00:00:00.000Z`);
    let leaseId: string | null = null, matchedBy: DraftCheck['matchedBy'] = null;
    if (c.payer) {
      const m = await matchPayer(c.payer, c.memo, userId).catch(() => null);
      if (m) { leaseId = m.leaseId; matchedBy = 'name'; }
    }
    if (!leaseId) {
      // No name on the check to go by: the one lease whose rent plus open utilities (or rent alone) is this amount.
      const hits: string[] = [];
      for (const l of leases) {
        const o = await owed(l.id, await rentMonthFor(l.id, when, c.memo));
        if (Math.abs(o.rentDue + o.utilitiesOwed - c.amount) < 0.5 || Math.abs(Number(l.rentAmount) - c.amount) < 0.5) hits.push(l.id);
      }
      if (hits.length === 1) { leaseId = hits[0]; matchedBy = 'amount'; }
    }
    let month: string | null = null, rentDue = 0, utilitiesOwed = 0, rent = 0, utilities = 0, alreadyLogged: string | null = null;
    if (leaseId) {
      const period = await rentMonthFor(leaseId, when, c.memo);
      month = period.toISOString().slice(0, 7);
      const o = await owed(leaseId, period);
      rentDue = o.rentDue; utilitiesOwed = o.utilitiesOwed;
      ({ rent, utilities } = splitCheck(c.amount, rentDue, utilitiesOwed, c.memo));
      // Logged already (by hand, or as a check on hand): a check payment of this amount, or this check's number, near the deposit.
      const near = await db.rentPayment.findFirst({
        where: {
          leaseId, method: 'CHECK',
          paidDate: { gte: new Date(new Date(`${postDate}T00:00:00Z`).getTime() - 21 * DAY), lte: new Date(new Date(`${postDate}T00:00:00Z`).getTime() + 3 * DAY) },
          OR: [{ amount: { gte: c.amount - 0.5, lte: c.amount + 0.5 } }, ...(rent > 0 ? [{ amount: { gte: rent - 0.5, lte: rent + 0.5 } }] : []), ...(c.checkNumber ? [{ notes: { contains: c.checkNumber } }] : [])],
        },
        select: { amount: true, paidDate: true },
      });
      if (near) alreadyLogged = `A ${usd(Number(near.amount))} check payment on ${near.paidDate.toISOString().slice(0, 10)} is already on record`;
    }
    checks.push({ ...c, leaseId, ...(leaseId ? label(leaseId) : { tenant: null, place: null }), matchedBy, month, rentDue, utilitiesOwed, rent, utilities, alreadyLogged, include: !!leaseId && !alreadyLogged });
  }
  const checksSum = r2(read.checks.reduce((s, c) => s + c.amount, 0));
  const problems: string[] = [];
  if (read.checkCount && read.checkCount > read.checks.length) problems.push(`Read ${read.checks.length} of the ${read.checkCount} checks — add screenshots showing the rest.`);
  if (read.total != null && Math.abs(read.total - checksSum) > 0.01 && !(read.checkCount && read.checkCount > read.checks.length)) problems.push(`The checks read add up to ${usd(checksSum)}, not the ${usd(read.total)} total — check the amounts.`);
  if (read.accountLast4 && !bankAccountId) problems.push(`No bank account ending ${read.accountLast4} is in Sollux — pick the account.`);
  let recorded: DepositDraft['recorded'] = null;
  if (bankAccountId && read.total != null) {
    const key = recordKey(userId, bankAccountId, postDate, read.total);
    const row = await db.appSetting.findUnique({ where: { key } });
    if (row) recorded = { at: (JSON.parse(row.value) as { at: string }).at, key };
  }
  return { ...read, postDate, bankAccountId, checksSum, problems, recorded, checks };
}

export interface RecordInput {
  bankAccountId: string; postDate: string; total: number;
  checks: { leaseId: string; amount: number; month: string; rent: number; utilities: number; payer?: string | null; checkNumber?: string | null; memo?: string | null }[];
}

/**
 * Records the checks the owner kept: rent for the month (method CHECK, deposited into the account on
 * the post date), utilities on the tenant's open invoices oldest first and the rest as a utility payment.
 * The bank's own lines for this deposit are marked as recorded so they are not logged again, and the
 * whole deposit can be undone (the record is kept in app_settings).
 */
export async function recordDeposit(userId: string, input: RecordInput): Promise<{ key: string; rent: number; utilities: number; checks: number }> {
  if (!(await db.bankAccount.findFirst({ where: { id: input.bankAccountId, userId }, select: { id: true } }))) throw Object.assign(new Error('Bank account not found'), { status: 404 });
  const leaseIds = [...new Set(input.checks.map(c => c.leaseId))];
  const owned = await db.lease.findMany({ where: { id: { in: leaseIds }, unit: { property: { userId } } }, select: { id: true } });
  if (owned.length !== leaseIds.length) throw Object.assign(new Error('Lease not found'), { status: 404 });
  for (const c of input.checks) {
    if (Math.abs(c.rent + c.utilities - c.amount) > 0.01 || c.rent < 0 || c.utilities < 0) throw Object.assign(new Error(`A ${usd(c.amount)} check's rent and utilities must add up to it.`), { status: 400 });
    if (!/^\d{4}-\d{2}$/.test(c.month)) throw Object.assign(new Error('Each check needs the month its rent is for.'), { status: 400 });
  }
  const key = recordKey(userId, input.bankAccountId, input.postDate, input.total);
  if (await db.appSetting.findUnique({ where: { key } })) throw Object.assign(new Error('This deposit is already recorded — undo it first to record it again.'), { status: 409 });

  const paid = new Date(`${input.postDate}T00:00:00.000Z`);
  const made = { rent: [] as string[], reimb: [] as string[] };
  let rentTotal = 0, utilTotal = 0;
  for (const c of input.checks) {
    const notes = `Check${c.checkNumber ? ` #${c.checkNumber}` : ''}${c.payer ? ` from ${c.payer}` : ''} — in the ${input.postDate} deposit${c.memo ? ` · "${c.memo}"` : ''}`.slice(0, 500);
    if (c.rent > 0.005) {
      const p = await recordRentPayment({ leaseId: c.leaseId, periodDate: new Date(`${c.month}-01T00:00:00.000Z`), amount: c.rent, paidDate: paid, method: 'CHECK' as any, bankAccountId: input.bankAccountId, notes });
      await db.rentPayment.update({ where: { id: p.id }, data: { depositedAt: paid } });
      made.rent.push(p.id); rentTotal += c.rent;
    }
    if (c.utilities > 0.005) {
      let left = r2(c.utilities);
      const { invoices } = await owedOn(c.leaseId, userId, new Date(`${c.month}-01T00:00:00.000Z`));
      for (const inv of invoices) {
        if (left <= 0.005) break;
        const take = r2(Math.min(left, inv.outstanding));
        const p = await payInvoice(inv.id, userId, { amount: take, paidAt: input.postDate, method: 'CHECK', bankAccountId: input.bankAccountId, notes });
        made.reimb.push(p.id); left = r2(left - take);
      }
      if (left > 0.005) {
        const p = await recordReimbursementPayment(c.leaseId, userId, { amount: left, paidDate: input.postDate, method: 'CHECK', bankAccountId: input.bankAccountId, notes, allocations: [], invoiceId: null });
        made.reimb.push(p.id);
      }
      utilTotal += c.utilities;
    }
  }
  // The bank's line(s) for this deposit — the total, or a check posted on its own — are recorded now, not left to be logged again.
  const amounts = [input.total, ...input.checks.map(c => c.amount)];
  const lines = await db.incomingTransaction.findMany({
    where: { userId, bankAccountId: input.bankAccountId, status: { not: 'APPLIED' }, date: { gte: new Date(paid.getTime() - 4 * DAY), lte: new Date(paid.getTime() + 4 * DAY) } },
    select: { id: true, amount: true },
  });
  const marked: string[] = [];
  for (const l of lines) if (amounts.some(a => Math.abs(Number(l.amount) - a) < 0.005)) {
    await db.incomingTransaction.update({ where: { id: l.id }, data: { status: 'APPLIED', reviewNote: `Recorded check by check from the ${input.postDate} deposit` } });
    marked.push(l.id);
  }
  await db.appSetting.create({ data: { key, value: JSON.stringify({ at: new Date().toISOString(), ...made, marked }) } });
  // A deposit of these checks entered earlier as pending: the bank has it.
  void checkPendingWithBank(userId).catch(() => 0);
  return { key, rent: r2(rentTotal), utilities: r2(utilTotal), checks: input.checks.length };
}

/** Undo a recorded deposit: its rent and utility payments go, balances are put back, the bank's lines are back for review. */
export async function undoDeposit(userId: string, key: string): Promise<number> {
  if (!key.startsWith(`deposit-read:${userId}:`)) throw Object.assign(new Error('Not found'), { status: 404 });
  const row = await db.appSetting.findUnique({ where: { key } });
  if (!row) throw Object.assign(new Error('Nothing to undo'), { status: 404 });
  const made = JSON.parse(row.value) as { rent: string[]; reimb: string[]; marked?: string[] };
  let n = 0;
  for (const id of made.rent) {
    const p = await db.rentPayment.findFirst({ where: { id, lease: { unit: { property: { userId } } } } });
    if (!p) continue;
    await db.rentPayment.delete({ where: { id } });
    const restored = Number(p.appliedToArrears) + Number(p.settledRolledRent);
    if (restored > 0) await db.lease.update({ where: { id: p.leaseId }, data: { arrearsBalance: { increment: restored } } });
    n++;
  }
  for (const id of made.reimb) { await deleteReimbursementPayment(id, userId).catch(() => null); n++; }
  if (made.marked?.length) await db.incomingTransaction.updateMany({ where: { id: { in: made.marked }, userId }, data: { status: 'UNMATCHED', reviewNote: null } });
  await db.appSetting.delete({ where: { key } });
  return n;
}
