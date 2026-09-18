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
- Workers run separately from the API server: `npm run workers` in `/backend`
- Gmail OAuth is the fast path for providers without a scraper yet
- BullMQ queues: `scrape`, `insights`, `notifications`, `gmail`
- AI insights use `claude-sonnet-4-6` via the Anthropic SDK

## Agent workflow (scheduled Claude Code sessions and PRs)
A scheduled Claude Code Routine picks up GitHub issues labelled `claude-build` and turns each into a PR.
Whether you are that Routine or an interactive session, ship changes the same way:
1. Branch from the latest `main`: `git fetch origin main && git checkout -B claude/<short-slug> origin/main`.
2. Type-check both sides before committing; nothing ships red:
   `cd backend && npx prisma generate && npx tsc --noEmit -p .` and `cd frontend && npx tsc --noEmit -p .`
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
- All `/api/*` routes except `/api/auth` and `/api/stripe/webhook` require authentication
- PDF files must always be accessed via signed S3 URLs, never public URLs

## Environment setup
Copy `.env.example` to `.env` in both `frontend/` and `backend/` and fill in your keys.
Generate ENCRYPTION_KEY: `openssl rand -hex 32`

## Key real-world data (from user's actual portfolio)
The user has 22 properties, 135 bills, 76 utility accounts across CA, FL, WV, TX, NV.
Key providers in their portfolio:
- SDGE, SoCal Gas, IID, Cox, T-Mobile, AT&T, WM, Republic Services
- City of Oceanside, City of Imperial, City of El Centro, City of Brawley
- FPL, Brevard County Water, Vista Irrigation District
- Service Finance (solar), Bamboo Insurance, Safeco, Keystone HOA

When building scrapers, prioritize these providers first.
