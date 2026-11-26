/**
 * What a bill lookup page's field asks for, by its label, and how the account's number is typed
 * into it (scrapers/portalAgent.ts fillLookup). Kept apart so the rules are tested on their own.
 */
export type LookupField = 'account number' | 'customer number' | 'ZIP code' | 'name on the bill';

export function lookupFieldKind(label: string): LookupField | null {
  // An account number, or an insurer's policy number ("Policy or Quotation Number", the FAIR Plan's).
  if (/account\s*(number|no\b|#|id)|policy\s*(or\s*quot\w*\s*)?(number|no\b|#)/i.test(label)) return 'account number';
  if (/customer\s*(number|no\b|#|id)/i.test(label)) return 'customer number';
  if (/\bzip\b|postal\s*code/i.test(label)) return 'ZIP code';
  if (/name/i.test(label) && !/user\s*name|e-?mail/i.test(label)) return 'name on the bill';
  return null;
}

/**
 * A number printed in two parts ("123456-654321": customer number, then account number) is split;
 * a policy number with a space in it ("CFP 0123456", which the FAIR Plan wants typed as printed)
 * is one number.
 */
export function lookupNumberParts(number: string): string[] {
  const split = number.split(/[\s-]+/).filter(Boolean);
  return split.length === 2 && split.every(p => /^\d+$/.test(p)) ? split : [number];
}
