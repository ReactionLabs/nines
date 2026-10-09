import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { normalizeIncoming, pushBus, persistEvents } from "@/lib/stream/events";

/**
 * POST /api/stream-ingest — authenticated event intake for our own
 * stream ingestor (ingestor/ingestor.py, same machine).
 *
 * Body: { events: [{ topic|type, ts|at, mint?, data? }, ...] } (max 1000)
 * Auth:  Authorization: Bearer <STREAM_INGEST_TOKEN> (timing-safe compare)
 *
 * Events are normalized, pushed to the in-memory bus, and persisted
 * best-effort to Neon Postgres (the durable cross-instance plane). The
 * `persisted` flag in the response tells the ingestor whether the write
 * is durable; without STREAM_DB_URL set it is best-effort only.
 *
 * 200 { ok, accepted, persisted } · 400 bad body · 401 bad token · 429 rate limited
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EVENTS = 1000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120; // our own ingestor: generous but bounded
const rateHits = new Map<string, { count: number; reset: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const h = rateHits.get(ip);
  if (!h || now > h.reset) {
    rateHits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    return false;
  }
  h.count += 1;
  return h.count > RATE_MAX;
}

function authorized(req: NextRequest): boolean {
  const token = process.env.STREAM_INGEST_TOKEN;
  if (!token) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  // Fixed-length compare to avoid length oracle.
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const raw = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(raw)) {
    return NextResponse.json(
      { error: "expected { events: [...] }" },
      { status: 400 }
    );
  }

  const events = normalizeIncoming(raw).slice(0, MAX_EVENTS);
  pushBus(events);

  let persisted = false;
  if (events.length > 0) {
    persisted = await persistEvents(events);
  }

  return NextResponse.json({
    ok: true,
    accepted: events.length,
    persisted,
  });
}
