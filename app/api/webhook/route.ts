import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

const auditParamSchema = z.object({
  audit_parameter_name: z.string(),
  answer: z.string(),
  justification: z.string().optional(),
  audit_parameter_category_name: z.string().optional(),
});

const detailSchema = z.object({
  id: z.union([z.string(), z.number()]),
  agent: z.union([z.string(), z.number()]),
  total_call_duration: z.number(),
  time: z.string(),
  client_metadata: z.object({
    clientcode: z.string(),
    empcode: z.union([z.string(), z.number()]).optional(),
    recording_duration: z.union([z.string(), z.number()]).optional(),
  }),
  audit_template_parameters: z.array(auditParamSchema).optional().default([]),
  // extra top-level fields present in real payload — captured but not required
  agent_name: z.string().optional(),
  detected_language: z.string().optional(),
  call_quality_score: z.number().optional(),
  audit_compliance_score: z.number().optional(),
  transcript: z.string().optional(),
  function_calling_parameters: z.record(z.string(), z.unknown()).optional(),
});

const webhookSchema = z.object({
  status: z.string(),
  details: z.array(detailSchema).min(1),
});

type AuditParam = z.infer<typeof auditParamSchema>;

// Find a param by partial name match
function findParam(params: AuditParam[], keyword: string): AuditParam | undefined {
  return params.find((p) =>
    p.audit_parameter_name.toLowerCase().includes(keyword.toLowerCase())
  );
}

// Detect stock name — tries justification text first, then transcript
function extractStockName(
  params: AuditParam[],
  transcript?: string
): string {
  const sources = [
    ...params.map((p) => p.justification ?? ""),
    transcript ?? "",
  ];

  for (const text of sources) {
    if (!text) continue;
    // "Bharat Floor", "Bharat Forge" etc.
    const compoundMatch = text.match(/\b(Bharat\s+(?:Floor|Forge|Petroleum|Electronics|Heavy|Financial)?)\b/i);
    if (compoundMatch) return compoundMatch[1].trim();

    // Common tickers / company names
    const tickerMatch = text.match(
      /\b(NIFTY|BANKNIFTY|SBI|RELIANCE|TCS|HDFC|INFOSYS|ICICI|AXIS|WIPRO|ITC|LT|ONGC|NTPC|COAL\s*INDIA|ADANI\s*\w+|[A-Z]{3,6})\b/
    );
    if (tickerMatch) return tickerMatch[1];
  }
  return "unknown";
}

// Detect target value — scans all justifications for a number near the word "target"
function extractTargetValue(params: AuditParam[]): string {
  for (const p of params) {
    if (!p.justification) continue;
    const match = p.justification.match(
      /target[^\d]{0,20}(\d[\d,.]+)|(\d[\d,.]+)[^\d]{0,20}target/i
    );
    if (match) return (match[1] || match[2]).replace(/,/g, "");
  }
  return "0";
}

// Detect stop loss value — scans for SL / stop.loss near a number
function extractStopLossValue(params: AuditParam[]): string {
  for (const p of params) {
    if (!p.justification) continue;
    const match = p.justification.match(
      /(?:stop.?loss|SL|sl)[^\d]{0,20}(\d[\d,.]+)|(\d[\d,.]+)[^\d]{0,20}(?:stop.?loss|SL)/i
    );
    if (match) return (match[1] || match[2]).replace(/,/g, "");
  }
  return "0";
}

// Detect trade type (BUY / SELL / HOLD) from justification and transcript
function extractTradeType(params: AuditParam[], transcript?: string): string {
  const combined = [
    ...params.map((p) => p.justification ?? ""),
    transcript ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (/\bsell\b|बेच|selling/.test(combined)) return "SELL";
  if (/\bbuy\b|खरीद|buying/.test(combined)) return "BUY";
  if (/\bhold\b|होल्ड/.test(combined)) return "HOLD";
  return "unknown";
}

// Detect customer consent from transcript and justifications
function extractCustomerConsent(params: AuditParam[], transcript?: string): string {
  const combined = [
    ...params.map((p) => p.justification ?? ""),
    transcript ?? "",
  ]
    .join(" ")
    .toLowerCase();

  // Hindi/English consent signals
  if (/ठीक है|हाँ|हां|agreed|yes|okay|ok|sure|bilkul|बिल्कुल/.test(combined))
    return "yes";
  if (/no|nahi|नहीं|refused|disagree/.test(combined)) return "no";
  return "unknown";
}

// Detect duration horizon from pitch type (intraday / short / medium / long)
function extractDurationHorizon(params: AuditParam[]): string {
  const pitchParam = findParam(params, "in-house call pitch");
  if (!pitchParam?.justification) return "short";

  const j = pitchParam.justification.toLowerCase();
  if (/intraday|इंट्राडे/.test(j)) return "intraday";
  if (/long.term|long term|दीर्घकालिक/.test(j)) return "long";
  if (/medium|मध्यम/.test(j)) return "medium";
  return "short"; // technical calls default to short
}

// Detect contract type (equity / options / futures)
function extractContractType(params: AuditParam[], transcript?: string): string {
  const combined = [
    ...params.map((p) => p.justification ?? ""),
    transcript ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (/option|call option|put option|strike/.test(combined)) return "options";
  if (/future|fut\b|फ्यूचर/.test(combined)) return "futures";
  return "equity";
}

function mapToCallRecord(detail: z.infer<typeof detailSchema>) {
  const params = detail.audit_template_parameters;
  const transcript = detail.transcript;

  const pitchParam = findParam(params, "in-house call pitch");
  const pitchAnswer = pitchParam?.answer?.toLowerCase() ?? "na";

  // SL mentioned = Excellent or Good rating on pitch
  const stopLossMentioned =
    pitchAnswer === "excellent" || pitchAnswer === "good" ? "yes" : "no";

  // Target mentioned = anything other than NA or Poor
  const targetMentioned =
    pitchAnswer !== "na" && pitchAnswer !== "poor" ? "yes" : "no";

  return {
    call_id: String(detail.id),
    advisor_code: String(detail.client_metadata.empcode ?? detail.agent),
    client_code: detail.client_metadata.clientcode,
    timestamp: detail.time,
    duration_sec: String(
      detail.total_call_duration ||
        detail.client_metadata.recording_duration ||
        0
    ),
    stock_name: extractStockName(params, transcript),
    price: "0",
    quantity: "0",
    trade_type: extractTradeType(params, transcript),
    customer_consent: extractCustomerConsent(params, transcript),
    trade_initiator: "advisor",
    stop_loss_mentioned: stopLossMentioned,
    target_price_mentioned: targetMentioned,
    target_value: extractTargetValue(params),
    stop_loss_value: extractStopLossValue(params),
    contract_type: extractContractType(params, transcript),
    strike_price: "0",
    expiry_date: "NA",
    duration_horizon: extractDurationHorizon(params),
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
        return {
          index,
          call_id: created.call_id,
          status: "created" as const,
          extracted: {
            stock_name: record.stock_name,
            trade_type: record.trade_type,
            customer_consent: record.customer_consent,
            target_value: record.target_value,
            stop_loss_value: record.stop_loss_value,
            contract_type: record.contract_type,
            duration_horizon: record.duration_horizon,
          },
        };
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
