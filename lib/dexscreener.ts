/**
 * DexScreener enrichment (real data only).
 *
 * The scanner state.json carries no numeric price/mcap/liquidity fields,
 * only gate detail text. This module merges per-mint data from the free
 * DexScreener tokens API:
 *
 *   GET https://api.dexscreener.com/tokens/v1/solana/{m1,m2,...}  (<=30 per call)
 *
 * Tokens absent from DexScreener get nulls everywhere and the UI marks
 * figures as unavailable. Prices, mcaps, and candles are never invented.
 */

export interface EnrichedToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  mcapUsd: number | null; // marketCap, falling back to fdv
  liqUsd: number | null;
  vol24h: number | null;
  change24h: number | null; // percent
  pairUrl: string | null;
  dexId: string | null; // deepest-pair DEX id (e.g. pump, raydium)
  imageUrl: string | null; // token icon (Dex Paid tokens)
  bannerUrl: string | null; // token header art (Dex Paid tokens)
}

interface DsPair {
  pairAddress?: string;
  dexId?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string | number;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  url?: string;
  info?: {
    imageUrl?: string;
    header?: string;
    openGraph?: string;
  };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Pick the deepest pair per mint (highest liquidity) and flatten it. */
export function mergePairs(pairs: DsPair[]): Record<string, EnrichedToken> {
  const best: Record<string, DsPair> = {};
  for (const p of pairs) {
    const mint = p?.baseToken?.address;
    if (!mint) continue;
    const liq = p?.liquidity?.usd ?? 0;
    const cur = best[mint];
    if (!cur || liq > (cur.liquidity?.usd ?? 0)) best[mint] = p;
  }

  const out: Record<string, EnrichedToken> = {};
  for (const [mint, p] of Object.entries(best)) {
    const mcap = num(p.marketCap) ?? num(p.fdv);
    const info = p.info ?? {};
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.startsWith("http") ? v : null;
    out[mint] = {
      mint,
      symbol: p.baseToken?.symbol ?? null,
      name: p.baseToken?.name ?? null,
      priceUsd: num(p.priceUsd),
      mcapUsd: mcap,
      liqUsd: num(p.liquidity?.usd),
      vol24h: num(p.volume?.h24),
      change24h: num(p.priceChange?.h24),
      pairUrl: p.url ?? null,
      dexId: p.dexId ?? null,
      imageUrl: str(info.imageUrl),
      bannerUrl: str(info.header) ?? str(info.openGraph),
    };
  }
  return out;
}

/** Placeholder for a mint DexScreener has no record of. */
export function emptyEnriched(mint: string): EnrichedToken {
  return {
    mint,
    symbol: null,
    name: null,
    priceUsd: null,
    mcapUsd: null,
    liqUsd: null,
    vol24h: null,
    change24h: null,
    pairUrl: null,
    dexId: null,
    imageUrl: null,
    bannerUrl: null,
  };
}

/** Fetch one batch (<=30 mints) from the DexScreener tokens endpoint. */
export async function fetchBatch(mints: string[]): Promise<DsPair[]> {
  if (mints.length === 0) return [];
  const res = await fetch(
    `https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`
  );
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? (data as DsPair[]) : [];
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
