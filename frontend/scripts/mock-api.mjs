/**
 * Sample API answers for scripts/screens.mjs. Shapes follow the backend
 * routes; amounts and names are made up. Anything not listed answers an
 * empty list (or object for a path ending in an id).
 */
export function handle(method, path, query, body) {
  if (method !== 'GET') return { body: { ok: true } };
  const hit = Object.entries(GET).find(([p]) => new RegExp(`^${p}$`).test(path));
  if (hit) return { body: typeof hit[1] === 'function' ? hit[1](path, query) : hit[1] };
  return { body: /\/[a-z0-9]{20,}$/i.test(path) ? {} : [] };
}

const GET = {};

// Gmail coverage (Import → What Gmail is and isn't bringing in), with senders that match no account.
const msg = (outcome, subject) => ({ id: subject, receivedAt: '2026-10-10T12:00:00Z', subject, from: null, mailbox: 'owner@example.com', outcome, detail: null });
GET['/gmail/coverage'] = {
  since: '2026-09-04T00:00:00Z',
  providers: [{ provider: 'SDG&E', status: 'ok', filed: 6, notExtracted: [], notExtractedCount: 0, accounts: [] }],
  unmatched: [
    ['Example Bank', 'alerts@notify.examplebank.com', 14, 'online', 'Your statement for account ending 1234 is ready'],
    ['City Gym', 'no_reply@citygym.example', 4, 'review', 'Waive Balance Confirmation'],
    ['PayLater', 'noreply@paylater.example', 3, 'online', 'Your September account statement'],
    ['Credit Monitor', 'support@creditmonitor.example', 3, 'online', 'Your monthly account statement is ready'],
    ['Home Store Card', 'card@homestore.example', 2, 'review', 'Your Rewards card statement'],
    ['Cooling & Heating Co.', 'invoices@cooling.example', 2, 'review', 'Your invoice from Cooling & Heating Co.'],
    ['Mortgage Servicer', 'noreply@servicer.example', 2, 'review', 'Payment statement, 432 W Main St'],
    ['HOA Portal', 'noreply@hoaportal.example', 2, 'online', 'Your e-Statement is here!'],
    ['Big Bank', 'no.reply.alerts@bigbank.example', 1, 'online', 'Your latest statement is now available'],
    ['Specialty Care', 'noreply@care.example', 1, 'online', 'This is your statement notice'],
    ['Payment Reminder Co.', 'billing@reminder.example', 1, 'error', 'Upcoming payment reminder'],
  ].map(([name, address, count, outcome, subject]) => ({ from: `${name} <${address}>`, name, domain: address.split('@')[1], count, latest: msg(outcome, subject) })),
};
