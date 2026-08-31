/**
 * Turn an axios failure into something a person can act on.
 *
 * The API answers a schema failure with `{ error: 'Validation error', details }`
 * where details carries the offending field paths. Rendering only `error`
 * showed "Validation error" with no indication of which field was wrong — a
 * pay link reading "CR&R Online Bill Pay" instead of a URL failed the form
 * with nothing pointing at the pay link.
 */

/**
 * Prepare a URL field for the API, which accepts a full URL or nothing.
 *
 * A pasted "brawleyca.municipalonlinepayments.com" is a perfectly good answer
 * to "pay/login link" and should not be rejected for missing a scheme, so add
 * one. Text that isn't a host at all ("CR&R Online Bill Pay") is passed
 * through unchanged, to be refused with a message naming the field rather
 * than quietly turned into https://CR&R.
 */
export function normalizeUrlInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // A bare host: letters, digits, dashes and dots, at least one dot, no spaces.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/** Field names as the API knows them → the label the form shows. */
const FIELD_LABELS: Record<string, string> = {
  loginUrl: 'Pay/login link',
  accountNumber: 'Account number',
  providerName: 'Provider',
  providerSlug: 'Provider',
  propertyId: 'Property',
  category: 'Category',
  username: 'Username / Email',
  password: 'Password',
  notes: 'Notes',
  insuranceType: 'Insurance type',
  loanType: 'Loan type',
};

interface ZodIssue { path?: (string | number)[]; message?: string }

export function describeApiError(err: any, fallback: string): string {
  const data = err?.response?.data;
  if (!data) return err?.message || fallback;

  const issues: ZodIssue[] | undefined =
    Array.isArray(data.details) ? data.details : undefined;

  if (issues?.length) {
    const parts = issues.slice(0, 3).map(issue => {
      const key = issue.path?.filter(p => typeof p === 'string').slice(-1)[0] as string | undefined;
      const label = key ? (FIELD_LABELS[key] ?? key) : null;
      // Zod's own wording for a bad URL is "Invalid url", which reads poorly
      // next to a field label.
      const detail = /invalid url/i.test(issue.message ?? '')
        ? 'must be a full web address (https://…) or left empty'
        : issue.message ?? 'is invalid';
      return label ? `${label}: ${detail}` : detail;
    });
    return parts.join(' · ');
  }

  return data.error || data.message || fallback;
}
