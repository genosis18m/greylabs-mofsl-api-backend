import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth";
import { Prisma } from "@prisma/client";

const stringOrNumber = z.union([z.string().min(1), z.number()]);

const callSchema = z.object({
  call_id: stringOrNumber,
  advisor_code: z.string().min(1),
  client_code: z.string().min(1),
  timestamp: z.string().min(1),
  duration_sec: stringOrNumber,
  stock_name: z.string().min(1),
  price: stringOrNumber,
  quantity: stringOrNumber,
  trade_type: z.string().min(1),
  customer_consent: z.string().min(1),
  trade_initiator: z.string().min(1),
  stop_loss_mentioned: z.string().min(1),
  target_price_mentioned: z.string().min(1),
  target_value: stringOrNumber,
  stop_loss_value: stringOrNumber,
  contract_type: z.string().min(1),
  strike_price: stringOrNumber,
  expiry_date: z.string().min(1),
  duration_horizon: z.string().min(1),
});

function toRecord(data: z.infer<typeof callSchema>) {
  return {
    call_id: String(data.call_id),
    advisor_code: data.advisor_code,
    client_code: data.client_code,
    timestamp: data.timestamp,
    duration_sec: String(data.duration_sec),
    stock_name: data.stock_name,
    price: String(data.price),
    quantity: String(data.quantity),
    trade_type: data.trade_type,
    customer_consent: data.customer_consent,
    trade_initiator: data.trade_initiator,
    stop_loss_mentioned: data.stop_loss_mentioned,
    target_price_mentioned: data.target_price_mentioned,
    target_value: String(data.target_value),
    stop_loss_value: String(data.stop_loss_value),
    contract_type: data.contract_type,
    strike_price: String(data.strike_price),
    expiry_date: data.expiry_date,
    duration_horizon: data.duration_horizon,
  };
}

function isDuplicate(err: unknown) {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
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

  // ── BULK: array ──────────────────────────────────────────────────────────
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return NextResponse.json({ error: "Array must not be empty" }, { status: 400 });
    }

    const parsed = body.map((item, index) => {
      const result = callSchema.safeParse(item);
      if (!result.success) {
        return {
          index,
          call_id: null,
          status: "validation_failed" as const,
          issues: result.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        };
      }
      return { index, data: result.data };
    });

    const results = await Promise.all(
      parsed.map(async (item) => {
        if ("issues" in item) return item;

        const record = toRecord(item.data);
        try {
          const created = await prisma.callRecord.create({ data: record });
          return { index: item.index, call_id: created.call_id, status: "created" as const };
        } catch (err) {
          if (isDuplicate(err)) {
            return { index: item.index, call_id: record.call_id, status: "duplicate" as const };
          }
          console.error(err);
          return { index: item.index, call_id: record.call_id, status: "error" as const };
        }
      })
    );

    const created = results.filter((r) => r.status === "created").length;
    const duplicates = results.filter((r) => r.status === "duplicate").length;
    const failed = results.filter((r) => r.status === "validation_failed" || r.status === "error").length;

    return NextResponse.json(
      { total: body.length, created, duplicates, failed, results },
      { status: 207 }
    );
  }

  // ── SINGLE: object ───────────────────────────────────────────────────────
  const result = callSchema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      field: i.path.join("."),
      message: i.message,
    }));
    return NextResponse.json({ error: "Validation failed", issues }, { status: 400 });
  }

  const record = toRecord(result.data);

  try {
    const created = await prisma.callRecord.create({ data: record });
    return NextResponse.json({ received: true, call_id: created.call_id }, { status: 201 });
  } catch (err) {
    if (isDuplicate(err)) {
      return NextResponse.json({ error: "call_id already exists" }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
