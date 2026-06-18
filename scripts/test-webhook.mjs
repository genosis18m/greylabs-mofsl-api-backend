/**
 * Webhook edge-case test suite — run against local dev server
 * Usage: node scripts/test-webhook.mjs
 */

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

// unique prefix per run so re-running never hits duplicate call_ids
const RUN = Date.now().toString(36).toUpperCase();

// ── helpers ────────────────────────────────────────────────────────────────

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// ── shared builders ─────────────────────────────────────────────────────────

function makeTradeSummaryParam(fields = {}) {
  const trade = {
    stock_name: "RELIANCE",
    price: "2950",
    quantity: "10",
    trade_type: "BUY",
    customer_consent: "YES",
    trade_initiator: "ADVISOR",
    stop_loss_mentioned: "YES",
    target_price_mentioned: "YES",
    target_value: "3100",
    stop_loss_value: "2850",
    contract_type: "EQ",
    strike_price: "NA",
    expiry_date: "NA",
    duration_horizon: "short",
    ...fields,
  };
  return {
    audit_parameter_name: "Trade Summary",
    answer: "```json\n" + JSON.stringify([trade]) + "\n```",
  };
}

function makeDetail(id, overrides = {}) {
  return {
    id,
    agent: "42615",
    total_call_duration: 120,
    time: "2026-06-17 10:00:00+05:30",
    client_metadata: {
      empcode: "42615",
      clientcode: "CUST" + id,
      recording_duration: "120",
    },
    audit_template_parameters: [],
    insights: { subjective_data: [] },
    transcript: "",
    ...overrides,
  };
}

function id(tag) {
  return `${RUN}_${tag}`;
}

function payload(...details) {
  return { status: "success", details };
}

// ── Test 1: Full MOFSL payload with Trade Summary (happy path) ──────────────

async function test1() {
  console.log("\nTest 1: Full Trade Summary — all fields extracted from TS");
  const { status, body } = await post("/api/webhook", payload(
    makeDetail(id("T1"), {
      insights: { subjective_data: [makeTradeSummaryParam()] },
    })
  ));

  assert("HTTP 207", status === 207);
  assert("created=1", body?.created === 1);
  const r = body?.results?.[0];
  assert("stock_name = RELIANCE",          r?.extracted?.stock_name === "RELIANCE");
  assert("trade_type = BUY",               r?.extracted?.trade_type === "BUY");
  assert("target_value = 3100",            r?.extracted?.target_value === "3100");
  assert("stop_loss_value = 2850",         r?.extracted?.stop_loss_value === "2850");
  assert("contract_type = equity (EQ→)",  r?.extracted?.contract_type === "equity");
  assert("duration_horizon = short",       r?.extracted?.duration_horizon === "short");
  assert("customer_consent = yes (YES→)", r?.extracted?.customer_consent === "yes");
}

// ── Test 2: Trade Summary all NA → NLP fallback ────────────────────────────

async function test2() {
  console.log("\nTest 2: Trade Summary all NA — falls back to NLP extraction");
  const { status, body } = await post("/api/webhook", payload(
    makeDetail(id("T2"), {
      audit_template_parameters: [
        {
          audit_parameter_name: "In-house Call Pitch with Strategy / SL / Tgt & Reasoning",
          answer: "Good",
          justification: "Agent recommended SBI at target of 650, SL at 580. Good technical call.",
        },
      ],
      transcript: "हाँ सर buy करते हैं SBI",
      insights: {
        subjective_data: [
          makeTradeSummaryParam({
            stock_name: "NA",
            trade_type: "NA",
            customer_consent: "NA",
            target_value: "NA",
            stop_loss_value: "NA",
            contract_type: "NA",
            duration_horizon: "NA",
          }),
        ],
      },
    })
  ));

  assert("HTTP 207", status === 207);
  const r = body?.results?.[0];
  assert("created",                                  r?.status === "created");
  assert("trade_type = BUY (transcript हाँ buy)",   r?.extracted?.trade_type === "BUY");
  assert("target_value = 650 (justification NLP)",  r?.extracted?.target_value === "650");
  assert("stop_loss_value = 580 (justification NLP)", r?.extracted?.stop_loss_value === "580");
  assert("customer_consent = yes (हाँ)",             r?.extracted?.customer_consent === "yes");
}

// ── Test 3: No insights at all → pure NLP fallback ────────────────────────

async function test3() {
  console.log("\nTest 3: No insights field — pure NLP fallback");
  const { status, body } = await post("/api/webhook", payload(
    makeDetail(id("T3"), {
      audit_template_parameters: [
        {
          audit_parameter_name: "Convincing Pitch & Proactive Trade Generation",
          answer: "Excellent",
          justification: "Agent pitched HDFC BUY with target 1800, SL at 1650. Great conviction shown.",
        },
      ],
      transcript: "ठीक है sir HDFC buy करते हैं",
      // intentionally omitting insights
    })
  ));

  assert("HTTP 207", status === 207);
  const r = body?.results?.[0];
  assert("created",                       r?.status === "created");
  assert("trade_type = BUY (NLP)",        r?.extracted?.trade_type === "BUY");
  assert("target_value = 1800 (NLP)",     r?.extracted?.target_value === "1800");
  assert("stop_loss_value = 1650 (NLP)",  r?.extracted?.stop_loss_value === "1650");
  assert("customer_consent = yes (ठीक है)", r?.extracted?.customer_consent === "yes");
}

// ── Test 4: Trade Summary as plain JSON (no markdown wrapper) ─────────────

async function test4() {
  console.log("\nTest 4: Trade Summary answer is raw JSON (no code block)");
  const { status, body } = await post("/api/webhook", payload(
    makeDetail(id("T4"), {
      insights: {
        subjective_data: [
          {
            audit_parameter_name: "Trade Summary",
            answer: JSON.stringify([{
              stock_name: "TCS",
              price: "4200",
              quantity: "5",
              trade_type: "SELL",
              customer_consent: "NO",
              trade_initiator: "CLIENT",
              stop_loss_mentioned: "NO",
              target_price_mentioned: "YES",
              target_value: "4000",
              stop_loss_value: "NA",
              contract_type: "EQ",
              strike_price: "NA",
              expiry_date: "NA",
              duration_horizon: "intraday",
            }]),
          },
        ],
      },
    })
  ));

  assert("HTTP 207", status === 207);
  const r = body?.results?.[0];
  assert("created",                        r?.status === "created");
  assert("stock_name = TCS",               r?.extracted?.stock_name === "TCS");
  assert("trade_type = SELL",              r?.extracted?.trade_type === "SELL");
  assert("stop_loss_value = 0 (NA→0)",     r?.extracted?.stop_loss_value === "0");
  assert("duration_horizon = intraday",    r?.extracted?.duration_horizon === "intraday");
  assert("customer_consent = no (NO→no)", r?.extracted?.customer_consent === "no");
}

// ── Test 5: Contract type normalisation ───────────────────────────────────

async function test5() {
  console.log("\nTest 5: Contract type normalisation (CE→options, FUT→futures, PE→options)");

  const { status: s1, body: b1 } = await post("/api/webhook", payload(
    makeDetail(id("T5A"), {
      insights: { subjective_data: [makeTradeSummaryParam({ contract_type: "CE", strike_price: "22000", expiry_date: "2026-06-26" })] },
    })
  ));
  assert("CE: HTTP 207",   s1 === 207);
  assert("CE → options",   b1?.results?.[0]?.extracted?.contract_type === "options");

  const { status: s2, body: b2 } = await post("/api/webhook", payload(
    makeDetail(id("T5B"), {
      insights: { subjective_data: [makeTradeSummaryParam({ contract_type: "FUT" })] },
    })
  ));
  assert("FUT: HTTP 207",  s2 === 207);
  assert("FUT → futures",  b2?.results?.[0]?.extracted?.contract_type === "futures");

  const { status: s3, body: b3 } = await post("/api/webhook", payload(
    makeDetail(id("T5C"), {
      insights: { subjective_data: [makeTradeSummaryParam({ contract_type: "PE" })] },
    })
  ));
  assert("PE: HTTP 207",   s3 === 207);
  assert("PE → options",   b3?.results?.[0]?.extracted?.contract_type === "options");
}

// ── Test 6: Duplicate call_id ──────────────────────────────────────────────

async function test6() {
  console.log("\nTest 6: Duplicate call_id → status: duplicate");
  const detail = makeDetail(id("T6_DUP"), {
    insights: { subjective_data: [makeTradeSummaryParam()] },
  });

  await post("/api/webhook", payload(detail)); // first insert
  const { status, body } = await post("/api/webhook", payload(detail)); // duplicate

  assert("HTTP 207 even for dup", status === 207);
  assert("created=0",             body?.created === 0);
  assert("duplicates=1",          body?.duplicates === 1);
  assert("result = duplicate",    body?.results?.[0]?.status === "duplicate");
}

// ── Test 7: Batch with mixed outcomes ─────────────────────────────────────

async function test7() {
  console.log("\nTest 7: Batch — new + duplicate + NLP-only in one request");
  const bId = id("T7B");

  // pre-insert B so it will be a duplicate in the batch
  await post("/api/webhook", payload(
    makeDetail(bId, { insights: { subjective_data: [makeTradeSummaryParam()] } })
  ));

  const cId = id("T7C");
  const { status, body } = await post("/api/webhook", payload(
    makeDetail(id("T7A"), { insights: { subjective_data: [makeTradeSummaryParam()] } }),
    makeDetail(bId,       { insights: { subjective_data: [makeTradeSummaryParam()] } }),
    makeDetail(cId, {
      audit_template_parameters: [{
        audit_parameter_name: "In-house Call Pitch with Strategy / SL / Tgt & Reasoning",
        answer: "Poor",
        justification: "No target or SL mentioned.",
      }],
      transcript: "बेचते हैं",
    }),
  ));

  assert("HTTP 207",         status === 207);
  assert("total = 3",        body?.total === 3);
  assert("created = 2",      body?.created === 2);
  assert("duplicates = 1",   body?.duplicates === 1);
  assert("failed = 0",       body?.failed === 0);

  const c = body?.results?.find(r => r.call_id === cId);
  assert("C trade_type = SELL (बेचते हैं NLP)", c?.extracted?.trade_type === "SELL");
}

// ── Test 8: Schema validation ──────────────────────────────────────────────

async function test8() {
  console.log("\nTest 8: Validation — malformed payloads rejected with 400");

  const { status: s1, body: b1 } = await post("/api/webhook", { details: [makeDetail("X")] });
  assert("Missing status → 400",   s1 === 400);
  assert("issues array present",   Array.isArray(b1?.issues));

  const { status: s2 } = await post("/api/webhook", { status: "success", details: [] });
  assert("Empty details → 400",    s2 === 400);

  const { status: s3 } = await post("/api/webhook", { status: "success", details: "bad" });
  assert("details not array → 400", s3 === 400);

  const res4 = await fetch(`${BASE}/api/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not json!!!",
  });
  assert("Invalid JSON body → 400", res4.status === 400);
}

// ── Test 9: Numeric id + duration fallback ────────────────────────────────

async function test9() {
  console.log("\nTest 9: Numeric id; total_call_duration=0 → recording_duration fallback");
  const numId = parseInt(RUN, 36); // unique numeric per run
  const { status, body } = await post("/api/webhook", payload({
    id: numId,
    agent: 42615,
    total_call_duration: 0,
    time: "2026-06-17 11:00:00+05:30",
    client_metadata: {
      empcode: "EMP99",
      clientcode: "CLI99",
      recording_duration: "95",
    },
    audit_template_parameters: [],
    insights: { subjective_data: [makeTradeSummaryParam()] },
  }));

  assert("HTTP 207",                     status === 207);
  const r = body?.results?.[0];
  assert(`call_id = '${numId}'`,         r?.call_id === String(numId));

  const g = await get(`/api/calls?call_id=${numId}`);
  assert("duration_sec = 95 (fallback)", g.body?.data?.[0]?.duration_sec === "95");
}

// ── Test 10: GET /api/calls filters ───────────────────────────────────────

async function test10() {
  console.log("\nTest 10: GET /api/calls — filters and pagination");

  const { body: b1 } = await get("/api/calls?advisor_code=42615&limit=5");
  assert("advisor_code filter returns data",    Array.isArray(b1?.data));
  assert("all rows match advisor_code=42615",   b1?.data?.every(r => r.advisor_code === "42615") ?? false);

  const { body: b2 } = await get("/api/calls?stock_name=reli");
  assert("stock_name partial match (insensitive)", b2?.data?.some(r => r.stock_name?.toLowerCase().includes("reli")) ?? false);

  const { body: b3 } = await get("/api/calls?trade_type=BUY&limit=100");
  assert("trade_type=BUY filter no SELL rows",  b3?.data?.every(r => r.trade_type === "BUY") ?? true);

  const { body: b4 } = await get("/api/calls?page=1&limit=2");
  assert("limit=2 respected",   (b4?.data?.length ?? 0) <= 2);
  assert("pages field present", typeof b4?.pages === "number");
  assert("total field present", typeof b4?.total === "number");
}

// ── runner ─────────────────────────────────────────────────────────────────

async function run() {
  console.log("=== Webhook Test Suite ===");
  console.log(`Run ID: ${RUN}`);
  console.log(`Target: ${BASE}/api/webhook\n`);

  try {
    await fetch(`${BASE}/api/calls`);
  } catch {
    console.error("Dev server not reachable at", BASE, "— run: npm run dev");
    process.exit(1);
  }

  await test1();
  await test2();
  await test3();
  await test4();
  await test5();
  await test6();
  await test7();
  await test8();
  await test9();
  await test10();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
