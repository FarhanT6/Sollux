/**
 * The first month a loan's payment is due. A mortgage's interest is paid in
 * arrears and the closing covers the first month (prepaid interest, escrow),
 * so the first payment is due the month after it funds — funded July 1,
 * first payment August 1. The owner can name the first payment date when a
 * loan differs (`firstPaymentDate`), e.g. funded mid-June, first payment
 * August 1. Every place that expects a loan payment in a month asks this.
 */
const ym = (d: Date) => d.toISOString().slice(0, 7);

export function firstDueMonth(l: { originationDate?: Date | null; firstPaymentDate?: Date | null }): string | null {
  if (l.firstPaymentDate) return ym(l.firstPaymentDate);
  if (!l.originationDate) return null;
  const d = l.originationDate;
  return ym(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
}

/** Whether a payment is owed in `month` (YYYY-MM) by its start; a loan with no dates is taken as running. */
export const dueBy = (l: { originationDate?: Date | null; firstPaymentDate?: Date | null }, month: string) => {
  const first = firstDueMonth(l);
  return !first || first <= month;
};
