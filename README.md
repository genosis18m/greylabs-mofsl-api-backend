# greylabs-mofsl-api-backend

Backend API for the Greylabs MOFSL financial advisory BI platform.

Receives call recording data from a call analytics system and stores it in NeonDB PostgreSQL for matching against trade data.

## Stack

- **Next.js 14** — App Router, TypeScript
- **Prisma 7** — ORM with `@prisma/adapter-pg` driver
- **NeonDB** — PostgreSQL (pooler for runtime, direct URL for migrations)
- **Zod 4** — request validation

## Endpoint

```
POST /api/call
```

Accepts call record JSON, validates all 20 fields, coerces numeric types to string, and persists to the `call_records` table.

| Response | Condition |
|---|---|
| `201 { received: true, call_id }` | Success |
| `400 { error, issues[] }` | Validation failure |
| `409 { error }` | Duplicate `call_id` |

## Setup

```bash
# Install dependencies
npm install

# Copy env file and fill in NeonDB credentials
cp .env.example .env

# Push schema to database
npm run db:push

# Run dev server
npm run dev
```

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon pooler connection string (pgbouncer=true) |
| `DIRECT_URL` | Neon direct connection string (for migrations) |

## Deploy on Render

1. Push this repo to GitHub
2. Create a **Web Service** on [Render](https://render.com) pointing to the repo
3. Set `DATABASE_URL` and `DIRECT_URL` in the Render environment variables dashboard
4. Render will auto-run `npm ci && prisma generate && next build` on each deploy

The `render.yaml` in this repo configures the service automatically.

## Database

The `call_records` table lives alongside the existing trade and conversation tables in NeonDB. The dashboard backend can JOIN or query `call_records` against `trade_rows` on `(advisor_code, client_code, stock_name)` with a 7-day window to compute conversion and compliance metrics.
