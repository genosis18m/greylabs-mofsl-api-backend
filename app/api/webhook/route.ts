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
  client_metadata: z.record(z.string(), z.unknown()).default({}),
  audit_template_parameters: z.array(auditParamSchema).optional().default([]),
  insights: z.object({
    subjective_data: z.array(z.object({
      audit_parameter_name: z.string(),
      answer: z.string(),
    })).optional().default([]),
  }).optional(),
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
type SubjectiveParam = { audit_parameter_name: string; answer: string };

interface TradeSummaryFields {
  stock_name?: string;
  price?: string;
  quantity?: string;
  trade_type?: string;
  customer_consent?: string;
  trade_initiator?: string;
  stop_loss_mentioned?: string;
  target_price_mentioned?: string;
  target_value?: string;
  stop_loss_value?: string;
  contract_type?: string;
  strike_price?: string;
  expiry_date?: string;
  duration_horizon?: string;
}

// Parse the "Trade Summary" subjective_data param — answer is a JSON array in a markdown code block
function parseTradeSummary(subjective: SubjectiveParam[]): TradeSummaryFields | null {
  const param = subjective.find((s) =>
    s.audit_parameter_name.toLowerCase().includes("trade summary")
  );
  if (!param?.answer) return null;

  // Strip ```json ... ``` wrapper if present
  const raw = param.answer.replace(/```(?:json)?\n?/gi, "").trim();
  try {
    const parsed = JSON.parse(raw);
    const trade: Record<string, unknown> = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!trade || typeof trade !== "object") return null;
    return trade as TradeSummaryFields;
  } catch {
    return null;
  }
}

// Normalise YES/NO/NA strings to yes/no/unknown
function normaliseYesNo(v: string | undefined, fallback = "unknown"): string {
  if (!v) return fallback;
  const u = v.trim().toUpperCase();
  if (u === "YES") return "yes";
  if (u === "NO") return "no";
  return fallback;
}

// Normalise contract type: EQ → equity, FUT → futures, OPT/CE/PE → options
function normaliseContractType(v: string | undefined): string {
  if (!v) return "equity";
  const u = v.trim().toUpperCase();
  if (u === "EQ" || u === "EQUITY") return "equity";
  if (u === "FUT" || u === "FUTURES" || u === "FUTURE") return "futures";
  if (["OPT", "OPTIONS", "CE", "PE", "CALL", "PUT"].includes(u)) return "options";
  return "equity";
}

// Normalise a numeric-or-NA string to a clean number string
function normaliseNum(v: string | undefined, fallback = "0"): string {
  if (!v || v.trim().toUpperCase() === "NA" || v.trim() === "") return fallback;
  // strip commas (thousands separator) and trailing non-digit punctuation (e.g. "1650.")
  return v.replace(/,/g, "").replace(/[^\d]+$/, "").trim();
}

// Find an audit_template_parameter by partial name
function findParam(params: AuditParam[], keyword: string): AuditParam | undefined {
  return params.find((p) =>
    p.audit_parameter_name.toLowerCase().includes(keyword.toLowerCase())
  );
}

// Fallback: extract stock name from justifications + transcript
function extractStockNameFallback(params: AuditParam[], transcript?: string): string {
  const sources = [...params.map((p) => p.justification ?? ""), transcript ?? ""];
  for (const text of sources) {
    if (!text) continue;
    const compound = text.match(/\b(Bharat\s+(?:Floor|Forge|Petroleum|Electronics|Heavy|Financial)?)\b/i);
    if (compound) return compound[1].trim();
    const ticker = text.match(
      /\b(NIFTY|BANKNIFTY|SBI|RELIANCE|TCS|HDFC|INFOSYS|ICICI|AXIS|WIPRO|ITC|LT|ONGC|NTPC|COAL\s*INDIA|ADANI\s*\w+|[A-Z]{3,6})\b/
    );
    if (ticker) return ticker[1];
  }
  return "unknown";
}

// Fallback: trade type from text
function extractTradeTypeFallback(params: AuditParam[], transcript?: string): string {
  const combined = [...params.map((p) => p.justification ?? ""), transcript ?? ""]
    .join(" ").toLowerCase();
  if (/\bsell\b|बेच|selling/.test(combined)) return "SELL";
  if (/\bbuy\b|खरीद|buying/.test(combined)) return "BUY";
  if (/\bhold\b|होल्ड/.test(combined)) return "HOLD";
  return "unknown";
}

// Fallback: customer consent from transcript
function extractCustomerConsentFallback(params: AuditParam[], transcript?: string): string {
  const combined = [...params.map((p) => p.justification ?? ""), transcript ?? ""]
    .join(" ").toLowerCase();
  if (/ठीक है|हाँ|हां|agreed|yes|okay|ok|sure|bilkul|बिल्कुल/.test(combined)) return "yes";
  if (/no|nahi|नहीं|refused|disagree/.test(combined)) return "no";
  return "unknown";
}

// Fallback: target value from justifications
function extractTargetValueFallback(params: AuditParam[]): string {
  for (const p of params) {
    if (!p.justification) continue;
    const match = p.justification.match(/target[^\d]{0,20}(\d[\d,.]+)|(\d[\d,.]+)[^\d]{0,20}target/i);
    if (match) return (match[1] || match[2]).replace(/,/g, "").replace(/[^\d]+$/, "");
  }
  return "0";
}

// Fallback: stop loss value from justifications
function extractStopLossValueFallback(params: AuditParam[]): string {
  for (const p of params) {
    if (!p.justification) continue;
    if (/stop.?loss\s+(was\s+)?not\s+mention|no\s+stop.?loss|sl\s+(was\s+)?not/i.test(p.justification)) continue;
    const match = p.justification.match(/(?:stop.?loss|SL)\s+(?:at|of|is|=|:|@)?\s*(\d[\d,.]+)/i);
    if (match) return match[1].replace(/,/g, "").replace(/[^\d]+$/, "");
  }
  return "0";
}

// Fallback: duration horizon from pitch param
function extractDurationHorizonFallback(params: AuditParam[]): string {
  const pitchParam = findParam(params, "in-house call pitch");
  if (!pitchParam?.justification) return "short";
  const j = pitchParam.justification.toLowerCase();
  if (/intraday|इंट्राडे/.test(j)) return "intraday";
  if (/long.term|long term|दीर्घकालिक/.test(j)) return "long";
  if (/medium|मध्यम/.test(j)) return "medium";
  return "short";
}

// Fallback: contract type from text
function extractContractTypeFallback(params: AuditParam[], transcript?: string): string {
  const combined = [...params.map((p) => p.justification ?? ""), transcript ?? ""]
    .join(" ").toLowerCase();
  if (/option|call option|put option|strike/.test(combined)) return "options";
  if (/future|fut\b|फ्यूचर/.test(combined)) return "futures";
  return "equity";
}

function mapToCallRecord(detail: z.infer<typeof detailSchema>) {
  const params = detail.audit_template_parameters;
  const transcript = detail.transcript;
  const cm = detail.client_metadata as Record<string, unknown>;
  const subjective = detail.insights?.subjective_data ?? [];

  const str = (v: unknown) => (v != null ? String(v) : undefined);

  // advisor_code: empcode (MOFSL) → agent_id → agent field
  const advisorCode = str(cm["empcode"]) ?? str(cm["agent_id"]) ?? String(detail.agent);

  // client_code: clientcode (MOFSL) → Call_ID → customer_id → "unknown"
  const clientCode = str(cm["clientcode"]) ?? str(cm["Call_ID"]) ?? str(cm["customer_id"]) ?? "unknown";

  // duration: total_call_duration → recording_duration → call_duration
  const duration = String(
    detail.total_call_duration || cm["recording_duration"] || cm["call_duration"] || 0
  );

  // PRIMARY: parse structured Trade Summary from insights.subjective_data
  const ts = parseTradeSummary(subjective);

  // stock_name: Trade Summary → audit/transcript fallback
  const stockName = (ts?.stock_name && ts.stock_name.toUpperCase() !== "NA" && ts.stock_name !== "unknown")
    ? ts.stock_name
    : extractStockNameFallback(params, transcript);

  // trade fields — Trade Summary first, NLP fallback
  const tradeType = (ts?.trade_type && ts.trade_type.toUpperCase() !== "NA")
    ? ts.trade_type.toUpperCase()
    : extractTradeTypeFallback(params, transcript);

  const customerConsent = (ts?.customer_consent && ts.customer_consent.toUpperCase() !== "NA")
    ? normaliseYesNo(ts.customer_consent)
    : extractCustomerConsentFallback(params, transcript);

  const tradeInitiator = (ts?.trade_initiator && ts.trade_initiator.toUpperCase() !== "NA")
    ? ts.trade_initiator.toLowerCase()
    : "advisor";

  const stopLossMentioned = (ts?.stop_loss_mentioned && ts.stop_loss_mentioned.toUpperCase() !== "NA")
    ? normaliseYesNo(ts.stop_loss_mentioned)
    : (() => {
        const pitchAnswer = findParam(params, "in-house call pitch")?.answer?.toLowerCase() ?? "na";
        return pitchAnswer === "excellent" || pitchAnswer === "good" ? "yes" : "no";
      })();

  const targetMentioned = (ts?.target_price_mentioned && ts.target_price_mentioned.toUpperCase() !== "NA")
    ? normaliseYesNo(ts.target_price_mentioned)
    : (() => {
        const pitchAnswer = findParam(params, "in-house call pitch")?.answer?.toLowerCase() ?? "na";
        return pitchAnswer !== "na" && pitchAnswer !== "poor" ? "yes" : "no";
      })();

  const targetValue = (ts?.target_value && ts.target_value.toUpperCase() !== "NA")
    ? normaliseNum(ts.target_value)
    : extractTargetValueFallback(params);

  const stopLossValue = (ts?.stop_loss_value && ts.stop_loss_value.toUpperCase() !== "NA")
    ? normaliseNum(ts.stop_loss_value)
    : extractStopLossValueFallback(params);

  const contractType = ts?.contract_type
    ? normaliseContractType(ts.contract_type)
    : extractContractTypeFallback(params, transcript);

  const strikePrice = ts?.strike_price ? normaliseNum(ts.strike_price) : "0";
  const expiryDate = (ts?.expiry_date && ts.expiry_date.toUpperCase() !== "NA") ? ts.expiry_date : "NA";

  const durationHorizon = (ts?.duration_horizon && ts.duration_horizon.toUpperCase() !== "NA")
    ? ts.duration_horizon.toLowerCase()
    : extractDurationHorizonFallback(params);

  const price = (ts?.price && ts.price.toUpperCase() !== "NA") ? normaliseNum(ts.price) : "0";
  const quantity = (ts?.quantity && ts.quantity.toUpperCase() !== "NA") ? normaliseNum(ts.quantity) : "0";

  return {
    call_id: String(detail.id),
    advisor_code: advisorCode,
    client_code: clientCode,
    timestamp: detail.time,
    duration_sec: duration,
    stock_name: stockName,
    price,
    quantity,
    trade_type: tradeType,
    customer_consent: customerConsent,
    trade_initiator: tradeInitiator,
    stop_loss_mentioned: stopLossMentioned,
    target_price_mentioned: targetMentioned,
    target_value: targetValue,
    stop_loss_value: stopLossValue,
    contract_type: contractType,
    strike_price: strikePrice,
    expiry_date: expiryDate,
    duration_horizon: durationHorizon,
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
