/**
 * Stand-in for @clerk/express in the local dev stack (scripts/dev/devAuth.cjs).
 * Every request is signed in as the seeded owner (clerkUserId "user_mock").
 */
const pass = () => (_req, _res, next) => next();
module.exports = {
  clerkMiddleware: pass,
  requireAuth: pass,
  getAuth: () => ({ userId: 'user_mock', sessionId: 'sess_mock' }),
  clerkClient: { users: { getUser: async () => ({ id: 'user_mock', firstName: 'Farhan', lastName: 'Talukder', emailAddresses: [{ id: 'e', emailAddress: 'owner@example.com', verification: { status: 'verified' } }], primaryEmailAddressId: 'e', phoneNumbers: [] }) } },
};
