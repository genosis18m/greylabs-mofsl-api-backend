import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

// Constant-time string compare so the token can't be guessed by timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Gate a request behind the API token.
 *
 * Accepts the token either as `x-api-key: <token>` or `Authorization: Bearer <token>`.
 * Returns a NextResponse (401/500) if the caller is NOT allowed, or `null` if allowed.
 *
 * Fails CLOSED: if API_KEY is not configured on the server, every request is rejected.
 *
 * Usage at the top of a handler:
 *   const denied = requireAuth(req);
 *   if (denied) return denied;
 */
export function requireAuth(req: NextRequest): NextResponse | null {
  const expected = process.env.API_KEY;
  if (!expected) {
    return NextResponse.json(
      { error: "Server misconfigured: API_KEY is not set" },
      { status: 500 }
    );
  }

  const fromHeader = req.headers.get("x-api-key");
  const fromBearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const provided = fromHeader ?? fromBearer ?? "";

  if (!provided || !safeEqual(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
