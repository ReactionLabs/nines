/**
 * Server-side candle data for the token drawer chart.
 *
 * Source: GeckoTerminal free API (no key). Flow:
 *   1. /networks/solana/tokens/{mint} -> resolve the top pool address
 *   2. /networks/solana/pools/{pool}/ohlcv/{timeframe} -> real OHLCV
 *
 * Verified 2026-10-08: returns real candles for pump.fun mints
 * (pool address = pool id after the "solana_" prefix).
 * Server-side fetch avoids CORS/adblock issues on phones.
 * Short in-memory cache; behind the session gate like every /api/* route.
 */
export const dynamic = "force-dynamic";

import { pollTick, tickCandles, TF_SECONDS } from "@/lib/tick-engine";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const TF_MAP: Record<string, { tf: string; aggregate: number }> = {
  "1m": { tf: "minute", aggregate: 1 },
  "5m": { tf: "minute", aggregate: 5 },
  "15m": { tf: "minute", aggregate: 15 },
  "1h": { tf: "hour", aggregate: 1 },
  "1H": { tf: "hour", aggregate: 1 },
};

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: unknown }>();

async function gt(path: string) {
  const res = await fetch(`https://api.geckoterminal.com/api/v2${path}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 429) {
    const err = new Error("rate limited") as Error & { rateLimited?: boolean };
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`geckoterminal ${res.status}`);
  return res.json();
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mint = (searchParams.get("mint") ?? "").trim();
  const tfKey = searchParams.get("tf") ?? "5m";

  if (!MINT_RE.test(mint)) {
    return Response.json({ ok: false, reason: "invalid mint" }, { status: 400 });
  }

  // Sub-minute timeframes: served from our own live tick engine, never
  // from history (no free API serves sub-minute candles). Every call also
  // samples one tick, so the chart's 1s refresh loop IS the feed driver.
  // Nothing is synthesized or backfilled: a fresh session starts empty.
  if (TF_SECONDS[tfKey]) {
    const tick = await pollTick(mint);
    const { candles, tickCount, lastTickAgeMs } = tickCandles(mint, tfKey);
    return Response.json(
      {
        ok: true,
        mint,
        tf: tfKey,
        source: "ticks",
        tickSource: tick.source,
        tickCount,
        lastTickAgeMs,
        degraded: tick.degraded,
        activeMints: tick.activeMints,
        serverTime: Date.now(),
        candles,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const tfm = TF_MAP[tfKey] ?? TF_MAP["5m"];

  const cacheKey = `${mint}:${tfKey}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Response.json(hit.data, {
      headers: { "Cache-Control": "public, max-age=30" },
    });
  }

  try {
    // 1. Resolve the token's top pool.
    const tok = await gt(`/networks/solana/tokens/${mint}`);
    const pools: Array<{ id?: string }> =
      tok?.data?.relationships?.top_pools?.data ?? [];
    if (pools.length === 0 || !pools[0].id) {
      const payload = { ok: true, mint, tf: tfKey, source: "history", candles: [], reason: "no pool indexed" };
      cache.set(cacheKey, { at: Date.now(), data: payload });
      return Response.json(payload);
    }
    const poolId = pools[0].id as string;
    const poolAddr = poolId.includes("_")
      ? poolId.split("_").slice(1).join("_")
      : poolId;

    // 2. Real OHLCV for the pool.
    const ohlcv = await gt(
      `/networks/solana/pools/${poolAddr}/ohlcv/${tfm.tf}?aggregate=${tfm.aggregate}&limit=200`
    );
    const rows: number[][] =
      ohlcv?.data?.attributes?.ohlcv_list ?? [];
    // GeckoTerminal returns newest-first; Lightweight Charts requires
    // ascending time order (descending data silently breaks rendering).
    // Also drop malformed rows and duplicate timestamps defensively.
    const candles = rows
      .map((r) => ({
        time: r[0],
        open: r[1],
        high: r[2],
        low: r[3],
        close: r[4],
        volume: r[5],
      }))
      .filter(
        (c) =>
          Number.isFinite(c.time) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)
      )
      .sort((a, b) => a.time - b.time)
      .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);
    const payload = { ok: true, mint, tf: tfKey, source: "history", pool: poolAddr, candles };
    cache.set(cacheKey, { at: Date.now(), data: payload });
    return Response.json(payload, {
      headers: { "Cache-Control": "public, max-age=30" },
    });
  } catch (e) {
    const rateLimited = (e as { rateLimited?: boolean })?.rateLimited === true;
    return Response.json(
      { ok: false, reason: rateLimited ? "rate limited" : "candles unreachable" },
      { status: rateLimited ? 429 : 502 }
    );
  }
}
