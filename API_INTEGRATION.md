# API Integration Guide — Calls & Trades

This backend ingests call/trade data and lets a dashboard pull it back out.
Use this doc to integrate the API into the main dashboard.

- **Base URL (production):** `https://greylabs-mofsl-api-backend.onrender.com`
- **Auth:** every endpoint requires the API token (see below). No token → `401`.
- **Content type:** `application/json`

---

## Authentication

Every request MUST include the token, either header works:

```
x-api-key: <API_TOKEN>
```
or
```
Authorization: Bearer <API_TOKEN>
```

- Missing/empty token → `401 {"error":"Unauthorized"}`
- Wrong token → `401 {"error":"Unauthorized"}`
- The token is stored server-side as the `API_KEY` env var. **Never hardcode it in
  frontend code shipped to browsers** — call these endpoints from your dashboard's
  server/backend, not from client-side JS.

> The actual token value is shared separately (not committed to the repo).

---

## 1. POST `/api/v2/call` — push call + trades  (ingest)

Stores one call and its trades. Accepts a single object **or** an array (bulk).

### Request body — single
```json
{
  "call": {
    "advisor_name_stated": null,
    "right_party": "client",
    "client_age_stated": null,
    "primary_topic": "trade",
    "unconditional_assurance_given": false,
    "assurance_quote": null,
    "misinformation_suspected": false
  },
  "trades": [
    {
      "instrument_type": "EQUITY",
      "underlying": "BHEL",
      "side": "SELL",
      "quantity_value": 777,
      "price": 161.10,
      "customer_consent": "yes",
      "action_taken": true,
      "stop_loss_mentioned": false,
      "target_mentioned": false
      // ...any of the trade fields listed in the Data Model section
    }
  ]
}
```

### Request body — bulk
Send an **array** of the above objects to insert many calls in one request:
```json
[ { "call": {...}, "trades": [...] }, { "call": {...}, "trades": [...] } ]
```

### Idempotency / `call_id`
- If you include a unique **`call_id`** (top-level or inside `call`), it is used as the
  dedup key — re-sending the same `call_id` returns `409` instead of duplicating.
- If no id is provided, the server derives a stable hash of the payload as the key.
  **Strongly recommended: send a real `call_id`.**

### Responses
| Code | When | Body |
|------|------|------|
| `201` | single call stored | `{ "received": true, "call_id": "...", "trades": 2 }` |
| `409` | duplicate `call_id` | `{ "error": "call already exists", "call_id": "..." }` |
| `207` | bulk processed | `{ "total", "created", "duplicates", "failed", "results": [...] }` |
| `400` | invalid JSON / bad shape | `{ "error": "...", "issues": [...] }` |
| `401` | missing/invalid token | `{ "error": "Unauthorized" }` |

### Example
```bash
curl -X POST https://greylabs-mofsl-api-backend.onrender.com/api/v2/call \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_TOKEN>" \
  -d '{"call":{"primary_topic":"trade"},"trades":[{"side":"SELL","underlying":"BHEL","quantity_value":777,"price":161.10}]}'
```

---

## 2. GET `/api/v2/calls` — pull calls + trades  (read for dashboard)

Returns stored calls, each with its nested `trades[]`, newest first, paginated.

### Query params (all optional)
| Param | Meaning |
|-------|---------|
| `page` | page number (default 1) |
| `limit` | rows per page (default 50, max 200) |
| `call_id` | exact match |
| `primary_topic` | exact match |
| `right_party` | exact match |
| `underlying` | calls having a trade whose underlying contains this (case-insensitive) |
| `side` | `BUY` / `SELL` — calls having a trade with this side |
| `date_from`, `date_to` | filter on `createdAt` (ISO date/time) |

### Response
```json
{
  "total": 200,
  "page": 1,
  "limit": 50,
  "pages": 4,
  "data": [
    {
      "id": "uuid",
      "call_id": "...",
      "primary_topic": "trade",
      "right_party": "client",
      "raw_payload": { /* full original payload */ },
      "createdAt": "2026-06-26T11:50:27.927Z",
      "trades": [ { "id": "uuid", "side": "BUY", "underlying": "TCS", "price": "100", ... } ]
    }
  ]
}
```

### Example
```bash
curl -H "Authorization: Bearer <API_TOKEN>" \
  "https://greylabs-mofsl-api-backend.onrender.com/api/v2/calls?limit=20&side=SELL"
```

### Dashboard fetch (server-side) example
```ts
const res = await fetch(
  "https://greylabs-mofsl-api-backend.onrender.com/api/v2/calls?limit=50",
  { headers: { "x-api-key": process.env.API_TOKEN! } }
);
const { data, total, pages } = await res.json();
```

---

## Data Model

### `calls` (one row per call)
| Field | Type |
|-------|------|
| `id` | uuid (PK) |
| `call_id` | string (unique) |
| `advisor_name_stated` | string \| null |
| `right_party` | string \| null |
| `client_age_stated` | int \| null |
| `primary_topic` | string \| null |
| `unconditional_assurance_given` | boolean |
| `assurance_quote` | string \| null |
| `misinformation_suspected` | boolean |
| `raw_payload` | json (full original payload) |
| `createdAt` | timestamp |
| `trades` | `Trade[]` (relation) |

### `trades` (many per call)
`position_index, instrument_type, underlying_spoken, underlying, underlying_alternatives[],
name_confidence, option_type, strike_price, expiry_hint, side, quantity_value, quantity_unit,
price, price_type, product_hint, trade_initiator, recommendation_source, customer_consent,
consent_is_explicit, consent_quote, consent_ts, trade_phase, action_taken, stop_loss_mentioned,
stop_loss_value, target_mentioned, target_value, conditional_exit, evidence_quote, evidence_ts,
extraction_confidence`

---

## Legacy endpoints (still available, also token-protected)
- `POST /api/call` — flat single-trade records → `call_records` table
- `POST /api/webhook` — `{ status, details[] }` audit format → `call_records` table
- `GET  /api/calls` — read `call_records`

## Operational notes
- **Cold start:** on the free Render tier the first request after idle can take ~30–60s.
  Retry on timeout / 5xx; consider a warm-up GET before a large batch.
- **All endpoints require the token** — same `API_KEY` for ingest and pull.
