/**
 * v1 bot API: candles.
 *
 * GET /api/v1/candles?mint={mint}&tf={tf}
 *   tf: 1m | 5m | 15m | 1H            -> historical OHLCV (GeckoTerminal)
 *       1s | 5s | 15s | 30s           -> live tick candles (our tick engine)
 * -> { ok, mint, tf, source: "history"|"ticks", candles[], ... }
 *
 * History candles are reliable and complete. Tick candles aggregate from
 * the live tick engine; on serverless the tick registry is per-instance, so
 * treat sub-minute candles as best-effort and prefer /api/v1/ticks for
 * streaming prices (aggregate client-side, as the dashboard does).
 *
 * Auth: X-API-Key header or ?key= (see docs/api-v1.md).
 */
export const dynamic = "force-dynamic";

import { pollTick, tickCandles, validMint, TF_SECONDS } from "@/lib/tick-engine";
import { fetchHistoryCandles, isHistoryTf } from "@/lib/history-candles";
import { v1err } from "@/lib/bot-auth";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mint = (searchParams.get("mint") ?? "").trim();
  const tf = (searchParams.get("tf") ?? "5m").trim();
  if (!validMint(mint)) {
    return v1err("invalid_mint", "mint must be a 32-44 char base58 address", 400);
  }

  if (isHistoryTf(tf)) {
    try {
      const { candles, pool } = await fetchHistoryCandles(mint, tf);
      return Response.json(
        {
          ok: true,
          mint,
          tf,
          source: "history",
          pool,
          count: candles.length,
          candles,
        },
        { headers: { "Cache-Control": "public, max-age=30" } }
      );
    } catch (e) {
      const rateLimited =
        (e as { rateLimited?: boolean })?.rateLimited === true;
      return v1err(
        rateLimited ? "rate_limited" : "upstream_error",
        rateLimited ? "chart provider rate limited" : "candles unreachable",
        rateLimited ? 429 : 502
      );
    }
  }

  if (TF_SECONDS[tf]) {
    const tick = await pollTick(mint);
    const { candles, tickCount, lastTickAgeMs } = tickCandles(mint, tf);
    return Response.json(
      {
        ok: true,
        mint,
        tf,
        source: "ticks",
        tickSource: tick.source,
        tickCount,
        lastTickAgeMs,
        degraded: tick.degraded,
        count: candles.length,
        candles,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  return v1err(
    "invalid_tf",
    "tf must be one of: 1s, 5s, 15s, 30s, 1m, 5m, 15m, 1H",
    400
  );
}
