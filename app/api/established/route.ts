/**
 * Established coins: curated blue-chip meme coins.
 * GET /api/established
 * -> { ok, updatedAt, coins: [{ mint, symbol, name, priceUsd, mcapUsd, vol24h, change24h, imageUrl }] }
 *
 * Fetches from DexScreener. Server-side 5-min cache.
 */
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; data: unknown } | null = null;

// Curated established meme coins (Solana)
const ESTABLISHED = [
  { mint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQK9iWna", symbol: "FARTCOIN" },
  { mint: "Dz9mQ9NzkBcCsuGPFJ3r1LR78owTmpDK7NjkANNByr", symbol: "USELESS" },
  { mint: "7vfCXTUXx5WJV5JADk17b8P876Q9yMLc1jCs4Zr7zM", symbol: "POPCAT" },
  { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB", symbol: "BONK" },
  { mint: "EKpQGSJtjMFqKZ9KQan5ozUo2MNhtQRnekWJ1W5n8", symbol: "WIF" },
];

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return Response.json(
      { ok: true, cached: true, updatedAt: Math.floor(cache.at / 1000), coins: cache.data },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  }

  try {
    const mints = ESTABLISHED.map((c) => c.mint).join(",");
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mints}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    const json = await res.json();
    const pairs = json.pairs ?? [];

    // Pick the highest-liquidity pair per mint
    const byMint = new Map<string, any>();
    for (const p of pairs) {
      const addr = p.baseToken?.address;
      if (!addr) continue;
      const cur = byMint.get(addr);
      if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) {
        byMint.set(addr, p);
      }
    }

    const coins = ESTABLISHED.map((c) => {
      const p = byMint.get(c.mint);
      return {
        mint: c.mint,
        symbol: p?.baseToken?.symbol ?? c.symbol,
        name: p?.baseToken?.name ?? c.symbol,
        priceUsd: parseFloat(p?.priceUsd ?? "0"),
        mcapUsd: p?.marketCap ?? p?.fdv ?? 0,
        vol24h: p?.volume?.h24 ?? 0,
        change24h: p?.priceChange?.h24 ?? 0,
        imageUrl: p?.info?.imageUrl ?? null,
      };
    });

    cache = { at: now, data: coins };
    return Response.json(
      { ok: true, cached: false, updatedAt: Math.floor(now / 1000), coins },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  } catch (e) {
    if (cache) {
      return Response.json(
        { ok: true, cached: true, stale: true, updatedAt: Math.floor(cache.at / 1000), coins: cache.data }
      );
    }
    return Response.json({ ok: false, reason: "unreachable" }, { status: 502 });
  }
}
