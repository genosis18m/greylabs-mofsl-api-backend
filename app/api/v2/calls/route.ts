import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth";
import { Prisma } from "@prisma/client";

// GET /api/v2/calls — pull stored calls with their nested trades.
// Auth required (x-api-key or Authorization: Bearer).
//
// Query params (all optional):
//   page, limit            pagination (limit max 200, default 50)
//   call_id                exact match
//   primary_topic          exact match
//   right_party            exact match
//   underlying             trades whose underlying contains this (case-insensitive)
//   side                   BUY / SELL — calls that have a trade with this side
//   date_from, date_to     filter on createdAt (ISO date/time)
export async function GET(req: NextRequest) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const { searchParams } = req.nextUrl;

  const call_id       = searchParams.get("call_id")       ?? undefined;
  const primary_topic = searchParams.get("primary_topic") ?? undefined;
  const right_party   = searchParams.get("right_party")   ?? undefined;
  const underlying    = searchParams.get("underlying")    ?? undefined;
  const side          = searchParams.get("side")          ?? undefined;
  const date_from     = searchParams.get("date_from")     ?? undefined;
  const date_to       = searchParams.get("date_to")       ?? undefined;

  const page  = Math.max(1, parseInt(searchParams.get("page")  ?? "1",  10));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
  const skip  = (page - 1) * limit;

  const tradeSome: Prisma.TradeWhereInput = {
    ...(underlying && { underlying: { contains: underlying, mode: "insensitive" } }),
    ...(side && { side: side.toUpperCase() }),
  };

  const where: Prisma.CallWhereInput = {
    ...(call_id && { call_id }),
    ...(primary_topic && { primary_topic }),
    ...(right_party && { right_party }),
    ...(Object.keys(tradeSome).length > 0 && { trades: { some: tradeSome } }),
    ...(date_from || date_to
      ? {
          createdAt: {
            ...(date_from && { gte: new Date(date_from) }),
            ...(date_to && { lte: new Date(date_to) }),
          },
        }
      : {}),
  };

  const [records, total] = await Promise.all([
    prisma.call.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: { trades: { orderBy: { position_index: "asc" } } },
    }),
    prisma.call.count({ where }),
  ]);

  return NextResponse.json({
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    data: records,
  });
}
