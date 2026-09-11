import type { PaymentBreakdown } from '../../types';

const money = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

/**
 * Where a payment went, in the order the provider applies it: fees, then
 * the balance carried from earlier, then a plan installment, then this
 * period's charge; anything beyond that is credit. Only the parts that are
 * non-zero are shown, so a plain bill paid in full reads as one item.
 */
export default function PaymentBreakdownLine({ b }: { b?: PaymentBreakdown | null }) {
  if (!b) return null;
  const parts: { label: string; amount: number; cls: string }[] = [];
  if (b.creditUsed > 0) parts.push({ label: 'credit used', amount: b.creditUsed, cls: 'text-emerald-500' });
  if (b.toFees > 0) parts.push({ label: 'late fees', amount: b.toFees, cls: 'text-red-400' });
  if (b.toPastDue > 0) parts.push({ label: 'past due', amount: b.toPastDue, cls: 'text-red-400' });
  if (b.toInstallment > 0) parts.push({ label: 'plan installment', amount: b.toInstallment, cls: 'text-amber-400' });
  if (b.toCurrent > 0) parts.push({ label: 'current charges', amount: b.toCurrent, cls: 'text-gray-300' });
  if (b.overpaid > 0) parts.push({ label: 'overpaid → credit', amount: b.overpaid, cls: 'text-emerald-500' });
  if (parts.length === 0) return null;
  return (
    <p className="text-[11px] mt-0.5">
      <span className="text-gray-600">Applied{b.statementLabel ? ` to ${b.statementLabel}` : ''}: </span>
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
