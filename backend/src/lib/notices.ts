export type NoticeLineItem = { amount: number; dueDate: Date };

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

export function computeStandardBreakdown(
  arrearsBalance: number,
  currentPeriodOwed: number,
  rentAmount: number,
  currentPeriodDueDate: Date,
): NoticeLineItem[] {
  const total = arrearsBalance + currentPeriodOwed;
  if (total <= 0 || rentAmount <= 0) return [];
  const mostRecentDue = currentPeriodOwed > 0 ? currentPeriodDueDate : addMonths(currentPeriodDueDate, -1);
  const items: NoticeLineItem[] = [];
  let remaining = total;
  let dueDate = mostRecentDue;
  while (remaining > 0.005) {
    const amount = Math.min(remaining, rentAmount);
    items.push({ amount: Math.round(amount * 100) / 100, dueDate });
    remaining -= amount;
    dueDate = addMonths(dueDate, -1);
  }
  return items.reverse();
}
