/**
 * Tick feed control plane.
 *
 * GET  ?mint=   -> sample one tick (drives the feed), return live price +
 *                 session stats. Called ~1/s by an open drawer on a
 *                 sub-minute timeframe; the upstream fetch is throttled to
 *                 1/s per mint server-side and shared across viewers.
 * POST {mint}   -> unsubscribe (drawer closed). Best-effort; the engine's
 *                 3-minute idle TTL is the backstop.
 *
 * behind the session gate like every /api/* route (see middleware.ts).
 */
export const dynamic = "force-dynamic";

import { pollTick, unsubscribeMint, validMint, TICK_TFS } from "@/lib/tick-engine";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mint = (searchParams.get("mint") ?? "").trim();
  if (!validMint(mint)) {
    return Response.json({ ok: false, reason: "invalid mint" }, { status: 400 });
  }
  const r = await pollTick(mint);
  return Response.json(
    {
      ok: true,
      mint,
      price: r.price,
      source: r.source,
      tickCount: r.tickCount,
      cached: r.cached,
      degraded: r.degraded,
      activeMints: r.activeMints,
      serverTime: Date.now(),
      subMinuteTimeframes: TICK_TFS,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  const d = (await req.json().catch(() => null)) as { mint?: unknown } | null;
  const mint = typeof d?.mint === "string" ? d.mint.trim() : "";
  if (!validMint(mint)) {
    return Response.json({ ok: false, reason: "invalid mint" }, { status: 400 });
  }
  const removed = unsubscribeMint(mint);
  return Response.json({ ok: true, mint, unsubscribed: removed });
}
