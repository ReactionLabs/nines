import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { roleSignature, timingSafeEqualHex } from "./lib/auth";
import {
  extractKey,
  validateKey,
  checkRateLimit,
  v1err,
  V1_RATE_LIMIT_PER_MIN,
} from "./lib/bot-auth";

async function authorized(req: NextRequest): Promise<boolean> {
  const role = req.cookies.get("tyck_role")?.value;
  const sig = req.cookies.get("tyck_sig")?.value;
  if (role !== "dip" && role !== "johnny") return false;
  if (!sig) return false;
  try {
    const expected = await roleSignature(role);
    return timingSafeEqualHex(sig, expected);
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  // v1 bot API: API key auth + per-key rate limiting. Separate from the
  // cookie-based dashboard auth below, which stays exactly as-is.
  if (req.nextUrl.pathname.startsWith("/api/v1/")) {
    const key = extractKey(req);
    if (!key) {
      return v1err(
        "unauthorized",
        "missing API key: send X-API-Key header or ?key=",
        401
      );
    }
    const keyId = await validateKey(key);
    if (!keyId) {
      return v1err("unauthorized", "invalid API key", 401);
    }
    const retryAfter = checkRateLimit(keyId);
    if (retryAfter !== null) {
      const r = v1err(
        "rate_limited",
        `rate limit exceeded (${V1_RATE_LIMIT_PER_MIN} req/min)`,
        429
      );
      r.headers.set("Retry-After", String(retryAfter));
      return r;
    }
    return NextResponse.next();
  }

  if (await authorized(req)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api")) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!api/login|api/auth/wallet|api/access-request|api/stream-ingest|login|_next/static|_next/image|favicon.ico|robots.txt).*)",
  ],
};
