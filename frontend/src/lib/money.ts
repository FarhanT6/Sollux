/** $1,234.56 — dollars with cents, as bills and statements print them. */
export function fmtMoney(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** An amount in another currency: ৳1,21,350.00 for BDT, with its own grouping. */
export function fmtCurrency(v: number | string | null | undefined, currency: string): string {
  const n = Number(v ?? 0);
  const locale = currency === 'BDT' ? 'en-IN' : 'en-US';
  try {
    return (Number.isFinite(n) ? n : 0).toLocaleString(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return `${currency} ${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
