import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const advisor_code        = searchParams.get("advisor_code")        ?? undefined;
  const client_code         = searchParams.get("client_code")         ?? undefined;
  const call_id             = searchParams.get("call_id")             ?? undefined;
  const stock_name          = searchParams.get("stock_name")          ?? undefined;
  const trade_type          = searchParams.get("trade_type")          ?? undefined;
  const customer_consent    = searchParams.get("customer_consent")    ?? undefined;
  const trade_initiator     = searchParams.get("trade_initiator")     ?? undefined;
  const stop_loss_mentioned = searchParams.get("stop_loss_mentioned") ?? undefined;
  const target_price_mentioned = searchParams.get("target_price_mentioned") ?? undefined;
  const contract_type       = searchParams.get("contract_type")       ?? undefined;
  const duration_horizon    = searchParams.get("duration_horizon")    ?? undefined;
  const date_from           = searchParams.get("date_from")           ?? undefined;
  const date_to             = searchParams.get("date_to")             ?? undefined;

  // Pagination
  const page  = Math.max(1, parseInt(searchParams.get("page")  ?? "1",  10));
  const limit = Math.min(500, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
  const skip  = (page - 1) * limit;

  const where: Prisma.CallRecordWhereInput = {
    ...(call_id          && { call_id }),
    ...(advisor_code     && { advisor_code }),
    ...(client_code      && { client_code }),
    ...(trade_type       && { trade_type: trade_type.toUpperCase() }),
    ...(customer_consent && { customer_consent }),
    ...(trade_initiator  && { trade_initiator }),
    ...(stop_loss_mentioned && { stop_loss_mentioned }),
    ...(target_price_mentioned && { target_price_mentioned }),
    ...(contract_type    && { contract_type }),
    ...(duration_horizon && { duration_horizon }),
    ...(stock_name && {
      stock_name: { contains: stock_name, mode: "insensitive" },
    }),
    ...(date_from || date_to
      ? {
          timestamp: {
            ...(date_from && { gte: date_from }),
            ...(date_to   && { lte: date_to }),
          },
        }
      : {}),
  };

  const [records, total] = await Promise.all([
    prisma.callRecord.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.callRecord.count({ where }),
  ]);

  return NextResponse.json({
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    data: records,
  });
}
