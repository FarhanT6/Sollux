/**
 * The first month a loan's payment is due. A mortgage's interest is paid in
 * arrears and the closing covers the first month (prepaid interest, escrow),
 * so the first payment is due the month after it funds — funded July 1,
 * first payment August 1. The owner can name the first payment date when a
 * loan differs (`firstPaymentDate`), e.g. funded mid-June, first payment
 * August 1. Every place that expects a loan payment in a month asks this.
 *
 * A loan with neither date is counted from the month it was added to Sollux
 * (`createdAt`): before that its history was never kept here, and calling
 * every earlier month late — while catch-up had no start to fill from —
 * left months red that nothing could clear. Payments logged earlier still
 * show as paid.
 */
const ym = (d: Date) => d.toISOString().slice(0, 7);

type LoanDates = { originationDate?: Date | null; firstPaymentDate?: Date | null; createdAt?: Date | null };

export function firstDueMonth(l: LoanDates): string | null {
  if (l.firstPaymentDate) return ym(l.firstPaymentDate);
  if (!l.originationDate) return l.createdAt ? ym(l.createdAt) : null;
  const d = l.originationDate;
  return ym(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
}

/** Whether a payment is owed in `month` (YYYY-MM) by its start; a loan with no dates at all is taken as running. */
export const dueBy = (l: LoanDates, month: string) => {
  const first = firstDueMonth(l);
  return !first || first <= month;
};
