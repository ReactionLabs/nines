/**
 * Server-side tick engine for sub-minute charts (1s / 5s / 15s / 30s).
 *
 * No free chart API serves sub-minute candles (GeckoTerminal bottoms out at
 * 1m), so we collect our own ticks: while a client has a token drawer open on
 * a sub-minute timeframe, it hits /api/candles?source=ticks once per second;
 * each hit samples one live price and appends it to a short in-memory ring
 * buffer for that mint. Candles are aggregated server-side from real ticks.
 *
 * Serverless honesty: this module lives in-memory per Vercel instance.
 * Warm instances accumulate ticks; a cold start begins an empty session and
 * the client reports "collecting live ticks…" until ticks land. Nothing is
 * ever synthesized, interpolated, or backfilled.
 *
 * Tick source cascade (best precision first): pump.fun bonding curve
 * (u64 reserves via public RPC — unlimited precision, no key) → Jupiter
 * v3 (full double precision, fallback only) → DexScreener (coarse, last
 * resort). Upstream is throttled to at most 1 fetch per mint per second,
 * shared across all viewers of the same mint.
 *
 * Staleness guard: the curve price is cross-validated against Jupiter
 * (independent source) on a 60s cadence. If they diverge >3%, the curve is
 * considered stale/frozen (graduated token, stuck RPC slot, wrong account)
 * and skipped until the verdict expires. The `complete` flag is also
 * honored inside curvePriceUsd.
 */

import { readCurveState, solPriceUsd } from "@/lib/pump-curve";

export type TickCandle = {
  time: number; // seconds epoch, ascending (Lightweight Charts contract)
  open: number;
  high: number;
  low: number;
  close: number;
};

export type TickSource = "curve" | "jupiter" | "dexscreener" | "none";

type Tick = { t: number; p: number }; // t = ms epoch, p = USD price

type MintState = {
  ticks: Tick[];
  lastPoll: number; // last client poll for this mint (idle eviction)
  lastPrice: number | null;
  lastSource: TickSource | null;
  lastUpstream: number; // last upstream fetch (1s throttle)
  inflight: Promise<number | null> | null; // shared across concurrent viewers
  degraded: boolean; // last upstream fetch failed
  /** Curve-vs-Jupiter cross-validation verdict, 60s TTL. */
  curveCheck: { ok: boolean; at: number } | null;
};

const registry = new Map<string, MintState>();

export const TICK_TFS = ["1s", "5s", "15s", "30s"] as const;
export const TF_SECONDS: Record<string, number> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "30s": 30,
};

const MAX_TICKS = 3600; // 1h at 1s cadence
const MAX_CANDLES = 300; // display cap per response
const IDLE_TTL_MS = 180_000; // drop mints with no viewers for 3 min
const UPSTREAM_MIN_MS = 1000; // at most 1 upstream fetch / mint / second
const CURVE_CHECK_TTL_MS = 60_000; // cross-validation verdict cache
const CURVE_MAX_DIVERGENCE = 0.03; // >3% vs Jupiter => curve is stale, skip it

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function validMint(m: string): boolean {
  return MINT_RE.test(m);
}

const FETCH_TIMEOUT_MS = 4000;

/** Live USD price for a mint via Jupiter v3 (full double precision). */
async function fetchJupPrice(mint: string): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.jup.ag/price/v3?ids=${encodeURIComponent(mint)}`,
      { headers: { Accept: "application/json" }, signal: ctrl.signal }
    );
    if (res.status === 429) {
      const err = new Error("jupiter rate limited") as Error & {
        rateLimited?: boolean;
      };
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) return null;
    const d = (await res.json().catch(() => null)) as Record<
      string,
      { usdPrice?: number }
    > | null;
    const p = d?.[mint]?.usdPrice;
    return typeof p === "number" && p > 0 ? p : null;
  } catch (e) {
    if ((e as { rateLimited?: boolean })?.rateLimited) throw e;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Live USD price for a mint via DexScreener (most-liquid pair wins). Last resort. */
async function fetchDexPrice(mint: string): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { headers: { Accept: "application/json" }, signal: ctrl.signal }
    );
    if (!res.ok) return null;
    const d = (await res.json().catch(() => null)) as {
      pairs?: Array<{ priceUsd?: string; volume?: { h24?: number } }>;
    } | null;
    const pairs = d?.pairs ?? [];
    if (pairs.length === 0) return null;
    let bestPrice: number | null = null;
    let bestVol = -1;
    for (const p of pairs) {
      const v = p?.volume?.h24 ?? 0;
      const price = p?.priceUsd ? parseFloat(p.priceUsd) : NaN;
      if (Number.isFinite(price) && price > 0 && v > bestVol) {
        bestVol = v;
        bestPrice = price;
      }
    }
    return bestPrice;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/**
 * Bonding-curve price with graduation detection.
 * Returns graduated=true when the curve is complete/drained — its reserves
 * are frozen and any price derived from them would be stale forever.
 */
async function curveTick(
  mint: string
): Promise<{ price: number | null; graduated: boolean }> {
  const st = await readCurveState(mint);
  if (!st) return { price: null, graduated: false };
  if (
    st.complete ||
    st.virtualTokenReserves === BigInt(0) ||
    st.virtualSolReserves === BigInt(0)
  ) {
    return { price: null, graduated: true };
  }
  const solUsd = await solPriceUsd();
  if (solUsd === null) return { price: null, graduated: false };
  const solPerToken =
    Number(st.virtualSolReserves) / Number(st.virtualTokenReserves) / 1000;
  const usd = solPerToken * solUsd;
  return {
    price: Number.isFinite(usd) && usd > 0 ? usd : null,
    graduated: false,
  };
}

/** Independent reference price for cross-validating the curve, with source.
 * DexScreener first: its quote feed is the freshest source we have (it also
 * powers the live quote tiles). Jupiter v3 is a backup — its edge cache can
 * serve prices hours stale on memecoins. */
async function referencePrice(
  mint: string
): Promise<{ price: number | null; source: "jupiter" | "dexscreener" }> {
  const dex = await fetchDexPrice(mint);
  if (dex !== null) return { price: dex, source: "dexscreener" };
  try {
    const jup = await fetchJupPrice(mint);
    if (jup !== null) return { price: jup, source: "jupiter" };
  } catch {
    // rate limited or down — no reference available
  }
  return { price: null, source: "dexscreener" };
}

/**
 * Tick price cascade with source attribution and a staleness guard.
 *
 * 1. pump.fun bonding curve — unless a fresh cross-validation verdict says
 *    it's stale. When no verdict is cached, the curve price is checked
 *    against DexScreener (independent source); >3% divergence means the curve
 *    read is frozen/wrong and we fall through to DexScreener's price instead.
 * 2. DexScreener (freshest quote feed; coarse 4-sig-digit precision).
 * 3. Jupiter v3 (last resort — its edge cache can lag hours on memecoins).
 */
async function fetchTickPrice(
  mint: string,
  s: MintState
): Promise<{ price: number | null; source: TickSource }> {
  const now = Date.now();
  const verdict =
    s.curveCheck && now - s.curveCheck.at < CURVE_CHECK_TTL_MS
      ? s.curveCheck.ok
      : null;
  const tag = shortMint(mint);

  if (verdict !== false) {
    const { price: curve, graduated } = await curveTick(mint);
    if (graduated) {
      // Frozen curve — never trust it. Cache the negative verdict so we
      // don't burn an RPC race on every tick.
      s.curveCheck = { ok: false, at: now };
      console.warn(`[ticks] ${tag} curve graduated/frozen — skipping curve`);
    } else if (curve !== null) {
      if (verdict === true) {
        return { price: curve, source: "curve" };
      }
      // No cached verdict — cross-validate against an independent source
      // before trusting. Catches frozen reserves, stuck RPC slots, wrong
      // accounts — anything that makes the curve disagree with the market.
      const ref = await referencePrice(mint);
      if (ref.price !== null && ref.price > 0) {
        const div = Math.abs(curve - ref.price) / ref.price;
        const ok = div <= CURVE_MAX_DIVERGENCE;
        s.curveCheck = { ok, at: now };
        if (ok) {
          return { price: curve, source: "curve" };
        }
        console.warn(
          `[ticks] ${tag} curve STALE (div ${(div * 100).toFixed(2)}% vs ${ref.source}) — skipping curve for 60s`
        );
        return { price: ref.price, source: ref.source };
      }
      // No independent reference (very fresh token): trust the curve
      // tentatively and cache a short positive verdict so we don't
      // re-run reference lookups on every tick.
      s.curveCheck = { ok: true, at: now };
      return { price: curve, source: "curve" };
    }
    // Curve unreadable this poll (transient RPC failure): don't cache a
    // verdict, just fall through to the next source.
  }
  // Verdict says stale, or curve unreadable: DexScreener first (freshest),
  // Jupiter only as a last resort (stale edge cache on memecoins).
  const dex = await fetchDexPrice(mint);
  if (dex !== null) return { price: dex, source: "dexscreener" };
  try {
    const jup = await fetchJupPrice(mint);
    if (jup !== null) return { price: jup, source: "jupiter" };
  } catch {
    // rate limited or down — no price available
  }
  return { price: null, source: "none" };
}

function evictIdle(now: number): void {
  registry.forEach((s, m) => {
    if (now - s.lastPoll > IDLE_TTL_MS) registry.delete(m);
  });
}

export type PollResult = {
  price: number | null;
  source: TickSource | null;
  tickCount: number;
  cached: boolean; // true when this poll reused the 1s throttle window
  degraded: boolean; // true when the last upstream fetch failed
  activeMints: number;
};

/**
 * Sample one tick for a mint. Drives the feed: every call refreshes
 * lastPoll (subscription heartbeat) and, outside the 1s throttle window,
 * fetches one live price upstream and appends it.
 */
export async function pollTick(mint: string): Promise<PollResult> {
  const now = Date.now();
  evictIdle(now);
  let s = registry.get(mint);
  if (!s) {
    s = {
      ticks: [],
      lastPoll: now,
      lastPrice: null,
      lastSource: null,
      lastUpstream: 0,
      inflight: null,
      degraded: false,
      curveCheck: null,
    };
    registry.set(mint, s);
  }
  s.lastPoll = now;

  if (!s.inflight && now - s.lastUpstream >= UPSTREAM_MIN_MS) {
    s.lastUpstream = now;
    const state = s;
    const tag = shortMint(mint);
    const p: Promise<number | null> = (async () => {
      try {
        const { price, source } = await fetchTickPrice(mint, state);
        if (price !== null && source !== state.lastSource) {
          console.log(`[ticks] ${tag} source -> ${source} @ ${price}`);
        }
        state.lastSource = source === "none" ? state.lastSource : source;
        return price;
      } catch {
        return null;
      }
    })();
    s.inflight = p;
    const price = await p;
    s.inflight = null;
    if (price !== null) {
      s.lastPrice = price;
      s.degraded = false;
      s.ticks.push({ t: Date.now(), p: price });
      if (s.ticks.length > MAX_TICKS) {
        s.ticks.splice(0, s.ticks.length - MAX_TICKS);
      }
      return {
        price,
        source: s.lastSource,
        tickCount: s.ticks.length,
        cached: false,
        degraded: false,
        activeMints: registry.size,
      };
    }
    s.degraded = true;
  }

  return {
    price: s.lastPrice,
    source: s.lastSource,
    tickCount: s.ticks.length,
    cached: true,
    degraded: s.degraded,
    activeMints: registry.size,
  };
}

export type TickCandleResult = {
  candles: TickCandle[];
  tickCount: number;
  lastTickAgeMs: number | null;
};

/** Aggregate a mint's ticks into N-second candles (ascending time order). */
export function tickCandles(mint: string, tfKey: string): TickCandleResult {
  const secs = TF_SECONDS[tfKey] ?? 5;
  const s = registry.get(mint);
  const ticks = s?.ticks ?? [];
  const buckets = new Map<number, Tick[]>();
  for (const t of ticks) {
    const b = Math.floor(t.t / 1000 / secs);
    const arr = buckets.get(b);
    if (arr) arr.push(t);
    else buckets.set(b, [t]);
  }
  const keys = Array.from(buckets.keys())
    .sort((a, b) => a - b)
    .slice(-MAX_CANDLES);
  const candles: TickCandle[] = keys.map((k) => {
    const arr = buckets.get(k) as Tick[];
    let high = -Infinity;
    let low = Infinity;
    for (const x of arr) {
      if (x.p > high) high = x.p;
      if (x.p < low) low = x.p;
    }
    return {
      time: k * secs,
      open: arr[0].p,
      high,
      low,
      close: arr[arr.length - 1].p,
    };
  });
  const lastTick = ticks.length > 0 ? ticks[ticks.length - 1].t : null;
  return {
    candles,
    tickCount: ticks.length,
    lastTickAgeMs: lastTick === null ? null : Date.now() - lastTick,
  };
}

/** Explicit unsubscribe (drawer closed). Best-effort; idle TTL is the backstop. */
export function unsubscribeMint(mint: string): boolean {
  return registry.delete(mint);
}
