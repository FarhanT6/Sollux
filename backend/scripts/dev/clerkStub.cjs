/**
 * Stand-in for @clerk/express in the local dev stack (scripts/dev/devAuth.cjs).
 * Every request is signed in as the seeded owner (clerkUserId "user_mock"),
 * or as a tenant ("user_tenant_mock") when the token is "mock-tenant" — the
 * mock frontend sends that when localStorage sollux.mockUser is "tenant".
 */
const idOf = req => (String(req?.headers?.authorization ?? '').endsWith('mock-tenant') ? 'user_tenant_mock' : 'user_mock');
const pass = () => (_req, _res, next) => next();
module.exports = {
  clerkMiddleware: pass,
  requireAuth: pass,
  getAuth: req => ({ userId: idOf(req), sessionId: 'sess_mock' }),
  clerkClient: { users: { getUser: async id => id === 'user_tenant_mock' ? ({ id, firstName: 'Tina', lastName: 'Tenant', emailAddresses: [{ id: 't', emailAddress: 'tenant@example.com', verification: { status: 'verified' } }], primaryEmailAddressId: 't', phoneNumbers: [] }) : ({ id: 'user_mock', firstName: 'Farhan', lastName: 'Talukder', emailAddresses: [{ id: 'e', emailAddress: 'owner@example.com', verification: { status: 'verified' } }], primaryEmailAddressId: 'e', phoneNumbers: [] }) } },
};
