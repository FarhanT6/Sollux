import type { PaymentBreakdown } from '../../types';
import { feesPaidParts } from '../../lib/feeKinds';

// "2026-08" → "Aug 2026"; anything else as it is.
const monthName = (label: string) => /^\d{4}-\d{2}$/.test(label)
  ? new Date(Date.UTC(Number(label.slice(0, 4)), Number(label.slice(5, 7)) - 1, 15)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  : label;
const money = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

/**
 * Where a payment went, in the order the provider applies it: fees, then
 * the balance carried from earlier, then a plan installment, then this
 * period's charge; anything beyond that is credit. Only the parts that are
 * non-zero are shown, so a plain bill paid in full reads as one item.
 * Fees are named by kind from the bill's charge lines when `statement` is given.
 */
export default function PaymentBreakdownLine({ b, statement }: { b?: PaymentBreakdown | null; statement?: any }) {
  if (!b) return null;
  const parts: { label: string; amount: number; cls: string }[] = [];
  if (b.creditUsed > 0) parts.push({ label: 'credit used', amount: b.creditUsed, cls: 'text-emerald-500' });
  if (b.toFees > 0) for (const f of feesPaidParts(b.toFees, statement)) parts.push({ label: f.label, amount: f.amount, cls: 'text-red-400' });
  if (b.toPastDue > 0) parts.push({ label: 'past due', amount: b.toPastDue, cls: 'text-red-400' });
  if (b.toInstallment > 0) parts.push({ label: 'plan installment', amount: b.toInstallment, cls: 'text-amber-400' });
  if (b.toCurrent > 0) parts.push({ label: 'current charges', amount: b.toCurrent, cls: 'text-gray-300' });
  if (b.overpaid > 0) parts.push({ label: 'overpaid → credit', amount: b.overpaid, cls: 'text-emerald-500' });
  if (parts.length === 0) return null;
  return (
    <p className="text-[11px] mt-0.5">
      <span className="text-gray-600">Applied{b.statementLabel ? ` to ${monthName(b.statementLabel)}` : ''}: </span>
      {parts.map((x, i) => (
        <span key={x.label}>
          {i > 0 && <span className="text-gray-700"> · </span>}
          <span className={x.cls}>{money(x.amount)}</span> <span className="text-gray-500">{x.label}</span>
        </span>
      ))}
      {b.remainingAfter > 0.01 && <span className="text-gray-600"> · {money(b.remainingAfter)} still open</span>}
      {b.transactionFee > 0 && <span className="text-gray-600"> · {money(b.transactionFee)} transaction fee</span>}
    </p>
  );
}
