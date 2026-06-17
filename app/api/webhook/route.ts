import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

// Shape of the incoming call analytics payload
const auditParamSchema = z.object({
  audit_parameter_name: z.string(),
  answer: z.string(),
  justification: z.string().optional(),
});

const detailSchema = z.object({
  id: z.union([z.string(), z.number()]),
  agent: z.union([z.string(), z.number()]),
  total_call_duration: z.number(),
  time: z.string(),
  client_metadata: z.object({
    clientcode: z.string(),
    empcode: z.union([z.string(), z.number()]).optional(),
  }),
  audit_template_parameters: z.array(auditParamSchema).optional().default([]),
});

const webhookSchema = z.object({
  status: z.string(),
  details: z.array(detailSchema).min(1),
});

// Extract a named audit parameter's answer
function getAuditAnswer(
  params: z.infer<typeof auditParamSchema>[],
  name: string
): string {
  const p = params.find((p) =>
    p.audit_parameter_name.toLowerCase().includes(name.toLowerCase())
  );
  return p ? p.answer.toLowerCase() : "unknown";
}

// Pull stock name from audit justifications — looks for a capitalised ticker/company name
function extractStockName(params: z.infer<typeof auditParamSchema>[]): string {
  for (const p of params) {
    if (!p.justification) continue;
    // Look for patterns like "Bharat", "SBI", "RELIANCE", "NIFTY" etc.
    const match = p.justification.match(
      /\b(Bharat(?:\s+\w+)?|NIFTY|SBI|RELIANCE|TCS|HDFC|INFOSYS|ICICI|AXIS|WIPRO|[A-Z]{2,}(?:\s+[A-Z]{2,})?)\b/
    );
    if (match) return match[1];
  }
  return "unknown";
}

// Pull target value from justifications
function extractTargetValue(params: z.infer<typeof auditParamSchema>[]): string {
  for (const p of params) {
    if (!p.justification) continue;
    // Matches patterns like "target of 2200", "2200 target", "target रहेगा 2200"
    const match = p.justification.match(/target[^\d]*(\d[\d,.]+)|(\d[\d,.]+)[^\d]*target/i);
    if (match) return (match[1] || match[2]).replace(/,/g, "");
  }
  return "0";
}

function mapToCallRecord(detail: z.infer<typeof detailSchema>) {
  const params = detail.audit_template_parameters;

  const pitchParam = params.find((p) =>
    p.audit_parameter_name.toLowerCase().includes("in-house call pitch")
  );

  const stopLossMentioned =
    pitchParam?.answer?.toLowerCase() === "excellent" ||
    pitchParam?.answer?.toLowerCase() === "good"
      ? "yes"
      : "no";

  const targetMentioned =
    pitchParam?.answer?.toLowerCase() !== "na" &&
    pitchParam?.answer?.toLowerCase() !== "poor"
      ? "yes"
      : "no";

  const consentAnswer = getAuditAnswer(params, "customer");
  const customerConsent =
    consentAnswer === "na" || consentAnswer === "yes" ? "yes" : "no";

  return {
    call_id: String(detail.id),
    advisor_code: String(detail.client_metadata.empcode ?? detail.agent),
    client_code: detail.client_metadata.clientcode,
    timestamp: detail.time,
    duration_sec: String(detail.total_call_duration),
    stock_name: extractStockName(params),
    price: "0",
    quantity: "0",
    trade_type: "BUY",
    customer_consent: customerConsent,
    trade_initiator: "advisor",
    stop_loss_mentioned: stopLossMentioned,
    target_price_mentioned: targetMentioned,
    target_value: extractTargetValue(params),
    stop_loss_value: "0",
    contract_type: "equity",
    strike_price: "0",
    expiry_date: "NA",
    duration_horizon: "short",
  };
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Unexpected payload shape",
        issues: parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 }
    );
  }

  const results = await Promise.all(
    parsed.data.details.map(async (detail, index) => {
      const record = mapToCallRecord(detail);
      try {
        const created = await prisma.callRecord.create({ data: record });
        return { index, call_id: created.call_id, status: "created" as const };
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          return { index, call_id: record.call_id, status: "duplicate" as const };
        }
        console.error(err);
        return { index, call_id: record.call_id, status: "error" as const };
      }
    })
  );

  const created = results.filter((r) => r.status === "created").length;
  const duplicates = results.filter((r) => r.status === "duplicate").length;
  const failed = results.filter((r) => r.status === "error").length;

  return NextResponse.json(
    { total: parsed.data.details.length, created, duplicates, failed, results },
    { status: 207 }
  );
}
