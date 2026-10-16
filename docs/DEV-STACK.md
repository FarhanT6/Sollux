# Local dev stack and phone screen tests

Run the whole app on your machine with sample data, signed in without Clerk,
and screenshot every screen at iPhone size.

## 1. Database and sample data
```bash
# any local Postgres works; e.g. Postgres.app or `brew services start postgresql`
export DATABASE_URL=postgresql://localhost:5432/sollux_dev
export DIRECT_DATABASE_URL=$DATABASE_URL
cd backend
npx prisma db push          # create the tables
npm run seed:dev            # wipes and fills: 3 properties, 7 utilities, 5 leases
```
`seed:dev` refuses any DATABASE_URL that is not on localhost.

## 2. API without Clerk
```bash
cd backend
ENCRYPTION_KEY=$(openssl rand -hex 32) PORT=3001 npm run dev:local
```
`scripts/dev/devAuth.cjs` swaps `@clerk/express` for a stub, so every request
is the seeded owner (`owner@example.com`). It refuses to load when
`NODE_ENV=production` or on Render, and nothing in `src/` imports it.
Redis connection warnings are expected (the queues are not used here).

## 3. Phone screenshots
```bash
cd frontend
npm run screens                       # all tab screens → frontend/.screens/
npm run screens -- out /dashboard     # a folder and some routes
SCHEME=light npm run screens          # light mode
```
Starts Vite with `--mode mock` (`src/dev/clerkMock.tsx` stands in for
Clerk; refused for builds), opens each route as an iPhone 15 (393×852, 3x,
touch) and saves a PNG. It uses the API on :3001 when it is up, else the
sample answers in `scripts/mock-api.mjs`. A page error, console error, failed
request or sideways scrolling page fails the run.
