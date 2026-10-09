/**
 * Wallet PnL API — GET /api/wallet/pnl?address=<base58>&refresh=1
 *
 * Server-side only. Returns cost-basis lots (from Helius swap history) and
 * current prices (DexScreener), keyed by mint. The client merges these with
 * its RPC-loaded balances and computes per-token PnL via lib/wallet-pnl.
 *
 * Auth: dashboard cookie auth via middleware (dip + johnny roles).
 * Caching: in-memory per-address, 5 min TTL. ?refresh=1 bypasses.
 * Helius key: parsed from NEXT_PUBLIC_SOLANA_RPC_URL (already public).
 */

import {
  computeLots,
  buildValueSeries,
  SOL_MINT,
  type HeliusTx,
} from "@/lib/wallet-pnl";

const HELIUS_TX_URL = "https://api.helius.xyz/v0/addresses";
const DS_BATCH = "https://api.dexscreener.com/tokens/v1/solana";
const MAX_TXNS = 400;
const PAGE = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { data: unknown; expires: number };
const cache = new Map<string, CacheEntry>();

function heliusKey(): string | null {
  const url = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "";
  const m = url.match(/[?&]api-key=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function isValidAddress(a: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
}

async function fetchTxns(address: string, key: string): Promise<HeliusTx[]> {
  const out: HeliusTx[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_TXNS / PAGE; page++) {
    const u =
      `${HELIUS_TX_URL}/${address}/transactions?api-key=${encodeURIComponent(key)}` +
      `&limit=${PAGE}` +
      (before ? `&before=${before}` : "");
    let res: Response;
    try {
      res = await fetch(u, { headers: { Accept: "application/json" } });
    } catch {
      break;
    }
    if (!res.ok) break;
    const data = (await res.json().catch(() => null)) as HeliusTx[] | null;
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    before = data[data.length - 1]?.signature;
    if (data.length < PAGE || !before) break;
  }
  return out;
}

interface PriceInfo {
  priceUsd: number | null;
  symbol: string | null;
  name: string | null;
  change24h: number | null;
  imageUrl: string | null;
}

async function fetchPrices(mints: string[]): Promise<Map<string, PriceInfo>> {
  const out = new Map<string, PriceInfo>();
  const uniq = Array.from(new Set(mints)).filter(Boolean);
  for (let i = 0; i < uniq.length; i += 30) {
    const batch = uniq.slice(i, i + 30);
    let res: Response;
    try {
      res = await fetch(`${DS_BATCH}/${batch.join(",")}`, {
        headers: { Accept: "application/json" },
      });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const pairs = (await res.json().catch(() => null)) as any[] | null;
    if (!Array.isArray(pairs)) continue;
    const best = new Map<string, any>();
    for (const p of pairs) {
      const mint = p?.baseToken?.address;
      if (!mint) continue;
      const liq = p?.liquidity?.usd ?? 0;
      if (!best.has(mint) || liq > (best.get(mint)?.liquidity?.usd ?? 0))
        best.set(mint, p);
    }
    best.forEach((p, mint) => {
      const num = (v: unknown): number | null => {
        const n = typeof v === "string" ? Number(v) : (v as number);
        return typeof n === "number" && Number.isFinite(n) ? n : null;
      };
      out.set(mint, {
        priceUsd: num(p.priceUsd),
        symbol: p?.baseToken?.symbol ?? null,
        name: p?.baseToken?.name ?? null,
        change24h: num(p?.priceChange?.h24),
        imageUrl: typeof p?.info?.imageUrl === "string" ? p.info.imageUrl : null,
      });
    });
  }
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address") ?? "";
  const refresh = url.searchParams.get("refresh") === "1";

  if (!isValidAddress(address)) {
    return Response.json({ ok: false, error: "invalid address" }, { status: 400 });
  }
  const key = heliusKey();
  if (!key) {
    return Response.json(
      { ok: false, error: "Helius RPC not configured" },
      { status: 503 }
    );
  }

  const cacheKey = `pnl:${address}`;
  if (!refresh) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      return Response.json({ ...(hit.data as object), cached: true });
    }
  }

  const txns = await fetchTxns(address, key);
  const lots = computeLots(address, txns);

  const lotMints = Array.from(lots.keys());
  const priceMap = await fetchPrices([SOL_MINT, ...lotMints]);
  const solPriceUsd = priceMap.get(SOL_MINT)?.priceUsd ?? null;

  const costs: Record<
    string,
    {
      acquired: number;
      costSol: number;
      costUsdStable: number;
      transferIn: boolean;
    }
  > = {};
  for (const mint of lotMints) {
    const lot = lots.get(mint)!;
    costs[mint] = {
      acquired: lot.acquired,
      costSol: lot.costSol,
      costUsdStable: lot.costUsdStable,
      transferIn: lot.transferIn,
    };
  }

  const prices: Record<string, PriceInfo> = {};
  priceMap.forEach((p, mint) => {
    prices[mint] = p;
  });

  const priceLookup = new Map<string, number>();
  priceMap.forEach((p, m) => {
    if (p.priceUsd !== null) priceLookup.set(m, p.priceUsd);
  });
  const series = buildValueSeries(address, txns, priceLookup, solPriceUsd);

  const body = {
    ok: true,
    address,
    computedAt: Date.now(),
    txnsScanned: txns.length,
    solPriceUsd,
    costs,
    prices,
    series,
    cached: false,
  };

  cache.set(cacheKey, { data: body, expires: Date.now() + CACHE_TTL_MS });
  if (cache.size > 50) {
    const oldest = Array.from(cache.keys())[0];
    cache.delete(oldest);
  }

  return Response.json(body);
}
