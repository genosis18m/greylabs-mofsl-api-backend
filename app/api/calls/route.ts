import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  // Filters
  const advisor_code = searchParams.get("advisor_code") ?? undefined;
  const client_code = searchParams.get("client_code") ?? undefined;
  const stock_name = searchParams.get("stock_name") ?? undefined;
  const trade_type = searchParams.get("trade_type") ?? undefined;
  const customer_consent = searchParams.get("customer_consent") ?? undefined;
  const date_from = searchParams.get("date_from") ?? undefined;
  const date_to = searchParams.get("date_to") ?? undefined;

  // Pagination
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(500, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
  const skip = (page - 1) * limit;

  const where: Prisma.CallRecordWhereInput = {
    ...(advisor_code && { advisor_code }),
    ...(client_code && { client_code }),
    ...(trade_type && { trade_type: trade_type.toUpperCase() }),
    ...(customer_consent && { customer_consent }),
    ...(stock_name && {
      stock_name: { contains: stock_name, mode: "insensitive" },
    }),
    ...(date_from || date_to
      ? {
          timestamp: {
            ...(date_from && { gte: date_from }),
            ...(date_to && { lte: date_to }),
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
      select: {
        id: true,
        call_id: true,
        advisor_code: true,
        client_code: true,
        timestamp: true,
        duration_sec: true,
        stock_name: true,
        price: true,
        quantity: true,
        trade_type: true,
        customer_consent: true,
        trade_initiator: true,
        stop_loss_mentioned: true,
        target_price_mentioned: true,
        target_value: true,
        stop_loss_value: true,
        contract_type: true,
        strike_price: true,
        expiry_date: true,
        duration_horizon: true,
        createdAt: true,
      },
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
