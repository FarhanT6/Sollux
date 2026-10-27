# CLAUDE.md — Instructions for Claude Code

## Project: Sollux
Property utility intelligence platform. Connects to utility provider portals, scrapes statements,
runs AI anomaly detection, stores PDFs, and sends proactive notifications.

## Repo layout
```
sollux/
├── frontend/     React 18 + TypeScript + Vite + Tailwind
├── backend/      Node.js + Express + TypeScript + Prisma
└── README.md
```

## Design decisions already made
- White background everywhere (`#FFFFFF`), gold accent `#F5A623`
- All credentials encrypted AES-256-GCM before DB storage (see `backend/src/crypto/encrypt.ts`)
- Scrapers implement `BaseScraperProvider` from `backend/src/scrapers/base.ts`
- Workers run separately from the API server: `npm run workers` in `/backend` — or inside the API with `RUN_WORKERS_IN_API=true`. Workers write a heartbeat to `worker_heartbeats` every minute (`workers/heartbeat.ts`); `workerStatus()` says whether queued jobs will run (shown on Settings → AI usage and in the audit report)
- Gmail OAuth is the fast path for providers without a scraper yet
- BullMQ queues: `scrape`, `insights`, `notifications`, `gmail`
- Claude calls go through `askClaude` in `backend/src/ai/models.ts`: `claude-sonnet-5` first, `claude-opus-5-5` as the fallback when the first answer fails its check or the call errors (env `CLAUDE_MODEL` / `CLAUDE_FALLBACK_MODEL`)
- Rent collection and the tenant portal: owners connect Stripe Connect Express (`services/rentCollection.ts`); tenants pay by Checkout (bank free, card fee on the tenant, no platform fee) and the webhook writes `RentPayment` rows (pending → received). Tenants sign in through Clerk but only reach `/api/portal` (`attachTenant`); `attachDbUser` refuses a tenant's sign-in on every owner route. Repairs: `routes/maintenance.ts` (owner) and `/api/portal/requests` (tenant)
- Fetch from your computer: the owner runs `frontend/public/sollux-connector.mjs` (Node 22+, no deps), which opens its own Chrome profile and tunnels to the API (`services/connector.ts`, WebSocket `/api/connector/tunnel`); the portal agent drives that Chrome over CDP through `/api/connector/cdp/<signed session>` whenever the owner's connector is online, else the cloud browser. Devices in `connector_devices` (token hash only), managed in Settings → AI usage
- Property tax: `lib/propertyTaxRules.ts` holds each state's calendar, default, redemption and sale/deed rules (CA, FL, TX, AZ; other states use the bill's dates). `services/propertyTaxLookup.ts` looks a parcel up on its county's tax site by APN (a browser agent, read only; queued as `tax-lookup` on the insights queue, refreshed monthly once run) and saves years and unpaid years (`tax_defaults`)
- Ask Sollux (`ai/assistant.ts`) reads everything but the vault and credentials: statements with every stored figure, the statement and tax-bill PDFs and documents themselves (`open_file` hands the file to the model), payments, plans, properties, taxes, insurance, operating expenses, expenses; it only proposes payments, which the owner confirms
- Every Claude call is metered (`backend/src/ai/meter.ts`): give `askClaude` a `feature`, or use `meteredCreate` for a tool loop; spend lands in `ai_usage`, is capped by `AI_MONTHLY_BUDGET`, and shows on Settings → AI usage, which also runs a test of every AI feature. Reuse answers for unchanged facts with `memoAnswer`; cache tool loops (`cache: true`) and keep their history append-only

## Agent workflow (the auditor, the build agent, and PRs)
Two GitHub Actions keep the app improving without the owner having to describe defects:
- **Auditor** (`.github/workflows/sollux-auditor.yml`, every morning): reads the app's own quality report
  (`GET /api/audit/report`, `backend/src/routes/audit.ts` — bills read wrong, text fallbacks, duplicates,
  failing syncs, silent accounts, browser crashes from `POST /api/telemetry/error`) and files
  `Proposed: …` issues labelled `proposed`, each with evidence, a root-cause pointer into the code, and a plan.
  Data chores (an unpaid bill, a balance not entered) are the nightly bookkeeper's job, not issues.
- **Build agent** (`.github/workflows/claude-build.yml`): when the owner relabels a proposal `claude-build`
  (or files an issue titled `Build: …`, or mentions `@claude` in a thread), it builds the change on a branch,
  type-checks both sides, opens a PR against `main`, and comments the link. The owner's approval points are
  the relabel and the merge; "merge it" in the issue lets the agent merge itself.
Whether you are one of those agents or an interactive session, ship changes the same way:
1. Branch from the latest `main`: `git fetch origin main && git checkout -B claude/<short-slug> origin/main`.
2. Type-check both sides and run the tests before committing; nothing ships red:
   `cd backend && npx prisma generate && npx tsc --noEmit -p . && npm test` and `cd frontend && npx tsc --noEmit -p .`.
   Changes to billing, plan limits, account isolation or payments also run `npm run test:integration` with
   `TEST_DATABASE_URL` set to a disposable local Postgres database (it is wiped) and `REDIS_URL`.
   Stripe's own end-to-end checks are in `docs/STRIPE-CHECKLIST.md`.
3. Schema changes: edit `backend/prisma/schema.prisma` AND add a hand-written migration under
   `backend/prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` using `IF NOT EXISTS` guards. Render runs
   `prisma migrate deploy` on every build for both the API and the workers.
4. Verify extraction changes against real statements when any are available (`/root/.claude/uploads/...` in a
   session, or PDFs attached to the issue) with a scratch `npx tsx` script — never guess at a bill's layout.
5. Commit with a message that says what was wrong and what changed. Push with `git push -u origin <branch>`.
6. Open a PR against `main` whose body says what was wrong, what changed and which files; do NOT merge it
   unless the person asked for that in the issue. Comment on the issue with the PR link.
7. If the issue is unclear or would need a decision only the owner can make, comment the question on the issue
   and stop — do not build a guess.
Conventions the code follows: dark UI (`#1e1e1e` cards, amber `#F5A623` accent), money via `fmtMoney`, dates via
`lib/date.ts` helpers (never `new Date(...)` on a date-only string — timezone shift), paid state via
`frontend/src/lib/paidState.ts` (one rule for cards and pages), statement rows show what the statement printed.

## When adding a new scraper
1. Create `backend/src/scrapers/providers/{slug}.ts`
2. Extend `BaseScraperProvider`, implement `login()`, `scrapeStatements()`, `scrapePayments()`
3. Register in the `registry` object inside `backend/src/scrapers/base.ts`
4. Test by calling `POST /api/utilities/:id/sync`

## When adding a new page
1. Create `frontend/src/pages/{Name}Page.tsx`
2. Add route to `frontend/src/App.tsx`
3. Add nav link to `frontend/src/components/layout/AppLayout.tsx`

## Database changes
Always use `npx prisma migrate dev --name <description>` — never edit schema without a migration.

## Security rules (never violate)
- Never log decrypted credentials
- Never return `usernameEnc`, `passwordEnc`, `accountNumberEnc` fields from any API endpoint
- All `/api/*` routes except `/api/auth`, `/api/stripe/webhook` and the landing page's audit request form
  (`POST /api/public/audit-requests`: rate-limited, 5 files of 10 MB, PDF or image only) require authentication
- PDF files must always be accessed via signed S3 URLs, never public URLs
- The vault (`/vault`, `routes/vault.ts`, `lib/vaultCrypto.ts`) is zero-knowledge: records are encrypted in the
  browser with a key only the owner's vault passphrase or recovery key unwraps. The server must never receive,
  derive or log a passphrase, recovery key, data key or plaintext field; no AI tool, agent, export or import may
  read `vault_items`. Elsewhere, bank and card numbers stay last-4 only.

## Environment setup
Copy `.env.example` to `.env` in both `frontend/` and `backend/` and fill in your keys.
Generate ENCRYPTION_KEY: `openssl rand -hex 32`

## Providers to support first
Common providers for the owners Sollux serves — prioritize these when improving fetching or reading:
- SDG&E, SoCalGas, IID, Cox, T-Mobile, AT&T, WM, Republic Services
- City of Oceanside, City of Imperial, City of El Centro, City of Brawley
- FPL, Brevard County Water, Vista Irrigation District
- Service Finance (solar), Bamboo Insurance, Safeco, Keystone HOA

Never write a real owner's or tenant's details (names, addresses, account numbers, phone numbers, email
addresses, amounts tied to a person) into the repository — code, comments, tests, docs or issues. Use made-up
examples ("1200 Elm Grove Ln", "account 123456-654321").
