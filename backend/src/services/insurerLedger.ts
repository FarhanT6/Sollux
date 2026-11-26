/**
 * Line an insurance account up with the insurer's own records. An insurer billed in installments
 * (AmTrust) keeps two tables on its website: every installment and fee it invoiced, with dates
 * ("Policy Installments"), and every payment it received ("Payments Made"). Its bills reach Sollux
 * from several places — emails, uploads, saved pages, the payment schedule — and each read a
 * little differently: an overdue installment counted again on the next invoice as its own charge,
 * the same installment filed twice, a payment logged twice. One AmTrust policy read $3,943.50
 * billed and $3,093.80 paid for a year whose records say $2,509.00 and $2,509.00.
 *
 * The owner uploads those two pages (screenshots or a PDF); one model call reads them; the plan
 * shows, for each installment, the bill on file it matches (or that one will be added), what it
 * will charge, carry and total, and which bills and payments on file the records do not have — and
 * nothing changes until the owner applies it. Every bill is then: the installment, plus the fees
 * invoiced with it, plus the per-installment fee when the owner says one is charged; carried, the
 * records' billed-to-date before it less paid-to-date before it. A fee is on the next invoice when it
 * was still owed then, else with the installment it was charged on. A payment on file matched to one
 * of the records' takes its date and amount, anything above that kept as a processing fee. Payments are the records' own (one on file under another date or at the
 * invoice's figure is that payment, corrected), left to pay the oldest bills first (lib/paidState.ts).
 */
import Anthropic from '@anthropic-ai/sdk';
import { Prisma } from '@prisma/client';
import { db } from '../config/db';
import { askClaude, jsonIn, needsJson } from '../ai/models';
import { fileBlockForClaude } from './pdfImportService';

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const isoDay = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`; }
  return null;
};
const at = (d: string) => new Date(`${d}T12:00:00Z`);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export interface LedgerRead {
  policyNumber: string | null;
  /** The installments invoiced (Downpayment, "Installment 3 of 9"), on their invoice dates. */
  installments: { label: string; date: string; amount: number }[];
  /** Fees invoiced among them (Late Fee, Reinstatement Fee), on their own dates. */
  fees: { label: string; date: string; amount: number }[];
  /** Payments received ("Payments Made"), any status but returned or failed. */
  payments: { date: string; amount: number; status: string | null }[];
}

const PROMPT = `These are pages from an insurance company's website for one policy billed in installments: a table of the installments and fees it invoiced ("Policy Installments": Description, Amount, Invoice Date) and a table of payments it received ("Payments Made": Payment Date, Description, Amount, Date Entered, Status). Read every row of both tables exactly as printed. Return JSON only:
{"policyNumber": "string or null",
 "installments": [{"label": "Downpayment | Installment 1 of 9 | ...", "date": "YYYY-MM-DD (its invoice date)", "amount": n}],
 "fees": [{"label": "Late Fee | Reinstatement Fee | ...", "date": "YYYY-MM-DD", "amount": n}],
 "payments": [{"date": "YYYY-MM-DD (the payment date)", "amount": n, "status": "Completed | Pending | ..."}]}
A fee row printed among the installments goes in fees, never installments. Leave out total rows ("Total Estimated Premium"). Amounts as plain numbers.`;

/** The tables as the model read them, cleaned: dated, positive, in date order; returned payments left out. */
export function cleanLedger(raw: any): LedgerRead {
  const rows = (v: unknown) => (Array.isArray(v) ? v : []) as any[];
  const installments = rows(raw?.installments)
    .map(r => ({ label: String(r?.label ?? 'Installment').slice(0, 60), date: isoDay(r?.date), amount: num(r?.amount) }))
    .filter((r): r is { label: string; date: string; amount: number } => !!r.date && r.amount != null && r.amount > 0 && !/total/i.test(r.label))
    .sort((a, b) => a.date.localeCompare(b.date));
  const fees = rows(raw?.fees)
    .map(r => ({ label: String(r?.label ?? 'Fee').slice(0, 60), date: isoDay(r?.date), amount: num(r?.amount) }))
    .filter((r): r is { label: string; date: string; amount: number } => !!r.date && r.amount != null && r.amount !== 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const payments = rows(raw?.payments)
    .map(r => ({ date: isoDay(r?.date), amount: num(r?.amount), status: r?.status ? String(r.status).slice(0, 30) : null }))
    .filter((r): r is { date: string; amount: number; status: string | null } => !!r.date && r.amount != null && r.amount > 0 && !/return|reject|fail|reverse|void|nsf/i.test(r.status ?? ''))
    .sort((a, b) => a.date.localeCompare(b.date));
  // A fee printed in the installments table and read twice is one fee.
  const seenFee = new Set<string>();
  const feesOnce = fees.filter(f => { const k = `${f.date}|${f.amount}|${f.label.toLowerCase()}`; if (seenFee.has(k)) return false; seenFee.add(k); return true; });
  return { policyNumber: raw?.policyNumber ? String(raw.policyNumber).slice(0, 40) : null, installments, fees: feesOnce, payments };
}

export async function readInsurerLedger(files: { buf: Buffer; name: string }[]): Promise<LedgerRead> {
  const blocks = await Promise.all(files.map(f => fileBlockForClaude(f.buf, f.name)));
  const { text } = await askClaude(new Anthropic(), {
    label: files.map(f => f.name).join(', ').slice(0, 80), feature: 'insurer-ledger-read', maxTokens: 4000, check: needsJson,
    messages: [{ role: 'user', content: [...blocks, { type: 'text', text: PROMPT }] }],
  });
  const raw = jsonIn(text);
  if (!raw) throw Object.assign(new Error('Could not read the installments or payments from those pages.'), { status: 422 });
  return cleanLedger(raw);
}

export interface PlannedBill {
  key: string; label: string; invoiceDate: string; dueDate: string;
  installment: number; fees: { label: string; amount: number }[]; installmentFee: number;
  charge: number; carried: number; total: number;
  statementId: string | null;
  onFile: { statementDate: string; amountDue: number | null; carried: number | null; total: number | null } | null;
}
export interface LineUpPlan {
  bills: PlannedBill[];
  /** Bills on file in the term that no installment is: duplicates and misreads. */
  removeBills: { statementId: string; statementDate: string; amountDue: number | null; payments: number }[];
  /** The records' payments; one on file is matched (onFile: as Sollux had it, when its date or amount
   *  differed; keptAsFee: what it had above the records', kept on it as a processing fee). */
  payments: { date: string; amount: number; status: string | null; paymentId: string | null; onFile: { date: string; amount: number } | null; keptAsFee: number | null; feeOnFile: number | null }[];
  /** Payments on file in the term the records do not have. */
  removePayments: { paymentId: string; date: string; amount: number }[];
  /** owedWithoutFee: what the records leave owed before any per-installment fee the owner entered. */
  totals: { billed: number; paid: number; owed: number; owedWithoutFee: number; onFileBilled: number; onFilePaid: number };
  installmentFee: number;
}

/**
 * Which bill each installment is and what the account's bills and payments become. Pure but for
 * reading the account's bills and payments. Null when the account is not this owner's.
 */
export async function planLineUp(userId: string, accountId: string, read: LedgerRead, opts: { installmentFee?: number } = {}): Promise<LineUpPlan | null> {
  const account = await db.utilityAccount.findFirst({ where: { id: accountId, property: { userId } }, select: { id: true } });
  if (!account) return null;
  if (!read.installments.length) throw Object.assign(new Error('No installments were read — upload the Policy Installments page.'), { status: 422 });
  const fee = Math.max(0, r2(opts.installmentFee ?? 0));
  const first = at(read.installments[0]!.date), last = at(read.installments[read.installments.length - 1]!.date);
  const from = new Date(first.getTime() - 10 * DAY), to = new Date(last.getTime() + 40 * DAY);
  const statements = await db.statement.findMany({
    where: { utilityAccountId: accountId, statementDate: { gte: from, lte: to } },
    orderBy: { statementDate: 'asc' },
    select: { id: true, statementDate: true, dueDate: true, amountDue: true, pastDueCarried: true, isScheduled: true, isDownPayment: true, _count: { select: { payments: true } } },
  });
  const payments = await db.payment.findMany({
    where: { utilityAccountId: accountId, paymentDate: { gte: from, lte: new Date(Math.max(to.getTime(), Date.now()) + 5 * DAY) } },
    orderBy: { paymentDate: 'asc' },
    select: { id: true, paymentDate: true, amount: true, status: true, feeAmount: true },
  });
  // How long after its invoice a bill falls due on this account (20 days when none says).
  const gaps = statements.filter(s => !s.isScheduled && s.dueDate).map(s => Math.round((s.dueDate!.getTime() - s.statementDate.getTime()) / DAY)).filter(g => g >= 5 && g <= 45).sort((a, b) => a - b);
  const dueAfter = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 20;

  // A fee still owed when the next invoice went out is on that invoice (a late fee charged Mar 30 and
  // not paid by Apr 1 is on the Apr 1 invoice); one paid off before then — everything billed through
  // it was paid by the next invoice — stays with the installment it was charged on, so no invoice
  // shows a credit for a fee paid before it was printed.
  const feesBy = new Map<number, { label: string; amount: number }[]>();
  const paidBefore = (d: string) => read.payments.filter(x => x.date < d).reduce((t, x) => t + x.amount, 0);
  for (const f of read.fees) {
    const next = read.installments.findIndex(p => p.date >= f.date);
    let charged = -1;
    for (const [j, p] of read.installments.entries()) if (p.date <= f.date) charged = j;
    const billedThrough = read.installments.filter(p => p.date <= f.date).reduce((t, p) => t + p.amount + (/down\s*pay/i.test(p.label) ? 0 : fee), 0)
      + read.fees.filter(g => g.date <= f.date).reduce((t, g) => t + g.amount, 0);
    const paidOff = next >= 0 && paidBefore(read.installments[next]!.date) >= billedThrough - 0.01;
    const idx = next < 0 ? read.installments.length - 1 : paidOff && charged >= 0 ? charged : next;
    feesBy.set(idx, [...(feesBy.get(idx) ?? []), { label: f.label, amount: f.amount }]);
  }
  const used = new Set<string>();
  let billedBefore = 0;
  const bills: PlannedBill[] = read.installments.map((p, i) => {
    const fees = feesBy.get(i) ?? [];
    const perFee = /down\s*pay/i.test(p.label) ? 0 : fee;
    const charge = r2(p.amount + fees.reduce((t, f) => t + f.amount, 0) + perFee);
    const carried = r2(billedBefore - paidBefore(p.date));
    billedBefore = r2(billedBefore + charge);
    // The bill on file for this invoice: issued within six days of it, a real one before a scheduled one.
    const day = at(p.date).getTime();
    const near = statements
      .filter(s => !used.has(s.id) && Math.abs(s.statementDate.getTime() - day) <= 6 * DAY)
      .sort((a, b) => Number(a.isScheduled) - Number(b.isScheduled) || Math.abs(a.statementDate.getTime() - day) - Math.abs(b.statementDate.getTime() - day))[0];
    if (near) used.add(near.id);
    const onFileTotal = near && near.amountDue != null ? r2(Number(near.amountDue) + Number(near.pastDueCarried ?? 0)) : null;
    return {
      key: `${p.date}#${i}`, label: p.label, invoiceDate: p.date,
      dueDate: near?.dueDate && !near.isScheduled ? dayOf(near.dueDate) : dayOf(new Date(day + dueAfter * DAY)),
      installment: p.amount, fees, installmentFee: perFee, charge, carried, total: r2(charge + carried),
      statementId: near?.id ?? null,
      onFile: near ? { statementDate: dayOf(near.statementDate), amountDue: near.amountDue != null ? Number(near.amountDue) : null, carried: near.pastDueCarried != null ? Number(near.pastDueCarried) : null, total: onFileTotal } : null,
    };
  });
  const removeBills = statements.filter(s => !used.has(s.id))
    .map(s => ({ statementId: s.id, statementDate: dayOf(s.statementDate), amountDue: s.amountDue != null ? Number(s.amountDue) : null, payments: s._count.payments }));

  // Each payment the records show, matched to one on file: the same amount within five weeks (a
  // payment logged under the day it posted, or the bill's date), else the same few days with an
  // amount near it (logged at the invoice's figure, $249.90 for a $234.90 payment). A match takes
  // the records' date and amount; what it had above the records' is kept as a processing fee on it
  // (money out that never reduced the bill), so the money paid stays as it was.
  // Closest pairs first across all of them, so one payment logged late is not taken by an earlier one.
  const takenPay = new Set<string>();
  const hits = new Map<number, typeof payments[number]>();
  const pairUp = (fits: (x: LedgerRead['payments'][number], p: typeof payments[number]) => boolean) => {
    const pairs: { k: number; p: typeof payments[number]; gap: number }[] = [];
    for (const [k, x] of read.payments.entries()) {
      if (hits.has(k)) continue;
      for (const p of payments) if (!takenPay.has(p.id) && fits(x, p)) pairs.push({ k, p, gap: Math.abs(p.paymentDate.getTime() - at(x.date).getTime()) });
    }
    for (const { k, p } of pairs.sort((a, b) => a.gap - b.gap)) {
      if (hits.has(k) || takenPay.has(p.id)) continue;
      hits.set(k, p); takenPay.add(p.id);
    }
  };
  pairUp((x, p) => Math.abs(Number(p.amount) - x.amount) <= 0.01 && Math.abs(p.paymentDate.getTime() - at(x.date).getTime()) <= 35 * DAY);
  pairUp((x, p) => Math.abs(p.paymentDate.getTime() - at(x.date).getTime()) <= 3 * DAY && Math.abs(Number(p.amount) - x.amount) <= Math.max(20, x.amount * 0.1));
  const plannedPays = read.payments.map((x, k) => {
    const hit = hits.get(k);
    const differs = hit && (dayOf(hit.paymentDate) !== x.date || Math.abs(Number(hit.amount) - x.amount) > 0.005);
    const over = hit ? r2(Number(hit.amount) - x.amount) : 0;
    return {
      date: x.date, amount: x.amount, status: x.status, paymentId: hit?.id ?? null,
      onFile: hit && differs ? { date: dayOf(hit.paymentDate), amount: Number(hit.amount) } : null,
      keptAsFee: over > 0.005 ? over : null,
      feeOnFile: hit?.feeAmount != null ? Number(hit.feeAmount) : null,
    };
  });
  const removePayments = payments.filter(p => !takenPay.has(p.id) && p.paymentDate.getTime() >= from.getTime())
    .map(p => ({ paymentId: p.id, date: dayOf(p.paymentDate), amount: Number(p.amount) }));

  const billed = r2(bills.reduce((t, b) => t + b.charge, 0));
  const paid = r2(read.payments.reduce((t, x) => t + x.amount, 0));
  const fees = r2(bills.reduce((t, b) => t + b.installmentFee, 0));
  return {
    bills, removeBills, payments: plannedPays, removePayments, installmentFee: fee,
    totals: {
      billed, paid, owed: r2(billed - paid), owedWithoutFee: r2(billed - fees - paid),
      onFileBilled: r2(statements.filter(s => !s.isScheduled).reduce((t, s) => t + Number(s.amountDue ?? 0), 0)),
      onFilePaid: r2(payments.filter(p => p.status !== 'FAILED').reduce((t, p) => t + Number(p.amount), 0)),
    },
  };
}

/** Makes the account's bills and payments the records': bills set or added, duplicates removed, payments matched, added or removed. */
export async function applyLineUp(userId: string, accountId: string, read: LedgerRead, opts: { installmentFee?: number; insurer?: string } = {}) {
  const plan = await planLineUp(userId, accountId, read, opts);
  if (!plan) return null;
  const today = dayOf(new Date());
  const stamp = new Date().toISOString();
  const source = opts.insurer ? `${opts.insurer}'s records` : "the insurer's records";
  let updated = 0, added = 0;
  for (const b of plan.bills) {
    const breakdown: Record<string, number> = {
      [/down\s*pay/i.test(b.label) ? 'Downpayment' : 'Premium installment']: b.installment,
      ...(b.installmentFee ? { 'Installment fee': b.installmentFee } : {}),
    };
    for (const f of b.fees) breakdown[f.label] = r2((breakdown[f.label] ?? 0) + f.amount);
    const feesTotal = r2(b.fees.reduce((t, f) => t + f.amount, 0));
    const lineUp = { at: stamp, from: source, label: b.label };
    const data = {
      statementDate: at(b.invoiceDate),
      dueDate: at(b.dueDate),
      billingPeriodStart: null, billingPeriodEnd: null,
      amountDue: b.charge,
      chargesExcludingFees: r2(b.installment + b.installmentFee),
      penaltiesFees: feesTotal > 0 ? feesTotal : null,
      pastDueCarried: Math.abs(b.carried) > 0.005 ? b.carried : null,
      balance: b.total,
      paymentPlanAmount: null,
      carriedFee: null,
      amountPaid: null,
      isScheduled: b.invoiceDate > today,
    };
    if (b.statementId) {
      const cur = await db.statement.findUnique({ where: { id: b.statementId }, select: { rawDataJson: true } });
      const raw = { ...((cur?.rawDataJson ?? {}) as Record<string, unknown>) };
      delete raw.paymentPlan; delete raw.paymentPlanAmount;
      Object.assign(raw, { chargeBreakdown: breakdown, statedTotalDue: b.total, previousBalance: b.carried, currentCharges: b.charge, lineUp, ownerEditedAt: stamp });
      await db.statement.update({ where: { id: b.statementId }, data: { ...data, rawDataJson: raw as Prisma.InputJsonValue } });
      updated++;
    } else {
      await db.statement.create({ data: {
        utilityAccountId: accountId, ...data, sourceType: 'MANUAL',
        notes: `${b.label}, from ${source}`,
        rawDataJson: { source: 'insurer_records', chargeBreakdown: breakdown, statedTotalDue: b.total, previousBalance: b.carried, currentCharges: b.charge, lineUp, ownerEditedAt: stamp } as Prisma.InputJsonValue,
      } });
      added++;
    }
  }
  // Payments: the records' own, left unfiled so they pay the oldest bills first, as the insurer applied them.
  let paymentsAdded = 0;
  for (const x of plan.payments) {
    const note = `From ${source}${x.status && !/complete/i.test(x.status) ? ` (${x.status.toLowerCase()} there on ${today})` : ''}`;
    if (x.paymentId) await db.payment.update({ where: { id: x.paymentId }, data: {
      statementId: null, splitGroupId: null, paymentDate: at(x.date), amount: x.amount,
      ...(x.keptAsFee ? { feeAmount: r2((x.feeOnFile ?? 0) + x.keptAsFee) } : {}),
    } });
    else { await db.payment.create({ data: { utilityAccountId: accountId, amount: x.amount, paymentDate: at(x.date), status: 'PAID', paymentMethod: 'ONLINE', notes: note } }); paymentsAdded++; }
  }
  const removedPayments = plan.removePayments.length
    ? (await db.payment.deleteMany({ where: { id: { in: plan.removePayments.map(p => p.paymentId) }, utilityAccountId: accountId } })).count : 0;
  // Duplicates go; any payment still filed against one is left unfiled first.
  if (plan.removeBills.length) {
    const ids = plan.removeBills.map(b => b.statementId);
    await db.payment.updateMany({ where: { statementId: { in: ids } }, data: { statementId: null } });
    await db.statement.deleteMany({ where: { id: { in: ids }, utilityAccountId: accountId } });
  }
  return { updated, added, removed: plan.removeBills.length, paymentsAdded, paymentsRemoved: removedPayments, totals: plan.totals };
}
