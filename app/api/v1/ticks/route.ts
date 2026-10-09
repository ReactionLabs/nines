/**
 * v1 bot API: live tick price.
 *
 * GET /api/v1/ticks?mint={mint}
 * -> { ok, mint, price, source, tickCount, degraded, serverTime }
 *
 * Stateless price sample: curve -> DexScreener -> Jupiter cascade.
 * Poll ~1/s and aggregate client-side for sub-minute candles (see
 * docs/api-v1.md). This is the recommended streaming primitive for bots.
 *
 * Auth: X-API-Key header or ?key= (see docs/api-v1.md).
 */
export const dynamic = "force-dynamic";

import { pollTick, validMint, TICK_TFS } from "@/lib/tick-engine";
import { v1err } from "@/lib/bot-auth";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mint = (searchParams.get("mint") ?? "").trim();
  if (!validMint(mint)) {
    return v1err("invalid_mint", "mint must be a 32-44 char base58 address", 400);
  }
  const r = await pollTick(mint);
  return Response.json(
    {
      ok: true,
      mint,
      price: r.price,
      source: r.source,
      tickCount: r.tickCount,
      degraded: r.degraded,
      activeMints: r.activeMints,
      serverTime: Date.now(),
      subMinuteTimeframes: TICK_TFS,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
