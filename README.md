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
