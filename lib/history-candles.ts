/* Historical OHLCV for the v1 bot API, via GeckoTerminal (no key).
 *
 * Same source and shaping as the dashboard's /api/candles history path:
 * token -> top pool -> real OHLCV, newest-first normalized to ascending.
 * Kept as a separate module so the dashboard route stays untouched.
 */

export interface HistCandle {
  time: number; // unix seconds, ascending
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const TF_MAP: Record<string, { tf: string; aggregate: number }> = {
  "1m": { tf: "minute", aggregate: 1 },
  "5m": { tf: "minute", aggregate: 5 },
  "15m": { tf: "minute", aggregate: 15 },
  "1h": { tf: "hour", aggregate: 1 },
  "1H": { tf: "hour", aggregate: 1 },
};

export function isHistoryTf(tf: string): boolean {
  return tf in TF_MAP;
}

async function gt(path: string): Promise<unknown> {
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

export async function fetchHistoryCandles(
  mint: string,
  tfKey: string
): Promise<{ candles: HistCandle[]; pool: string }> {
  const tfm = TF_MAP[tfKey] ?? TF_MAP["5m"];
  const tok = (await gt(`/networks/solana/tokens/${mint}`)) as {
    data?: { relationships?: { top_pools?: { data?: Array<{ id?: string }> } } };
  };
  const pools = tok?.data?.relationships?.top_pools?.data ?? [];
  if (pools.length === 0 || !pools[0].id) {
    return { candles: [], pool: "" };
  }
  const poolId = pools[0].id as string;
  const poolAddr = poolId.includes("_")
    ? poolId.split("_").slice(1).join("_")
    : poolId;
  const ohlcv = (await gt(
    `/networks/solana/pools/${poolAddr}/ohlcv/${tfm.tf}?aggregate=${tfm.aggregate}&limit=200`
  )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  const rows: number[][] = ohlcv?.data?.attributes?.ohlcv_list ?? [];
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
  return { candles, pool: poolAddr };
}
