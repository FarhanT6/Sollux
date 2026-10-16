/**
 * Preload for the local dev stack only: `node -r ./scripts/dev/devAuth.cjs`.
 * Swaps @clerk/express for scripts/dev/clerkStub.cjs so the API runs without
 * a Clerk instance, signed in as the seeded owner. It refuses to load in
 * production, and nothing in src/ imports it.
 */
if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
  throw new Error('devAuth is for local development only');
}
const Module = require('module');
const path = require('path');
const stub = path.join(__dirname, 'clerkStub.cjs');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@clerk/express') return stub;
  return resolve.call(this, request, ...rest);
};
console.log('[devAuth] @clerk/express stubbed: every request is the seeded owner');
