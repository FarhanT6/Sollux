# Sollux — Codebase

**Property utility intelligence platform.** Connects to utility accounts, scrapes statements, surfaces AI insights, stores documents.

## Stack
- Frontend: React 18 + TypeScript + Vite + Tailwind CSS
- Backend: Node.js + Express + TypeScript + Prisma
- Database: PostgreSQL 15
- Queue: BullMQ + Redis
- Scraping: Playwright
- AI: Anthropic Claude API
- Storage: AWS S3
- Auth: Clerk
- Notifications: Twilio + SendGrid

## Quick Start

### Prerequisites
- Node.js 20+
- PostgreSQL 15
- Redis
- (Optional) Docker for local DB/Redis

### 1. Install dependencies
```bash
cd frontend && npm install
cd ../backend && npm install
```

### 2. Configure environment
```bash
# backend
cp backend/.env.example backend/.env
# Fill in your keys (see .env.example)

# frontend
cp frontend/.env.example frontend/.env
```

### 3. Set up database
```bash
cd backend
npx prisma migrate dev --name init
npx prisma generate
```

### 4. Run development
```bash
# Terminal 1 — backend
cd backend && npm run dev

# Terminal 2 — frontend
cd frontend && npm run dev

# Terminal 3 — workers (optional, for scraping)
cd backend && npm run workers
```

Frontend: http://localhost:5173  
Backend API: http://localhost:3001

## Architecture Notes for Claude Code

### Credential encryption
All utility credentials are encrypted with AES-256-GCM before database storage.
Key lives in `ENCRYPTION_KEY` env var (32-byte hex). See `backend/src/crypto/encrypt.ts`.

### Scraper pattern
Each utility provider has a scraper in `backend/src/scrapers/providers/`.
All scrapers implement the `ScraperProvider` interface from `backend/src/scrapers/base.ts`.
Scrapers are invoked by the BullMQ worker in `backend/src/workers/scrapeWorker.ts`.

### AI insights
The insight engine runs nightly via BullMQ. See `backend/src/ai/insightEngine.ts`.
It uses the Claude API to generate natural-language recommendations from scraped data.

### Gmail parsing
Gmail OAuth flow is in `backend/src/parsers/gmailParser.ts`.
After connecting, it runs every 6 hours to pull new utility emails and extract statement data.
