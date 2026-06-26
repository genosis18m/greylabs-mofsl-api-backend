import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth";
import { Prisma } from "@prisma/client";

// New nested shape: { call: {...}, trades: [...] }
// We validate loosely (the dev-team payload carries many fields and may grow),
// keep the full original in raw_payload, and coerce the known fields ourselves.
const envelopeSchema = z.object({
  call_id: z.union([z.string(), z.number()]).optional(),
  id: z.union([z.string(), z.number()]).optional(),
  call: z.record(z.string(), z.unknown()).optional().default({}),
  trades: z.array(z.record(z.string(), z.unknown())).optional().default([]),
});

type Envelope = z.infer<typeof envelopeSchema>;

// ── coercion helpers ────────────────────────────────────────────────────────
const str = (v: unknown): string | null => (v == null ? null : String(v));

const bool = (v: unknown): boolean => {
  if (typeof v === "boolean") return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1";
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

const intOrNull = (v: unknown): number | null => {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
};

// No call identifier exists in the payload yet (pending dev-team confirmation).
// Use one if provided (top-level or inside `call`); otherwise derive a stable
// hash of the payload so identical re-sends dedup instead of duplicating.
function resolveCallId(env: Envelope, raw: unknown): string {
  const c = env.call as Record<string, unknown>;
  const provided = env.call_id ?? env.id ?? c.call_id ?? c.id;
  if (provided != null && String(provided).trim() !== "") return String(provided);
  return "sha256:" + createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 40);
}

function buildTrade(t: Record<string, unknown>, position_index: number) {
  return {
    position_index,
    instrument_type: str(t.instrument_type),
    underlying_spoken: str(t.underlying_spoken),
    underlying: str(t.underlying),
    underlying_alternatives: Array.isArray(t.underlying_alternatives)
      ? t.underlying_alternatives.map((x) => String(x))
      : [],
    name_confidence: num(t.name_confidence),
    option_type: str(t.option_type),
    strike_price: num(t.strike_price),
    expiry_hint: str(t.expiry_hint),
    side: str(t.side),
    quantity_value: num(t.quantity_value),
    quantity_unit: str(t.quantity_unit),
    price: num(t.price),
    price_type: str(t.price_type),
    product_hint: str(t.product_hint),
    trade_initiator: str(t.trade_initiator),
    recommendation_source: str(t.recommendation_source),
    customer_consent: str(t.customer_consent),
    consent_is_explicit: bool(t.consent_is_explicit),
    consent_quote: str(t.consent_quote),
    consent_ts: intOrNull(t.consent_ts),
    trade_phase: str(t.trade_phase),
    action_taken: bool(t.action_taken),
    stop_loss_mentioned: bool(t.stop_loss_mentioned),
    stop_loss_value: num(t.stop_loss_value),
    target_mentioned: bool(t.target_mentioned),
    target_value: num(t.target_value),
    conditional_exit: bool(t.conditional_exit),
    evidence_quote: str(t.evidence_quote),
    evidence_ts: intOrNull(t.evidence_ts),
    extraction_confidence: num(t.extraction_confidence),
  };
}

function buildCall(env: Envelope, callId: string, raw: unknown) {
  const c = env.call as Record<string, unknown>;
  return {
    call_id: callId,
    advisor_name_stated: str(c.advisor_name_stated),
    right_party: str(c.right_party),
    client_age_stated: intOrNull(c.client_age_stated),
    primary_topic: str(c.primary_topic),
    unconditional_assurance_given: bool(c.unconditional_assurance_given),
    assurance_quote: str(c.assurance_quote),
    misinformation_suspected: bool(c.misinformation_suspected),
    raw_payload: raw as Prisma.InputJsonValue,
    trades: { create: env.trades.map((t, i) => buildTrade(t as Record<string, unknown>, i)) },
  };
}

function isDuplicate(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function ingestOne(raw: unknown) {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "validation_failed" as const,
      call_id: null,
      issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
    };
  }

  const callId = resolveCallId(parsed.data, raw);
  const data = buildCall(parsed.data, callId, raw);

  try {
    const created = await prisma.call.create({
      data,
      select: { call_id: true, _count: { select: { trades: true } } },
    });
    return { status: "created" as const, call_id: created.call_id, trades: created._count.trades };
  } catch (err) {
    if (isDuplicate(err)) return { status: "duplicate" as const, call_id: callId };
    console.error(err);
    return { status: "error" as const, call_id: callId };
  }
}

export async function POST(req: NextRequest) {
  const denied = requireAuth(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── BULK: array of envelopes ───────────────────────────────────────────────
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return NextResponse.json({ error: "Array must not be empty" }, { status: 400 });
    }
    const results = await Promise.all(
      body.map(async (item, index) => ({ index, ...(await ingestOne(item)) }))
    );
    const created = results.filter((r) => r.status === "created").length;
    const duplicates = results.filter((r) => r.status === "duplicate").length;
    const failed = results.filter((r) => r.status === "validation_failed" || r.status === "error").length;
    return NextResponse.json(
      { total: body.length, created, duplicates, failed, results },
      { status: 207 }
    );
  }

  // ── SINGLE: one envelope ───────────────────────────────────────────────────
  const result = await ingestOne(body);
  if (result.status === "validation_failed") {
    return NextResponse.json({ error: "Validation failed", issues: result.issues }, { status: 400 });
  }
  if (result.status === "duplicate") {
    return NextResponse.json({ error: "call already exists", call_id: result.call_id }, { status: 409 });
  }
  if (result.status === "error") {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  return NextResponse.json(
    { received: true, call_id: result.call_id, trades: result.trades },
    { status: 201 }
  );
}
